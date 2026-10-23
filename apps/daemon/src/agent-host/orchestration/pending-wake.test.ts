/**
 * Pending wakes (`pending-wake.ts`) and real background liveness, headlessly.
 *
 * The owner's incident (2026-10-23, thread bbd7145a): a Claude chat's last
 * background subagent finished at 09:20:10.905, the CLI began the parent's wake
 * at 09:20:11.005 (session running, no turn yet), and a deploy's pending
 * drain-restart stopped the host at 09:20:12.409 — the result was never handed
 * to the agent, and the chat sat waiting until the user typed "continue". These
 * tests replay that timeline on the host: the end is held as a pending wake
 * (reported on `/health`, on `meta.json`) until a turn starts; a host that
 * stops anyway leaves it, and the next host hands the agent the result once,
 * under the §3.3 continuation rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AdapterCapabilities, DomainEvent, RuntimeEvent } from "@orquester/api/agent-chat";

import { runtimeEventToActivities } from "../ingestion/activities.ts";
import { CONTINUATION_PROMPT } from "../host-protocol.ts";
import { WAKE_NOTE_SUMMARY } from "./pending-wake.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type FakeThreadStore,
  type ScriptedAdapter,
  type TestHost,
  type TestHostOptions
} from "./testing/index.ts";

const THREAD = "bbd7145a-6fb8-4b02-bebe-5a5a97943e22";
const SUBAGENT = "a848b4c83033e0f67";
const RESULT =
  "All four items (A to D) are fixed and committed on `t3gap/fix-auth`, and the tree is clean. The full daemon suite has one failure: the MCP tool-description size check.";
const OUTPUT_FILE = `/var/lib/orquester/tmp/claude-999/tasks/${SUBAGENT}.output`;

let seq = 0;
const cmd = (): string => `pw-${(seq += 1)}`;

/** A Claude stand-in: it wakes the agent for a finished background task, and knows which still run. */
function claude(options: { firstTurn?: number; capabilities?: Partial<AdapterCapabilities> } = {}): ScriptedAdapter & {
  live: Set<string>;
} {
  const adapter = createScriptedAdapter({
    id: "claude",
    capabilities: { wakesOnBackgroundCompletion: true, supportsTaskStop: true, ...options.capabilities }
  }) as ScriptedAdapter & { live: Set<string> };
  // A provider never reuses a turn id: burn the ones an earlier host handed out.
  for (let i = 1; i < (options.firstTurn ?? 1); i += 1) {
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
      return [{ ...envelope, type: "thread.session-set", payload: { session: { status: "ready", activeTurnId: null } } }];
    }
    if (event.type === "session.state.changed") {
      return [{ ...envelope, type: "thread.session-set", payload: { session: { status: "running", activeTurnId: null } } }];
    }
    return runtimeEventToActivities(event).map((activity) => ({
      ...envelope,
      type: "thread.activity-appended",
      payload: { activity }
    }));
  }) as never;
}

let eventSeq = 0;
function emitter(host: TestHost, adapter: ScriptedAdapter) {
  return (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): void =>
    adapter.emit({
      eventId: `ev-${(eventSeq += 1)}`,
      threadId: THREAD,
      createdAt: host.clock.nowIso(),
      type,
      payload,
      ...extra
    } as unknown as RuntimeEvent);
}

interface Scene {
  host: TestHost;
  adapter: ReturnType<typeof claude>;
  emit: ReturnType<typeof emitter>;
  consumed: Promise<void>;
  at: (iso: string) => Promise<void>;
}

/**
 * The bbd7145a thread up to 09:20:10.905: a turn that launched the subagent
 * settled long ago, the subagent works on in the background.
 */
async function sceneBeforeTheEnd(options: Omit<TestHostOptions, "adapters"> & { firstTurn?: number } = {}): Promise<Scene> {
  const adapter = claude(options.firstTurn !== undefined ? { firstTurn: options.firstTurn } : {});
  const host = createTestHost({ ...options, adapters: { claude: adapter } });
  translate(host);
  const at = async (iso: string): Promise<void> => {
    host.clock.set(Date.parse(iso));
    await host.settle();
  };
  await at("2026-10-23T06:17:00.000Z");
  await host.createThread({ threadId: THREAD, refId: "claude" });
  const consumed = host.orchestrator.consume(adapter);
  const emit = emitter(host, adapter);
  await host.orchestrator.command(THREAD, "turn", { commandId: cmd(), input: "fix the ten gaps, one subagent each" });
  await host.settle();
  const turnId = adapter.turnIds.at(-1)!;
  emit("turn.started", {}, { turnId });
  adapter.live.add(SUBAGENT);
  emit("task.started", { taskId: SUBAGENT, taskType: "local_agent", title: "Fix: revocable auth sessions", toolUseId: "toolu_01XGoPPMSzQwDsVGr7JMifeZ" });
  await host.settle();
  await at("2026-10-23T06:17:30.000Z");
  emit("turn.completed", { state: "completed" }, { turnId });
  await at("2026-10-23T09:19:59.000Z");
  assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [THREAD], "the subagent works on after its turn");
  return { host, adapter, emit, consumed, at };
}

