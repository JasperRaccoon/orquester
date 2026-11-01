/**
 * Host updates Phase 1 (spec 2026-11-01 P1.2, P1.5), headlessly: which chats a
 * restart continues and what the next host tells them. A "deploy" is `/stop`'s
 * marking pass, then the teardown's rows (every live task stopped), then the
 * host's stop; a "crash" is the host stopped with no teardown at all. The
 * continue turn is the next host's `sendTurn`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AdapterCapabilities, DomainEvent, RuntimeEvent } from "@orquester/api/agent-chat";

import { runtimeEventToActivities } from "../ingestion/activities.ts";
import {
  AUTO_CONTINUE_LOOP_MESSAGE,
  CONTINUATION_SEND_FAILED_MESSAGE,
  CRASH_RESUME_SUMMARY
} from "../host-protocol.ts";
import { DeadlineExceededError } from "../support/deadline.ts";
import { isContinuationPrompt } from "./continuation-prompt.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type FakeThreadStore,
  type ScriptedAdapter,
  type TestHost
} from "./testing/index.ts";

const THREAD = "revival-thread";
const HOUR = 60 * 60_000;

let seq = 0;
const cmd = (): string => `rv-${(seq += 1)}`;

type Claude = ScriptedAdapter & { live: Set<string> };

/** A Claude stand-in that knows which of its tasks still run (the liveness probe). */
function claude(firstTurn = 1, capabilities: Partial<AdapterCapabilities> = {}, id: "claude" | "codex" | "grok" = "claude"): Claude {
  const adapter = createScriptedAdapter({
    id,
    capabilities: { wakesOnBackgroundCompletion: id === "claude", supportsTaskStop: true, ...capabilities }
  }) as Claude;
  // A provider never reuses a turn id: burn the ones an earlier host handed out.
  for (let i = 1; i < firstTurn; i += 1) {
    void adapter.sendTurn({ threadId: "burn", input: "", attachments: [], interactionMode: "default" });
  }
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
      const state = (event.payload as { state?: string }).state;
      return [
        {
          ...envelope,
          type: "thread.session-set",
          payload: { session: { status: state === "interrupted" ? "stopped" : "ready", activeTurnId: null }, turn: { turnId: event.turnId } }
        }
      ];
    }
    return runtimeEventToActivities(event).map((activity) => ({ ...envelope, type: "thread.activity-appended", payload: { activity } }));
  }) as never;
}

interface Scene {
  host: TestHost;
  adapter: Claude;
  consumed: Promise<void>;
  emit(type: string, payload: Record<string, unknown>, extra?: Record<string, unknown>): void;
  /** The provider's current turn id. */
  turnId(): string;
}

let eventSeq = 0;

/** A host serving THREAD, consuming its adapter's events; `opts.turn` sends the first turn. */
async function serve(adapter: Claude, opts: { store?: FakeThreadStore; optIn?: boolean; create?: boolean } = {}): Promise<Scene> {
  const host = createTestHost({
    adapters: { [adapter.id]: adapter },
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    continuationEnabled: () => opts.optIn ?? true
  });
  translate(host);
  if (opts.create !== false) await host.createThread({ threadId: THREAD, refId: adapter.id });
  const consumed = host.orchestrator.consume(adapter);
  const emit = (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): void =>
    adapter.emit({ eventId: `ev-${(eventSeq += 1)}`, threadId: THREAD, createdAt: host.clock.nowIso(), type, payload, ...extra } as unknown as RuntimeEvent);
  return { host, adapter, consumed, emit, turnId: () => adapter.turnIds.at(-1)! };
}

/** The user's turn, running; `work` tasks launched in it. */
async function workingTurn(scene: Scene, work: Array<{ taskId: string; taskType: string; title: string }> = []): Promise<void> {
  await scene.host.orchestrator.command(THREAD, "turn", { commandId: cmd(), input: "do the job, with subagents" });
  await scene.host.settle();
  scene.emit("turn.started", {}, { turnId: scene.turnId() });
  for (const task of work) {
    scene.adapter.live.add(task.taskId);
    scene.emit("task.started", task);
  }
  await scene.host.settle();
}

