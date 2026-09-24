/**
 * The host's side of provider-native goals (goals spec §4.7, §5):
 *
 * - Codex's `/goal …` is parsed by the host and run as a goal command — the
 *   user's message is committed and NO turn is started (§5.1);
 * - every `startSession` carries the fold's goal, and an account switch carries
 *   the goal itself across homes (§5.3);
 * - the host summary names the unfinished goal and whether the provider keeps
 *   starting turns for it (§4.7);
 * - the turn watchdog waits an hour, not ten minutes, while a goal is active
 *   (§5.2).
 *
 * Fake adapters only: the Codex adapter's own `goalCommand` is exercised
 * against its mock app-server in `adapters/codex/`.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type {
  AdapterGoalSupport,
  AttachmentRef,
  DomainEvent,
  GoalUpdatedPayload,
  RuntimeEvent,
  ThreadActivityItem
} from "@orquester/api/agent-chat";

import type { GoalCommandResult, HostGoalCommand } from "../adapter.ts";
import { runtimeEventToActivities } from "../ingestion/activities.ts";
import {
  AGENT_HOST_DEADLINES,
  GOAL_CONTINUATION_GRACE_MS,
  TURN_LIVENESS_WINDOWS
} from "../support/deadline.ts";
import { isAgentChatCommandError } from "./errors.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type TestHost,
  type TestHostOptions
} from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `goal-cmd-${(commandSeq += 1)}`;

/** Codex's capability (goals §4.5). */
const HOST_GOALS: AdapterGoalSupport = {
  command: "host",
  actions: ["pause", "resume", "clear"],
  continuesAcrossTurns: true
};

/** Claude's capability (goals §4.5): `/goal` is the CLI's to parse. */
const PROVIDER_GOALS: AdapterGoalSupport = {
  command: "provider",
  actions: ["continue", "clear"],
  continuesAcrossTurns: false
};

function codexHost(
  goalCommand: (threadId: string, command: HostGoalCommand) => Promise<GoalCommandResult> = async () => ({
    summary: ""
  }),
  hostOptions: Omit<TestHostOptions, "adapters"> = {}
): TestHost {
  const codex = createScriptedAdapter({
    id: "codex",
    capabilities: { goals: HOST_GOALS },
    goalCommand
  });
  return createTestHost({ ...hostOptions, adapters: { codex } });
}

function log(host: TestHost, threadId = "thread-1"): DomainEvent[] {
  return host.store.logs.get(threadId) ?? [];
}

function activities(host: TestHost, threadId = "thread-1"): ThreadActivityItem[] {
  return log(host, threadId)
    .filter((event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
      event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);
}

function userMessages(
  host: TestHost,
  threadId = "thread-1"
): Array<Extract<DomainEvent, { type: "thread.message-sent" }>["payload"]> {
  return log(host, threadId)
    .filter((event): event is Extract<DomainEvent, { type: "thread.message-sent" }> =>
      event.type === "thread.message-sent"
    )
    .map((event) => event.payload);
}

const callsOf = (host: TestHost, kind: string): unknown[] =>
  host.adapter.calls.filter((call) => call.kind === kind).map((call) => call.detail);

let goalSeq = 0;

/**
 * An adapter's `thread.goal.updated`, through the real ingestion mapping
 * (goals §4.3) and into the thread the way the sink delivers it — so the
 * fold's `goal` is what a live provider would have produced.
 */
async function pushGoal(host: TestHost, payload: GoalUpdatedPayload, threadId = "thread-1"): Promise<void> {
  goalSeq += 1;
  const event = {
    eventId: `goal-${goalSeq}`,
    threadId,
    createdAt: host.clock.nowIso(),
    type: "thread.goal.updated",
    payload
  } as RuntimeEvent;
  const rows = runtimeEventToActivities(event);
  assert.equal(rows.length, 1, "a live goal update is one row");
  await host.orchestrator.ingestionSink(
    threadId,
    rows.map((activity) => ({
      eventId: `ingest-goal-${goalSeq}`,
      threadId,
      type: "thread.activity-appended" as const,
      payload: { activity },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }))
  );
}

/** The provider finished its turn; the child stays live (§5.1 settle by status). */
async function completeTurn(host: TestHost, threadId = "thread-1"): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `turn-end-${threadId}-${(goalSeq += 1)}`,
      threadId,
      type: "thread.session-set",
      payload: { session: { status: "ready", activeTurnId: null } },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
  await host.settle();
}

/**
 * Yield until `done()` holds: `consume` runs on the adapter's stream, so there
 * is no receipt to wait on. Bounded, and never a timed sleep (§9).
 */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done(), "the runtime event was never consumed");
}

const file: AttachmentRef = { type: "file", id: "att-1", name: "notes.txt", sizeBytes: 3 };

// ---------------------------------------------------------------------------
// §5.1 — Codex's `/goal` is a host command
// ---------------------------------------------------------------------------

