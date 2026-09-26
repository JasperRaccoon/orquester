/**
 * The REAL adapter — `createGrokAdapter`, the session, the ACP peer and the
 * spawn path — driven by a recorded capture played back by the mock peer
 * (`testing/mock-grok.mjs`, `GROK_MOCK_SCENARIO=replay`): the CLI's own frames
 * in the CLI's own order, paced by their recorded gaps. What the session
 * itself decides is what these pin — above all the turns the CLI starts on its
 * own (fixtures README observation 40).
 *
 * Nothing here sleeps: every wait is on an emitted event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { createTestClock } from "../../orchestration/testing/fakes.ts";
import { GROK_FIXTURES_DIR } from "./fixtures.ts";
import { createGrokAdapter } from "./index.ts";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "testing/mock-grok.mjs");

interface ReplayRig {
  adapter: Awaited<ReturnType<typeof createGrokAdapter>>;
  events: RuntimeEvent[];
  waitFor(predicate: (event: RuntimeEvent) => boolean, label: string): Promise<RuntimeEvent>;
  /** Wait for the `n`th event matching the predicate (1-based). */
  waitForNth(n: number, predicate: (event: RuntimeEvent) => boolean, label: string): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
}

async function replayRig(fixture: string): Promise<ReplayRig> {
  const cwd = await mkdtemp(join(tmpdir(), "grok-replay-"));
  const events: RuntimeEvent[] = [];
  const waiters: Array<() => void> = [];
  const controller = new AbortController();
  let ids = 0;
  const context: AdapterContext = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    // Real time: the mock paces frames by their recorded gaps, so a registry
    // whose clock follows `createdAt` sees the capture's order of events.
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: {
      eventId: () => `e${(ids += 1)}`,
      messageId: (prefix) => `${prefix}-${(ids += 1)}`,
      uuid: () => `u${(ids += 1)}`
    },
    resolveAttachmentPath: async () => await Promise.resolve(cwd),
    attachmentsDir: () => cwd,
    logRawFrame: () => {},
    buildEnv: () => ({
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      TMPDIR: cwd,
      GROK_MOCK_SCENARIO: "replay",
      GROK_MOCK_REPLAY: join(GROK_FIXTURES_DIR, fixture)
    }),
    resolveBin: async () => await Promise.resolve(MOCK),
    sessionPath: () => process.env["PATH"] ?? "",
    tmpDir: () => cwd,
    signal: controller.signal
  };
  const adapter = await createGrokAdapter(context);
  void (async () => {
    for await (const event of adapter.events) {
      events.push(event);
      for (const wake of waiters.splice(0)) {
        wake();
      }
    }
  })();
  const waitForNth = (n: number, predicate: (event: RuntimeEvent) => boolean, label: string) =>
    new Promise<RuntimeEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 20_000);
      const check = (): void => {
        const found = events.filter(predicate);
        if (found.length >= n) {
          clearTimeout(timer);
          resolve(found[n - 1]!);
          return;
        }
        waiters.push(check);
      };
      check();
    });
  return {
    adapter,
    events,
    waitFor: (predicate, label) => waitForNth(1, predicate, label),
    waitForNth,
    dispose: async () => {
      controller.abort();
      await adapter.stopAll();
    }
  };
}

async function start(r: ReplayRig, runtimeMode: "full-access" | "approval-required" = "full-access"): Promise<void> {
  await r.adapter.startSession({
    threadId: "t1",
    cwd: "/tmp",
    home: { kind: "system", path: "/tmp" },
    modelSelection: { model: "grok-4.7" },
    runtimeMode
  });
}

async function send(r: ReplayRig, input: string): Promise<string> {
  const { turnId } = await r.adapter.sendTurn({ threadId: "t1", input, attachments: [], interactionMode: "default" });
  return turnId;
}

const isTurnCompleted = (event: RuntimeEvent): event is Extract<RuntimeEvent, { type: "turn.completed" }> =>
  event.type === "turn.completed";

function textOn(events: readonly RuntimeEvent[], turnId: string): string {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text" && event.turnId === turnId && event.agentId === undefined)
    .map((event) => event.payload.delta)
    .join("");
}

// ---------------------------------------------------------------------------

