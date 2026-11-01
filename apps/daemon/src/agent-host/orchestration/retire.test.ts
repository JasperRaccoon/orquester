/**
 * Host updates (spec 2026-11-01 P2.3, P2.7 host tests): a retiring host keeps only the threads
 * with live work and releases each one at its first idle moment; a host that boots beside it never
 * touches those threads until it adopts them, and adopts each one exactly as a boot takes in a
 * thread from a stopped host. Fake adapters and the in-memory store; every wait is a drain.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AdapterGoalSupport,
  GoalUpdatedPayload,
  RuntimeEvent
} from "@orquester/api/agent-chat";

import type { GoalCommandResult } from "../adapter.ts";
import { runtimeEventToActivities } from "../ingestion/activities.ts";
import { isContinuationPrompt } from "./continuation-prompt.ts";
import { isAgentChatCommandError } from "./errors.ts";
import { createThreadOwnership, type ThreadOwnership } from "./ownership.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type FakeThreadStore,
  type ScriptedAdapter,
  type TestHost,
  type TestHostOptions
} from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `retire-${(commandSeq += 1)}`;
let eventSeq = 0;

/** A Claude stand-in that wakes the agent for finished background work and knows what still runs. */
function claude(): ScriptedAdapter & { live: Set<string> } {
  const adapter = createScriptedAdapter({
    id: "claude",
    capabilities: { wakesOnBackgroundCompletion: true, supportsTaskStop: true }
  }) as ScriptedAdapter & { live: Set<string> };
  adapter.live = new Set();
  adapter.backgroundTaskLive = (_threadId, taskId) => adapter.live.has(taskId);
  return adapter;
}

/** The ingestion the real host runs, for the shapes these tests emit. */
function translate(host: TestHost): void {
  host.ingestion.translate = ((event: RuntimeEvent) => {
    const envelope = {
      eventId: `ingest-${event.eventId}`,
      threadId: event.threadId,
      occurredAt: event.createdAt,
      commandId: null,
      causationEventId: null,
      metadata: {}
    };
    if (event.type === "turn.started") {
      return [{ ...envelope, type: "thread.session-set", payload: { session: { status: "running", activeTurnId: event.turnId ?? null } } }];
    }
    if (event.type === "turn.completed") {
      return [{ ...envelope, type: "thread.session-set", payload: { session: { status: "ready", activeTurnId: null } } }];
    }
    return runtimeEventToActivities(event).map((activity) => ({
      ...envelope,
      type: "thread.activity-appended",
      payload: { activity }
    }));
  }) as never;
}

function emitter(host: TestHost, adapter: ScriptedAdapter) {
  return (threadId: string, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): void =>
    adapter.emit({
      eventId: `ev-${(eventSeq += 1)}`,
      threadId,
      createdAt: host.clock.nowIso(),
      type,
      payload,
      ...extra
    } as unknown as RuntimeEvent);
}

const isCode = (code: string) => (error: unknown): boolean => isAgentChatCommandError(error) && error.code === code;

interface Scene {
  host: TestHost;
  adapter: ReturnType<typeof claude>;
  ownership: ThreadOwnership;
  emit: ReturnType<typeof emitter>;
  /** At each `stopSession`: whether the thread was still owned (I4). */
  stops: Array<{ threadId: string; ownedThen: boolean; endedByUser: boolean }>;
  released: string[];
  /** A turn the provider is running on the thread. */
  turnOn(threadId: string): Promise<string>;
  end(threadId: string, turnId: string): Promise<void>;
  finish(): Promise<void>;
}

/**
 * Four threads, as a retire finds them: `busy` mid-turn, `fleet` idle while its subagent works on,
 * `waking` idle with a finished subagent the provider has not woken the agent for yet, and `idle`
 * with a live provider session and nothing running.
 */