describe("goals §5.1 — Codex's /goal is a host command", () => {
  it("commits the user's message and NO turn row, and never sends /goal to the model", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });

    const receipt = await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "  /goal make the build green  "
    });
    await host.settle();

    assert.ok(receipt.seq > 0, "the command is receipted like any /turn");
    assert.deepEqual(
      userMessages(host).map((message) => ({
        role: message.role,
        text: message.text,
        turnId: message.turnId,
        streaming: message.streaming
      })),
      [{ role: "user", text: "/goal make the build green", turnId: null, streaming: false }],
      "the text as typed (trimmed like every turn), on no turn"
    );
    assert.ok(
      !log(host).some((event) => event.type === "thread.turn-start-requested"),
      "the host starts no turn: any turn Codex starts is its own"
    );
    assert.deepEqual(callsOf(host, "goalCommand"), [
      { kind: "set", objective: "make the build green" }
    ]);
    assert.deepEqual(callsOf(host, "sendTurn"), [], "T3 #13252: the model never sees /goal as text");

    const read = await host.orchestrator.readThread(threadId);
    assert.equal(read.kind, "snapshot");
    assert.deepEqual(read.kind === "snapshot" ? read.thread.turns : null, [], "no pending turn row");
    await host.stop();
  });

  it("ensures the provider session first, exactly as a turn does", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();
    assert.deepEqual(
      host.adapter.calls
        .map((call) => call.kind)
        .filter((kind) => kind === "startSession" || kind === "goalCommand"),
      ["startSession", "goalCommand"],
      "a thread with no live session gets one before the command"
    );

    // The child dies: the next goal command recovers it from the cursor, like
    // lazy recovery on a turn (§4.1).
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await host.adapter.stopSession(threadId);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal resume" });
    await host.settle();
    const starts = callsOf(host, "startSession") as Array<{ resumeCursor?: unknown }>;
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1]?.resumeCursor, { cursor: "turn-1" });
    assert.deepEqual(callsOf(host, "goalCommand").at(-1), { kind: "resume" });
    await host.stop();
  });

  it("during a running turn it joins that turn and opens nothing", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();

    assert.equal(userMessages(host).at(-1)?.turnId, "turn-1", "the running turn names it");
    assert.equal(
      log(host).filter((event) => event.type === "thread.turn-start-requested").length,
      1,
      "only the real turn's row"
    );
    assert.equal(callsOf(host, "sendTurn").length, 1, "and no steer either");
    assert.deepEqual(callsOf(host, "goalCommand"), [{ kind: "pause" }]);
    await host.stop();
  });

  it("a non-empty summary is a visible goal.status info row", async () => {
    const host = codexHost(async (_threadId, command) => ({
      summary: command.kind === "status" ? "Goal active: ship it — 1200 tokens, 3m" : ""
    }));
    const threadId = await host.createThread({ refId: "codex" });

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal" });
    await host.settle();

    const rows = activities(host).filter((row) => row.activityKind === "goal.status");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tone, "info");
    assert.equal(rows[0]?.summary, "Goal active: ship it — 1200 tokens, 3m");
    await host.stop();
  });

  it("an empty summary appends nothing — the provider's own updates tell the story", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal clear" });
    await host.settle();
    assert.deepEqual(
      activities(host)
        .map((row) => row.activityKind)
        .filter((kind) => kind.startsWith("goal.")),
      []
    );
    await host.stop();
  });

  it("a provider refusal is a goal.command.failed error row, never an HTTP error", async () => {
    const host = codexHost(async () => {
      throw new Error("no goal exists");
    });
    const threadId = await host.createThread({ refId: "codex" });

    // Answers like any /turn: the command is recorded before the provider is asked.
    const receipt = await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal pause"
    });
    await host.settle();
    assert.ok(receipt.seq > 0);

    const failed = activities(host).filter((row) => row.activityKind === "goal.command.failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.tone, "error");
    assert.equal(failed[0]?.summary, "Goal command failed");
    assert.equal((failed[0]?.payload as { detail?: string }).detail, "no goal exists");
    assert.equal(
      host.orchestrator.summary(threadId)?.chatSessionStatus === "error",
      false,
      "a refused goal command does not wedge the thread"
    );
    await host.stop();
  });

  it("a session that cannot start fails the goal command as a row, too", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    host.adapter.failNext("failStartSession", new Error("codex is not installed"));

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();

    assert.deepEqual(callsOf(host, "goalCommand"), [], "nothing to send it to");
    const failed = activities(host).filter((row) => row.activityKind === "goal.command.failed");
    assert.equal(failed.length, 1);
    assert.equal((failed[0]?.payload as { detail?: string }).detail, "codex is not installed");
    await host.stop();
  });

  it("a malformed goal command is refused BEFORE anything is committed (R2-7)", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    const before = log(host).length;

    const refused = async (input: string, message: string, attachments?: AttachmentRef[]) => {
      const commandId = cmd();
      await assert.rejects(
        () =>
          host.orchestrator.command(threadId, "turn", {
            commandId,
            input,
            ...(attachments !== undefined ? { attachments } : {})
          }),
        (error: unknown) =>
          isAgentChatCommandError(error) &&
          error.code === "INVALID_COMMAND" &&
          error.status === 400 &&
          error.message === message
      );
      // Recorded: a retry of the same command replays the refusal.
      await assert.rejects(
        () => host.orchestrator.command(threadId, "turn", { commandId, input: "/goal" }),
        (error: unknown) => isAgentChatCommandError(error) && error.message === message
      );
    };

    await refused("/goal edit", "Usage: /goal edit <objective>");
    await refused(`/goal ${"x".repeat(4_001)}`, "A goal is limited to 4000 characters.");
    await refused("/goal ship it", "A goal can't include attachments.", [file]);
    await host.settle();

    assert.equal(log(host).length, before, "no bubble for a command that never ran");
    assert.deepEqual(callsOf(host, "goalCommand"), []);
    assert.deepEqual(callsOf(host, "startSession"), []);
    await host.stop();
  });

  it("a provider-command adapter, or one with no goals, gets /goal as an ordinary turn", async () => {
    // Claude and Grok parse `/goal` in their own CLI; OpenCode has no goal
    // surface at all (goals §2). None of them is the host's to parse — not
    // even text the host parser would refuse.
    const claude = createScriptedAdapter({ id: "claude", capabilities: { goals: PROVIDER_GOALS } });
    const opencode = createScriptedAdapter({ id: "opencode" });
    const host = createTestHost({ adapters: { claude, opencode } });

    for (const [adapter, threadId] of [
      [claude, "thread-claude"],
      [opencode, "thread-opencode"]
    ] as const) {
      await host.createThread({ threadId, refId: adapter.id });
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal edit" });
      await host.settle();
      assert.equal(adapter.lastTurn?.input, "/goal edit", adapter.id);
      assert.ok(
        log(host, threadId).some((event) => event.type === "thread.turn-start-requested"),
        adapter.id
      );
      assert.equal(adapter.goalCommand, undefined);
    }
    await host.stop();
  });

  it("an adapter that advertises host goals without goalCommand fails as a row, not a crash", async () => {
    const codex = createScriptedAdapter({ id: "codex", capabilities: { goals: HOST_GOALS } });
    const host = createTestHost({ adapters: { codex } });
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();
    assert.deepEqual(callsOf(host, "sendTurn"), [], "still never forwarded as text");
    assert.equal(
      activities(host).filter((row) => row.activityKind === "goal.command.failed").length,
      1
    );
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// §5.3 — session start
// ---------------------------------------------------------------------------

describe("goals §5.3 — every session start carries the fold's goal", () => {
  it("knownGoal is the fold's goal without its row stamp, on every start", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    assert.equal(host.adapter.lastStart?.knownGoal, null, "no goal yet is said, not omitted");

    await pushGoal(host, {
      goal: { objective: "ship it", status: "active", rounds: 2, lastCheck: "tests still fail" },
      change: "checked"
    });
    // A restart for another reason (§3.4): the goal is known, not carried.
    await host.orchestrator.command(threadId, "mode", {
      commandId: cmd(),
      runtimeMode: "full-access"
    });
    await host.settle();

    assert.equal(callsOf(host, "startSession").length, 2);
    assert.deepEqual(host.adapter.lastStart?.knownGoal, {
      objective: "ship it",
      status: "active",
      rounds: 2,
      lastCheck: "tests still fail"
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(host.adapter.lastStart?.knownGoal ?? {}, "updatedAt"),
      false
    );
    assert.equal(host.adapter.lastStart?.carryGoal, undefined);
    await host.stop();
  });

  it("a finished goal is still handed over as known — the adapter decides", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await pushGoal(host, {
      goal: { objective: "ship it", status: "complete", rounds: 4 },
      change: "achieved"
    });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    assert.deepEqual(host.adapter.lastStart?.knownGoal, {
      objective: "ship it",
      status: "complete",
      rounds: 4
    });
    await host.stop();
  });

  /**
   * A Codex thread with an unfinished goal and an idle session. Paused: an
   * ACTIVE goal continues by itself and blocks the switch (§5.5) — a paused,
   * blocked or limited one is exactly what a switch carries across.
   */
  async function idleCodexThreadWithAGoal(): Promise<{ host: TestHost; threadId: string }> {
    const host = codexHost();
    const threadId = await host.createThread({
      refId: "codex",
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1"
    });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await host.settle();
    await completeTurn(host, threadId);
    await pushGoal(host, { goal: { objective: "ship it", status: "paused" }, change: "set" });
    return { host, threadId };
  }

  const toAcc2 = {
    accountId: "acc2",
    home: "account" as const,
    homePath: "/homes/acc2"
  };

  it("an account-switch restart carries the goal into the new home", async () => {
    // Codex keeps goals in the thread's CODEX_HOME, which a managed account
    // home does not share: without the carry the goal is lost (goals §3.2).
    const { host, threadId } = await idleCodexThreadWithAGoal();
    await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await host.settle();

    assert.equal(callsOf(host, "startSession").length, 2, "the live session was restarted");
    assert.equal(host.adapter.lastStart?.home.path, "/homes/acc2");
    assert.equal(host.adapter.lastStart?.carryGoal, true);
    assert.deepEqual(host.adapter.lastStart?.knownGoal, { objective: "ship it", status: "paused" });
    await host.stop();
  });

  it("a switch applied while no session is live still carries it — the binding names the old home", async () => {
    const { host, threadId } = await idleCodexThreadWithAGoal();
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    assert.equal(host.adapter.hasSession(threadId), false);

    await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await host.settle();

    assert.equal(host.adapter.lastStart?.home.path, "/homes/acc2");
    assert.equal(host.adapter.lastStart?.carryGoal, true);
    await host.stop();
  });

  it("a lazy restart in the SAME home carries nothing", async () => {
    const { host, threadId } = await idleCodexThreadWithAGoal();
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await host.settle();

    assert.equal(callsOf(host, "startSession").length, 2);
    assert.equal(host.adapter.lastStart?.carryGoal, undefined);
    assert.deepEqual(host.adapter.lastStart?.knownGoal, { objective: "ship it", status: "paused" });
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// §4.7 — the host summary
// ---------------------------------------------------------------------------

describe("goals §4.7 — the summary names the unfinished goal", () => {
  it("no goal reads null", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.goal, null);
    await host.stop();
  });

  it("an active goal on a provider that continues by itself, on a live session, is continuing", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });

    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "active",
      continuing: true
    });
    // Between two of Codex's own turns: still continuing — the settled turn is
    // a pause, not the end of the work.
    await completeTurn(host, threadId);
    assert.equal(host.orchestrator.summary(threadId)?.chatSessionStatus, "ready");
    assert.equal(host.orchestrator.summary(threadId)?.goal?.continuing, true);
    await host.stop();
  });

  it("a paused or limited goal is reported but not continuing; a finished one is not reported", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    await pushGoal(host, { goal: { objective: "ship it", status: "paused" }, change: "paused" });
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "paused",
      continuing: false
    });
    await pushGoal(host, {
      goal: { objective: "ship it", status: "usage-limited" },
      change: "limited"
    });
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "usage-limited",
      continuing: false
    });
    await pushGoal(host, {
      goal: null,
      change: "achieved",
      previous: { objective: "ship it", status: "complete" }
    });
    assert.equal(host.orchestrator.summary(threadId)?.goal, null);
    await pushGoal(host, {
      goal: { objective: "ship it", status: "failed", lastCheck: "impossible" },
      change: "failed"
    });
    assert.equal(host.orchestrator.summary(threadId)?.goal, null, "failed is finished too");
    await host.stop();
  });

  it("a provider that does not continue across turns is never continuing", async () => {
    const claude = createScriptedAdapter({ id: "claude", capabilities: { goals: PROVIDER_GOALS } });
    const host = createTestHost({ adapters: { claude } });
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal ship it" });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "active",
      continuing: false
    });
    await host.stop();
  });

  it("without a live session nothing can start the next turn, so it is not continuing", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    // Never started: no provider child at all.
    assert.equal(host.orchestrator.summary(threadId)?.goal?.continuing, false);

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.goal?.continuing, true);

    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "active",
      continuing: false
    });
    await host.stop();
  });

  it("a continuing goal is never background work and never an active turn (§4.7)", async () => {
    // A Codex goal survives a drain-restart — the resume continues it — so it
    // must not hold a deploy's handover open.
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    await completeTurn(host, threadId);

    assert.equal(host.orchestrator.summary(threadId)?.goal?.continuing, true);
    assert.equal(host.orchestrator.summary(threadId)?.backgroundLiveness, null);
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), []);
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), []);
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// §5.2 — the watchdog's goal window
// ---------------------------------------------------------------------------