async function turnEnds(scene: Scene, state: "completed" | "interrupted" = "completed"): Promise<void> {
  scene.emit("turn.completed", { state }, { turnId: scene.turnId() });
  await scene.host.settle();
}

/** `/stop`: the marking pass, then the teardown's rows — every live task stopped, a cut turn interrupted. */
async function deploy(scene: Scene): Promise<string[]> {
  const marked = await scene.host.orchestrator.markThreadsForContinuation();
  for (const taskId of [...scene.adapter.live]) {
    scene.adapter.live.delete(taskId);
    // A shell its adapter leaves running (Grok) is closed as such, as the real teardown writes it.
    const leftRunning = scene.adapter.capabilities.backgroundShellsOutliveSession === true && taskId.startsWith("shell");
    scene.emit("task.completed", { taskId, status: "stopped", ...(leftRunning ? { leftRunning: true } : {}) });
  }
  const head = scene.host.store.heads.get(THREAD);
  if (head?.session.status === "running" && head.session.activeTurnId !== null) await turnEnds(scene, "interrupted");
  await scene.host.settle();
  await shutDown(scene);
  return marked;
}

/** The host goes, writing nothing more: after `deploy`'s teardown, or as a crash. */
async function shutDown(scene: Scene): Promise<void> {
  scene.adapter.close();
  await scene.consumed;
  await scene.host.stop();
}

/** The next host's boot: reconcile, and what it sent THREAD. */
async function boot(store: FakeThreadStore, adapter: Claude, optIn = true): Promise<{ next: Scene; sends: string[] }> {
  const next = await serve(adapter, { store, optIn, create: false });
  await next.host.orchestrator.reconcile();
  await next.host.settle();
  return { next, sends: sendsOf(adapter) };
}

const sendsOf = (adapter: ScriptedAdapter): string[] =>
  adapter.calls
    .filter((call) => call.kind === "sendTurn" && call.threadId === THREAD)
    .map((call) => String((call.detail as { input?: unknown }).input));

const headOf = (store: FakeThreadStore) => {
  const head = store.heads.get(THREAD);
  assert.ok(head);
  return head;
};

const activities = (store: FakeThreadStore) =>
  (store.logs.get(THREAD) ?? []).flatMap((event: DomainEvent) =>
    event.type === "thread.activity-appended" ? [event.payload.activity] : []
  );

const SUBAGENT = { taskId: "agent-1", taskType: "local_agent", title: "S34: shrink shipped player size" };
const SHELL = { taskId: "shell-1", taskType: "local_bash", title: "Wait for F check completion" };