async function scene(options: Omit<TestHostOptions, "adapters"> = {}): Promise<Scene> {
  const adapter = claude();
  const ownership = options.ownership ?? createThreadOwnership();
  const released: string[] = [];
  const host = createTestHost({
    ...options,
    ownership,
    adapters: { claude: adapter },
    onThreadReleased: (threadId) => released.push(threadId)
  });
  translate(host);
  const consumed = host.orchestrator.consume(adapter);
  const emit = emitter(host, adapter);
  const stops: Scene["stops"] = [];
  const stopSession = adapter.stopSession.bind(adapter);
  adapter.stopSession = async (threadId, stopOptions) => {
    stops.push({
      threadId,
      ownedThen: host.orchestrator.ownedThreadIds()?.includes(threadId) ?? true,
      endedByUser: stopOptions?.endedByUser === true
    });
    await stopSession(threadId, stopOptions);
  };
  const turnOn = async (threadId: string): Promise<string> => {
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await host.settle();
    const turnId = adapter.turnIds.at(-1)!;
    emit(threadId, "turn.started", {}, { turnId });
    await host.settle();
    return turnId;
  };
  const end = async (threadId: string, turnId: string): Promise<void> => {
    emit(threadId, "turn.completed", { state: "completed" }, { turnId });
    await host.settle();
  };
  for (const threadId of ["busy", "fleet", "waking", "idle"]) {
    await host.createThread({ threadId, refId: "claude" });
  }
  await turnOn("busy");
  const fleetTurn = await turnOn("fleet");
  adapter.live.add("agent-fleet");
  emit("fleet", "task.started", { taskId: "agent-fleet", taskType: "local_agent", title: "Port the parser", toolUseId: "toolu_fleet" });
  await end("fleet", fleetTurn);
  const wakingTurn = await turnOn("waking");
  adapter.live.add("agent-waking");
  emit("waking", "task.started", { taskId: "agent-waking", taskType: "local_agent", title: "Write the docs", toolUseId: "toolu_waking" });
  await end("waking", wakingTurn);
  // Its subagent ends later, while no turn runs: a wake the provider owes the agent.
  host.clock.set(host.clock.now().getTime() + 60_000);
  adapter.live.delete("agent-waking");
  emit("waking", "task.completed", { taskId: "agent-waking", taskType: "local_agent", title: "Write the docs", status: "completed", summary: "Done." });
  await host.settle();
  await end("idle", await turnOn("idle"));
  assert.deepEqual(host.orchestrator.pendingWakes().map((wake) => wake.threadId), ["waking"]);
  return {
    host,
    adapter,
    ownership,
    emit,
    stops,
    released,
    turnOn,
    end,
    async finish() {
      adapter.close();
      await consumed;
      await host.stop();
    }
  };
}

describe("POST /retire — the owned set (P2.3 R18)", () => {
  it("keeps the threads with a turn, background work or a pending wake, and releases the idle one", async () => {
    const s = await scene();
    const { host } = s;

    assert.deepEqual(await host.orchestrator.retire(), ["busy", "fleet", "waking"]);
    assert.deepEqual(host.orchestrator.ownedThreadIds(), ["busy", "fleet", "waking"]);
    assert.deepEqual(await host.orchestrator.retire(), ["busy", "fleet", "waking"], "a second retire answers the same set");

    // The idle thread's session was closed as a restart closes it — cursor kept — while it was
    // still owned, and its session reads stopped before it left (I4).
    assert.deepEqual(s.stops, [{ threadId: "idle", ownedThen: true, endedByUser: false }]);
    assert.equal(host.store.heads.get("idle")?.session.status, "stopped");
    assert.deepEqual(host.store.bindings.get("idle")?.resumeCursor, { cursor: "turn-4" }, "the cursor stays for the adopter");
    assert.deepEqual(s.released, ["idle"]);

    // From now on this host never writes it, and every request for it is refused.
    const logLength = host.store.logs.get("idle")?.length;
    await assert.rejects(host.orchestrator.command("idle", "turn", { commandId: cmd(), input: "more" }), isCode("THREAD_NOT_OWNED"));
    await assert.rejects(host.orchestrator.readThread("idle"), isCode("THREAD_NOT_OWNED"));
    await assert.rejects(host.orchestrator.enterThread("idle"), isCode("THREAD_NOT_OWNED"));
    assert.equal(host.store.logs.get("idle")?.length, logLength, "nothing was appended to the released thread");
    // …nor takes a new thread; a thread it still owns answers as ever.
    await assert.rejects(host.createThread({ threadId: "fresh", refId: "claude" }), isCode("HOST_RETIRING"));
    assert.equal((await host.orchestrator.readThread("busy")).kind, "snapshot");
    await s.finish();
  });

  it("keeps a thread a request is in flight for, and releases it once that request is answered", async () => {
    const s = await scene();
    const leave = await s.host.orchestrator.enterThread("idle");
    assert.deepEqual(await s.host.orchestrator.retire(), ["busy", "fleet", "idle", "waking"]);
    assert.deepEqual(s.stops, []);
    leave();
    await s.host.settle();
    assert.deepEqual(s.host.orchestrator.ownedThreadIds(), ["busy", "fleet", "waking"]);
    assert.deepEqual(s.released, ["idle"]);
    await s.finish();
  });
});