/** 09:20:10.905 — the subagent's own end: `task.updated`, then `task.completed` with its result. */
async function subagentEnds(scene: Scene): Promise<void> {
  await scene.at("2026-10-23T09:20:10.905Z");
  scene.adapter.live.delete(SUBAGENT);
  scene.emit("task.updated", { taskId: SUBAGENT, taskType: "local_agent", title: "Fix: revocable auth sessions", status: "completed", endedAt: "2026-10-23T09:20:10.903Z" });
  scene.emit("task.completed", { taskId: SUBAGENT, taskType: "local_agent", title: "Fix: revocable auth sessions", status: "completed", summary: RESULT, outputFile: OUTPUT_FILE });
  await scene.host.settle();
}

const sendsOf = (adapter: ScriptedAdapter): string[] =>
  adapter.calls.filter((call) => call.kind === "sendTurn" && call.threadId === THREAD).map((call) => String((call.detail as { input?: unknown }).input));

const notesOf = (store: FakeThreadStore) =>
  (store.logs.get(THREAD) ?? []).flatMap((event: DomainEvent) =>
    event.type === "thread.activity-appended" && event.payload.activity.summary === WAKE_NOTE_SUMMARY
      ? [event.payload.activity]
      : []
  );

const detailOf = (activity: { payload: unknown }): string => String((activity.payload as { detail?: unknown }).detail);

describe("a pending wake holds the drain until the provider's wake turn starts (bbd7145a)", () => {
  it("the subagent's end, while no turn runs, is a pending wake — on /health and on meta.json", async () => {
    const scene = await sceneBeforeTheEnd();
    const { host } = scene;
    await subagentEnds(scene);
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [], "no background work is left…");
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), [], "…and no turn runs: the old drain went ahead here");
    assert.deepEqual(host.orchestrator.pendingWakes(), [{ threadId: THREAD, since: "2026-10-23T09:20:10.905Z" }]);
    const mark = host.store.heads.get(THREAD)?.pendingWake;
    assert.equal(mark?.tasks.length, 1);
    assert.deepEqual(
      { taskId: mark?.tasks[0]?.taskId, title: mark?.tasks[0]?.title, result: mark?.tasks[0]?.result, outputFile: mark?.tasks[0]?.outputFile },
      { taskId: SUBAGENT, title: "Fix: revocable auth sessions", result: RESULT, outputFile: OUTPUT_FILE },
      "one entry, the summary its task.completed carried"
    );

    // 09:20:11.005 — the CLI starts streaming the parent's wake: still no turn.
    await scene.at("2026-10-23T09:20:11.005Z");
    scene.emit("session.state.changed", { state: "running", reason: "wake:streaming" });
    await host.settle();
    assert.equal(host.orchestrator.pendingWakes().length, 1, "streaming is not a turn yet");

    // The wake's turn opens: the agent has the result.
    await scene.at("2026-10-23T09:20:12.900Z");
    scene.emit("turn.started", {}, { turnId: "wake-turn" });
    await host.settle();
    assert.deepEqual(host.orchestrator.pendingWakes(), []);
    assert.equal(host.store.heads.get(THREAD)?.pendingWake, undefined, "cleared on meta.json too");
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), [THREAD], "the wake turn itself holds the drain now");
    scene.emit("turn.completed", { state: "completed" }, { turnId: "wake-turn" });
    await host.settle();
    assert.deepEqual(host.orchestrator.activeTurnThreadIds(), []);
    assert.deepEqual(host.orchestrator.pendingWakes(), [], "settled: the drain may proceed");
    scene.adapter.close();
    await scene.consumed;
    await host.stop();
  });

  it("an end during a running turn, a stop, and a subagent's own shell are no wake", async () => {
    const scene = await sceneBeforeTheEnd();
    const { host, emit } = scene;
    emit("task.started", { taskId: "shell-of-agent", taskType: "local_bash", agentId: "other-agent" });
    emit("task.completed", { taskId: "shell-of-agent", taskType: "local_bash", agentId: "other-agent", status: "completed" });
    emit("task.completed", { taskId: SUBAGENT, taskType: "local_agent", status: "stopped" });
    await host.settle();
    assert.deepEqual(host.orchestrator.pendingWakes(), []);

    await host.orchestrator.command(THREAD, "turn", { commandId: cmd(), input: "and another" });
    await host.settle();
    emit("turn.started", {}, { turnId: scene.adapter.turnIds.at(-1)! });
    emit("task.started", { taskId: "bg-2", taskType: "local_agent" });
    emit("task.completed", { taskId: "bg-2", taskType: "local_agent", status: "completed", summary: "done" });
    await host.settle();
    assert.deepEqual(host.orchestrator.pendingWakes(), [], "a turn running takes the result in itself");
    scene.adapter.close();
    await scene.consumed;
    await host.stop();
  });

  it("a provider that never wakes for an end (Codex) holds nothing", async () => {
    const adapter = createScriptedAdapter({ id: "codex" });
    const host = createTestHost({ adapters: { codex: adapter } });
    translate(host);
    await host.createThread({ threadId: THREAD, refId: "codex" });
    const consumed = host.orchestrator.consume(adapter);
    const emit = emitter(host, adapter);
    emit("task.started", { taskId: "child", taskType: "subagent", agentId: "child" });
    emit("task.completed", { taskId: "child", taskType: "subagent", agentId: "child", status: "completed", summary: "done" });
    await host.settle();
    assert.deepEqual(host.orchestrator.pendingWakes(), []);
    adapter.close();
    await consumed;
    await host.stop();
  });

  it("the user ending the session lets the wake go", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    await scene.host.orchestrator.command(THREAD, "session/stop", { commandId: cmd() });
    await scene.host.settle();
    assert.deepEqual(scene.host.orchestrator.pendingWakes(), []);
    assert.equal(scene.host.store.heads.get(THREAD)?.pendingWake, undefined);
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop();
  });
});