test("16 replayed: the CLI's wake after a background agent's end is a turn the adapter opens and settles", async () => {
  const r = await replayRig("16-subagent-background-poll.ndjson");
  try {
    await start(r);
    const first = await send(r, "spawn it in the background");
    const firstDone = (await r.waitFor(isTurnCompleted, "turn 1")) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    assert.equal(firstDone.turnId, first);

    const wake = (await r.waitForNth(2, isTurnCompleted, "the woken turn")) as Extract<
      RuntimeEvent,
      { type: "turn.completed" }
    >;
    assert.notEqual(wake.turnId, first, "a turn of its own");
    assert.equal(wake.payload.state, "completed");
    assert.equal(wake.payload.tokenUsage?.inputTokens, 27_388, "the woken prompt's own usage, off its turn_completed");
    const started = r.events.filter((event) => event.type === "turn.started" && event.turnId === wake.turnId);
    assert.equal(started.length, 1, "opened once, by the adapter");
    assert.match(textOn(r.events, wake.turnId!), /finished successfully/, "the parent's woken reply lands in it");
    const agentEnd = r.events.findIndex(
      (event) => event.type === "task.completed" && event.payload.taskId === "call-a00d2553-adc5-48f4-9181-4a66616fc94f-0"
    );
    const wakeStart = r.events.indexOf(started[0]!);
    assert.ok(agentEnd >= 0 && agentEnd < wakeStart, "the agent's end, then the wake it caused");
    const isReady = (event: RuntimeEvent): boolean =>
      event.type === "session.state.changed" && (event.payload as { state: string }).state === "ready";
    await r.waitForNth(3, isReady, "ready after the session, turn 1 and the wake");
    const states = r.events
      .filter((event) => event.type === "session.state.changed")
      .map((event) => (event.payload as { state: string }).state);
    assert.deepEqual(
      states,
      ["ready", "running", "ready", "running", "ready"],
      "the thread reads running while the wake runs, and ready after it"
    );

    const second = await send(r, "poll it again");
    const secondDone = (await r.waitForNth(3, isTurnCompleted, "turn 2")) as Extract<
      RuntimeEvent,
      { type: "turn.completed" }
    >;
    assert.equal(secondDone.turnId, second);
    assert.equal(secondDone.payload.state, "completed");
    const warnings = r.events
      .filter((event): event is Extract<RuntimeEvent, { type: "runtime.warning" }> => event.type === "runtime.warning")
      .map((event) => `${event.payload.message} ${JSON.stringify(event.payload.detail ?? null)}`);
    assert.deepEqual(
      warnings,
      ['grok: MCP server not ready {"name":"stripe","status":"unavailable"}'],
      "the host's MCP failure once — not again when the subagent's spawn re-handshakes it, and not the " +
        "full-access self-resolve advisory"
    );
  } finally {
    await r.dispose();
  }
});

test("15 replayed: a foreground agent ends once; the CLI's replies to its own reloads are not warnings", async () => {
  const FG = "call-178a2a0c-2c5e-49a6-8fb8-e0fee73d6c1e-0";
  const r = await replayRig("15-subagent-foreground.ndjson");
  try {
    await start(r);
    await send(r, "spawn it in the foreground");
    const done = (await r.waitFor(isTurnCompleted, "the turn")) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    assert.equal(done.payload.state, "completed");
    assert.equal(done.payload.tokenUsage?.hasSubagents, true);
    const ends = r.events.filter((event) => event.type === "task.completed" && event.payload.taskId === FG);
    assert.deepEqual(
      ends.map((event) => [(event.payload as { status?: string }).status, (event.payload as { summary?: string }).summary]),
      [["completed", "sub-ok"]]
    );
    const warnings = r.events
      .filter((event): event is Extract<RuntimeEvent, { type: "runtime.warning" }> => event.type === "runtime.warning")
      .map((event) => event.payload.message);
    assert.deepEqual(
      warnings,
      ["grok: MCP server not ready"],
      "the five skills-reload / workflows-reload replies this capture holds are the CLI's own"
    );
  } finally {
    await r.dispose();
  }
});

