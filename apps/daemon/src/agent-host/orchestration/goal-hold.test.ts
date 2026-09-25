/**
 * Goals §5.7 — a deploy holds a continuing goal between its turns.
 *
 * While the daemon waits on a code-only deploy's drain it renews a lease
 * (`POST /goals/hold` → `holdContinuingGoals`). Under it the host pauses every
 * continuing goal between two of its turns — only once goals are the last
 * thing in the drain's way — marks it `goalHeldForHandover` for the next host,
 * and resumes it itself if the lease runs out with the host still up. The
 * user's own action on a held goal takes the hold back and resumes nothing.
 *
 * Fake adapters only. The Codex stand-in below answers goal commands the way
 * the real one does: the set's own `thread/goal/updated` follows, so the fold
 * reads `paused` once a pause has landed and `active` once a resume has — or
 * trails, and then the stand-in alone knows what it holds (`provider`), which
 * is what a host resume's `onlyIfPaused` asks it.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type {
  AdapterGoalSupport,
  AgentGoalStatus,
  DomainEvent,
  GoalUpdatedPayload,
  RuntimeEvent,
  ThreadActivityItem
} from "@orquester/api/agent-chat";

import { resolveChatActivity } from "../../agent-chat/activity-ladder.ts";
import type { GoalCommandResult, HostGoalCommand } from "../adapter.ts";
import { runtimeEventToActivities } from "../ingestion/activities.ts";
import {
  AGENT_HOST_DEADLINES,
  GOAL_CONTINUATION_GRACE_MS,
  GOAL_HOLD_IDLE_MS,
  GOAL_HOLD_LEASE_MS
} from "../support/deadline.ts";
import { isAgentChatCommandError } from "./errors.ts";
import {
  GOAL_HELD_FOR_UPDATE_KEY,
  GOAL_HELD_FOR_UPDATE_SUMMARY,
  GOAL_RESUME_FAILED_SUMMARY
} from "./orchestrator.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type ScriptedAdapter,
  type TestHost,
  type TestHostOptions
} from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `hold-cmd-${(commandSeq += 1)}`;

/** Codex's capability (goals §4.5). */
const HOST_GOALS: AdapterGoalSupport = {
  command: "host",
  actions: ["pause", "resume", "clear"],
  continuesAcrossTurns: true
};

/** Claude's capability: its goal runs inside one turn. */
const PROVIDER_GOALS: AdapterGoalSupport = {
  command: "provider",
  actions: ["continue", "clear"],
  continuesAcrossTurns: false
};

/** What the Codex stand-in does besides answering — the knobs a test turns. */
interface FakeCodexGoals {
  /** The next pause fails with this. */
  failNextPause: Error | null;
  /** The next pause is answered in these words instead of pausing ("No goal is set."). */
  answerNextPause: string | null;
  /** The next resume is answered in these words instead of resuming. */
  answerNextResume: string | null;
  /**
   * Commands whose own `thread/goal/updated` trails the reply: the fold does
   * not hear of them (a test pushes the update itself, or never).
   */
  trailing: Set<HostGoalCommand["kind"]>;
  /** Runs before the provider answers a command: what happens meanwhile. */
  during: ((command: HostGoalCommand, threadId: string) => Promise<void> | void) | null;
  /**
   * The goal's status as the provider holds it where the fold has not heard
   * of it — a `trailing` command's, or one a test sets — by thread. Every
   * update that reaches the fold (`pushGoal`) forgets it: the two agree again.
   */
  provider: Map<string, AgentGoalStatus>;
}

/** Each stand-in by its host, so an update reaching the fold can reach it too. */
const standIns = new WeakMap<TestHost, FakeCodexGoals>();

/** What a pause or a resume leaves a goal the provider holds as `current`. */
function applied(command: HostGoalCommand, current: AgentGoalStatus | null): AgentGoalStatus | null {
  if (current !== "active" && current !== "paused") return current;
  if (command.kind === "pause") return "paused";
  if (command.kind === "resume") return "active";
  return current;
}

function codexHost(hostOptions: Omit<TestHostOptions, "adapters"> = {}): {
  host: TestHost;
  codex: FakeCodexGoals;
} {
  const codex: FakeCodexGoals = {
    failNextPause: null,
    answerNextPause: null,
    answerNextResume: null,
    trailing: new Set(),
    during: null,
    provider: new Map()
  };
  let host: TestHost | undefined;
  const providerStatus = (threadId: string): AgentGoalStatus | null =>
    codex.provider.get(threadId) ?? host?.orchestrator.summary(threadId)?.goal?.status ?? null;
  const adapter = createScriptedAdapter({
    id: "codex",
    capabilities: { goals: HOST_GOALS },
    goalCommand: async (threadId, command, options): Promise<GoalCommandResult> => {
      await codex.during?.(command, threadId);
      if (command.kind === "pause") {
        const failure = codex.failNextPause;
        codex.failNextPause = null;
        if (failure !== null) throw failure;
        const words = codex.answerNextPause;
        codex.answerNextPause = null;
        if (words !== null) return { summary: words };
      }
      if (command.kind === "resume" && codex.answerNextResume !== null) {
        const words = codex.answerNextResume;
        codex.answerNextResume = null;
        return { summary: words };
      }
      // As the real adapter decides it: on what the provider holds, not the fold.
      if (command.kind === "resume" && options?.onlyIfPaused === true && providerStatus(threadId) !== "paused") {
        return { summary: "", notPaused: true };
      }
      if (host !== undefined) {
        if (codex.trailing.has(command.kind)) {
          const next = applied(command, providerStatus(threadId));
          if (next !== null) codex.provider.set(threadId, next);
        } else {
          await followWithUpdate(host, threadId, command);
          codex.provider.delete(threadId);
        }
      }
      return { summary: "" };
    }
  });
  host = createTestHost({ ...hostOptions, adapters: { codex: adapter } });
  standIns.set(host, codex);
  return { host, codex };
}

/** As Codex does: the set's own `thread/goal/updated` reaches the fold. */
async function followWithUpdate(
  host: TestHost,
  threadId: string,
  command: HostGoalCommand
): Promise<void> {
  const goal = host.orchestrator.summary(threadId)?.goal ?? null;
  if (command.kind === "pause" && goal?.status === "active") {
    await pushGoal(host, { goal: { objective: goal.objective, status: "paused" }, change: "paused" }, threadId);
  } else if (command.kind === "resume" && goal?.status === "paused") {
    await pushGoal(host, { goal: { objective: goal.objective, status: "active" }, change: "resumed" }, threadId);
  } else if (command.kind === "clear" && goal !== null) {
    await pushGoal(
      host,
      { goal: null, change: "cleared", previous: { objective: goal.objective, status: goal.status } },
      threadId
    );
  }
}

let eventSeq = 0;