describe("goals §5.2 — the turn watchdog while a goal is active", () => {
  async function silentTurn(goalStatus: "active" | "paused" | null): Promise<{
    host: TestHost;
    at: (ms: number) => Promise<void>;
    interrupts: () => number;
    stop: () => Promise<void>;
  }> {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal keep the build green"
    });
    await host.settle();
    if (goalStatus !== null) {
      await pushGoal(host, {
        goal: { objective: "keep the build green", status: goalStatus },
        change: goalStatus === "active" ? "set" : "paused"
      });
    }
    const consumed = host.orchestrator.consume(host.adapter);
    const base = { threadId, createdAt: host.clock.nowIso() };
    host.adapter.emit({ ...base, eventId: "s", type: "turn.started", turnId: "turn-1", payload: {} } as unknown as RuntimeEvent);
    host.adapter.emit({
      ...base,
      eventId: "d",
      type: "content.delta",
      turnId: "turn-1",
      payload: { streamKind: "assistant_text", delta: "working on it" }
    } as unknown as RuntimeEvent);
    await until(() => host.timers.pending > 0);
    const start = host.clock.now().getTime();
    return {
      host,
      at: async (ms: number) => {
        host.clock.set(start + ms);
        host.timers.runDue(ms);
        await host.settle();
      },
      interrupts: () => callsOf(host, "interruptTurn").length,
      stop: async () => {
        host.adapter.close();
        await consumed;
        await host.stop();
      }
    };
  }

  it("an active goal keeps a silent turn alive past the idle window, and not past an hour", async () => {
    const run = await silentTurn("active");
    await run.at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(run.interrupts(), 0, "a goal's silent verifier round is not a stall");
    await run.at(TURN_LIVENESS_WINDOWS.activeToolMs);
    assert.equal(run.interrupts(), 0);
    await run.at(TURN_LIVENESS_WINDOWS.goalMs);
    assert.equal(run.interrupts(), 1);
    assert.ok(
      activities(run.host).some((row) => row.summary === "Turn cancelled after inactivity"),
      "the stall is still reported the usual way"
    );
    await run.stop();
  });

  it("a paused goal, or none, leaves the normal window alone", async () => {
    for (const status of ["paused", null] as const) {
      const run = await silentTurn(status);
      await run.at(TURN_LIVENESS_WINDOWS.idleMs);
      assert.equal(run.interrupts(), 1, String(status));
      await run.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — review findings on the host paths
// ---------------------------------------------------------------------------

/** An approval card, parked the way ingestion parks one. */
async function openApproval(host: TestHost, requestId: string, threadId = "thread-1"): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `approval-${requestId}`,
      threadId,
      type: "thread.activity-appended",
      payload: {
        activity: {
          kind: "activity",
          id: `approval:${requestId}`,
          tone: "approval",
          activityKind: "approval.requested",
          summary: "Run a command?",
          payload: { requestId, requestKind: "command" },
          turnId: null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso()
        }
      },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
}

/** Runtime events as the adapter's stream delivers them. */
function runtimeEvent(
  host: TestHost,
  type: RuntimeEvent["type"],
  extra: Record<string, unknown> = {},
  threadId = "thread-1"
): RuntimeEvent {
  goalSeq += 1;
  return {
    eventId: `rt-${goalSeq}`,
    threadId,
    createdAt: host.clock.nowIso(),
    type,
    payload: {},
    ...extra
  } as RuntimeEvent;
}

/**
 * Fold every `thread.goal.updated` the adapter emits through the real
 * ingestion mapping — the flow in which the watchdog OBSERVES a goal event
 * before ingestion folds it.
 */
function foldGoalEvents(host: TestHost): void {
  host.ingestion.translate = (event) =>
    event.type !== "thread.goal.updated"
      ? []
      : runtimeEventToActivities(event).map((activity) => ({
          eventId: `ingest-${event.eventId}`,
          threadId: event.threadId,
          type: "thread.activity-appended" as const,
          payload: { activity },
          occurredAt: event.createdAt,
          commandId: null,
          causationEventId: null,
          metadata: {}
        }));
}

/** Move the clock and the timer wheel together, `ms` after `start`. */
function clockFrom(host: TestHost): (ms: number) => Promise<void> {
  const start = host.clock.now().getTime();
  return async (ms: number) => {
    host.clock.set(start + ms);
    host.timers.runDue(ms);
    await host.settle();
  };
}

describe("fix round 1 — review findings", () => {
  it("finding 2: a turn Codex starts by itself for a host /goal is watched, and cancelled on silence", async () => {
    // No `/turn` ever ran here, so nothing armed the watchdog explicitly: the
    // provider-initiated turn itself must.
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    const consumed = host.orchestrator.consume(host.adapter);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal ship it" });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });

    host.adapter.emit(runtimeEvent(host, "turn.started", { turnId: "codex-goal-1" }));
    host.adapter.emit(
      runtimeEvent(host, "content.delta", {
        turnId: "codex-goal-1",
        payload: { streamKind: "assistant_text", delta: "working toward the goal" }
      })
    );
    await until(() => host.timers.pending > 0);
    const at = clockFrom(host);

    await at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.deepEqual(callsOf(host, "interruptTurn"), [], "the goal window applies");
    await at(TURN_LIVENESS_WINDOWS.goalMs);
    assert.deepEqual(callsOf(host, "interruptTurn"), ["codex-goal-1"]);
    assert.ok(activities(host).some((row) => row.summary === "Turn cancelled after inactivity"));
    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("finding 2: a replayed turn.started never arms one", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    const consumed = host.orchestrator.consume(host.adapter);
    host.adapter.emit(
      runtimeEvent(host, "turn.started", {
        turnId: "past",
        raw: { source: "history.replay", payload: {} }
      }, threadId)
    );
    host.adapter.emit(
      runtimeEvent(host, "content.delta", {
        turnId: "past",
        raw: { source: "history.replay", payload: {} },
        payload: { streamKind: "assistant_text", delta: "old" }
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.timers.pending, 0, "the past is not a stalled turn");
    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("finding 3: a goal that ends mid-turn gives the silence the normal window, not the hour", async () => {
    // The goal row is folded AFTER the watchdog observed its event, so the
    // timer that event armed read the goal as still active.
    const host = codexHost();
    foldGoalEvents(host);
    const threadId = await host.createThread({ refId: "codex" });
    const consumed = host.orchestrator.consume(host.adapter);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    host.adapter.emit(
      runtimeEvent(host, "thread.goal.updated", {
        payload: { goal: { objective: "ship it", status: "active" }, change: "set" }
      })
    );
    host.adapter.emit(runtimeEvent(host, "turn.started", { turnId: "turn-1" }));
    host.adapter.emit(
      runtimeEvent(host, "thread.goal.updated", {
        turnId: "turn-1",
        payload: {
          goal: null,
          change: "achieved",
          previous: { objective: "ship it", status: "complete" }
        }
      })
    );
    await until(() => host.orchestrator.summary(threadId)?.goal === null && host.timers.pending > 0);
    const at = clockFrom(host);

    await at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.deepEqual(callsOf(host, "interruptTurn"), ["turn-1"], "ten silent minutes, no goal: stalled");
    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("finding 5: a goal command waits for a compaction — refused before anything is committed", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();
    await completeTurn(host, threadId);

    let releaseCompact: () => void = () => undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = () => resolve();
    });
    const compact = host.adapter.compact.bind(host.adapter);
    host.adapter.compact = async (id: string) => {
      await compactGate;
      return compact(id);
    };
    await host.orchestrator.command(threadId, "compact", { commandId: cmd() });
    await new Promise((resolve) => setImmediate(resolve));

    const refused = async (input: string): Promise<void> => {
      const before = log(host).length;
      await assert.rejects(
        () => host.orchestrator.command(threadId, "turn", { commandId: cmd(), input }),
        (error: unknown) =>
          isAgentChatCommandError(error) &&
          error.code === "INVALID_COMMAND" &&
          error.message === "Wait for the compaction to finish before changing the goal."
      );
      assert.equal(log(host).length, before, "no bubble for a command that did not run");
    };
    await refused("/goal pause");

    // Queued behind the compaction: while the queue drains — no compaction
    // any more — a goal command still waits its turn.
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "queued 1" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "queued 2" });
    let releaseSend: () => void = () => undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = () => resolve();
    });
    const sendTurn = host.adapter.sendTurn.bind(host.adapter);
    host.adapter.sendTurn = async (input) => {
      await sendGate;
      return sendTurn(input);
    };
    releaseCompact();
    await until(() => callsOf(host, "compact").length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    await refused("/goal clear");

    releaseSend();
    await host.settle();
    assert.deepEqual(callsOf(host, "goalCommand"), [], "neither ever reached the provider");
    // Once the queue is empty the command is taken again.
    await completeTurn(host, threadId);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();
    assert.deepEqual(callsOf(host, "goalCommand"), [{ kind: "pause" }]);
    await host.stop();
  });

  it("finding 6: a goal command records a changed model selection exactly as a turn does", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal ship it",
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    const types = log(host).map((event) => event.type);
    const recorded = types.indexOf("thread.meta-updated");
    assert.ok(recorded >= 0, "the new selection is recorded");
    assert.equal(types[recorded + 1], "thread.message-sent", "right before the message, as a turn does");
    assert.ok(!types.includes("thread.turn-start-requested"), "and still no turn");
    const metaUpdates = log(host).filter(
      (event): event is Extract<DomainEvent, { type: "thread.meta-updated" }> =>
        event.type === "thread.meta-updated"
    );
    assert.deepEqual(metaUpdates.map((event) => event.payload), [
      { modelSelection: { model: "other-model" } }
    ]);
    const read = await host.orchestrator.readThread(threadId);
    assert.deepEqual(
      read.kind === "snapshot" ? read.thread.head.modelSelection : null,
      { model: "other-model" },
      "the next turn Orquester starts runs on it"
    );

    // The same selection again changes nothing.
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal",
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    assert.equal(
      log(host).filter((event) => event.type === "thread.meta-updated").length,
      1,
      "an unchanged selection is no event"
    );
    await host.stop();
  });

  it("finding 8: a live session whose head says error is not continuing", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    assert.equal(host.orchestrator.summary(threadId)?.goal?.continuing, true);

    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "session-error",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "error", activeTurnId: null, lastError: "boom" } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    assert.equal(host.adapter.hasSession(threadId), true, "the provider child is still there");
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "active",
      continuing: false
    });
    await host.stop();
  });

  describe("finding 9: Stop on a continuing goal pauses it before any card is cancelled", () => {
    async function runningGoalWithACard(
      goalCommand: (threadId: string, command: HostGoalCommand) => Promise<GoalCommandResult>
    ): Promise<{ host: TestHost; threadId: string }> {
      const host = codexHost(goalCommand);
      const threadId = await host.createThread({ refId: "codex" });
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
      await host.settle();
      await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
      await openApproval(host, "req-1");
      return { host, threadId };
    }

    const order = (host: TestHost): string[] =>
      host.adapter.calls
        .filter((call) =>
          ["goalCommand", "respondToApproval", "interruptTurn"].includes(call.kind)
        )
        .map((call) =>
          call.kind === "goalCommand" ? `goalCommand:${(call.detail as HostGoalCommand).kind}` : call.kind
        );

    const goalRows = (host: TestHost): string[] =>
      activities(host)
        .map((row) => row.activityKind)
        .filter((kind) => kind === "goal.status" || kind === "goal.command.failed");

    it("pause → card cancel → interrupt, with no goal row for the internal pause", async () => {
      // On Codex a `cancel` ends the turn by itself, and a continuing goal
      // starts the next turn at once — before the adapter's own pause runs.
      const { host, threadId } = await runningGoalWithACard(async () => ({
        summary: "Goal paused."
      }));
      await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
      await host.settle();
      assert.deepEqual(order(host), ["goalCommand:pause", "respondToApproval", "interruptTurn"]);
      assert.deepEqual(goalRows(host), [], "the user asked to stop, not for a goal row");
      await host.stop();
    });

    it("a pause that fails still cancels and interrupts, and is only logged", async () => {
      const { host, threadId } = await runningGoalWithACard(async () => {
        throw new Error("cannot update goal");
      });
      await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
      await host.settle();
      assert.deepEqual(order(host), ["goalCommand:pause", "respondToApproval", "interruptTurn"]);
      assert.deepEqual(goalRows(host), []);
      assert.ok(
        host.logger.entries.some(
          (entry) => entry.level === "warn" && /pause/i.test(entry.message)
        ),
        "the failure is logged"
      );
      await host.stop();
    });

    it("a pause that hangs is given up after its deadline, and Stop goes on", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const { host, threadId } = await runningGoalWithACard(
          () => new Promise<GoalCommandResult>(() => undefined)
        );
        await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
        await until(() => callsOf(host, "goalCommand").length === 1);
        assert.deepEqual(order(host), ["goalCommand:pause"], "nothing else until the pause answers");
        mock.timers.tick(AGENT_HOST_DEADLINES.goalPauseMs);
        await host.settle();
        assert.deepEqual(order(host), ["goalCommand:pause", "respondToApproval", "interruptTurn"]);
        assert.deepEqual(goalRows(host), []);
        await host.stop();
      } finally {
        mock.timers.reset();
      }
    });

    it("no pause for a goal that is not continuing, or an adapter without goal commands", async () => {
      const { host, threadId } = await runningGoalWithACard(async () => ({ summary: "" }));
      await pushGoal(host, { goal: { objective: "ship it", status: "paused" }, change: "paused" });
      await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
      await host.settle();
      assert.deepEqual(order(host), ["respondToApproval", "interruptTurn"]);
      await host.stop();

      const claude = createScriptedAdapter({ id: "claude", capabilities: { goals: PROVIDER_GOALS } });
      const other = createTestHost({ adapters: { claude } });
      const claudeThread = await other.createThread();
      await other.orchestrator.command(claudeThread, "turn", { commandId: cmd(), input: "go" });
      await other.settle();
      await pushGoal(other, { goal: { objective: "ship it", status: "active" }, change: "set" });
      await other.orchestrator.command(claudeThread, "interrupt", { commandId: cmd() });
      await other.settle();
      assert.deepEqual(
        claude.calls.filter((call) => call.kind === "interruptTurn").length,
        1,
        "Claude's goal runs inside its turns: a plain interrupt"
      );
      await other.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// §5.5 — a continuing goal survives host restarts and account switches
// ---------------------------------------------------------------------------

describe("goals §5.5 — a continuing goal survives restarts and account switches", () => {
  /** A Codex thread between two of its goal turns: live session, cursor, active goal. */
  async function continuingGoalThread(
    hostOptions: Omit<TestHostOptions, "adapters"> = {}
  ): Promise<{ host: TestHost; threadId: string }> {
    const host = codexHost(undefined, hostOptions);
    const threadId = await host.createThread({
      refId: "codex",
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1"
    });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await host.settle();
    await completeTurn(host, threadId);
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    return { host, threadId };
  }

  const toAcc2 = { accountId: "acc2", home: "account" as const, homePath: "/homes/acc2" };

  describe("the account switch", () => {
    it("is refused while the goal continues, in the host's exact words", async () => {
      const { host, threadId } = await continuingGoalThread();
      await assert.rejects(
        () => host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 }),
        (error: unknown) =>
          isAgentChatCommandError(error) &&
          error.code === "COMMAND_REJECTED" &&
          error.message === "Pause the goal before switching accounts."
      );
      assert.equal(host.store.heads.get(threadId)?.accountId, "acc1", "nothing moved");
      await host.stop();
    });

    it("goes ahead for an active goal whose session is stopped — nothing continues it, and the goal is carried", async () => {
      // Pausing a stopped Codex session would itself resume it and start a
      // goal turn: the switch is the better path, and `carryGoal` re-creates
      // the goal on the new account.
      const { host, threadId } = await continuingGoalThread();
      await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
      await host.settle();
      await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 });
      await host.settle();
      assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
      await host.settle();
      assert.equal(host.adapter.lastStart?.carryGoal, true);
      assert.deepEqual(host.adapter.lastStart?.knownGoal, { objective: "ship it", status: "active" });
      await host.stop();
    });

    it("goes ahead for an active goal on an errored session", async () => {
      const { host, threadId } = await continuingGoalThread();
      await host.orchestrator.ingestionSink(threadId, [
        {
          eventId: "session-error",
          threadId,
          type: "thread.session-set",
          payload: { session: { status: "error", activeTurnId: null, lastError: "boom" } },
          occurredAt: host.clock.nowIso(),
          commandId: null,
          causationEventId: null,
          metadata: {}
        }
      ]);
      await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 });
      assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
      await host.stop();
    });

    it("goes ahead once the goal is paused, and the goal is carried to the new home", async () => {
      const { host, threadId } = await continuingGoalThread();
      await pushGoal(host, { goal: { objective: "ship it", status: "paused" }, change: "paused" });
      await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 });
      await host.settle();
      assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
      await host.settle();
      assert.equal(host.adapter.lastStart?.carryGoal, true);
      assert.deepEqual(host.adapter.lastStart?.knownGoal, { objective: "ship it", status: "paused" });
      await host.stop();
    });

    it("never refuses for a goal the provider does not continue by itself", async () => {
      const claude = createScriptedAdapter({ id: "claude", capabilities: { goals: PROVIDER_GOALS } });
      const host = createTestHost({ adapters: { claude } });
      const threadId = await host.createThread({ accountId: "acc1", homePath: "/homes/acc1" });
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
      await host.settle();
      await completeTurn(host, threadId);
      await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
      await host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 });
      assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
      await host.stop();
    });
  });

  describe("the deploy handover", () => {
    it("marks a continuing goal WITHOUT the project's continuation opt-in", async () => {
      const { host, threadId } = await continuingGoalThread();
      assert.deepEqual(await host.orchestrator.markThreadsForContinuation(), [threadId]);
      const head = host.store.heads.get(threadId);
      assert.equal(head?.resumeGoalAfterRestart, true);
      assert.equal(head?.continueAfterRestart, undefined, "no turn was running to continue");
      await host.stop();
    });

    it("with the opt-in and a turn running, both markers are written", async () => {
      const { host, threadId } = await continuingGoalThread({ continuationEnabled: () => true });
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "more" });
      await host.settle();
      assert.deepEqual(await host.orchestrator.markThreadsForContinuation(), [threadId]);
      const head = host.store.heads.get(threadId);
      assert.equal(head?.resumeGoalAfterRestart, true);
      assert.equal(head?.continueAfterRestart?.turnId, "turn-2");
      await host.stop();
    });

    it("marks nothing for a goal that is not continuing, or that nothing could resume", async () => {
      // Paused.
      const paused = await continuingGoalThread();
      await pushGoal(paused.host, { goal: { objective: "ship it", status: "paused" }, change: "paused" });
      assert.deepEqual(await paused.host.orchestrator.markThreadsForContinuation(), []);
      assert.equal(paused.host.store.heads.get(paused.threadId)?.resumeGoalAfterRestart, undefined);
      await paused.host.stop();

      // No live session: the user stopped it, so nothing is continuing.
      const stopped = await continuingGoalThread();
      await stopped.host.orchestrator.command(stopped.threadId, "session/stop", { commandId: cmd() });
      await stopped.host.settle();
      assert.deepEqual(await stopped.host.orchestrator.markThreadsForContinuation(), []);
      await stopped.host.stop();

      // A provider that does not continue by itself.
      const claude = createScriptedAdapter({ id: "claude", capabilities: { goals: PROVIDER_GOALS } });
      const claudeHost = createTestHost({ adapters: { claude } });
      const claudeThread = await claudeHost.createThread();
      await claudeHost.orchestrator.command(claudeThread, "turn", { commandId: cmd(), input: "work" });
      await claudeHost.settle();
      await completeTurn(claudeHost, claudeThread);
      await pushGoal(claudeHost, { goal: { objective: "ship it", status: "active" }, change: "set" });
      assert.deepEqual(await claudeHost.orchestrator.markThreadsForContinuation(), []);
      await claudeHost.stop();

      // No resume cursor: a live session that has never run a turn.
      const noCursor = codexHost();
      const bare = await noCursor.createThread({ refId: "codex" });
      await noCursor.orchestrator.command(bare, "turn", { commandId: cmd(), input: "/goal ship it" });
      await noCursor.settle();
      await pushGoal(noCursor, { goal: { objective: "ship it", status: "active" }, change: "set" });
      assert.equal(noCursor.adapter.hasSession(bare), true);
      assert.equal(noCursor.store.bindings.get(bare)?.resumeCursor ?? undefined, undefined);
      assert.deepEqual(await noCursor.orchestrator.markThreadsForContinuation(), []);
      await noCursor.stop();
    });

    it("an aborted stop clears the goal marker with the others", async () => {
      const { host, threadId } = await continuingGoalThread();
      const marked = await host.orchestrator.markThreadsForContinuation();
      await host.orchestrator.clearContinuationMarkers(marked);
      assert.equal(host.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
      await host.stop();
    });
  });

  describe("the next boot", () => {
    /** The old host marks and stops; a new host comes up on the same disk. */
    async function handover(nextOptions: {
      failStart?: Error;
      isThreadClosed?: (threadId: string) => boolean;
    } = {}): Promise<{ next: TestHost; threadId: string }> {
      const { host: first, threadId } = await continuingGoalThread();
      await first.orchestrator.markThreadsForContinuation();
      await first.stop();
      const next = codexHost(undefined, {
        store: first.store,
        launchConfigs: first.launchConfigs,
        ...(nextOptions.isThreadClosed ? { isThreadClosed: nextOptions.isThreadClosed } : {})
      });
      if (nextOptions.failStart) {
        next.adapter.failNext("failStartSession", nextOptions.failStart);
      }
      return { next, threadId };
    }

    it("resumes the goal's session WITHOUT a turn, then clears the marker", async () => {
      const { next, threadId } = await handover();
      await next.orchestrator.reconcile();
      await next.settle();

      const starts = callsOf(next, "startSession") as Array<{ resumeCursor?: unknown; knownGoal?: unknown }>;
      assert.equal(starts.length, 1, "the session is back");
      assert.deepEqual(starts[0]?.resumeCursor, { cursor: "turn-1" }, "the same conversation");
      assert.deepEqual(starts[0]?.knownGoal, { objective: "ship it", status: "active" });
      assert.deepEqual(callsOf(next, "sendTurn"), [], "Codex continues the goal by itself");
      assert.equal(next.adapter.hasSession(threadId), true);
      assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
      await next.stop();
    });

    it("a resume that fails is logged, clears the marker, and is never retried", async () => {
      const { next, threadId } = await handover({ failStart: new Error("codex is gone") });
      await next.orchestrator.reconcile();
      await next.settle();
      await next.settle();
      assert.equal(callsOf(next, "startSession").length, 1, "one attempt, no loop");
      assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
      assert.ok(
        next.logger.entries.some((entry) => entry.level === "warn" && /goal/i.test(entry.message)),
        "the failure is logged"
      );
      assert.equal(next.orchestrator.summary(threadId)?.goal?.continuing, false);
      await next.stop();
    });

    it("a closed tab's goal is not resumed", async () => {
      const { next, threadId } = await handover({ isThreadClosed: () => true });
      await next.orchestrator.reconcile();
      await next.settle();
      assert.deepEqual(callsOf(next, "startSession"), [], "no provider child for a tab nobody has");
      assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
      await next.stop();
    });

    it("the summary keeps the goal continuing through the gap — no finished stamp", async () => {
      const { next, threadId } = await handover();
      // The new host has read the thread (the daemon's summary poll does) but
      // resumed nothing yet: no live session, only the marker.
      await next.orchestrator.readThread(threadId);
      assert.equal(next.adapter.hasSession(threadId), false);
      assert.deepEqual(next.orchestrator.summary(threadId)?.goal, {
        objective: "ship it",
        status: "active",
        continuing: true
      });
      await next.orchestrator.reconcile();
      await next.settle();
      assert.equal(next.orchestrator.summary(threadId)?.goal?.continuing, true, "…and after it");
      await next.stop();
    });

    it("an unmarked boot resumes nothing — a crash leaves the goal to the next start", async () => {
      const { host: first, threadId } = await continuingGoalThread();
      await first.stop();
      const next = codexHost(undefined, { store: first.store, launchConfigs: first.launchConfigs });
      await next.orchestrator.reconcile();
      await next.settle();
      assert.deepEqual(callsOf(next, "startSession"), []);
      await next.orchestrator.readThread(threadId);
      assert.equal(next.orchestrator.summary(threadId)?.goal?.continuing, false);
      await next.stop();
    });

    it("the user's own Stop before the resume wins over the marker", async () => {
      const { next, threadId } = await handover();
      await next.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
      await next.settle();
      await next.orchestrator.reconcile();
      await next.settle();
      assert.deepEqual(callsOf(next, "startSession"), []);
      assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
      await next.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------------

/** A session state the provider reported, through the sink as ingestion delivers it. */
async function sessionSet(
  host: TestHost,
  session: { status: "running" | "ready" | "error"; activeTurnId: string | null; lastError?: string },
  threadId = "thread-1"
): Promise<void> {
  goalSeq += 1;
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `session-${goalSeq}`,
      threadId,
      type: "thread.session-set",
      payload: { session },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
}

/** What the provider was asked, in order, around a Stop. */
function stopOrder(host: TestHost): string[] {
  return host.adapter.calls
    .filter((call) => ["goalCommand", "respondToApproval", "interruptTurn"].includes(call.kind))
    .map((call) =>
      call.kind === "goalCommand"
        ? `goalCommand:${(call.detail as HostGoalCommand).kind}`
        : call.kind === "interruptTurn"
          ? `interruptTurn:${String(call.detail)}`
          : call.kind
    );
}

describe("fix round 2 — a Stop that arrives after its turn ended, on a continuing goal", () => {
  /**
   * The user's own turn ended, the goal continues: the Stop the client aimed
   * at that turn arrives after it, so the staleness guard used to drop it —
   * and Codex's next goal turn kept running.
   */
  async function continuingAfterUserTurn(goalStatus: "active" | "paused" = "active"): Promise<{
    host: TestHost;
    threadId: string;
  }> {
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    await completeTurn(host, threadId);
    await pushGoal(host, {
      goal: { objective: "ship it", status: goalStatus },
      change: goalStatus === "active" ? "set" : "paused"
    });
    return { host, threadId };
  }

  it("a provider-started turn is paused AND interrupted, in the normal order", async () => {
    const { host, threadId } = await continuingAfterUserTurn();
    // Codex started its next goal turn by itself: no user message behind it.
    await sessionSet(host, { status: "running", activeTurnId: "codex-goal-2" });
    await openApproval(host, "req-1");
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "turn-1" });
    await host.settle();
    assert.deepEqual(stopOrder(host), [
      "goalCommand:pause",
      "respondToApproval",
      "interruptTurn:codex-goal-2"
    ]);
    await host.stop();
  });

  it("a turn the USER started is still protected: pause only", async () => {
    const { host, threadId } = await continuingAfterUserTurn();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "and this" });
    await host.settle();
    await openApproval(host, "req-1");
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "turn-1" });
    await host.settle();
    assert.deepEqual(stopOrder(host), ["goalCommand:pause"], "the user's new turn runs on");
    await host.stop();
  });

  it("with nothing running, the Stop pauses the goal and interrupts nothing", async () => {
    const { host, threadId } = await continuingAfterUserTurn();
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "turn-1" });
    await host.settle();
    assert.deepEqual(stopOrder(host), ["goalCommand:pause"]);
    assert.ok(
      !activities(host).some((row) => row.activityKind === "provider.turn.interrupt.failed"),
      "no failure row for a turn that is simply over"
    );
    await host.stop();
  });

  it("without a continuing goal, a late Stop behaves exactly as before", async () => {
    // Another turn is running: the Stop is dropped, as the staleness guard says.
    const running = await continuingAfterUserTurn("paused");
    await sessionSet(running.host, { status: "running", activeTurnId: "codex-goal-2" });
    await running.host.orchestrator.command(running.threadId, "interrupt", {
      commandId: cmd(),
      turnId: "turn-1"
    });
    await running.host.settle();
    assert.deepEqual(stopOrder(running.host), []);
    await running.host.stop();

    // Nothing running: the interrupt goes through as it always did.
    const idle = await continuingAfterUserTurn("paused");
    await idle.host.orchestrator.command(idle.threadId, "interrupt", {
      commandId: cmd(),
      turnId: "turn-1"
    });
    await idle.host.settle();
    assert.deepEqual(stopOrder(idle.host), ["interruptTurn:turn-1"]);
    await idle.host.stop();
  });
});