describe("a retiring host releases each thread at its first idle moment (P2.3 R19)", () => {
  it("the turn's end, the subagent's end and the wake's turn each release their thread, session closed first", async () => {
    const s = await scene();
    const { host } = s;
    await host.orchestrator.retire();

    await s.end("busy", "turn-1");
    assert.deepEqual(host.orchestrator.ownedThreadIds(), ["fleet", "waking"], "the turn's end released it");

    // The subagent ends while no turn runs: that is a pending wake, still live work.
    s.adapter.live.delete("agent-fleet");
    s.emit("fleet", "task.completed", { taskId: "agent-fleet", taskType: "local_agent", title: "Port the parser", status: "completed", summary: "Ported." });
    await host.settle();
    assert.deepEqual(host.orchestrator.ownedThreadIds(), ["fleet", "waking"], "a wake is owed: the thread stays");

    // The provider's wake turn hands the agent the result, and its end releases the thread.
    for (const threadId of ["fleet", "waking"]) {
      const wakeTurn = `wake-${threadId}`;
      s.emit(threadId, "turn.started", {}, { turnId: wakeTurn });
      await host.settle();
      assert.ok(host.orchestrator.ownedThreadIds()?.includes(threadId), "the wake turn runs here");
      await s.end(threadId, wakeTurn);
    }
    assert.deepEqual(host.orchestrator.ownedThreadIds(), []);
    assert.deepEqual(s.released, ["idle", "busy", "fleet", "waking"]);
    assert.ok(s.stops.every((stop) => stop.ownedThen && !stop.endedByUser), "every session closed while still owned, as a restart");
    for (const threadId of ["busy", "fleet", "waking"]) {
      assert.equal(host.store.heads.get(threadId)?.session.status, "stopped", `${threadId}: closed before it was released`);
    }
    await s.finish();
  });

  it("a request that arrives during a release waits for it, then is refused", async () => {
    const s = await scene();
    await s.host.orchestrator.retire();
    // Hold the release inside its session close.
    let closeSession!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeSession = resolve;
    });
    const stopSession = s.adapter.stopSession.bind(s.adapter);
    s.adapter.stopSession = async (threadId, options) => {
      await closing;
      await stopSession(threadId, options);
    };
    let reached!: () => void;
    const inClose = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = s.adapter.stopSession;
    s.adapter.stopSession = async (threadId, options) => {
      reached();
      await held(threadId, options);
    };
    s.emit("busy", "turn.completed", { state: "completed" }, { turnId: "turn-1" });
    // The release has begun and sits in the session close.
    await inClose;
    const entering = s.host.orchestrator.enterThread("busy");
    let settled = false;
    void entering.catch(() => undefined).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, "the request waits for the release in flight");
    closeSession();
    await assert.rejects(entering, isCode("THREAD_NOT_OWNED"));
    await s.finish();
  });

  it("an unretire takes every released thread back", async () => {
    const s = await scene();
    await s.host.orchestrator.retire();
    assert.deepEqual(await s.host.orchestrator.unretire(), ["busy", "fleet", "idle", "waking"]);
    assert.equal(s.host.orchestrator.isRetiring(), false);
    assert.equal(s.host.orchestrator.ownedThreadIds(), null);
    await s.end("idle", await s.turnOn("idle"));
    assert.ok(s.adapter.calls.some((call) => call.kind === "sendTurn" && call.threadId === "idle" && call !== undefined));
    const created = await s.host.createThread({ threadId: "fresh", refId: "claude" });
    assert.equal(created, "fresh", "creation is back");
    await s.finish();
  });
});