/** An adapter's `thread.goal.updated`, through the real ingestion mapping (goals §4.3). */
async function pushGoal(host: TestHost, payload: GoalUpdatedPayload, threadId = "thread-1"): Promise<void> {
  standIns.get(host)?.provider.delete(threadId);
  eventSeq += 1;
  const event = {
    eventId: `hold-goal-${eventSeq}`,
    threadId,
    createdAt: host.clock.nowIso(),
    type: "thread.goal.updated",
    payload
  } as RuntimeEvent;
  await host.orchestrator.ingestionSink(
    threadId,
    runtimeEventToActivities(event).map((activity) => ({
      eventId: `ingest-hold-goal-${eventSeq}`,
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

/** The provider finished its turn; the child stays live. */
async function completeTurn(host: TestHost, threadId = "thread-1"): Promise<void> {
  eventSeq += 1;
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `hold-turn-end-${eventSeq}`,
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
 * A Codex thread whose goal CONTINUES: a live session, a resume cursor, an
 * active goal — and, unless `running: false`, the goal's turn still running.
 */
async function continuingGoal(
  host: TestHost,
  options: { threadId?: string; running?: boolean } = {}
): Promise<string> {
  const threadId = await host.createThread({
    threadId: options.threadId ?? "thread-1",
    refId: "codex",
    accountId: "acc1",
    home: "account",
    homePath: "/homes/acc1"
  });
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
  await host.settle();
  await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" }, threadId);
  if (options.running === false) {
    await completeTurn(host, threadId);
  }
  return threadId;
}

/** The goal commands the provider was sent, in order. */
const goalCalls = (adapter: ScriptedAdapter): string[] =>
  adapter.calls
    .filter((call) => call.kind === "goalCommand")
    .map((call) => (call.detail as HostGoalCommand).kind);

const callsOf = (host: TestHost, kind: string): unknown[] =>
  host.adapter.calls.filter((call) => call.kind === kind).map((call) => call.detail);

function activities(host: TestHost, threadId = "thread-1"): ThreadActivityItem[] {
  return (host.store.logs.get(threadId) ?? [])
    .filter((event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
      event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);
}

/** The rows a hold leaves: one `goal.status` info row per hold. */
const heldRows = (host: TestHost, threadId = "thread-1"): ThreadActivityItem[] =>
  activities(host, threadId).filter(
    (row) => row.activityKind === "goal.status" && row.summary === GOAL_HELD_FOR_UPDATE_SUMMARY
  );

/** The rows that take the hold's promise back: the resume did not happen. */
const resumeFailedRows = (host: TestHost, threadId = "thread-1"): ThreadActivityItem[] =>
  activities(host, threadId).filter(
    (row) => row.activityKind === "goal.status" && row.summary === GOAL_RESUME_FAILED_SUMMARY
  );

/** Whether a row carries the hold's payload flag (goals §5.7). */
const flagged = (row: ThreadActivityItem | undefined): boolean =>
  (row?.payload as Record<string, unknown> | undefined)?.[GOAL_HELD_FOR_UPDATE_KEY] === true;

/** Another thread whose own turn keeps the drain waiting: neither held nor holdable. */
async function userTurnElsewhere(host: TestHost, threadId = "thread-other"): Promise<string> {
  if (!host.store.heads.has(threadId)) {
    await host.createThread({ threadId, refId: "codex" });
  }
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "a long refactor" });
  await host.settle();
  return threadId;
}

const heldMark = (host: TestHost, threadId = "thread-1"): true | undefined =>
  host.store.heads.get(threadId)?.goalHeldForHandover;

const continuing = (host: TestHost, threadId = "thread-1"): boolean | undefined =>
  host.orchestrator.summary(threadId)?.goal?.continuing;

/** Move the clock and the timer wheel together, `ms` after `start`. */
function clockFrom(host: TestHost): (ms: number) => Promise<void> {
  const start = host.clock.now().getTime();
  return async (ms: number) => {
    host.clock.set(start + ms);
    host.timers.runDue(ms);
    await host.settle();
  };
}

/** Yield until `done()` holds — never a timed sleep (§9). */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(done(), "the condition never held");
}

const toAcc2 = { accountId: "acc2", home: "account" as const, homePath: "/homes/acc2" };

// ---------------------------------------------------------------------------
// Holding
// ---------------------------------------------------------------------------

describe("goals §5.7 — holding a continuing goal for a deploy", () => {
  it("pauses a goal whose turn is running, marks it at once, says why in one row, and answers its id", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host);
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), [threadId], "its turn holds the drain");

    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);

    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    assert.deepEqual(host.adapter.goalCommandOptions, [undefined], "the Stop's own pause: no model");
    assert.deepEqual(callsOf(host, "interruptTurn"), [], "the running turn finishes as it would have");
    assert.equal(heldMark(host), true, "on meta.json the moment the pause landed");
    const rows = heldRows(host);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tone, "info");
    assert.equal(rows[0]?.summary, GOAL_HELD_FOR_UPDATE_SUMMARY);
    assert.equal(GOAL_HELD_FOR_UPDATE_KEY, "heldForUpdate");
    assert.deepEqual(
      rows[0]?.payload,
      { heldForUpdate: true },
      "flagged, so no reader takes it for a /goal status answer"
    );

    // A renewal keeps it held and pauses nothing twice.
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    assert.equal(heldRows(host).length, 1);
    await host.stop();
  });

  it("the held goal's settled turn reads continuing: no finished stamp, the switch still refused", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host);
    await host.orchestrator.holdContinuingGoals();
    await completeTurn(host, threadId);

    const summary = host.orchestrator.summary(threadId)!;
    assert.equal(summary.chatSessionStatus, "ready");
    assert.equal(summary.latestTurn?.state, "completed");
    assert.deepEqual(
      summary.goal,
      { objective: "ship it", status: "paused", continuing: true },
      "the fold reads paused, yet only the handover keeps it from going on"
    );
    const activity = resolveChatActivity(summary);
    assert.equal(activity.rung, "goal-continuing");
    assert.equal(activity.state, "working");
    assert.equal(activity.attention, null, "no finished stamp, and so no push");
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), [], "while the drain may go ahead");

    // Past the grace too: it waits for a host, not for a continuation.
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS + 1);
    assert.equal(continuing(host, threadId), true);
    await assert.rejects(
      () => host.orchestrator.setIdentity(threadId, { commandId: cmd(), ...toAcc2 }),
      (error: unknown) =>
        isAgentChatCommandError(error) && error.message === "Pause the goal before switching accounts."
    );
    await host.stop();
  });

  it("holds a goal between two of its turns — inside the grace and past it", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), []);
    assert.equal(continuing(host, threadId), true, "Codex is about to start its next turn");
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    await host.stop();

    // The grace is ignored, as at the handover: a late continuation must not slip through.
    const late = codexHost();
    const lateThread = await continuingGoal(late.host, { running: false });
    late.host.clock.advance(GOAL_CONTINUATION_GRACE_MS + 1);
    assert.deepEqual(await late.host.orchestrator.holdContinuingGoals(), [lateThread]);
    await late.host.stop();
  });

  it("holds nothing while another thread's own turn keeps the drain waiting, and holds once it settles", async () => {
    const { host } = codexHost();
    const goalThread = await continuingGoal(host, { threadId: "thread-goal", running: false });
    const userThread = await host.createThread({ threadId: "thread-user", refId: "codex" });
    await host.orchestrator.command(userThread, "turn", { commandId: cmd(), input: "a long refactor" });
    await host.settle();
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), [userThread]);

    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(goalCalls(host.adapter), [], "the deploy waits on that turn anyway: the goal works on");
    assert.equal(heldMark(host, goalThread), undefined);

    await completeTurn(host, userThread);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [goalThread]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    await host.stop();
  });

  it("holds nothing while another thread's background work keeps the drain waiting", async () => {
    const codex = createScriptedAdapter({
      id: "codex",
      capabilities: { goals: HOST_GOALS },
      goalCommand: async () => ({ summary: "" })
    });
    const claude = createScriptedAdapter({ id: "claude" });
    const host = createTestHost({ adapters: { codex, claude } });
    const goalThread = await continuingGoal(host, { threadId: "thread-goal", running: false });
    const fleetThread = await host.createThread({ threadId: "thread-fleet", refId: "claude" });
    const consumed = host.orchestrator.consume(claude);
    const task = (type: "task.started" | "task.completed", status?: string): RuntimeEvent =>
      ({
        eventId: `fleet-${(eventSeq += 1)}`,
        threadId: fleetThread,
        createdAt: host.clock.nowIso(),
        type,
        payload: { taskId: "agent-1", taskType: "subagent", ...(status ? { status } : {}) }
      }) as unknown as RuntimeEvent;

    claude.emit(task("task.started"));
    await until(() => host.orchestrator.backgroundWorkThreadIds().includes(fleetThread));
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(goalCalls(codex), [], "a subagent fleet would leave the goal idle for as long as it runs");

    claude.emit(task("task.completed", "completed"));
    await until(() => host.orchestrator.backgroundWorkThreadIds().length === 0);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [goalThread]);
    await host.stop();
    await consumed;
  });

  it("holds every holdable goal at once, and a thread already held never keeps the others waiting", async () => {
    const { host } = codexHost();
    const running = await continuingGoal(host, { threadId: "thread-a" });
    const between = await continuingGoal(host, { threadId: "thread-b", running: false });
    assert.deepEqual((await host.orchestrator.holdContinuingGoals()).sort(), [running, between]);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "pause"]);
    assert.equal(heldRows(host, running).length, 1);
    assert.equal(heldRows(host, between).length, 1);

    // A goal that starts continuing later is held under the same lease: the
    // held thread whose final turn still runs is no obstacle.
    const later = await continuingGoal(host, { threadId: "thread-c", running: false });
    assert.deepEqual((await host.orchestrator.holdContinuingGoals()).sort(), [running, between, later]);
    await host.stop();
  });

  it("never holds a goal that runs inside its turn (Claude), and that turn keeps every other goal going", async () => {
    const codex = createScriptedAdapter({
      id: "codex",
      capabilities: { goals: HOST_GOALS },
      goalCommand: async () => ({ summary: "" })
    });
    const claude = createScriptedAdapter({ id: "claude", capabilities: { goals: PROVIDER_GOALS } });
    const host = createTestHost({ adapters: { codex, claude } });
    await continuingGoal(host, { threadId: "thread-codex", running: false });
    const claudeThread = await host.createThread({ threadId: "thread-claude", refId: "claude" });
    await host.orchestrator.command(claudeThread, "turn", { commandId: cmd(), input: "/goal ship it" });
    await host.settle();
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "set" }, claudeThread);

    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(goalCalls(codex), []);
    assert.equal(claude.goalCommand, undefined);
    await host.stop();
  });

  it("two requests that overlap pause once and write one row", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host);
    const [first, second] = await Promise.all([
      host.orchestrator.holdContinuingGoals(),
      host.orchestrator.holdContinuingGoals()
    ]);
    assert.deepEqual(first, [threadId]);
    assert.deepEqual(second, [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "decided again on the thread's own queue");
    assert.equal(heldRows(host).length, 1);
    await host.stop();
  });

  it("a pause that fails holds nothing — the mark written before it goes again — and the next renewal retries", async () => {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host);
    codex.failNextPause = new Error("cannot update goal");
    const markWhilePausing: Array<true | undefined> = [];
    codex.during = (command) => {
      if (command.kind === "pause") markWhilePausing.push(heldMark(host));
    };

    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(markWhilePausing, [true], "the mark was on meta.json before the pause was asked");
    assert.equal(heldMark(host), undefined, "and is gone once the pause failed");
    assert.deepEqual(heldRows(host), [], "no row for a pause that did not land");
    assert.equal(continuing(host, threadId), true, "the goal works on");
    assert.ok(
      host.logger.entries.some((entry) => entry.level === "warn" && /hold/.test(entry.message)),
      "the failure is logged"
    );

    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "pause"]);
    assert.equal(heldMark(host), true);
    await host.stop();
  });

  it("a pause the provider answers in words (no goal left to pause) holds nothing", async () => {
    const { host, codex } = codexHost();
    await continuingGoal(host);
    codex.answerNextPause = "No goal is set.";
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.equal(heldMark(host), undefined);
    assert.deepEqual(heldRows(host), []);
    await host.stop();
  });

  it("a pause that hangs is given up after its deadline, holding nothing", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { host, codex } = codexHost();
      await continuingGoal(host);
      codex.during = (command) =>
        command.kind === "pause" ? new Promise<void>(() => undefined) : undefined;
      const holding = host.orchestrator.holdContinuingGoals();
      await until(() => goalCalls(host.adapter).length === 1);
      mock.timers.tick(AGENT_HOST_DEADLINES.goalPauseMs);
      assert.deepEqual(await holding, []);
      assert.equal(heldMark(host), undefined);
      await host.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("holds nothing once the host has begun to stop", async () => {
    const { host } = codexHost();
    await continuingGoal(host);
    await host.orchestrator.markThreadsForContinuation();
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(goalCalls(host.adapter), [], "a pause now would race the teardown");
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe("goals §5.7 — the lease runs out with the host still up", () => {
  it("resumes a held goal that still reads paused, and clears both marks", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    const at = clockFrom(host);

    await at(GOAL_HOLD_LEASE_MS - 1);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "not before the lease has run out");
    assert.equal(heldMark(host), true);

    await at(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined);
    // Its last turn settled two minutes ago; the resume is the idle point
    // Codex continues from, so the goal reads as work until that turn starts.
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "active",
      continuing: true
    });
    assert.equal(heldRows(host).length, 1, "the resume adds no row: the goal's update says it");
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS);
    assert.equal(continuing(host, threadId), false, "a continuation that never starts is not work");
    await host.stop();
  });

  it("a renewal pushes the end back: the timer waits out the remainder", async () => {
    const { host } = codexHost();
    await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    const at = clockFrom(host);
    await at(60_000);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), ["thread-1"]);

    await at(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "renewed 60 s in: 60 s still to go");
    await at(GOAL_HOLD_LEASE_MS + 60_000);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    await host.stop();
  });

  it("resumes nothing for a goal achieved, cleared, blocked or limited during its final turn", async () => {
    const endings: Array<[string, GoalUpdatedPayload]> = [
      ["achieved", { goal: null, change: "achieved", previous: { objective: "ship it", status: "complete" } }],
      ["cleared", { goal: null, change: "cleared", previous: { objective: "ship it", status: "paused" } }],
      ["blocked", { goal: { objective: "ship it", status: "blocked", lastCheck: "no creds" }, change: "blocked" }],
      ["limited", { goal: { objective: "ship it", status: "budget-limited" }, change: "limited" }]
    ];
    for (const [label, ending] of endings) {
      const { host } = codexHost();
      const threadId = await continuingGoal(host);
      await host.orchestrator.holdContinuingGoals();
      await pushGoal(host, ending, threadId);
      await completeTurn(host, threadId);
      assert.notEqual(continuing(host, threadId), true, `${label}: nothing to hold up`);
      const at = clockFrom(host);
      await at(GOAL_HOLD_LEASE_MS);
      assert.deepEqual(goalCalls(host.adapter), ["pause"], `${label}: never set going again`);
      assert.equal(heldMark(host, threadId), undefined, `${label}: the marks go`);
      await host.stop();
    }
  });

  it("a resume that fails says so on the timeline, the marks go anyway, and the goal stays paused", async () => {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    codex.during = (command) => {
      if (command.kind === "resume") throw new Error("codex is gone");
    };
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined);
    assert.deepEqual(host.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "paused",
      continuing: false
    });
    assert.ok(
      host.logger.entries.some((entry) => entry.level === "warn" && /resume/.test(entry.message)),
      "the failure is logged"
    );
    const failed = resumeFailedRows(host);
    assert.equal(failed.length, 1, "the row that promised a resume is taken back");
    assert.equal(failed[0]?.tone, "info");
    assert.ok(flagged(failed[0]), "carries the hold flag");
    await host.stop();
  });

  it("a resume the provider refuses in words puts those words on the timeline", async () => {
    const { host, codex } = codexHost();
    await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    const refusal = "This goal reached its token budget and can't be resumed. Set a new goal or clear it.";
    codex.answerNextResume = refusal;
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    const rows = activities(host).filter((row) => row.summary === refusal);
    assert.equal(rows.length, 1, "the provider's own advice beats a generic one here");
    assert.equal(rows[0]?.activityKind, "goal.status");
    assert.ok(flagged(rows[0]), "carries the hold flag");
    assert.deepEqual(resumeFailedRows(host), []);
    assert.equal(heldMark(host), undefined);
    await host.stop();
  });

  it("the release brings back a provider that died while the goal was held, then resumes it", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    await host.adapter.stopSession(threadId);
    assert.equal(host.adapter.hasSession(threadId), false, "the Codex child is gone");

    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    const starts = callsOf(host, "startSession") as Array<{ resumeCursor?: unknown }>;
    assert.equal(starts.length, 2, "started again, as a /goal command would");
    assert.deepEqual(starts[1]?.resumeCursor, { cursor: "turn-1" }, "the same conversation");
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "active");
    assert.deepEqual(resumeFailedRows(host), []);
    await host.stop();
  });

  it("a held session that cannot be brought back is a failed resume, said on the timeline", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    await host.adapter.stopSession(threadId);
    host.adapter.failNext("failStartSession", new Error("codex is not installed"));

    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "nothing to send a resume to");
    assert.equal(resumeFailedRows(host).length, 1);
    assert.equal(heldMark(host), undefined);
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "paused");
    await host.stop();
  });

  it("the release starts no session for a goal that ended meanwhile", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    await host.adapter.stopSession(threadId);
    await pushGoal(host, { goal: null, change: "cleared", previous: { objective: "ship it", status: "paused" } }, threadId);
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.equal(callsOf(host, "startSession").length, 1, "no child for a goal nothing will resume");
    assert.equal(heldMark(host), undefined);
    await host.stop();
  });

  it("a session the release starts after a stop began is stopped again, and the mark is kept", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    await host.adapter.stopSession(threadId);
    let release: () => void = () => undefined;
    let starting = false;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const start = host.adapter.startSession.bind(host.adapter);
    host.adapter.startSession = async (input) => {
      starting = true;
      await gate;
      return start(input);
    };
    host.clock.advance(GOAL_HOLD_LEASE_MS);
    host.timers.runDue(GOAL_HOLD_LEASE_MS);
    await until(() => starting);
    // The handover begins while the provider child is starting.
    const marking = host.orchestrator.markThreadsForContinuation();
    release();
    await marking;
    await host.settle();
    assert.equal(host.adapter.hasSession(threadId), false, "no child outlives the stop");
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "never a resume under a stopping host");
    assert.equal(heldMark(host), true, "the next host owes it");
    assert.deepEqual(resumeFailedRows(host), [], "no failure: the next host resumes it");
    await host.stop();
  });

  it("a hold that lands after the lease ran out is released at once", async () => {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => {
      land = () => resolve();
    });
    codex.during = (command) => (command.kind === "pause" ? landed : undefined);
    const holding = host.orchestrator.holdContinuingGoals();
    await until(() => goalCalls(host.adapter).length === 1);
    // The daemon stopped asking while the provider still had the pause.
    host.clock.advance(GOAL_HOLD_LEASE_MS);
    host.timers.runDue(GOAL_HOLD_LEASE_MS);
    land();
    await holding;
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined);
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "active");
    await host.stop();
  });

  it("…even while the pause's own update trails: the release asks the provider, which holds the goal paused", async () => {
    // Codex's update of a set trails its reply (fixtures README observation
    // 20): the release runs right behind the pause, before the fold reads
    // `paused` — and the fold's `active` must not pass for a goal going on.
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    codex.trailing.add("pause");
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => {
      land = () => resolve();
    });
    codex.during = (command) => (command.kind === "pause" ? landed : undefined);
    const holding = host.orchestrator.holdContinuingGoals();
    await until(() => goalCalls(host.adapter).length === 1);
    host.clock.advance(GOAL_HOLD_LEASE_MS);
    host.timers.runDue(GOAL_HOLD_LEASE_MS);
    land();
    await holding;
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "active", "the fold never heard of the pause");
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"], "resumed all the same");
    assert.deepEqual(host.adapter.goalCommandOptions.at(-1), { onlyIfPaused: true });
    assert.equal(codex.provider.get(threadId), undefined, "the provider holds it going again");
    assert.equal(heldMark(host), undefined);
    assert.deepEqual(resumeFailedRows(host), []);
    assert.equal(continuing(host, threadId), true);
    await host.stop();
  });

  it("a stop that cuts the hold's pause short keeps the thread held; aborted, the lease's end asks the provider", async () => {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    let marking: Promise<string[]> | undefined;
    codex.during = (command, id) => {
      if (command.kind !== "pause") return;
      // The request reached Codex, which paused the goal — and the stop's
      // teardown closes the connection before the reply is read.
      codex.provider.set(id, "paused");
      marking = host.orchestrator.markThreadsForContinuation();
      throw new Error("the provider connection closed");
    };
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId], "counted as held");
    const marked = (await marking) ?? [];
    assert.equal(heldMark(host), true, "the mark stays: the pause may have landed");
    assert.deepEqual(heldRows(host), [], "no row: nobody knows whether it did");

    codex.during = null;
    await host.orchestrator.clearContinuationMarkers(marked);
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.deepEqual(host.adapter.goalCommandOptions.at(-1), { onlyIfPaused: true });
    assert.equal(codex.provider.get(threadId), undefined, "going again");
    assert.equal(heldMark(host), undefined);
    await host.stop();
  });

  it("a release still queued when a stop begins resumes nothing and keeps the mark", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    // The thread's effect queue is busy — the user's next message is being
    // sent — when the lease runs out, so the release waits behind it.
    let sent: () => void = () => undefined;
    let sending = false;
    const sendGate = new Promise<void>((resolve) => {
      sent = () => resolve();
    });
    const sendTurn = host.adapter.sendTurn.bind(host.adapter);
    host.adapter.sendTurn = async (input) => {
      sending = true;
      await sendGate;
      return sendTurn(input);
    };
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "one more thing" });
    await until(() => sending);
    host.clock.advance(GOAL_HOLD_LEASE_MS);
    host.timers.runDue(GOAL_HOLD_LEASE_MS);
    // …and the handover begins before it gets its turn — with the Codex child
    // already gone, so a release that ran anyway would start a new one.
    await host.orchestrator.markThreadsForContinuation();
    await host.adapter.stopSession(threadId);
    sent();
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "the next host owes the resume");
    assert.equal(callsOf(host, "startSession").length, 1, "no child is started while the host stops");
    assert.equal(heldMark(host), true);
    await host.stop();
    assert.equal(heldMark(host), true, "and the stop's own head saves carry it");
  });

  it("a stop that begins while the provider answers the release keeps the mark", async () => {
    const { host, codex } = codexHost();
    await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    let marking: Promise<string[]> | undefined;
    codex.during = (command) => {
      if (command.kind === "resume") marking = host.orchestrator.markThreadsForContinuation();
    };
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    await marking;
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), true, "the session is the one the stop kills: the next host owes it");
    await host.stop();
    assert.equal(heldMark(host), true);
  });

  it("a stop under way suspends the lease; an aborted stop brings it back", async () => {
    const { host } = codexHost();
    await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    const marked = await host.orchestrator.markThreadsForContinuation();
    assert.equal(heldMark(host), true, "the handover leaves the hold's mark as it is");

    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "the next host owes the resume, not this one");
    assert.equal(heldMark(host), true);

    // The stop is aborted: this host lives on, and the lease that ran out
    // meanwhile is released at once.
    await host.orchestrator.clearContinuationMarkers(marked);
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined);
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// The user wins
// ---------------------------------------------------------------------------