/** The next host, on the first one's store, its clock where the first one stopped. */
function nextHost(scene: Scene, options: Omit<TestHostOptions, "adapters" | "store"> & { firstTurn: number }): { host: TestHost; adapter: ReturnType<typeof claude> } {
  const adapter = claude({ firstTurn: options.firstTurn });
  const host = createTestHost({ ...options, store: scene.host.store, launchConfigs: scene.host.launchConfigs, adapters: { claude: adapter } });
  translate(host);
  host.clock.set(scene.host.clock.now().getTime() + 30_000);
  return { host, adapter };
}

describe("a host that stops on a pending wake: the next one hands the agent the result, once", () => {
  it("a deploy's stop past the drain's cap: delivered under the opt-in, with a visible note", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    await scene.at("2026-10-23T09:22:11.000Z"); // the daemon's 2-minute cap ran out
    await scene.host.orchestrator.markThreadsForContinuation();
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop();
    assert.ok(scene.host.store.heads.get(THREAD)?.pendingWake, "the mark survives the teardown");

    const { host, adapter } = nextHost(scene, { firstTurn: 3, continuationEnabled: () => true });
    await host.orchestrator.reconcile();
    await host.settle();
    const sends = sendsOf(adapter);
    assert.equal(sends.length, 1, "one turn hands the agent the result");
    assert.match(sends[0]!, /While the agent host restarted, a background task you started finished/);
    assert.match(sends[0]!, /"Fix: revocable auth sessions" \(task id a848b4c83033e0f67\) completed/);
    assert.ok(sends[0]!.includes(RESULT), "with its result");
    assert.ok(sends[0]!.includes(`Full output: ${OUTPUT_FILE}`));
    assert.notEqual(sends[0], CONTINUATION_PROMPT);
    const notes = notesOf(host.store);
    assert.equal(notes.length, 1);
    assert.match(detailOf(notes[0]!), /"Fix: revocable auth sessions" finished while the agent host restarted\. The agent was given the result and continues\./);
    const head = host.store.heads.get(THREAD);
    assert.equal(head?.pendingWake, undefined, "cleared once sent");
    assert.equal(head?.session.status, "running");

    // Never twice: the same host again, and the host after it.
    await host.orchestrator.reconcile();
    await host.settle();
    await host.stop();
    const third = nextHost({ ...scene, host }, { firstTurn: 4, continuationEnabled: () => true });
    await third.host.orchestrator.reconcile();
    await third.host.settle();
    assert.equal(sendsOf(adapter).length + sendsOf(third.adapter).filter((input) => input !== CONTINUATION_PROMPT).length, 1);
    await third.host.stop();
  });

  it("a completion the CLI already consumed — a turn started after it — is never re-delivered", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    // The head write that cleared the mark was lost; the log says a turn started.
    const stale = structuredClone(scene.host.store.heads.get(THREAD)!);
    await scene.at("2026-10-23T09:20:12.900Z");
    scene.emit("turn.started", {}, { turnId: "wake-turn" });
    scene.emit("turn.completed", { state: "completed" }, { turnId: "wake-turn" });
    await scene.host.settle();
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop();
    scene.host.store.heads.set(THREAD, { ...scene.host.store.heads.get(THREAD)!, pendingWake: stale.pendingWake! });

    const { host, adapter } = nextHost(scene, { firstTurn: 3, continuationEnabled: () => true });
    await host.orchestrator.reconcile();
    await host.settle();
    assert.deepEqual(sendsOf(adapter), []);
    assert.deepEqual(notesOf(host.store), []);
    assert.equal(host.store.heads.get(THREAD)?.pendingWake, undefined, "the stale mark goes");
    await host.stop();
  });

  it("a crash while the wake streamed (no teardown, the head still running): resumed with the result", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    await scene.at("2026-10-23T09:20:11.005Z");
    scene.emit("session.state.changed", { state: "running", reason: "wake:streaming" });
    await scene.host.settle();
    // A background shell was still running too.
    scene.emit("task.started", { taskId: "b2flqtqds", taskType: "local_bash", title: "Wait for daemon suite" });
    await scene.host.settle();
    assert.equal(scene.host.store.heads.get(THREAD)?.session.status, "running");
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop(); // a crash: nothing settles anything

    const { host, adapter } = nextHost(scene, { firstTurn: 3, continuationEnabled: () => true });
    await host.orchestrator.reconcile();
    await host.settle();
    const sends = sendsOf(adapter);
    assert.equal(sends.length, 1);
    assert.ok(sends[0]!.includes(RESULT));
    assert.match(sends[0]!, /still running when the agent host stopped, and it was stopped with it: "Wait for daemon suite" \(background task\)/);
    const log = host.store.logs.get(THREAD)!;
    const stoppedRow = log.find(
      (event) => event.type === "thread.activity-appended" && event.payload.activity.summary === "Background work stopped with the agent host"
    );
    assert.ok(stoppedRow, "the leftover-work report names the stopped shell in the chat");
    assert.match(detailOf(notesOf(host.store)[0]!), /Stopped with the restart: "Wait for daemon suite" \(background task\)/);
    assert.equal(
      log.some((event) => event.type === "thread.activity-appended" && event.payload.activity.summary === "Session did not survive a restart"),
      false,
      "a wake that died streaming is no failed turn"
    );
    await host.stop();
  });

  it("a host that dies between preparing the delivery and sending it counts on, bounded", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop();
    let current: Scene = scene;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const dying = nextHost(current, { firstTurn: 2 + attempt, continuationEnabled: () => true });
      let onDisk: { head: unknown; log: DomainEvent[]; binding: unknown } | null = null;
      dying.adapter.startSession = async () => {
        onDisk = {
          head: structuredClone(dying.host.store.heads.get(THREAD)),
          log: [...dying.host.store.logs.get(THREAD)!],
          binding: structuredClone(dying.host.store.bindings.get(THREAD))
        };
        throw new Error("the host died here");
      };
      await dying.host.orchestrator.reconcile();
      await dying.host.settle();
      await dying.host.stop();
      const crashed = onDisk as unknown as { head: never; log: DomainEvent[]; binding: never };
      assert.ok(crashed);
      dying.host.store.heads.set(THREAD, crashed.head);
      dying.host.store.logs.set(THREAD, crashed.log);
      dying.host.store.bindings.set(THREAD, crashed.binding);
      dying.host.store.snapshots.delete(THREAD);
      const mark = dying.host.store.heads.get(THREAD)?.pendingWake;
      assert.deepEqual({ prepared: mark?.prepared, attempt: mark?.attempt }, { prepared: true, attempt });
      current = { ...scene, host: dying.host };
    }
    const last = nextHost(current, { firstTurn: 5, continuationEnabled: () => true });
    await last.host.orchestrator.reconcile();
    await last.host.settle();
    assert.deepEqual(sendsOf(last.adapter), [], "not a third time");
    assert.match(detailOf(notesOf(last.host.store).at(-1)!), /stopped again while handing the agent the result/);
    assert.equal(last.host.store.heads.get(THREAD)?.pendingWake, undefined);
    assert.notEqual(last.host.store.heads.get(THREAD)?.session.status, "starting");
    await last.host.stop();
  });

  it("a project that opted out: nothing is resumed, but the chat says what finished", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    await scene.host.orchestrator.markThreadsForContinuation();
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop();

    const { host, adapter } = nextHost(scene, { firstTurn: 3, continuationEnabled: () => false });
    await host.orchestrator.reconcile();
    await host.settle();
    assert.deepEqual(sendsOf(adapter), []);
    const notes = notesOf(host.store);
    assert.equal(notes.length, 1);
    assert.match(detailOf(notes[0]!), /continuing after a restart is off for this project\. Send a message to continue\./);
    assert.equal(host.store.heads.get(THREAD)?.pendingWake, undefined);
    await host.stop();
  });

  it("a thread whose tab was closed is let go of silently", async () => {
    const scene = await sceneBeforeTheEnd();
    await subagentEnds(scene);
    scene.adapter.close();
    await scene.consumed;
    await scene.host.stop();
    const { host, adapter } = nextHost(scene, { firstTurn: 3, continuationEnabled: () => true, isThreadClosed: () => true });
    await host.orchestrator.reconcile();
    await host.settle();
    assert.deepEqual(sendsOf(adapter), []);
    assert.deepEqual(notesOf(host.store), []);
    assert.equal(host.store.heads.get(THREAD)?.pendingWake, undefined);
    await host.stop();
  });

  it("a deploy's teardown that stops a running shell says so in the chat", async () => {
    const scene = await sceneBeforeTheEnd();
    const { host, emit } = scene;
    emit("task.started", { taskId: "dev", taskType: "local_bash", title: "pnpm dev" });
    await host.settle();
    await host.orchestrator.markThreadsForContinuation();
    // The adapter's teardown closes what it ran.
    emit("task.completed", { taskId: "dev", taskType: "local_bash", status: "stopped" });
    emit("task.completed", { taskId: SUBAGENT, taskType: "local_agent", status: "stopped" });
    await host.settle();
    scene.adapter.close();
    await scene.consumed;
    await host.stop();
    const notice = host.store.logs
      .get(THREAD)!
      .flatMap((event) => (event.type === "thread.activity-appended" ? [event.payload.activity] : []))
      .find((activity) => /background tasks stopped with the agent host/.test(activity.summary));
    assert.ok(notice);
    assert.match(detailOf(notice), /pnpm dev \(background task\)/);
    assert.match(detailOf(notice), /Fix: revocable auth sessions \(agent\)/);
  });
});