describe("a restart continues every chat that had live work (spec 2026-11-01 R2)", () => {
  it("a running turn: continued, and told which subagents the restart stopped", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SUBAGENT]);
    assert.deepEqual(await deploy(first), [THREAD]);
    assert.deepEqual(headOf(first.host.store).continueAfterRestart?.stoppedWork, [{ name: SUBAGENT.title, kind: "subagent" }]);

    const { next, sends } = await boot(first.host.store, claude(2));
    assert.equal(sends.length, 1);
    assert.match(sends[0]!, /^Orquester restarted while you were working, so your last turn was cut short\./);
    assert.match(sends[0]!, /The restart stopped these subagents: "S34: shrink shipped player size" \(subagent\)\. Relaunch the subagents/);
    assert.equal(headOf(next.host.store).continueAfterRestart, undefined);
    await shutDown(next);
  });

  it("a revival: the turn had ended, but its subagents still ran — the agent is woken to relaunch them", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SUBAGENT, SHELL]);
    await turnEnds(first);
    assert.deepEqual(await deploy(first), [THREAD], "marked although no turn runs");
    const marker = headOf(first.host.store).continueAfterRestart;
    assert.equal(marker?.revival, true);
    assert.equal(marker?.turnId, "turn-1", "it names the turn that ended");

    const { next, sends } = await boot(first.host.store, claude(2));
    assert.equal(sends.length, 1);
    assert.match(sends[0]!, /^Orquester restarted while your subagents and background commands were still running\. Continue where you left off\./);
    assert.match(sends[0]!, /"S34: shrink shipped player size" \(subagent\), "Wait for F check completion" \(background command\)/);
    assert.equal(headOf(next.host.store).session.status, "running");
    await shutDown(next);
  });

  it("background commands alone revive a chat whose last turn ended less than 6 h before the stop", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SHELL]);
    await turnEnds(first);
    first.host.clock.advance(5 * HOUR);
    assert.deepEqual(await deploy(first), [THREAD]);
    const { next, sends } = await boot(first.host.store, claude(2));
    assert.match(sends[0] ?? "", /^Orquester restarted while your background commands were still running\./);
    await shutDown(next);
  });

  it("…but not a days-old one: a dev server left running wakes nobody", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SHELL]);
    await turnEnds(first);
    first.host.clock.advance(7 * HOUR);
    assert.deepEqual(first.host.orchestrator.backgroundWorkThreadIds(), [THREAD], "the shell still runs");
    assert.deepEqual(await deploy(first), []);
    const { next, sends } = await boot(first.host.store, claude(2));
    assert.deepEqual(sends, []);
    await shutDown(next);
  });

  it("an opted-out project is never marked, revival or not", async () => {
    const first = await serve(claude(), { optIn: false });
    await workingTurn(first, [SUBAGENT]);
    await turnEnds(first);
    assert.deepEqual(await deploy(first), []);
  });

  it("the user's Stop under way when the restart begins is not undone (R4)", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SUBAGENT]);
    await first.host.orchestrator.command(THREAD, "interrupt", { commandId: cmd(), turnId: first.turnId() });
    await first.host.settle();
    assert.equal(headOf(first.host.store).session.status, "running", "the provider has not settled the turn yet");
    assert.deepEqual(await deploy(first), []);
  });

  it("a turn the user stopped is not revived for the subagents it left running (R4)", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SUBAGENT]);
    await turnEnds(first, "interrupted");
    assert.deepEqual(await deploy(first), []);
  });

  it("a turn cut while it waited on an approval is continued, and told the request was cancelled (R5)", async () => {
    const first = await serve(claude());
    await workingTurn(first);
    await first.host.orchestrator.ingestionSink(THREAD, [
      {
        eventId: "ingest-approval",
        threadId: THREAD,
        type: "thread.activity-appended",
        payload: {
          activity: {
            kind: "activity",
            id: "approval:req-1",
            tone: "approval",
            activityKind: "approval.requested",
            summary: "Run a command?",
            payload: { requestId: "req-1", requestKind: "command" },
            turnId: first.turnId(),
            createdAt: first.host.clock.nowIso(),
            updatedAt: first.host.clock.nowIso()
          }
        },
        occurredAt: first.host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      } as never
    ]);
    await first.host.settle();
    assert.deepEqual(await deploy(first), [THREAD]);
    assert.equal(headOf(first.host.store).continueAfterRestart?.requestCancelled, true);
    const { next, sends } = await boot(first.host.store, claude(2));
    assert.equal(sends.length, 1);
    assert.match(sends[0]!, /cancelled by the restart: ask again if the action is still needed/);
    await shutDown(next);
  });
});