describe("goals §5.7 — the user's own action takes a hold back", () => {
  async function held(options: { running?: boolean } = {}): Promise<{
    host: TestHost;
    codex: FakeCodexGoals;
    threadId: string;
  }> {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, options);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    return { host, codex, threadId };
  }

  it("/goal pause: the hold goes, nothing is resumed, and the goal stays paused", async () => {
    const { host, threadId } = await held({ running: false });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "pause"], "the command ran as usual");
    assert.equal(heldMark(host), undefined);
    assert.equal(continuing(host, threadId), false, "a paused goal of the user's own");
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "pause"], "the lease's end resumes nothing");
    await host.stop();
  });

  it("/goal resume: the goal goes again, renewals leave it alone, and a new lease holds it", async () => {
    const { host, threadId } = await held({ running: false });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal resume" });
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined);
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "active");

    // For the rest of this lease the drain waits for it, as before holds existed.
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);

    // Once the lease has run out, the user's word is forgotten with it.
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume", "pause"]);
    await host.stop();
  });

  it("a Stop: the hold goes, and the Stop is an ordinary interrupt of the turn it names", async () => {
    const { host, threadId } = await held();
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd(), turnId: "turn-1" });
    await host.settle();
    assert.deepEqual(callsOf(host, "interruptTurn"), ["turn-1"]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "no second pause: the goal is paused already");
    assert.equal(heldMark(host), undefined);

    // Not held again under this lease, even should the goal go again.
    await pushGoal(host, { goal: { objective: "ship it", status: "active" }, change: "resumed" }, threadId);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    await host.stop();
  });

  it("a session stop: the hold goes with the session, and nothing is resumed", async () => {
    const { host, threadId } = await held({ running: false });
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    assert.equal(host.adapter.hasSession(threadId), false);
    assert.equal(heldMark(host), undefined);
    assert.equal(host.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
    assert.equal(continuing(host, threadId), false);
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    await host.stop();
  });

  it("deleting the thread: nothing is held any more, and nothing is resumed", async () => {
    const { host, threadId } = await held({ running: false });
    await host.orchestrator.deleteThread(threadId);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    await host.stop();
  });

  it("/goal status reads the goal and keeps the hold: a read must not cancel the promised resume", async () => {
    const { host, threadId } = await held({ running: false });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal status" });
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "status"]);
    assert.equal(heldMark(host), true);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    await clockFrom(host)(GOAL_HOLD_LEASE_MS * 2);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "status", "resume"]);
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// The handover and the next host
// ---------------------------------------------------------------------------