describe("a quiet background shell stays live while it runs (2026-10-23)", () => {
  it("17 silent minutes and a turn of the user's own later, it still holds the drain — and says what it is", async () => {
    const scene = await sceneBeforeTheEnd();
    const { host, emit, adapter } = scene;
    adapter.live.add("suite");
    emit(
      "item.started",
      { itemType: "command_execution", status: "inProgress", title: "Background shell", data: { command: "pnpm test > /tmp/suite.log 2>&1", toolName: "Bash" } },
      { itemId: "bgshell:suite" }
    );
    emit("task.started", { taskId: "suite", taskType: "local_bash", title: "Run the full suite" });
    await host.settle();
    await scene.at("2026-10-23T09:37:00.000Z");
    await host.orchestrator.command(THREAD, "turn", { commandId: cmd(), input: "status?" });
    await host.settle();
    const turnId = adapter.turnIds.at(-1)!;
    emit("turn.started", {}, { turnId });
    emit("turn.completed", { state: "completed" }, { turnId });
    await host.settle();
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), [THREAD]);
    assert.equal(host.orchestrator.summary(THREAD)?.backgroundLiveness, "working", "the subagent and the shell");
    const suite = host.orchestrator.backgroundTasks().find((task) => task.taskId === "suite");
    assert.deepEqual(
      suite && { kind: suite.kind, title: suite.title, command: suite.command, stoppable: suite.stoppable },
      { kind: "background", title: "Run the full suite", command: "pnpm test > /tmp/suite.log 2>&1", stoppable: true }
    );
    // Its process ends: the adapter says so, and only then is it gone.
    adapter.live.delete("suite");
    adapter.live.delete(SUBAGENT);
    assert.deepEqual(host.orchestrator.backgroundWorkThreadIds(), []);
    adapter.close();
    await scene.consumed;
    await host.stop();
  });
});