describe("fix round 2 — the boot resume", () => {
  /** A Codex thread whose goal was continuing when the previous host handed over. */
  async function markedHandover(options: { midTurn?: boolean } = {}): Promise<{
    first: TestHost;
    threadId: string;
  }> {
    const first = codexHost();
    const threadId = await first.createThread({
      refId: "codex",
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1"
    });
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await first.settle();
    await completeTurn(first, threadId);
    await pushGoal(first, { goal: { objective: "ship it", status: "active" }, change: "set" });
    if (options.midTurn) {
      // A goal turn Codex started is running when the host is stopped.
      await sessionSet(first, { status: "running", activeTurnId: "codex-goal-2" });
    }
    assert.deepEqual(await first.orchestrator.markThreadsForContinuation(), [threadId]);
    await first.stop();
    return { first, threadId };
  }

  function nextHost(first: TestHost): TestHost {
    return codexHost(undefined, { store: first.store, launchConfigs: first.launchConfigs });
  }

  /** Hold `startSession` open until released; `reached()` once a start is waiting. */
  function gateStart(host: TestHost): { release: () => void; reached: () => boolean } {
    let release: () => void = () => undefined;
    let waiting = false;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const start = host.adapter.startSession.bind(host.adapter);
    host.adapter.startSession = async (input) => {
      waiting = true;
      await gate;
      return start(input);
    };
    return { release, reached: () => waiting };
  }

  it("item 2: a stop that lands while the resume is starting keeps the mark and stops the new child", async () => {
    const { first, threadId } = await markedHandover();
    const next = nextHost(first);
    const start = gateStart(next);
    await next.orchestrator.reconcile();
    await until(start.reached);

    // The host is stopped while the provider child is still starting.
    const stopping = next.orchestrator.stop();
    start.release();
    await stopping;

    assert.equal(next.adapter.hasSession(threadId), false, "no provider child outlives the stop");
    assert.deepEqual(
      next.adapter.calls.map((call) => call.kind).filter((kind) => kind === "startSession" || kind === "stopSession"),
      ["startSession", "stopSession"],
      "the child the resume started was stopped again"
    );
    assert.equal(
      next.store.heads.get(threadId)?.resumeGoalAfterRestart,
      true,
      "the mark is kept for the host after this one"
    );
  });

  it("item 2: a handover that begins before the resume reaches the provider starts nothing, and keeps the mark", async () => {
    const { first, threadId } = await markedHandover();
    const next = nextHost(first);
    await next.orchestrator.reconcile();
    // The /stop route's marking pass runs before the resume got its turn.
    await next.orchestrator.markThreadsForContinuation();
    await next.settle();
    assert.deepEqual(callsOf(next, "startSession"), []);
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, true);
    await next.stop();
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, true, "and still after the stop");
  });

  it("item 2: a handover that begins while the resume is still loading the thread starts nothing", async () => {
    const { first, threadId } = await markedHandover();
    const next = nextHost(first);
    // Hold the thread's load: the resume is past its first check, not yet on
    // the effect queue.
    let releaseLoad: () => void = () => undefined;
    let loading = false;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = () => resolve();
    });
    const loadBinding = next.store.loadBinding.bind(next.store);
    next.store.loadBinding = async (id) => {
      loading = true;
      await loadGate;
      return loadBinding(id);
    };
    await next.orchestrator.reconcile();
    await until(() => loading);
    await next.orchestrator.markThreadsForContinuation();
    releaseLoad();
    await next.settle();
    assert.deepEqual(callsOf(next, "startSession"), [], "the provider is never asked");
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, true);
    await next.stop();
  });

  it("item 2: a start the stop tears down is not a failed resume — the mark is kept", async () => {
    const { first, threadId } = await markedHandover();
    const next = nextHost(first);
    let tearDown: () => void = () => undefined;
    let waiting = false;
    const torn = new Promise<void>((resolve) => {
      tearDown = () => resolve();
    });
    next.adapter.startSession = async () => {
      waiting = true;
      await torn;
      throw new Error("the provider child was stopped while it started");
    };
    await next.orchestrator.reconcile();
    await until(() => waiting);
    const stopping = next.orchestrator.stop();
    tearDown();
    await stopping;
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, true);
    assert.ok(
      !next.logger.entries.some((entry) => /could not resume/.test(entry.message)),
      "not reported as a failed resume"
    );
  });

  it("item 3: a thread that cannot be loaded has its mark cleared — logged, never retried", async () => {
    const { first, threadId } = await markedHandover();
    const next = nextHost(first);
    next.store.readEventsFrom = async () => {
      throw new Error("the log is unreadable");
    };
    await next.orchestrator.reconcile();
    await next.settle();
    await next.settle();
    assert.deepEqual(callsOf(next, "startSession"), []);
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
    assert.ok(
      next.logger.entries.some((entry) => entry.level === "warn" && /goal/i.test(entry.message)),
      "the failure is logged"
    );
    await next.stop();
  });

  it("item 4: a goal turn killed mid-flight keeps `continuing` through the error settle until the resume", async () => {
    // A manual stop mid-turn, no continuation opt-in: the reconcile settles
    // the orphaned turn as an error, but the goal's resume is still owed.
    const { first, threadId } = await markedHandover({ midTurn: true });
    const next = nextHost(first);
    const start = gateStart(next);
    await next.orchestrator.reconcile();
    await until(start.reached);

    const gap = next.orchestrator.summary(threadId);
    assert.equal(gap?.chatSessionStatus, "error", "the orphaned turn was settled");
    assert.deepEqual(gap?.goal, { objective: "ship it", status: "active", continuing: true });

    start.release();
    await next.settle();
    const after = next.orchestrator.summary(threadId);
    assert.equal(after?.chatSessionStatus, "ready", "the resumed session");
    assert.equal(after?.goal?.continuing, true);
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
    await next.stop();
  });

  it("item 4: once the resume has failed, an error is an error again", async () => {
    const { first, threadId } = await markedHandover({ midTurn: true });
    const next = nextHost(first);
    next.adapter.failNext("failStartSession", new Error("codex is gone"));
    await next.orchestrator.reconcile();
    await next.settle();
    const summary = next.orchestrator.summary(threadId);
    assert.equal(summary?.chatSessionStatus, "error");
    assert.equal(summary?.goal?.continuing, false, "no pending mark: the goal masks nothing");
    await next.stop();
  });
});