describe("goals §5.7 — the handover, and the next host", () => {
  /**
   * The old host holds the goal while its turn runs, the turn settles, the
   * drain goes ahead and the handover stops the host. `finalTurn` is what the
   * goal did during that last turn, if anything.
   */
  async function heldThenHandedOver(finalTurn?: GoalUpdatedPayload): Promise<{
    first: TestHost;
    threadId: string;
  }> {
    const { host: first } = codexHost();
    const threadId = await continuingGoal(first);
    assert.deepEqual(await first.orchestrator.holdContinuingGoals(), [threadId]);
    if (finalTurn !== undefined) {
      await pushGoal(first, finalTurn, threadId);
    }
    await completeTurn(first, threadId);
    assert.deepEqual(first.orchestrator.activeTurnThreadIds(), [], "the drain goes ahead");
    await first.orchestrator.markThreadsForContinuation();
    await first.stop();
    return { first, threadId };
  }

  const nextHost = (first: TestHost, options: { openGate?: boolean } = {}): ReturnType<typeof codexHost> =>
    codexHost({ store: first.store, launchConfigs: first.launchConfigs, ...options });

  const providerOrder = (host: TestHost): string[] =>
    host.adapter.calls
      .map((call) =>
        call.kind === "goalCommand" ? `goalCommand:${(call.detail as HostGoalCommand).kind}` : call.kind
      )
      .filter((kind) => kind === "startSession" || kind === "sendTurn" || kind.startsWith("goalCommand"));

  it("the handover keeps the mark, which the stop's head saves carry", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const head = first.store.heads.get(threadId);
    assert.equal(head?.goalHeldForHandover, true);
    assert.equal(head?.resumeGoalAfterRestart, undefined, "the goal no longer continues: the hold's mark is the one");
    assert.deepEqual(goalCalls(first.adapter), ["pause"], "a stopping host never releases");
  });

  it("the next host resumes nothing before its gate opens: never on the readiness path", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first, { openGate: false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), [], "the reconcile only collects it");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, true, "still owed");
    next.orchestrator.openGate();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"]);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("the next host resumes the session, THEN the goal — and clears both marks", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first);
    // Loaded but not resumed yet: the gap reads as work, not as finished.
    await next.orchestrator.readThread(threadId);
    assert.equal(next.adapter.hasSession(threadId), false);
    assert.deepEqual(next.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "paused",
      continuing: true
    });

    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"], "never a turn");
    assert.deepEqual(next.adapter.goalCommandOptions, [{ onlyIfPaused: true }]);
    const start = next.adapter.lastStart;
    assert.deepEqual(start?.resumeCursor, { cursor: "turn-1" }, "the same conversation");
    assert.deepEqual(start?.knownGoal, { objective: "ship it", status: "paused" });
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
    assert.deepEqual(next.orchestrator.summary(threadId)?.goal, {
      objective: "ship it",
      status: "active",
      continuing: true
    }, "going again, inside the resumed session's grace");
    await next.stop();
  });

  it("…and resumes only the session when the goal no longer reads paused", async () => {
    const endings: GoalUpdatedPayload[] = [
      { goal: null, change: "achieved", previous: { objective: "ship it", status: "complete" } },
      { goal: { objective: "ship it", status: "blocked" }, change: "blocked" }
    ];
    for (const ending of endings) {
      const { first, threadId } = await heldThenHandedOver(ending);
      const { host: next } = nextHost(first);
      await next.orchestrator.reconcile();
      await next.settle();
      assert.deepEqual(providerOrder(next), ["startSession"], ending.change);
      assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined, ending.change);
      await next.stop();
    }
  });

  /** Hold `startSession` open until released; `reached()` once a start waits. */
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

  it("keeps the mark when its own stop cuts the session resume short", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first);
    const start = gateStart(next);
    await next.orchestrator.reconcile();
    await until(start.reached);
    const stopping = next.orchestrator.stop();
    start.release();
    await stopping;
    assert.equal(next.adapter.hasSession(threadId), false, "no provider child outlives the stop");
    assert.deepEqual(goalCalls(next.adapter), [], "the goal is not set going under a stopping host");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, true, "the host after this one owes it");
  });

  it("keeps the mark when a stop begins while the goal's resume is answered", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next, codex } = nextHost(first);
    let marking: Promise<string[]> | undefined;
    codex.during = (command) => {
      // The /stop route's marking pass begins while the provider answers.
      if (command.kind === "resume") marking = next.orchestrator.markThreadsForContinuation();
    };
    await next.orchestrator.reconcile();
    await next.settle();
    await marking;
    assert.deepEqual(goalCalls(next.adapter), ["resume"]);
    assert.equal(next.adapter.hasSession(threadId), false, "the session it started is stopped again");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, true);
    await next.stop();
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, true, "and still after the stop");
  });

  it("a crash while holding leaves the mark, and the next host resumes the goal all the same", async () => {
    // No handover at all: the host dies mid-turn with the goal held.
    const { host: first } = codexHost();
    const threadId = await continuingGoal(first);
    await first.orchestrator.holdContinuingGoals();
    assert.equal(first.store.heads.get(threadId)?.goalHeldForHandover, true, "written at the pause, not at a stop");

    const { host: next } = nextHost(first);
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"]);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    assert.equal(next.orchestrator.summary(threadId)?.goal?.status, "active");
    await next.stop();
  });

  it("a crash after the final turn settled is found off meta.json alone, and resumed the same way", async () => {
    const { host: first } = codexHost();
    const threadId = await continuingGoal(first);
    await first.orchestrator.holdContinuingGoals();
    await completeTurn(first, threadId);

    const { host: next } = nextHost(first);
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"]);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("the user's own goal command before the boot's resume wins over the mark", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first);
    await next.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await next.settle();
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(goalCalls(next.adapter), ["pause"], "the paused goal is not set going behind the user's back");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("the user's own session stop before the boot's resume clears the mark", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first);
    await next.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await next.settle();
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), []);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("a thread that cannot be loaded has both marks cleared off meta.json", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first);
    next.store.readEventsFrom = async () => {
      throw new Error("the log is unreadable");
    };
    await next.orchestrator.reconcile();
    await next.settle();
    await next.settle();
    assert.deepEqual(providerOrder(next), []);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("a goal resume that fails on the next host takes the hold's promise back on the timeline", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next, codex } = nextHost(first);
    codex.during = (command) => {
      if (command.kind === "resume") throw new Error("cannot update goal");
    };
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"]);
    const failed = resumeFailedRows(next, threadId);
    assert.equal(failed.length, 1);
    assert.ok(flagged(failed[0]), "carries the hold flag");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined, "cleared, as §5.5 clears its own");
    assert.equal(next.orchestrator.summary(threadId)?.goal?.status, "paused");
    await next.stop();
  });

  it("a held goal whose session the next host cannot start says so too", async () => {
    const { first, threadId } = await heldThenHandedOver();
    const { host: next } = nextHost(first);
    next.adapter.failNext("failStartSession", new Error("codex is gone"));
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(goalCalls(next.adapter), [], "no session to send a resume to");
    assert.equal(resumeFailedRows(next, threadId).length, 1);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("a §5.5 resume that fails writes no such row: only a held goal was promised one", async () => {
    // A continuing goal handed over WITHOUT a hold (a manual stop): its mark is
    // `resumeGoalAfterRestart`, and no row ever promised it anything.
    const { host: first } = codexHost();
    const threadId = await continuingGoal(first, { running: false });
    await first.orchestrator.markThreadsForContinuation();
    await first.stop();
    assert.equal(first.store.heads.get(threadId)?.resumeGoalAfterRestart, true);
    const { host: next } = nextHost(first);
    next.adapter.failNext("failStartSession", new Error("codex is gone"));
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(resumeFailedRows(next, threadId), []);
    await next.stop();
  });

  it("a pause whose update never reached the old host: the next host asks Codex, which holds the goal paused", async () => {
    // The old host stopped between the pause's reply and its update, so its
    // log still says `active` (the handover marks the goal for §5.5 too).
    const { host: first, codex } = codexHost();
    const threadId = await continuingGoal(first, { running: false });
    codex.trailing.add("pause");
    assert.deepEqual(await first.orchestrator.holdContinuingGoals(), [threadId]);
    await first.orchestrator.markThreadsForContinuation();
    await first.stop();
    assert.equal(first.store.heads.get(threadId)?.goalHeldForHandover, true);

    const { host: next, codex: nextCodex } = nextHost(first);
    nextCodex.provider.set(threadId, "paused");
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"]);
    assert.deepEqual(next.adapter.goalCommandOptions, [{ onlyIfPaused: true }]);
    assert.equal(nextCodex.provider.get(threadId), undefined, "going again");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    assert.equal(next.store.heads.get(threadId)?.resumeGoalAfterRestart, undefined);
    assert.deepEqual(resumeFailedRows(next, threadId), []);
    await next.stop();
  });

  it("a stop that cuts the hold's pause short hands the mark over, and the next host asks Codex", async () => {
    const { host: first, codex } = codexHost();
    const threadId = await continuingGoal(first, { running: false });
    let marking: Promise<string[]> | undefined;
    codex.during = (command, id) => {
      if (command.kind !== "pause") return;
      codex.provider.set(id, "paused");
      marking = first.orchestrator.markThreadsForContinuation();
      throw new Error("the provider connection closed");
    };
    await first.orchestrator.holdContinuingGoals();
    await marking;
    await first.stop();
    assert.equal(first.store.heads.get(threadId)?.goalHeldForHandover, true, "carried by the stop's saves");

    const { host: next, codex: nextCodex } = nextHost(first);
    nextCodex.provider.set(threadId, "paused");
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"]);
    assert.equal(nextCodex.provider.get(threadId), undefined, "going again");
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
    await next.stop();
  });

  it("a crash after the mark but before the pause leaves a mark the next host clears safely", async () => {
    // The hold writes its mark FIRST: a host that dies between it and the
    // pause leaves a mark on a goal Codex still runs. The next host resumes
    // the session and asks Codex to resume the goal only if it holds it
    // paused — it does not: nothing is set, Codex continues the goal by
    // itself — and clears the mark.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { host: first, codex } = codexHost();
      const threadId = await continuingGoal(first, { running: false });
      codex.during = (command) =>
        command.kind === "pause" ? new Promise<void>(() => undefined) : undefined;
      void first.orchestrator.holdContinuingGoals();
      await until(() => goalCalls(first.adapter).length === 1);
      // The host dies here: the pause never reached Codex.
      assert.equal(first.store.heads.get(threadId)?.goalHeldForHandover, true);

      const { host: next } = nextHost(first);
      await next.orchestrator.reconcile();
      await next.settle();
      assert.deepEqual(providerOrder(next), ["startSession", "goalCommand:resume"], "the session comes back, and Codex is asked");
      assert.deepEqual(next.adapter.goalCommandOptions, [{ onlyIfPaused: true }], "only if it holds the goal paused");
      assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined);
      assert.deepEqual(resumeFailedRows(next, threadId), [], "nothing failed");
      assert.deepEqual(next.orchestrator.summary(threadId)?.goal, {
        objective: "ship it",
        status: "active",
        continuing: true
      });
      await next.stop();
    } finally {
      mock.timers.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// Review round — the bounds and races of a hold
// ---------------------------------------------------------------------------

describe("goals §5.7 — a held goal idle behind other work is let go of", () => {
  /**
   * A goal held between its turns while goals were the last thing in the
   * way — then another thread's own turn starts, and the daemon keeps
   * renewing. `at(ms)` is a renewal `ms` after that other work began.
   */
  async function heldBehindOtherWork(): Promise<{
    host: TestHost;
    threadId: string;
    other: string;
    at: (ms: number) => Promise<string[]>;
    setClock: (ms: number) => void;
  }> {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { threadId: "thread-goal", running: false });
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    const other = await userTurnElsewhere(host);
    const start = host.clock.now().getTime();
    const setClock = (ms: number): void => host.clock.set(start + ms);
    const at = async (ms: number): Promise<string[]> => {
      setClock(ms);
      const held = await host.orchestrator.holdContinuingGoals();
      await host.settle();
      return held;
    };
    return { host, threadId, other, at, setClock };
  }

  it("is let go of after GOAL_HOLD_IDLE_MS behind other work — not before — and held again once goals are last", async () => {
    assert.equal(GOAL_HOLD_IDLE_MS, 3 * 60_000);
    const { host, threadId, other, at } = await heldBehindOtherWork();
    assert.deepEqual(await at(0), [threadId], "its idle clock starts");
    assert.deepEqual(await at(GOAL_HOLD_IDLE_MS - 1), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"], "a short wait causes no pause/resume churn");

    await at(GOAL_HOLD_IDLE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"], "let go of: the goal goes on");
    assert.equal(heldMark(host, threadId), undefined, "both marks go, as at the lease's end");
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "active");
    assert.deepEqual(await at(GOAL_HOLD_IDLE_MS + 1), [], "not held again while the other work runs");

    // A HOST release bars nothing: goals the last thing in the way again, it is held again.
    await completeTurn(host, other);
    assert.deepEqual(await at(GOAL_HOLD_IDLE_MS + 2), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume", "pause"]);
    assert.equal(heldRows(host, threadId).length, 2);
    await host.stop();
  });

  it("its clock restarts when the held thread runs a turn of its own", async () => {
    const { host, threadId, at, setClock } = await heldBehindOtherWork();
    await at(0);
    // Halfway, the user sends the held thread a quick message, answered
    // between two renewals.
    setClock(GOAL_HOLD_IDLE_MS / 2);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "quick question" });
    await host.settle();
    await completeTurn(host, threadId);
    assert.deepEqual(await at(GOAL_HOLD_IDLE_MS), [threadId], "idle only since that turn settled");
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);

    // A turn still running at a renewal has no clock at all.
    setClock(GOAL_HOLD_IDLE_MS + 1000);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "and another" });
    await host.settle();
    assert.deepEqual(await at(2 * GOAL_HOLD_IDLE_MS), [threadId]);
    await completeTurn(host, threadId);
    assert.deepEqual(await at(2 * GOAL_HOLD_IDLE_MS + 1), [threadId], "starts afresh here");
    assert.deepEqual(await at(3 * GOAL_HOLD_IDLE_MS), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    await at(3 * GOAL_HOLD_IDLE_MS + 1);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    await host.stop();
  });

  it("its clock resets whenever nothing but goals is in the way", async () => {
    const { host, threadId, other, at } = await heldBehindOtherWork();
    await at(0);
    await completeTurn(host, other);
    assert.deepEqual(await at(GOAL_HOLD_IDLE_MS - 1), [threadId], "nothing else in the way: clocks cleared");
    await userTurnElsewhere(host, other);
    assert.deepEqual(await at(GOAL_HOLD_IDLE_MS), [threadId], "counted afresh from here");
    assert.deepEqual(await at(2 * GOAL_HOLD_IDLE_MS - 1), [threadId]);
    assert.deepEqual(goalCalls(host.adapter), ["pause"]);
    await at(2 * GOAL_HOLD_IDLE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    await host.stop();
  });

  it("a thread's OWN background work is in the way: nothing new is held, and a held goal is let go of", async () => {
    const { host } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    const consumed = host.orchestrator.consume(host.adapter);
    const task = (taskId: string, type: "task.started" | "task.completed"): RuntimeEvent =>
      ({
        eventId: `own-bg-${(eventSeq += 1)}`,
        threadId,
        createdAt: host.clock.nowIso(),
        type,
        payload: {
          taskId,
          taskType: "subagent",
          ...(type === "task.completed" ? { status: "completed" } : {})
        }
      }) as unknown as RuntimeEvent;

    // Holdable, but its own background work runs on: a hold would not end it.
    host.adapter.emit(task("agent-1", "task.started"));
    await until(() => host.orchestrator.backgroundWorkThreadIds().includes(threadId));
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    assert.deepEqual(goalCalls(host.adapter), []);
    host.adapter.emit(task("agent-1", "task.completed"));
    await until(() => host.orchestrator.backgroundWorkThreadIds().length === 0);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);

    // Held, then its own background work starts: the goal idles behind it.
    host.adapter.emit(task("agent-2", "task.started"));
    await until(() => host.orchestrator.backgroundWorkThreadIds().includes(threadId));
    const start = host.clock.now().getTime();
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId]);
    host.clock.set(start + GOAL_HOLD_IDLE_MS);
    await host.orchestrator.holdContinuingGoals();
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined);
    await host.stop();
    await consumed;
  });
});