test("20 replayed: a monitor's first event wakes the agent before the prompt settles — its turn opens right after", async () => {
  const r = await replayRig("20-monitor.ndjson");
  try {
    await start(r);
    const first = await send(r, "start a monitor");
    const done = (await r.waitForNth(4, isTurnCompleted, "the prompt and three wakes")) as Extract<
      RuntimeEvent,
      { type: "turn.completed" }
    >;
    const turns = r.events.filter(isTurnCompleted).map((event) => event.turnId);
    assert.equal(turns[0], first, "the user's turn settles first, from its own RPC result");
    assert.equal(new Set(turns).size, 4, "every wake is a turn of its own");
    assert.equal(done.payload.state, "completed");
    const order = r.events
      .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
      .map((event) => event.type);
    assert.deepEqual(
      order,
      ["turn.started", "turn.completed", "turn.started", "turn.completed", "turn.started", "turn.completed", "turn.started", "turn.completed"],
      "never two turns open at once"
    );
    for (const turnId of turns.slice(1)) {
      assert.equal(textOn(r.events, turnId!), "SEEN");
    }

    // Each prompt's own `user_prompt_submit` hook lands on its own turn — the
    // first wake's arrives while the user's turn is still settling, and is
    // held for the wake by the prompt id it names.
    const promptHooks = r.events
      .filter((event) => event.type === "hook.started" && (event.payload as { hookEvent?: string }).hookEvent === "user_prompt_submit")
      .map((event) => event.turnId);
    assert.deepEqual(promptHooks, turns, "one prompt hook per turn, each on its own");

    // Fed as the host feeds it — every event, on a clock following its
    // stamps — the monitor stays live through its own wakes.
    const MONITOR = "01a0d913-6204-7391-8dbb-5ea888f73f03";
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    const readings: string[] = [];
    for (const event of r.events) {
      clock.set(Date.parse(event.createdAt));
      registry.observe(event);
      if (event.type === "task.completed" && event.payload.taskId === MONITOR) {
        break;
      }
      if (event.type === "turn.completed") {
        readings.push(String(registry.liveness("t1")));
      }
    }
    assert.deepEqual(readings, ["monitoring", "monitoring", "monitoring"], "never dropped while it runs");
  } finally {
    await r.dispose();
  }
});

test("21 replayed: the session-scoped Stop closes the work; the poll that says the shell still runs revives it", async () => {
  const SHELL = "01a0d915-61b7-7132-b432-a6c95b3f7778";
  const AGENT = "call-7b249d13-32d3-4f24-a3ad-b582665c9c5a-1";
  const r = await replayRig("21-stop-with-background-work.ndjson");
  try {
    await start(r);
    await send(r, "start both");
    await r.waitFor(isTurnCompleted, "turn 1");
    await r.adapter.interruptTurn("t1");
    const closed = r.events.filter((event) => event.type === "task.completed");
    assert.deepEqual(
      closed.map((event) => [event.payload.taskId, event.payload.status]).sort(),
      [
        [AGENT, "stopped"],
        [SHELL, "stopped"]
      ].sort()
    );
    await send(r, "poll both");
    await r.waitForNth(2, isTurnCompleted, "turn 2");
    const restarts = r.events.filter((event) => event.type === "task.started" && event.payload.taskId === SHELL);
    assert.equal(restarts.length, 2, "the CLI's poll answering running counted the shell live again");
    assert.equal(
      r.events.filter((event) => event.type === "task.completed" && event.payload.taskId === AGENT).length,
      1,
      "the CLI's own cancel of the agent adds no second end"
    );
  } finally {
    await r.dispose();
  }
});

test("25 replayed, supervised: a subagent's own write asks on the PARENT's session — the parent's card, on the parent's turn", async () => {
  const SPAWN = "call-b3e76da4-ba41-4077-ba32-0ac796f0a406-0";
  const CHILD_WRITE = "call-4788fbf7-40c9-4968-a7db-62c3e7eee640-0";
  const r = await replayRig("25-subagent-child-approval.ndjson");
  try {
    await start(r, "approval-required");
    const turnId = await send(r, "spawn a writer");
    const isCard = (event: RuntimeEvent): event is Extract<RuntimeEvent, { type: "request.opened" }> =>
      event.type === "request.opened";
    const spawnCard = (await r.waitForNth(1, isCard, "the spawn's own card")) as Extract<
      RuntimeEvent,
      { type: "request.opened" }
    >;
    // The CLI waits for the answer, and so does the replay.
    await r.adapter.respondToApproval("t1", spawnCard.requestId!, "accept");
    const writeCard = (await r.waitForNth(2, isCard, "the child's write card")) as Extract<
      RuntimeEvent,
      { type: "request.opened" }
    >;
    // Supervised, the spawn itself asks first (`x.ai/tool` kind `task`): a card
    // of its own, before the subagent exists.
    assert.equal((spawnCard.payload.args as { toolCallId?: string }).toolCallId, SPAWN);
    // The child's write is asked on the parent's session, naming the child's call.
    assert.equal((writeCard.payload.args as { toolCallId?: string }).toolCallId, CHILD_WRITE);
    assert.equal(writeCard.payload.requestType, "file_change_approval");
    for (const card of [spawnCard, writeCard]) {
      assert.equal(card.turnId, turnId, "on the parent's turn, open while its foreground spawn runs");
      assert.equal(card.agentId, undefined, "the parent's card, as a Codex collab child's approval is");
    }
    const childCall = r.events.find(
      (event) => event.type === "item.started" && event.itemId === CHILD_WRITE
    );
    assert.equal(childCall?.agentId, SPAWN, "while the call itself is the agent's own row");
    await r.adapter.respondToApproval("t1", writeCard.requestId!, "accept");
    const done = (await r.waitFor(isTurnCompleted, "the turn")) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    assert.equal(done.turnId, turnId);
    const resolved = r.events.filter(
      (event) => event.type === "request.resolved" && event.requestId === writeCard.requestId
    );
    assert.deepEqual(
      resolved.map((event) => (event.payload as { decision?: string }).decision),
      ["accept"]
    );
    const ends = r.events.filter((event) => event.type === "task.completed" && event.payload.taskId === SPAWN);
    assert.deepEqual(
      ends.map((event) => [(event.payload as { status?: string }).status, (event.payload as { summary?: string }).summary]),
      [["completed", "done"]],
      "allowed, the child wrote its file and finished"
    );
  } finally {
    await r.dispose();
  }
});