describe("work that outlives the stop is never counted as stopped (Grok's shells)", () => {
  const grok = (firstTurn = 1) => claude(firstTurn, { backgroundShellsOutliveSession: true }, "grok");

  it("a restart: a shell left running neither revives the chat nor is named to the agent", async () => {
    const shellOnly = await serve(grok());
    await workingTurn(shellOnly, [SHELL]);
    await turnEnds(shellOnly);
    assert.deepEqual(await deploy(shellOnly), [], "the shell runs on: nothing to revive");

    const both = await serve(grok());
    await workingTurn(both, [SUBAGENT, SHELL]);
    await turnEnds(both);
    assert.deepEqual(await deploy(both), [THREAD], "the subagent did stop");
    const { next, sends } = await boot(both.host.store, grok(2));
    assert.equal(sends.length, 1);
    assert.match(sends[0]!, /The restart stopped these subagents: "S34: shrink shipped player size" \(subagent\)\./);
    assert.doesNotMatch(sends[0]!, /Wait for F check completion/, "never asked to start the running shell again");
    await shutDown(next);
  });

  it("a crash: the shell survives the host's death too, so it revives nothing", async () => {
    const first = await serve(grok());
    await workingTurn(first, [SHELL]);
    await turnEnds(first);
    await shutDown(first); // a crash
    const { next, sends } = await boot(first.host.store, grok(2));
    assert.deepEqual(sends, []);
    await shutDown(next);
  });
});

describe("Codex's promptless continuation only when nothing else was stopped (R7)", () => {
  const codex = (firstTurn = 1) => claude(firstTurn, { promptlessTurnContinuation: true }, "codex");

  it("a bare cut turn: promptless", async () => {
    const first = await serve(codex());
    await workingTurn(first);
    await deploy(first);
    const { next } = await boot(first.host.store, codex(2));
    const send = next.adapter.calls.find((call) => call.kind === "sendTurn" && call.threadId === THREAD);
    assert.deepEqual(
      { input: (send?.detail as { input?: string }).input, continuation: (send?.detail as { continuation?: boolean }).continuation },
      { input: "", continuation: true }
    );
    await shutDown(next);
  });

  it("a cut turn whose subagents were stopped: the full prompt, so it learns what to relaunch", async () => {
    const first = await serve(codex());
    await workingTurn(first, [SUBAGENT]);
    await deploy(first);
    const { next, sends } = await boot(first.host.store, codex(2));
    assert.equal(sends.length, 1);
    assert.ok(isContinuationPrompt(sends[0]!));
    assert.match(sends[0]!, /S34: shrink shipped player size/);
    await shutDown(next);
  });
});

describe("a crash revives what it stopped too (R3)", () => {
  it("an idle chat whose subagent the crash killed is continued, and the chat says the host stopped unexpectedly", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SUBAGENT]);
    await turnEnds(first);
    assert.equal(headOf(first.host.store).backgroundWorkLive, true, "meta.json says work runs");
    await shutDown(first); // a crash: no marker, no teardown

    const { next, sends } = await boot(first.host.store, claude(2));
    assert.equal(sends.length, 1);
    assert.match(sends[0]!, /^Orquester stopped unexpectedly while your subagents were still running\./);
    assert.match(sends[0]!, /"S34: shrink shipped player size" \(subagent\)/);
    assert.equal(activities(next.host.store).filter((row) => row.summary === CRASH_RESUME_SUMMARY).length, 1);
    assert.equal(headOf(next.host.store).backgroundWorkLive, undefined, "the mark has done its job");
    await shutDown(next);
  });

  it("an idle chat whose work had ended is left alone", async () => {
    const first = await serve(claude());
    await workingTurn(first, [SUBAGENT]);
    first.adapter.live.delete(SUBAGENT.taskId);
    first.emit("task.completed", { taskId: SUBAGENT.taskId, status: "completed", summary: "done" });
    await turnEnds(first);
    assert.equal(headOf(first.host.store).backgroundWorkLive, undefined, "cleared when the last task ended");
    await shutDown(first);
    const { next, sends } = await boot(first.host.store, claude(2));
    assert.deepEqual(sends, []);
    await shutDown(next);
  });
});