describe("goals §5.7 — races between the user and a hold", () => {
  it("a user pause racing a hold queued behind it wins: the hold does nothing", async () => {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { threadId: "thread-goal", running: false });
    const other = await userTurnElsewhere(host);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [], "the lease runs, the other turn in the way");

    // The goal thread's effect queue is busy — the user's next message is
    // being sent — when the user pauses the goal; Codex's own `paused` update
    // will trail the reply.
    let sent: () => void = () => undefined;
    let sending = false;
    const sendGate = new Promise<void>((resolve) => {
      sent = () => resolve();
    });
    const sendTurn = host.adapter.sendTurn.bind(host.adapter);
    host.adapter.sendTurn = async (input) => {
      if (input.threadId === threadId) {
        sending = true;
        await sendGate;
      }
      return sendTurn(input);
    };
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "one more thing" });
    await until(() => sending);
    codex.trailing.add("pause");
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });

    // The other turn settles, and the next renewal decides on a fold that
    // still reads `active`: a hold is queued BEHIND the user's pause.
    eventSeq += 1;
    await host.orchestrator.ingestionSink(other, [
      {
        eventId: `race-turn-end-${eventSeq}`,
        threadId: other,
        type: "thread.session-set",
        payload: { session: { status: "ready", activeTurnId: null } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    const holding = host.orchestrator.holdContinuingGoals();
    sent();
    assert.deepEqual(await holding, []);
    await host.settle();

    assert.deepEqual(goalCalls(host.adapter), ["pause"], "the user's own pause, and no other");
    assert.equal(heldMark(host, threadId), undefined);
    assert.deepEqual(heldRows(host, threadId), [], "no promise to resume a goal the user paused");
    // The trailing update lands: the goal is the user's, paused, and stays so.
    await pushGoal(host, { goal: { objective: "ship it", status: "paused" }, change: "paused" }, threadId);
    assert.equal(continuing(host, threadId), false);
    assert.deepEqual(await host.orchestrator.holdContinuingGoals(), []);
    await host.stop();
  });

  it("a pause that lands after its deadline is adopted as a hold — mark, then row", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { host, codex } = codexHost();
      const threadId = await continuingGoal(host, { running: false });
      let land: () => void = () => undefined;
      const landed = new Promise<void>((resolve) => {
        land = () => resolve();
      });
      codex.during = (command) => (command.kind === "pause" ? landed : undefined);
      const holding = host.orchestrator.holdContinuingGoals();
      await until(() => goalCalls(host.adapter).length === 1);
      mock.timers.tick(AGENT_HOST_DEADLINES.goalPauseMs);
      assert.deepEqual(await holding, [], "given up on in time");
      assert.equal(heldMark(host), undefined, "and its mark with it");

      // Codex answers after all: a goal it paused must not be left unmarked.
      land();
      await until(() => heldMark(host) === true);
      await host.settle();
      assert.equal(heldRows(host).length, 1);
      assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "paused");
      assert.deepEqual(await host.orchestrator.holdContinuingGoals(), [threadId], "held after all");
      await host.stop();
    } finally {
      mock.timers.reset();
    }
  });
});