test("29 replayed: the scheduler's reports reach the normaliser — a loop row, never an unhandled-method warning", async () => {
  const LOOP = "01a0de9b-e17c-7fa0-83dc-a436461e59b5";
  const r = await replayRig("29-loop-scheduled-task.ndjson");
  try {
    await start(r);
    await send(r, "/loop 60s Reply with exactly: tick");
    await r.waitFor(isTurnCompleted, "the /loop turn");
    await r.waitForNth(2, isTurnCompleted, "the wake its fire caused");
    await send(r, "delete it");
    await r.waitFor(
      (event) => event.type === "task.completed" && event.payload.taskId === LOOP,
      "the loop's end, at scheduled_task_deleted"
    );
    const loop = r.events.filter(
      (event) => event.type.startsWith("task.") && (event.payload as { taskId?: string }).taskId === LOOP
    );
    assert.deepEqual(
      loop.map((event) => event.type),
      ["task.started", "task.progress", "task.completed"]
    );
    const warnings = r.events
      .filter((event): event is Extract<RuntimeEvent, { type: "runtime.warning" }> => event.type === "runtime.warning")
      .map((event) => event.payload.message);
    assert.deepEqual(warnings, ["grok: MCP server not ready"], "no acp: unhandled notification _x.ai/scheduled_task_*");
  } finally {
    await r.dispose();
  }
});

test("31 replayed: the host's cancel of a question is the CLI's own; a Stop's order ends the turn interrupted", async () => {
  const r = await replayRig("31-question-cancelled.ndjson");
  try {
    await start(r);
    const isQuestion = (event: RuntimeEvent): boolean => event.type === "user-input.requested";

    // Turn 1: the question answered with the host's cancel alone. The CLI
    // reads it as the user declining ("User declined to answer the
    // questions…") and the model goes on.
    const first = await send(r, "ask me");
    const asked = await r.waitForNth(1, isQuestion, "the first question");
    await r.adapter.respondToUserInput("t1", asked.requestId!, {}, { cancel: true });
    const firstDone = (await r.waitFor(isTurnCompleted, "turn 1")) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    assert.equal(firstDone.turnId, first);
    const declined = r.events.findIndex(
      (event) => event.type === "user-input.resolved" && event.requestId === asked.requestId
    );
    assert.equal(textOn(r.events.slice(0, declined), first), "I'll ask that one question now.");
    assert.equal(textOn(r.events.slice(declined), first), "NONE", "the model heard nobody answered");

    // Turn 2: a Stop — the host cancels the question, then interrupts.
    const second = await send(r, "ask me again");
    const again = await r.waitForNth(2, isQuestion, "the second question");
    await r.adapter.respondToUserInput("t1", again.requestId!, {}, { cancel: true });
    await r.adapter.interruptTurn("t1");
    const secondDone = (await r.waitForNth(2, isTurnCompleted, "turn 2")) as Extract<
      RuntimeEvent,
      { type: "turn.completed" }
    >;
    assert.equal(secondDone.turnId, second);
    assert.equal(secondDone.payload.state, "interrupted");

    const resolutions = r.events.filter((event) => event.type === "user-input.resolved");
    assert.deepEqual(
      resolutions.map((event) => [event.requestId, (event.payload as { withdrawn?: boolean }).withdrawn]),
      [
        [asked.requestId, true],
        [again.requestId, true]
      ],
      "one closing row per card, each nobody's answer"
    );
    assert.equal(
      r.events.filter(isTurnCompleted).length,
      2,
      "the cancelled prompt's own result, arriving after the interrupt, settles nothing twice"
    );
  } finally {
    await r.dispose();
  }
});
