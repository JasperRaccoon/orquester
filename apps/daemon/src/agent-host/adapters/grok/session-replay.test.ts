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
    clock: { now: () => new Date(0), nowIso: () => "2026-09-25T00:00:00.000Z" },
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

async function start(r: ReplayRig): Promise<void> {
  await r.adapter.startSession({
    threadId: "t1",
    cwd: "/tmp",
    home: { kind: "system", path: "/tmp" },
    modelSelection: { model: "grok-4.7" },
    runtimeMode: "full-access"
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