// ---------------------------------------------------------------------------
// Final fix wave
// ---------------------------------------------------------------------------

describe("final fix wave — `continuing`, the switch, Stop at a boundary, the model, /compact", () => {
  /** A Codex thread between two goal turns: live session, cursor, active goal. */
  async function liveGoal(
    goalCommand?: (threadId: string, command: HostGoalCommand) => Promise<GoalCommandResult>
  ): Promise<{ host: TestHost; threadId: string }> {
    const host = codexHost(goalCommand);
    const threadId = await host.createThread({
      refId: "codex",
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1"
    });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await host.settle();
    await completeTurn(host, threadId);
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    return { host, threadId };
  }

  const continuing = (host: TestHost, threadId = "thread-1"): boolean | undefined =>
    host.orchestrator.summary(threadId)?.goal?.continuing;

  it("item 2: `continuing` lasts the grace past the last turn settling, and flips on read with no event", async () => {
    const { host, threadId } = await liveGoal();
    assert.equal(GOAL_CONTINUATION_GRACE_MS, 60_000);
    assert.equal(continuing(host, threadId), true, "the turn just settled");
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS - 1);
    assert.equal(continuing(host, threadId), true);
    const events = log(host).length;
    host.clock.advance(2);
    assert.equal(continuing(host, threadId), false, "a continuation that never started is not work");
    assert.equal(log(host).length, events, "the summary is recomputed on read — no event");

    // A turn running is continuing whatever the clock says…
    await sessionSet(host, { status: "running", activeTurnId: "codex-goal-2" });
    host.clock.advance(10 * 60_000);
    assert.equal(continuing(host, threadId), true);
    // …and its end opens a fresh grace.
    await sessionSet(host, { status: "ready", activeTurnId: null });
    assert.equal(continuing(host, threadId), true);
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS);
    assert.equal(continuing(host, threadId), false);
    await host.stop();
  });

  it("item 2: a freshly started session is the goal's idle point too", async () => {
    // Codex continues an active goal right after a resume, so a session the
    // host just (re)started opens the grace — the last turn's end may be long past.
    const { host, threadId } = await liveGoal();
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    host.clock.advance(5 * 60_000);
    assert.equal(continuing(host, threadId), false, "no live session");
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal status" });
    await host.settle();
    assert.equal(host.adapter.hasSession(threadId), true);
    assert.equal(continuing(host, threadId), true, "the session just came back");
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS);
    assert.equal(continuing(host, threadId), false);
    await host.stop();
  });

  it("item 2: a pending resume mark keeps the goal continuing whatever the clock says", async () => {
    const { host: first, threadId } = await liveGoal();
    await first.orchestrator.markThreadsForContinuation();
    await first.stop();
    const next = codexHost(undefined, { store: first.store, launchConfigs: first.launchConfigs });
    await next.orchestrator.readThread(threadId);
    next.clock.advance(30 * 60_000);
    assert.equal(continuing(next, threadId), true, "the gap of a slow handover");
    await next.stop();
  });

  it("item 1: the switch is refused only while the goal is continuing — a stale grace lets it through", async () => {
    const { host, threadId } = await liveGoal();
    await assert.rejects(
      () =>
        host.orchestrator.setIdentity(threadId, {
          commandId: cmd(),
          accountId: "acc2",
          home: "account",
          homePath: "/homes/acc2"
        }),
      (error: unknown) =>
        isAgentChatCommandError(error) && error.message === "Pause the goal before switching accounts."
    );
    // The continuation never started: the thread is idle, in the summary's
    // sense and the gate's alike.
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS + 1);
    assert.equal(continuing(host, threadId), false);
    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc2",
      home: "account",
      homePath: "/homes/acc2"
    });
    assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
    await host.stop();
  });

  it("item 3: a Stop whose turn ends during the pause interrupts the provider's next turn instead", async () => {
    // The fold still names the user's turn when the Stop is decided; while the
    // pause is asked, the provider ends it and starts its next goal turn.
    let host: TestHost | undefined;
    ({ host } = await liveGoal(async (_threadId, command) => {
      if (command.kind === "pause" && host !== undefined) {
        await sessionSet(host, { status: "ready", activeTurnId: null });
        await sessionSet(host, { status: "running", activeTurnId: "codex-goal-3" });
      }
      return { summary: "" };
    }));
    const threadId = "thread-1";
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "more" });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.latestTurn?.turnId, "turn-2");
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "turn-2" });
    await host.settle();
    assert.deepEqual(stopOrder(host), ["goalCommand:pause", "interruptTurn:codex-goal-3"]);
    await host.stop();
  });

  it("item 3: a Stop whose turn ends during the pause, with nothing after it, interrupts nothing", async () => {
    let host: TestHost | undefined;
    ({ host } = await liveGoal(async (_threadId, command) => {
      if (command.kind === "pause" && host !== undefined) {
        await sessionSet(host, { status: "ready", activeTurnId: null });
      }
      return { summary: "" };
    }));
    const threadId = "thread-1";
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "more" });
    await host.settle();
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "turn-2" });
    await host.settle();
    assert.deepEqual(stopOrder(host), ["goalCommand:pause"]);
    await host.stop();
  });

  it("item 4: the model picked with a goal command reaches the provider, only when it changed", async () => {
    const { host, threadId } = await liveGoal();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal ship it",
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal",
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();
    assert.deepEqual(host.adapter.goalCommandOptions, [
      { modelSelection: { model: "other-model" } },
      {},
      {}
    ]);
    await host.stop();
  });

  it("the host's own pause never carries a model — only the user's /goal does, and only a changed one", async () => {
    // A `pause` applies a model when handed one (the Codex adapter), so the
    // pause a Stop sends — on the normal path, a late Stop, or a boundary
    // re-read — must never pass one.
    const { host, threadId } = await liveGoal();
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "/goal ship it",
      modelSelection: { model: "other-model" }
    });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" });
    await sessionSet(host, { status: "running", activeTurnId: "codex-goal-2" });
    // The normal path: the Stop names the running turn.
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "codex-goal-2" });
    await host.settle();
    // A late Stop: the goal continues (the provider started another turn).
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "resumed" });
    await sessionSet(host, { status: "running", activeTurnId: "codex-goal-3" });
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "codex-goal-2" });
    await host.settle();
    assert.deepEqual(
      host.adapter.calls
        .filter((call) => call.kind === "goalCommand")
        .map((call) => (call.detail as HostGoalCommand).kind),
      ["set", "pause", "pause"]
    );
    assert.deepEqual(host.adapter.goalCommandOptions, [
      { modelSelection: { model: "other-model" } },
      undefined,
      undefined
    ]);
    await host.stop();
  });

  it("micro-fix: a compaction already running is named first, even under a continuing goal", async () => {
    // Mirrors the account-switch gate: the compaction is the phase that ends
    // by itself, and a goal command would wait for it too.
    const { host, threadId } = await liveGoal();
    assert.equal(continuing(host, threadId), true);
    let releaseCompact: () => void = () => undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = () => resolve();
    });
    const compact = host.adapter.compact.bind(host.adapter);
    host.adapter.compact = async (id: string) => {
      await compactGate;
      return compact(id);
    };
    await host.orchestrator.command(threadId, "compact", { commandId: cmd() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(continuing(host, threadId), true, "the goal still continues");
    await assert.rejects(
      () => host.orchestrator.command(threadId, "compact", { commandId: cmd() }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMPACTION_UNAVAILABLE" &&
        error.message === "Context compaction is unavailable while a provider turn is running."
    );
    releaseCompact();
    await host.settle();

    // The goal alone — a goal turn running, no compaction — still gets the
    // goal advice.
    await sessionSet(host, { status: "running", activeTurnId: "codex-goal-2" });
    await assert.rejects(
      () => host.orchestrator.command(threadId, "compact", { commandId: cmd() }),
      (error: unknown) =>
        isAgentChatCommandError(error) && error.message === "Pause the goal before compacting."
    );
    await host.stop();
  });

  it("item 5: /compact under a continuing goal says to pause the goal", async () => {
    const { host, threadId } = await liveGoal();
    await sessionSet(host, { status: "running", activeTurnId: "codex-goal-2" });
    for (const attempt of [
      () => host.orchestrator.command(threadId, "compact", { commandId: cmd() }),
      () => host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/compact" })
    ]) {
      await assert.rejects(attempt, (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMPACTION_UNAVAILABLE" &&
        error.message === "Pause the goal before compacting."
      );
    }
    await host.stop();

    // Without a goal the advice is the old one.
    const plain = codexHost();
    const plainThread = await plain.createThread({ refId: "codex" });
    await plain.orchestrator.command(plainThread, "turn", { commandId: cmd(), input: "work" });
    await plain.settle();
    await assert.rejects(
      () => plain.orchestrator.command(plainThread, "compact", { commandId: cmd() }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.message === "Context compaction is unavailable while a provider turn is running."
    );
    await plain.stop();
  });
});