describe("the loop cap (R4)", () => {
  it("three automatic continues in a row within 10 minutes, nobody writing: the fourth restart settles the chat", async () => {
    let scene = await serve(claude());
    await workingTurn(scene);
    for (let restart = 1; restart <= 3; restart += 1) {
      await deploy(scene);
      const { next, sends } = await boot(scene.host.store, claude(restart + 1));
      assert.equal(sends.length, 1, `restart ${restart} continues`);
      next.emit("turn.started", {}, { turnId: next.turnId() });
      await next.host.settle();
      scene = next;
    }
    await deploy(scene);
    const { next, sends } = await boot(scene.host.store, claude(5));
    assert.deepEqual(sends, [], "not a fourth time");
    assert.equal(headOf(next.host.store).session.lastError, AUTO_CONTINUE_LOOP_MESSAGE);
    await shutDown(next);
  });

  it("a message of the user's in between starts the count again", async () => {
    let scene = await serve(claude());
    await workingTurn(scene);
    for (let restart = 1; restart <= 4; restart += 1) {
      await deploy(scene);
      const { next, sends } = await boot(scene.host.store, claude(2 * restart));
      assert.equal(sends.length, 1, `restart ${restart} continues`);
      next.emit("turn.started", {}, { turnId: next.turnId() });
      await next.host.settle();
      if (restart === 2) {
        await turnEnds(next);
        await workingTurn(next);
      }
      scene = next;
    }
    await shutDown(scene);
  });
});

describe("a continuation whose start fails (R6)", () => {
  it("a transient failure is retried at 30 s and then at 120 s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = await serve(claude());
    await workingTurn(first);
    await deploy(first);
    const adapter = claude(2);
    adapter.failNext("failStartSession", new DeadlineExceededError("session-open:claude", 30_000));
    const { next, sends } = await boot(first.host.store, adapter);
    assert.deepEqual(sends, [], "the first start timed out");
    assert.notEqual(headOf(next.host.store).session.status, "error", "not settled: it is tried again");

    adapter.failNext("failStartSession", new DeadlineExceededError("session-open:claude", 30_000));
    t.mock.timers.tick(30_000);
    await next.host.settle();
    assert.equal(adapter.calls.filter((call) => call.kind === "startSession").length, 2, "retried after 30 s");

    t.mock.timers.tick(120_000);
    await next.host.settle();
    assert.equal(sendsOf(adapter).length, 1, "the second retry got through");
    assert.equal(headOf(next.host.store).session.status, "running");
    await shutDown(next);
  });

  it("is retried twice at most: a third transient failure settles it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = await serve(claude());
    await workingTurn(first);
    await deploy(first);
    const adapter = claude(2);
    adapter.failNext("failStartSession", new DeadlineExceededError("session-open:claude", 30_000));
    const { next } = await boot(first.host.store, adapter);
    for (const wait of [30_000, 120_000]) {
      adapter.failNext("failStartSession", new DeadlineExceededError("session-open:claude", 30_000));
      t.mock.timers.tick(wait);
      await next.host.settle();
    }
    assert.equal(adapter.calls.filter((call) => call.kind === "startSession").length, 3);
    assert.equal(headOf(next.host.store).session.lastError, CONTINUATION_SEND_FAILED_MESSAGE);
    await shutDown(next);
  });

  it("a refusal — a usage limit — is not retried: settled at once", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = await serve(claude());
    await workingTurn(first);
    await deploy(first);
    const adapter = claude(2);
    adapter.failNext("failStartSession", new Error("You've hit your usage limit"));
    const { next } = await boot(first.host.store, adapter);
    assert.equal(headOf(next.host.store).session.lastError, CONTINUATION_SEND_FAILED_MESSAGE);
    t.mock.timers.tick(150_000);
    await next.host.settle();
    assert.equal(adapter.calls.filter((call) => call.kind === "startSession").length, 1);
    await shutDown(next);
  });
});