describe("goals §5.7 — no finished window after the host resumes a held goal", () => {
  /** A held goal the lease's end resumes, Codex's own `active` update still on its way. */
  async function resumedWithUpdateTrailing(): Promise<{ host: TestHost; threadId: string }> {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.holdContinuingGoals();
    codex.trailing.add("resume");
    await clockFrom(host)(GOAL_HOLD_LEASE_MS);
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume"]);
    assert.equal(heldMark(host), undefined, "the marks are gone");
    return { host, threadId };
  }

  it("reads continuing while the fold still says paused — no finished stamp, no push", async () => {
    const { host, threadId } = await resumedWithUpdateTrailing();
    const summary = host.orchestrator.summary(threadId)!;
    assert.deepEqual(summary.goal, { objective: "ship it", status: "paused", continuing: true });
    const activity = resolveChatActivity(summary);
    assert.equal(activity.rung, "goal-continuing");
    assert.equal(activity.attention, null);
    // …and only through the grace: an update that never comes is not work forever.
    host.clock.advance(GOAL_CONTINUATION_GRACE_MS);
    assert.equal(continuing(host, threadId), false);
    await host.stop();
  });

  it("a Stop in that moment still pauses the goal: Codex would start its next turn once its update lands", async () => {
    const { host, threadId } = await resumedWithUpdateTrailing();
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume", "pause"]);
    assert.equal(continuing(host, threadId), false);
    await host.stop();
  });

  it("the user's own /goal resume opens the same moment: working, and a Stop in it pauses", async () => {
    const { host, codex } = codexHost();
    const threadId = await continuingGoal(host, { running: false });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal pause" });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.goal?.status, "paused");
    codex.trailing.add("resume");
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "/goal resume" });
    await host.settle();
    assert.deepEqual(
      host.orchestrator.summary(threadId)?.goal,
      { objective: "ship it", status: "paused", continuing: true },
      "Codex's own update is still on its way"
    );
    await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
    await host.settle();
    assert.deepEqual(goalCalls(host.adapter), ["pause", "resume", "pause"]);
    assert.equal(continuing(host, threadId), false);
    await host.stop();
  });

  it("the user's own pause, or a Stop, right after ends it", async () => {
    for (const action of ["/goal pause", "stop"] as const) {
      const { host, threadId } = await resumedWithUpdateTrailing();
      assert.equal(continuing(host, threadId), true);
      if (action === "stop") {
        await host.orchestrator.command(threadId, "interrupt", { commandId: cmd() });
      } else {
        await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: action });
      }
      await host.settle();
      assert.equal(continuing(host, threadId), false, action);
      await host.stop();
    }
  });
});