// ---------------------------------------------------------------------------
// A continuing goal (goals §5.7's hold, reused)
// ---------------------------------------------------------------------------

const HOST_GOALS: AdapterGoalSupport = {
  command: "host",
  actions: ["pause", "resume", "clear"],
  continuesAcrossTurns: true
};

async function pushGoal(host: TestHost, threadId: string, payload: GoalUpdatedPayload): Promise<void> {
  eventSeq += 1;
  const event = {
    eventId: `retire-goal-${eventSeq}`,
    threadId,
    createdAt: host.clock.nowIso(),
    type: "thread.goal.updated",
    payload
  } as RuntimeEvent;
  await host.orchestrator.ingestionSink(
    threadId,
    runtimeEventToActivities(event).map((activity) => ({
      eventId: `ingest-retire-goal-${eventSeq}`,
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

async function sessionSet(
  host: TestHost,
  threadId: string,
  status: "ready" | "running" | "stopped",
  activeTurnId: string | null,
  turnId?: string
): Promise<void> {
  eventSeq += 1;
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `retire-session-${eventSeq}`,
      threadId,
      type: "thread.session-set",
      payload: { session: { status, activeTurnId }, ...(turnId !== undefined ? { turn: { turnId } } : {}) } as never,
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
  await host.settle();
}

/** A Codex stand-in whose pause and resume land in the fold, as Codex's own goal update does. */
function codexHost(options: Omit<TestHostOptions, "adapters"> & { store?: FakeThreadStore } = {}): TestHost {
  let host: TestHost | undefined;
  const adapter = createScriptedAdapter({
    id: "codex",
    capabilities: { goals: HOST_GOALS },
    goalCommand: async (threadId, command): Promise<GoalCommandResult> => {
      const goal = host?.orchestrator.summary(threadId)?.goal ?? null;
      if (host !== undefined && goal !== null) {
        if (command.kind === "pause") {
          await pushGoal(host, threadId, { goal: { objective: goal.objective, status: "paused" }, change: "paused" });
        } else if (command.kind === "resume" && goal.status === "paused") {
          await pushGoal(host, threadId, { goal: { objective: goal.objective, status: "active" }, change: "resumed" });
        }
      }
      return { summary: "" };
    }
  });
  host = createTestHost({ ...options, adapters: { codex: adapter } });
  return host;
}

describe("a retiring host hands a continuing goal over held (P2.3 R19, goals §5.7)", () => {
  it("holds the goal at once, releases the thread at the turn's end, and the adopter resumes it", async () => {
    const host = codexHost();
    const threadId = await host.createThread({ threadId: "goal", refId: "codex", homePath: "/homes/acc1" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
    await host.settle();
    await pushGoal(host, threadId, { goal: { objective: "ship it", status: "active" }, change: "set" });

    assert.deepEqual(await host.orchestrator.retire(), ["goal"]);
    await host.settle();
    const goalCalls = () => host.adapter.calls.filter((call) => call.kind === "goalCommand").map((call) => (call.detail as { kind: string }).kind);
    assert.deepEqual(goalCalls(), ["pause"], "held between its turns: the turn running finishes");
    assert.equal(host.store.heads.get(threadId)?.goalHeldForHandover, true, "marked for the next host");
    assert.deepEqual(host.orchestrator.ownedThreadIds(), ["goal"], "its turn still runs here");

    await sessionSet(host, threadId, "ready", null);
    assert.deepEqual(host.orchestrator.ownedThreadIds(), [], "released at the turn boundary");
    assert.equal(host.store.heads.get(threadId)?.goalHeldForHandover, true, "the mark went with it");
    await host.stop();

    // The new host booted beside it with the thread foreign: nothing of it is touched…
    const next = codexHost({ store: host.store, ownership: createThreadOwnership({ foreignThreadIds: [threadId] }) });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(next.adapter.calls.length, 0, "the boot reconcile skipped it");
    // …until it adopts it: the held goal's session comes back and the goal is resumed.
    assert.equal(await next.orchestrator.adoptThread(threadId), true);
    await next.settle();
    const resumed = next.adapter.calls.filter((call) => call.kind === "goalCommand").map((call) => (call.detail as { kind: string }).kind);
    assert.deepEqual(resumed, ["resume"]);
    assert.equal(next.store.heads.get(threadId)?.goalHeldForHandover, undefined, "the mark is consumed");
    assert.equal(await next.orchestrator.adoptThread(threadId), false, "a second adopt is a no-op");
    await next.stop();
  });
});

// ---------------------------------------------------------------------------
// The host that boots beside a retiring one (P2.3 R16, R17)
// ---------------------------------------------------------------------------

/** A thread mid-turn when its host died (no marker): the crash path's input. */
async function crashedMidTurn(threadId: string): Promise<FakeThreadStore> {
  const first = createTestHost();
  await first.createThread({ threadId });
  await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
  await first.settle();
  assert.equal(first.store.heads.get(threadId)?.session.status, "running");
  return first.store;
}

const continuationSends = (host: TestHost) =>
  host.adapter.calls.filter(
    (call) => call.kind === "sendTurn" && isContinuationPrompt((call.detail as { input?: string }).input ?? "")
  );

describe("foreign threads are untouchable until adopted (P2.3 R16, R17)", () => {
  it("the boot neither reconciles, marks nor starts anything for a foreign thread, and every route refuses it", async () => {
    const store = await crashedMidTurn("theirs");
    const before = JSON.stringify({ log: store.logs.get("theirs"), head: store.heads.get("theirs") });
    const host = createTestHost({
      store,
      continuationEnabled: () => true,
      ownership: createThreadOwnership({ foreignThreadIds: ["theirs"] })
    });
    await host.orchestrator.reconcile();
    await host.settle();
    assert.deepEqual(await host.orchestrator.markThreadsForContinuation(), [], "a stop marks only its own threads");
    await assert.rejects(host.orchestrator.readThread("theirs"), isCode("THREAD_NOT_OWNED"));
    await assert.rejects(host.orchestrator.command("theirs", "interrupt", { commandId: cmd() }), isCode("THREAD_NOT_OWNED"));
    await assert.rejects(host.orchestrator.subscribe("theirs", { onEvents: () => undefined }), isCode("THREAD_NOT_OWNED"));
    assert.equal(host.adapter.calls.length, 0, "no session started, stopped or swept for it");
    assert.equal(JSON.stringify({ log: store.logs.get("theirs"), head: store.heads.get("theirs") }), before, "not a byte written");
    await host.stop();
  });

  it("an adopted crash orphan is resumed as a boot resumes one, once", async () => {
    const store = await crashedMidTurn("crashed");
    const host = createTestHost({
      store,
      continuationEnabled: () => true,
      ownership: createThreadOwnership({ foreignThreadIds: ["crashed"] })
    });
    await host.orchestrator.reconcile();
    await host.settle();
    assert.equal(continuationSends(host).length, 0);
    assert.equal(await host.orchestrator.adoptThread("crashed"), true);
    await host.settle();
    assert.equal(continuationSends(host).length, 1, "the crash path continued it");
    assert.equal(host.store.heads.get("crashed")?.session.status, "running");
    assert.equal(await host.orchestrator.adoptThread("crashed"), false);
    await host.settle();
    assert.equal(continuationSends(host).length, 1, "idempotent");
    await host.stop();
  });

  it("adopting a thread that is gone answers THREAD_NOT_FOUND, never a fresh thread", async () => {
    const host = createTestHost({ ownership: createThreadOwnership({ foreignThreadIds: ["gone"] }) });
    await assert.rejects(host.orchestrator.adoptThread("gone"), isCode("THREAD_NOT_FOUND"));
    assert.equal(host.store.heads.has("gone"), false);
    await host.stop();
  });

  it("an adopted thread whose old host's stop marked its turn is continued from the marker", async () => {
    const first = createTestHost({ continuationEnabled: () => true });
    await first.createThread({ threadId: "handed" });
    await first.orchestrator.command("handed", "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    assert.deepEqual(await first.orchestrator.markThreadsForContinuation(), ["handed"]);
    // The teardown's rows: the turn interrupted, the session stopped.
    await sessionSet(first, "handed", "stopped", null, "turn-1");
    await first.stop();
    const host = createTestHost({
      store: first.store,
      continuationEnabled: () => false,
      ownership: createThreadOwnership({ foreignThreadIds: ["handed"] })
    });
    await host.orchestrator.reconcile();
    assert.equal(await host.orchestrator.adoptThread("handed"), true);
    await host.settle();
    assert.equal(continuationSends(host).length, 1, "the marker alone decides, as at boot");
    assert.equal(host.store.heads.get("handed")?.continueAfterRestart, undefined);
    await host.stop();
  });

  it("an adopted thread with a wake its old host left undelivered gets the wake", async () => {
    const s = await scene();
    await s.finish();
    const host = createTestHost({
      store: s.host.store,
      continuationEnabled: () => true,
      ownership: createThreadOwnership({ foreignThreadIds: ["waking"] }),
      adapters: { claude: claude() }
    });
    await host.orchestrator.reconcile();
    await host.settle();
    const wakeSends = () => host.adapter.calls.filter((call) => call.kind === "sendTurn" && call.threadId === "waking");
    assert.equal(wakeSends().length, 0);
    assert.equal(await host.orchestrator.adoptThread("waking"), true);
    await host.settle();
    assert.equal(wakeSends().length, 1, "the wake is delivered by the adopter");
    await host.stop();
  });

  it("forks a foreign parent by reading it in place, and writes only the child", async () => {
    const first = createTestHost();
    await first.createThread({ threadId: "parent" });
    await first.orchestrator.command("parent", "turn", { commandId: cmd(), input: "the parent's question" });
    await first.settle();
    await sessionSet(first, "parent", "ready", null);
    await first.stop();
    const store = first.store;
    const before = JSON.stringify({
      log: store.logs.get("parent"),
      head: store.heads.get("parent"),
      binding: store.bindings.get("parent"),
      snapshot: store.snapshots.get("parent")
    });
    const host = createTestHost({ store, ownership: createThreadOwnership({ foreignThreadIds: ["parent"] }) });
    const fork = await host.orchestrator.forkThread("parent", {
      threadId: "child",
      projectPath: "/work/project",
      cwd: "/work/project",
      title: "Test thread (fork)",
      refId: "claude",
      accountId: "acc1",
      home: "account",
      modelSelection: undefined,
      runtimeMode: undefined,
      fork: {}
    });
    assert.equal(fork.head.id, "child");
    assert.equal(fork.lineage.parentThreadId, "parent");
    assert.equal((await host.orchestrator.readThread("child")).kind, "snapshot", "the child is this host's");
    assert.equal(
      JSON.stringify({
        log: store.logs.get("parent"),
        head: store.heads.get("parent"),
        binding: store.bindings.get("parent"),
        snapshot: store.snapshots.get("parent")
      }),
      before,
      "the parent was read, never written"
    );
    await assert.rejects(host.orchestrator.readThread("parent"), isCode("THREAD_NOT_OWNED"), "and stays foreign");
    await host.stop();
  });
});
