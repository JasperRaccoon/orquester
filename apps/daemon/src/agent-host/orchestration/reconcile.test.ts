/**
 * §3.3 reconcile, asserted headlessly (spec §9: "tested headlessly, not only by
 * restarting a real daemon"). Every restart flavour is driven through a
 * scripted adapter and a temporary in-memory store; the assertions are on the
 * resulting head and on which continuation call the adapter received — and on
 * what a thread's first load closes of the work a dead process left open (one
 * of those on the real store, for what reaches the disk).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  foldSubagentActivities,
  openWorkOf,
  type DomainEvent,
  type ThreadActivityItem,
  type ThreadItem
} from "@orquester/api/agent-chat";

import {
  CONTINUATION_FAILED_MESSAGE,
  CONTINUATION_PROMPT,
  CONTINUATION_SEND_FAILED_MESSAGE
} from "../host-protocol.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "../store/index.ts";
import { LEFTOVER_CALL_DETAIL } from "./leftover-work.ts";
import { PENDING_TURN_GRACE_MS } from "./orchestrator.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type FakeThreadStore,
  type TestHost
} from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `rc-${(commandSeq += 1)}`;

/** Build a thread that was mid-turn when the host died. */
async function threadInFlight(options: {
  continuationEnabled?: boolean;
} = {}): Promise<{ store: FakeThreadStore; threadId: string; first: TestHost }> {
  const first = createTestHost();
  const threadId = await first.createThread();
  await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
  await first.settle();
  // The head is persisted with `status: running` and an active turn.
  const head = first.store.heads.get(threadId);
  assert.equal(head?.session.status, "running");
  assert.equal(head?.session.activeTurnId, "turn-1");
  void options;
  return { store: first.store, threadId, first };
}

function headOf(store: FakeThreadStore, threadId: string) {
  const head = store.heads.get(threadId);
  assert.ok(head, "the head was persisted");
  return head;
}

function sessionEvents(store: FakeThreadStore, threadId: string) {
  return (store.logs.get(threadId) ?? []).filter(
    (event): event is Extract<DomainEvent, { type: "thread.session-set" }> =>
      event.type === "thread.session-set"
  );
}

/**
 * Count every read of a thread's LOG the store serves, per thread — the cost
 * the lazy boot (design 2026-09-23, A1) exists to avoid. Installed on the
 * store the next host is built on, before it is built.
 */
function countLogReads(store: FakeThreadStore): Map<string, number> {
  const reads = new Map<string, number>();
  const bump = (threadId: string): void => {
    reads.set(threadId, (reads.get(threadId) ?? 0) + 1);
  };
  const readAll = store.readAll.bind(store);
  store.readAll = async (threadId) => {
    bump(threadId);
    return readAll(threadId);
  };
  const readTail = store.readTail.bind(store);
  store.readTail = async (threadId, afterSeq) => {
    bump(threadId);
    return readTail(threadId, afterSeq);
  };
  const readEventsFrom = store.readEventsFrom.bind(store);
  store.readEventsFrom = async (threadId, input) => {
    bump(threadId);
    return readEventsFrom(threadId, input);
  };
  return reads;
}

/** A persisted event, as a host that died mid-command left it in the log. */
function persisted<TType extends DomainEvent["type"]>(
  threadId: string,
  seq: number,
  type: TType,
  payload: Extract<DomainEvent, { type: TType }>["payload"],
  occurredAt: string
): DomainEvent {
  return {
    seq,
    eventId: `persisted-${seq}`,
    threadId,
    type,
    payload,
    occurredAt,
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as DomainEvent;
}

/**
 * The host died between a `/turn`'s commit and its effect: the user's message
 * and the pending turn row are in the log, the head never left `idle`.
 */
function appendStrandedTurn(store: FakeThreadStore, threadId: string, requestedAt: string): void {
  const log = store.logs.get(threadId);
  assert.ok(log, "the thread has a log");
  log.push(
    persisted(
      threadId,
      log.length + 1,
      "thread.message-sent",
      { messageId: "user:stranded", role: "user", text: "never sent", streaming: false, turnId: null },
      requestedAt
    )
  );
  log.push(
    persisted(
      threadId,
      log.length + 1,
      "thread.turn-start-requested",
      { turnId: null, messageId: "user:stranded", interactionMode: "default" },
      requestedAt
    )
  );
}

let sinkSeq = 0;
/** An event as ingestion hands it to the sink: the store assigns the seq. */
function sunk<TType extends DomainEvent["type"]>(
  threadId: string,
  type: TType,
  payload: Extract<DomainEvent, { type: TType }>["payload"]
): AppendableDomainEvent {
  sinkSeq += 1;
  return {
    eventId: `sunk-${sinkSeq}`,
    threadId,
    type,
    payload,
    occurredAt: "2026-09-24T10:00:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as AppendableDomainEvent;
}

function sunkRow(
  threadId: string,
  id: string,
  activityKind: string,
  payload: Record<string, unknown>,
  over: Partial<ThreadActivityItem> = {}
): AppendableDomainEvent {
  return sunk(threadId, "thread.activity-appended", {
    activity: {
      kind: "activity",
      id,
      tone: activityKind.startsWith("tool.") ? "tool" : "info",
      activityKind,
      summary: activityKind,
      payload,
      turnId: null,
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:00.000Z",
      ...over
    }
  });
}

/**
 * What a provider process had running when its host died, as ingestion wrote
 * it: a parent call, a background shell (its task, then its item), a subagent
 * working between parent turns with a call of its own and words still
 * streaming, and a Codex-style child whose turn finished — `idle`, resumable.
 */
function leftoverRows(threadId: string): AppendableDomainEvent[] {
  return [
    sunkRow(threadId, "parent-start", "tool.started", {
      itemType: "command_execution",
      toolUseId: "toolu_parent",
      status: "inProgress",
      title: "Bash",
      data: { toolName: "Bash", input: {} }
    }, { turnId: "turn-1", status: "inProgress" }),
    sunkRow(threadId, "parent-update", "tool.updated", {
      itemType: "command_execution",
      toolUseId: "toolu_parent",
      status: "inProgress",
      title: "Bash",
      data: { toolName: "Bash", input: { command: "npm test" } }
    }, { turnId: "turn-1", status: "inProgress" }),
    sunkRow(threadId, "shell-task", "task.started", {
      taskId: "shell-1",
      detail: "npm run dev",
      agentKind: "background",
      taskType: "local_bash",
      title: "npm run dev",
      toolUseId: "toolu_shell"
    }, { turnId: "turn-1" }),
    sunkRow(threadId, "shell-item", "tool.started", {
      itemType: "command_execution",
      toolUseId: "bgshell:shell-1",
      status: "inProgress",
      title: "Background shell",
      agentId: "shell-1",
      data: { toolName: "Bash", input: { command: "npm run dev" }, background: true }
    }, { turnId: "turn-1", agentId: "shell-1", status: "inProgress" }),
    sunkRow(threadId, "shell-chunk", "tool.output", {
      toolUseId: "bgshell:shell-1",
      streamKind: "command_output",
      delta: "ready on :5173\n"
    }, { agentId: "shell-1" }),
    sunkRow(threadId, "agent-task", "task.started", {
      taskId: "agent-1",
      detail: "Explore the repo",
      agentKind: "agent",
      taskType: "local_agent",
      title: "Explore the repo",
      toolUseId: "toolu_launch"
    }, { turnId: "turn-1" }),
    sunkRow(threadId, "agent-call", "tool.started", {
      itemType: "command_execution",
      toolUseId: "toolu_agent_call",
      status: "inProgress",
      title: "Bash",
      agentId: "agent-1",
      parentToolUseId: "toolu_launch",
      data: { toolName: "Bash", input: { command: "rg TODO" } }
    }, { agentId: "agent-1", parentToolUseId: "toolu_launch", status: "inProgress" }),
    sunkRow(threadId, "codex-task", "task.started", {
      taskId: "codex-child",
      detail: "agent codex-child",
      agentKind: "agent",
      title: "Reviewer",
      toolUseId: "codex-run:t1"
    }, { turnId: "turn-1" }),
    sunkRow(threadId, "codex-idle", "task.updated", { taskId: "codex-child", status: "idle", agentKind: "agent" }),
    sunk(threadId, "thread.message-sent", {
      messageId: "assistant:agent-1:m1",
      role: "assistant",
      text: "Looking at the tests",
      streaming: true,
      turnId: null,
      agentId: "agent-1"
    })
  ];
}

/** The closings `leftoverRows` owes, in the order a first load appends them. */
const LEFTOVER_CLOSINGS = [
  ["tool.completed", "toolu_parent"],
  ["tool.completed", "bgshell:shell-1"],
  ["tool.completed", "toolu_agent_call"],
  // The shell's item before its task, as the adapters close one.
  ["task.completed", "shell-1"],
  ["task.completed", "agent-1"],
  ["message", "assistant:agent-1:m1"]
];

/** Each closing an event appended: its row kind and the unit it ends. */
function closingsIn(events: readonly DomainEvent[]): string[][] {
  const closings: string[][] = [];
  for (const event of events) {
    if (event.type === "thread.message-sent" && !event.payload.streaming) {
      closings.push(["message", event.payload.messageId]);
    }
    if (event.type !== "thread.activity-appended") continue;
    const { activity } = event.payload;
    const payload = activity.payload as Record<string, unknown>;
    if (activity.activityKind === "tool.completed") {
      closings.push([activity.activityKind, String(payload.toolUseId)]);
    } else if (activity.activityKind === "task.completed") {
      closings.push([activity.activityKind, String(payload.taskId)]);
    }
  }
  return closings;
}

/**
 * "Open ⇒ running", read as every reader reads it once a session is live
 * again: no open call, no open background task, no active roster row, no
 * streaming message — and the idle child still idle.
 */
function assertNothingRunning(items: readonly ThreadItem[]): void {
  const activities = items.filter((item): item is ThreadActivityItem => item.kind === "activity");
  assert.deepEqual(openWorkOf(activities), { calls: [], tasks: [] });
  assert.deepEqual(
    foldSubagentActivities(activities, { sessionLive: true }).map((row) => [row.id, row.status]),
    [
      ["shell-1", "interrupted"],
      ["agent-1", "interrupted"],
      ["codex-child", "idle"]
    ]
  );
  assert.deepEqual(
    items.filter((item) => item.kind === "message" && item.streaming).map((item) => item.id),
    []
  );
}

/** The items of a whole-thread read, which is always a snapshot. */
function snapshotItems(read: Awaited<ReturnType<TestHost["orchestrator"]["readThread"]>>): ThreadItem[] {
  assert.equal(read.kind, "snapshot");
  return read.kind === "snapshot" ? read.thread.items : [];
}

describe("reconcile — the lazy boot (design 2026-09-23, A1)", () => {
  it("folds an orphaned thread at boot and never reads an idle one", async () => {
    const first = createTestHost();
    const orphan = await first.createThread({ threadId: "orphan" });
    await first.orchestrator.command(orphan, "turn", { commandId: cmd(), input: "long job" });
    const idle = await first.createThread({ threadId: "idle" });
    await first.settle();
    await first.stop();
    assert.equal(headOf(first.store, orphan).session.status, "running");
    assert.equal(headOf(first.store, idle).session.status, "idle");

    const reads = countLogReads(first.store);
    const next = createTestHost({ store: first.store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();

    assert.ok((reads.get(orphan) ?? 0) > 0, "the orphaned thread is folded and settled at boot");
    assert.equal(headOf(first.store, orphan).session.status, "error");
    assert.equal(reads.get(idle) ?? 0, 0, "an idle thread's log is never read at boot");
    assert.deepEqual(next.orchestrator.liveThreadIds(), []);
    assert.deepEqual(next.orchestrator.activeTurnThreadIds(), []);

    // …and it folds on first use, exactly as before.
    const read = await next.orchestrator.readThread(idle);
    assert.equal(read.kind, "snapshot");
    assert.ok((reads.get(idle) ?? 0) > 0);
    await next.stop();
  });

  it("settles a stale pending turn on the thread's first load after boot, never at boot", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.stop();
    appendStrandedTurn(first.store, threadId, first.clock.nowIso());
    const logLength = first.store.logs.get(threadId)!.length;

    const next = createTestHost({ store: first.store });
    // Well past §3.4's grace window: this send is never going to happen.
    next.clock.advance(PENDING_TURN_GRACE_MS + 60_000);
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(
      first.store.logs.get(threadId)!.length,
      logLength,
      "boot appends nothing to a thread it did not fold"
    );

    // Two concurrent first reads: both see the thread already settled.
    const [left, right] = await Promise.all([
      next.orchestrator.readThread(threadId),
      next.orchestrator.readThread(threadId)
    ]);
    for (const read of [left, right]) {
      assert.equal(read.kind, "snapshot");
      if (read.kind !== "snapshot") continue;
      assert.equal(read.thread.turns.at(-1)?.state, "interrupted");
      assert.equal(read.thread.head.session.status, "stopped");
      const failure = read.thread.items.find(
        (item) => item.kind === "activity" && item.activityKind === "provider.turn.start.failed"
      );
      assert.ok(failure, "the reason is on the timeline");
    }
    const settledLength = first.store.logs.get(threadId)!.length;
    assert.ok(settledLength > logLength);

    // Once: a later read settles nothing again.
    await next.orchestrator.readThread(threadId);
    await next.settle();
    assert.equal(first.store.logs.get(threadId)!.length, settledLength);
    await next.stop();
  });

  it("leaves a pending turn inside the grace window alone on first load", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.stop();
    appendStrandedTurn(first.store, threadId, first.clock.nowIso());
    const logLength = first.store.logs.get(threadId)!.length;

    const next = createTestHost({ store: first.store });
    await next.orchestrator.reconcile();
    const read = await next.orchestrator.readThread(threadId);
    assert.equal(read.kind === "snapshot" ? read.thread.turns.at(-1)?.state : null, "pending");
    assert.equal(first.store.logs.get(threadId)!.length, logLength);
    await next.stop();
  });

  it("settles a stale pending turn before the first command on it runs", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.stop();
    appendStrandedTurn(first.store, threadId, first.clock.nowIso());

    const next = createTestHost({ store: first.store });
    next.clock.advance(PENDING_TURN_GRACE_MS + 60_000);
    await next.orchestrator.reconcile();
    await next.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello again" });
    await next.settle();

    const log = first.store.logs.get(threadId)!;
    const stopped = log.findIndex(
      (event) => event.type === "thread.session-set" && event.payload.session.status === "stopped"
    );
    const message = log.findIndex(
      (event) =>
        event.type === "thread.message-sent" &&
        event.payload.role === "user" &&
        event.payload.text === "hello again"
    );
    assert.ok(stopped !== -1 && message !== -1);
    assert.ok(stopped < message, "the stranded turn is settled before the new message lands");
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);
    await next.stop();
  });

  it("an intentional stop after a lazy boot never folds a thread it did not load", async () => {
    const first = createTestHost({ continuationEnabled: () => true });
    const idle = await first.createThread({ threadId: "idle" });
    await first.stop();

    const reads = countLogReads(first.store);
    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    assert.deepEqual(await next.orchestrator.markThreadsForContinuation(), []);
    assert.equal(reads.get(idle) ?? 0, 0);
    await next.stop();
  });

  it("an intentional stop still marks a running thread the host serves", async () => {
    const host = createTestHost({ continuationEnabled: () => true });
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await host.settle();
    await host.createThread({ threadId: "quiet" });
    assert.deepEqual(await host.orchestrator.markThreadsForContinuation(), [threadId]);
    await host.stop();
  });

  it("a thread whose head cannot be read is folded at boot rather than guessed", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    await first.stop();
    // `meta.json` is gone; only the log can say the turn was running.
    first.store.heads.delete(threadId);

    const reads = countLogReads(first.store);
    const next = createTestHost({ store: first.store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.ok((reads.get(threadId) ?? 0) > 0);
    assert.equal(headOf(first.store, threadId).session.status, "error");
    await next.stop();
  });
});

describe("reconcile (§3.3)", () => {
  it("settles an orphaned turn as an error when continuation is off", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();

    const head = headOf(store, threadId);
    assert.equal(head.session.status, "error");
    assert.equal(head.session.activeTurnId, null);
    assert.equal(head.session.lastError, CONTINUATION_FAILED_MESSAGE);
    assert.equal(head.continueAfterRestart, undefined);
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    await next.stop();
  });

  it("continues an orphaned turn when the project opted in, and clears the marker", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();

    const sends = next.adapter.calls.filter((call) => call.kind === "sendTurn");
    assert.equal(sends.length, 1);
    assert.equal((sends[0]?.detail as { input: string }).input, CONTINUATION_PROMPT);
    // Resumed from the persisted cursor.
    assert.deepEqual(next.adapter.lastStart?.resumeCursor, { cursor: "turn-1" });
    const head = headOf(store, threadId);
    assert.equal(head.continueAfterRestart, undefined, "the marker is cleared on success");
    assert.equal(head.session.status, "running");
    await next.stop();
  });

  it("sends a promptless continuation where the adapter declares it (Codex)", async () => {
    const codex = createScriptedAdapter({
      id: "codex",
      capabilities: { promptlessTurnContinuation: true }
    });
    const first = createTestHost({ adapters: { codex } });
    const threadId = await first.createThread({ refId: "codex" });
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await first.settle();
    await first.stop();

    const codex2 = createScriptedAdapter({
      id: "codex",
      capabilities: { promptlessTurnContinuation: true }
    });
    const next = createTestHost({
      store: first.store,
      adapters: { codex: codex2 },
      continuationEnabled: () => true
    });
    await next.orchestrator.reconcile();
    await next.settle();

    const send = codex2.calls.find((call) => call.kind === "sendTurn");
    assert.ok(send);
    const detail = send?.detail as { input: string; continuation?: boolean };
    assert.equal(detail.continuation, true);
    assert.equal(detail.input, "");
    await next.stop();
  });

  it("settles rather than continues a thread whose tab was closed", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    const next = createTestHost({
      store,
      continuationEnabled: () => true,
      isThreadClosed: (id) => id === threadId
    });
    await next.orchestrator.reconcile();
    await next.settle();

    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    assert.equal(headOf(store, threadId).session.status, "error");
    await next.stop();
  });

  it("settles a thread with no resume cursor", async () => {
    const adapter = createScriptedAdapter({ id: "claude" });
    // An adapter whose sendTurn hands back no cursor.
    const originalSend = adapter.sendTurn.bind(adapter);
    adapter.sendTurn = async (input) => {
      const result = await originalSend(input);
      return { turnId: result.turnId };
    };
    const originalStart = adapter.startSession.bind(adapter);
    adapter.startSession = async (input) => {
      const session = await originalStart(input);
      const { resumeCursor: _unused, ...rest } = session;
      void _unused;
      return rest;
    };
    const first = createTestHost({ adapters: { claude: adapter } });
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await first.settle();
    await first.stop();

    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    assert.equal(headOf(first.store, threadId).session.lastError, CONTINUATION_FAILED_MESSAGE);
    await next.stop();
  });

  it("continues a `ready` thread whose marker says prepared-but-never-sent", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    // Simulate a host that resumed and died before sending: `ready`, no active
    // turn, marker with `prepared`.
    const head = headOf(store, threadId);
    store.heads.set(threadId, {
      ...head,
      session: { ...head.session, status: "ready", activeTurnId: null },
      continueAfterRestart: { turnId: "turn-1", prepared: true }
    });
    store.logs.get(threadId)?.push({
      seq: (store.logs.get(threadId)?.length ?? 0) + 1,
      eventId: "prepared",
      threadId,
      type: "thread.session-set",
      payload: {
        session: { status: "ready", activeTurnId: null, resumeCursor: { cursor: "turn-1" } }
      },
      occurredAt: new Date(0).toISOString(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    } as DomainEvent);

    const next = createTestHost({ store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();

    // The marker alone is enough — without it this looks like a settled thread
    // and the turn would be silently dropped.
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);
    await next.stop();
  });

  it("leaves an idle thread alone — lazy recovery re-adopts it", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.stop();

    const reads = countLogReads(first.store);

    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(next.adapter.calls.length, 0);
    assert.equal(sessionEvents(first.store, threadId).length, 0);
    assert.equal(reads.get(threadId) ?? 0, 0, "startup must not fold an idle thread's complete history");
    await next.stop();
  });

  it("does not reconcile a thread the host can still see running", async () => {
    const { store, threadId, first } = await threadInFlight();
    // The adapter survived (an adopted host): its session is still listed.
    const surviving = createScriptedAdapter({ id: "claude" });
    await surviving.startSession({
      threadId,
      cwd: "/work/project",
      home: { kind: "account", path: "/tmp/home/acc1" },
      modelSelection: { model: "test-model" },
      runtimeMode: "approval-required"
    });
    const next = createTestHost({
      store,
      adapters: { claude: surviving },
      continuationEnabled: () => true
    });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(surviving.calls.filter((call) => call.kind === "sendTurn").length, 0);
    assert.equal(headOf(store, threadId).session.status, "running");
    await first.stop();
    await next.stop();
  });

  it("settles individually and never fails the whole pass", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();
    // A second thread whose head cannot be folded at all.
    store.logs.set("broken", []);

    const next = createTestHost({ store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(headOf(store, threadId).session.status, "error");
    await next.stop();
  });

  it("an intentional stop marks only a project that opted in, and clears on abort", async () => {
    const opted = createTestHost({ continuationEnabled: () => true });
    const threadId = await opted.createThread();
    await opted.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await opted.settle();

    const marked = await opted.orchestrator.markThreadsForContinuation();
    assert.deepEqual(marked, [threadId]);
    assert.deepEqual(headOf(opted.store, threadId).continueAfterRestart, { turnId: "turn-1" });

    await opted.orchestrator.clearContinuationMarkers(marked);
    assert.equal(headOf(opted.store, threadId).continueAfterRestart, undefined);
    await opted.stop();
  });

  it("an intentional stop does NOT mark a project that opted out", async () => {
    // §3.3: continuation is opt-in per project over a host-wide default that
    // is off. The reconcile trusts a marker on its own, so writing one for an
    // opted-out thread is what would resume it — and spend tokens on a turn
    // that may have been halfway through something destructive.
    const { store, threadId, first } = await threadInFlight();
    const marked = await first.orchestrator.markThreadsForContinuation();
    assert.deepEqual(marked, []);
    assert.equal(headOf(store, threadId).continueAfterRestart, undefined);
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    assert.equal(headOf(store, threadId).session.status, "error");
    await next.stop();
  });

  it("an intentional stop rejects idle metadata without cold-folding the history", async () => {
    const first = createTestHost({ continuationEnabled: () => true });
    const threadId = await first.createThread();
    await first.stop();

    const reads = countLogReads(first.store);

    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    assert.deepEqual(await next.orchestrator.markThreadsForContinuation(), []);
    assert.equal(
      reads.get(threadId) ?? 0,
      0,
      `idle thread ${threadId} must not be folded during handover`
    );
    await next.stop();
  });

  it("writes the prepared marker and the binding BEFORE the continuation is sent", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => true });
    // What the world looked like at the instant the provider was asked. §3.3:
    // "the second write is what makes recovery survive a host that dies
    // BETWEEN resuming and sending".
    const snapshot = (label: string) => ({
      label,
      marker: store.heads.get(threadId)?.continueAfterRestart,
      bindingStatus: store.bindings.get(threadId)?.status,
      headStatus: store.heads.get(threadId)?.session.status
    });
    const observed: Array<ReturnType<typeof snapshot>> = [];
    const start = next.adapter.startSession.bind(next.adapter);
    next.adapter.startSession = async (input) => {
      observed.push(snapshot("startSession"));
      return start(input);
    };
    const send = next.adapter.sendTurn.bind(next.adapter);
    next.adapter.sendTurn = async (input) => {
      observed.push(snapshot("sendTurn"));
      return send(input);
    };
    await next.orchestrator.reconcile();
    await next.settle();

    assert.deepEqual(
      observed.map((entry) => entry.label),
      ["startSession", "sendTurn"]
    );
    // Both writes are on disk before the provider is touched at all.
    assert.deepEqual(observed[0]?.marker, { turnId: "turn-1", prepared: true });
    assert.equal(observed[0]?.bindingStatus, "starting");
    assert.equal(observed[0]?.headStatus, "starting");
    // And the marker is still there when the continuation is actually sent —
    // a host dying in THIS window must be recovered by the next boot.
    assert.deepEqual(observed[1]?.marker, { turnId: "turn-1", prepared: true });
    await next.stop();
  });

  it("a continuation that fails says so, and clears its marker", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => true });
    next.adapter.failNext("failSendTurn", new Error("provider refused"));
    await next.orchestrator.reconcile();
    await next.settle();

    const head = headOf(store, threadId);
    assert.equal(head.session.status, "error");
    assert.equal(head.session.activeTurnId, null);
    // The ATTEMPTED-and-failed copy, not the never-eligible one.
    assert.equal(head.session.lastError, CONTINUATION_SEND_FAILED_MESSAGE);
    assert.equal(head.continueAfterRestart, undefined);
    assert.equal(store.bindings.get(threadId)?.status, "stopped");
    // The cursor survives the failure: the user sends again into the SAME
    // conversation rather than a fresh one.
    assert.deepEqual(store.bindings.get(threadId)?.resumeCursor, { cursor: "turn-1" });
    await next.stop();
  });

  it("a prepare that cannot reach disk settles instead of sending", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => true });
    const append = store.append.bind(store);
    let failed = false;
    store.append = async (input) => {
      if (!failed && input.threadId === threadId) {
        failed = true;
        throw new Error("disk is full");
      }
      return append(input);
    };
    await next.orchestrator.reconcile();
    await next.settle();

    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    assert.equal(headOf(store, threadId).session.lastError, CONTINUATION_FAILED_MESSAGE);
    assert.equal(headOf(store, threadId).continueAfterRestart, undefined);
    store.append = append;
    await next.stop();
  });

  it("a marker from an older turn is ignored rather than replaying the wrong work", async () => {
    const { store, threadId, first } = await threadInFlight();
    await first.stop();
    const head = headOf(store, threadId);
    store.heads.set(threadId, {
      ...head,
      continueAfterRestart: { turnId: "turn-999" }
    });

    const next = createTestHost({ store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 0);
    assert.equal(headOf(store, threadId).session.status, "error");
    await next.stop();
  });
});

describe("reconcile — a host start closes what a dead process left open", () => {
  /** A thread whose last host died with `leftoverRows` running, its head idle. */
  async function idleThreadWithLeftovers(): Promise<{ store: FakeThreadStore; threadId: string; logLength: number }> {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.orchestrator.ingestionSink(threadId, leftoverRows(threadId));
    await first.settle();
    await first.stop();
    // Not orphaned by `meta.json`: background work outlives the turn that
    // launched it, so a host can die under it with the head at rest.
    assert.equal(isOrphaned(headOf(first.store, threadId)), false);
    return { store: first.store, threadId, logLength: first.store.logs.get(threadId)!.length };
  }

  const isOrphaned = (head: ReturnType<typeof headOf>): boolean =>
    head.session.status === "running" || head.session.activeTurnId !== null;

  it("a thread's first load closes every call, active task and streaming message the fold shows — the idle child untouched", async () => {
    const { store, threadId, logLength } = await idleThreadWithLeftovers();

    const next = createTestHost({ store });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(store.logs.get(threadId)!.length, logLength, "boot appends nothing to a thread it did not fold");

    const read = await next.orchestrator.readThread(threadId);
    const appended = store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), LEFTOVER_CLOSINGS);
    assert.equal(appended.length, LEFTOVER_CLOSINGS.length, "nothing else is written");
    const calls = appended.flatMap((event) =>
      event.type === "thread.activity-appended" && event.payload.activity.activityKind === "tool.completed"
        ? [event.payload.activity]
        : []
    );
    for (const call of calls) {
      const payload = call.payload as Record<string, unknown>;
      assert.equal(payload.status, "failed");
      assert.equal(payload.detail, LEFTOVER_CALL_DETAIL);
    }
    // Each closer in the window of the row that opened its call.
    assert.deepEqual(
      calls.map((call) => [call.turnId, call.agentId ?? null]),
      [
        ["turn-1", null],
        ["turn-1", "shell-1"],
        [null, "agent-1"]
      ]
    );

    // The first reader's snapshot already has nothing running.
    const items = snapshotItems(read);
    assertNothingRunning(items);
    const message = items.find((item) => item.id === "assistant:agent-1:m1");
    assert.deepEqual(
      message?.kind === "message" ? [message.text, message.streaming, message.turnId, message.agentId] : null,
      ["Looking at the tests", false, null, "agent-1"],
      "settled with its text unchanged"
    );
    await next.stop();
  });

  it("a second load appends nothing", async () => {
    const { store, threadId, logLength } = await idleThreadWithLeftovers();
    const next = createTestHost({ store });
    await next.orchestrator.reconcile();
    await next.orchestrator.readThread(threadId);
    await next.settle();
    await next.stop();
    const settled = store.logs.get(threadId)!.length;
    assert.equal(settled, logLength + LEFTOVER_CLOSINGS.length);

    // Later reads in the same host lifetime, then a whole new host.
    const third = createTestHost({ store });
    await third.orchestrator.reconcile();
    const read = await third.orchestrator.readThread(threadId);
    await third.orchestrator.readThread(threadId);
    await third.settle();
    assert.equal(store.logs.get(threadId)!.length, settled);
    assertNothingRunning(snapshotItems(read));
    await third.stop();
  });

  it("the orphaned-thread reconcile closes them too, before it settles the turn", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    await first.orchestrator.ingestionSink(threadId, leftoverRows(threadId));
    await first.settle();
    await first.stop();
    assert.equal(headOf(first.store, threadId).session.status, "running");
    const logLength = first.store.logs.get(threadId)!.length;

    const next = createTestHost({ store: first.store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();

    const appended = first.store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), LEFTOVER_CLOSINGS);
    const settledAt = appended.findIndex(
      (event) => event.type === "thread.session-set" && event.payload.session.status === "error"
    );
    assert.ok(settledAt !== -1, "the orphaned turn was settled");
    assert.deepEqual(closingsIn(appended.slice(0, settledAt)), LEFTOVER_CLOSINGS, "all of it before the settle");
    // A task's row rides the turn the head said was running, as a teardown's does.
    const stopped = appended.flatMap((event) =>
      event.type === "thread.activity-appended" && event.payload.activity.activityKind === "task.completed"
        ? [event.payload.activity.turnId]
        : []
    );
    assert.deepEqual(stopped, ["turn-1", "turn-1"]);
    assert.equal(headOf(first.store, threadId).session.status, "error");

    assertNothingRunning(snapshotItems(await next.orchestrator.readThread(threadId)));
    await next.orchestrator.readThread(threadId);
    await next.settle();
    assert.equal(first.store.logs.get(threadId)!.length, logLength + appended.length);
    await next.stop();
  });

  it("closes them ahead of a continuation as well: the new process owns none of them", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    await first.orchestrator.ingestionSink(threadId, leftoverRows(threadId));
    await first.settle();
    await first.stop();
    const logLength = first.store.logs.get(threadId)!.length;

    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();

    const appended = first.store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), LEFTOVER_CLOSINGS);
    const preparedAt = appended.findIndex(
      (event) => event.type === "thread.session-set" && event.payload.session.status === "starting"
    );
    assert.ok(preparedAt !== -1, "the continuation was prepared");
    assert.deepEqual(closingsIn(appended.slice(0, preparedAt)), LEFTOVER_CLOSINGS, "all of it before the prepare");
    assert.equal(next.adapter.calls.filter((call) => call.kind === "sendTurn").length, 1);
    await next.stop();
  });

  it("never touches a thread an adapter still lists as live", async () => {
    // The reconcile's own exclusion: an adopted host is not reconciled against itself.
    const first = createTestHost();
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    await first.orchestrator.ingestionSink(threadId, leftoverRows(threadId));
    await first.settle();
    const logLength = first.store.logs.get(threadId)!.length;
    const surviving = createScriptedAdapter({ id: "claude" });
    await surviving.startSession({
      threadId,
      cwd: "/work/project",
      home: { kind: "account", path: "/tmp/home/acc1" },
      modelSelection: { model: "test-model" },
      runtimeMode: "approval-required"
    });
    const next = createTestHost({
      store: first.store,
      adapters: { claude: surviving },
      continuationEnabled: () => true
    });
    await next.orchestrator.reconcile();
    await next.orchestrator.readThread(threadId);
    await next.settle();
    assert.equal(first.store.logs.get(threadId)!.length, logLength);
    await first.stop();
    await next.stop();
  });

  it("never closes anything on a first load that finds the thread live", async () => {
    const { store, threadId, logLength } = await idleThreadWithLeftovers();
    const next = createTestHost({ store });
    await next.orchestrator.reconcile();
    // A session came up for the thread between the boot and its first load:
    // whatever it runs is its own to settle.
    await next.adapter.startSession({
      threadId,
      cwd: "/work/project",
      home: { kind: "account", path: "/tmp/home/acc1" },
      modelSelection: { model: "test-model" },
      runtimeMode: "approval-required"
    });
    await next.orchestrator.readThread(threadId);
    await next.settle();
    assert.equal(store.logs.get(threadId)!.length, logLength);
    await next.stop();
  });

  it("a closing that cannot be appended is logged, and the thread still loads", async () => {
    const { store, threadId, logLength } = await idleThreadWithLeftovers();
    const next = createTestHost({ store });
    await next.orchestrator.reconcile();
    const append = store.append.bind(store);
    store.append = async (input) => {
      if (input.threadId === threadId) {
        throw new Error("disk is full");
      }
      return append(input);
    };
    const read = await next.orchestrator.readThread(threadId);
    store.append = append;
    assert.equal(read.kind, "snapshot");
    assert.equal(store.logs.get(threadId)!.length, logLength);
    assert.ok(
      next.logger.entries.some(
        (entry) => entry.level === "warn" && entry.message.includes(threadId) && entry.message.includes("left")
      ),
      "the failure is logged"
    );
    await next.stop();
  });

  it("a thread whose head cannot be read is folded at boot, and closed there", async () => {
    const { store, threadId, logLength } = await idleThreadWithLeftovers();
    // `meta.json` is gone: the reconcile folds the log to decide, finds the
    // thread at rest, and that fold is its first load.
    store.heads.delete(threadId);
    const next = createTestHost({ store });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.deepEqual(closingsIn(store.logs.get(threadId)!.slice(logLength)), LEFTOVER_CLOSINGS);
    await next.stop();
  });

  it("a fold snapshot taken at the load, before the closings, still reads nothing running on the next", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    // Enough history that the next host's cold load writes `state.json` (A2)
    // — BEFORE its closings, which then ride the log's tail.
    const filler = Array.from({ length: 220 }, (_, i) =>
      sunk(threadId, "thread.message-sent", {
        messageId: `user:${i}`,
        role: "user",
        text: `message ${i}`,
        streaming: false,
        turnId: null
      })
    );
    await first.orchestrator.ingestionSink(threadId, [...filler, ...leftoverRows(threadId)]);
    await first.settle();
    await first.stop();
    first.store.snapshots.delete(threadId);
    const logLength = first.store.logs.get(threadId)!.length;

    const next = createTestHost({ store: first.store });
    await next.orchestrator.reconcile();
    await next.orchestrator.readThread(threadId);
    await next.settle();
    await next.stop();
    const snapshot = first.store.snapshots.get(threadId);
    assert.ok(snapshot !== undefined && snapshot.seq === logLength, "the load's snapshot predates the closings");
    assert.equal(first.store.logs.get(threadId)!.length, logLength + LEFTOVER_CLOSINGS.length);

    const third = createTestHost({ store: first.store });
    await third.orchestrator.reconcile();
    const read = await third.orchestrator.readThread(threadId);
    await third.settle();
    assert.equal(first.store.logs.get(threadId)!.length, logLength + LEFTOVER_CLOSINGS.length);
    assertNothingRunning(snapshotItems(read));
    await third.stop();
  });

  it("on the real store: the closings reach the log on disk, and the next host finds nothing left", async (t) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-leftovers-"));
    const stores: Array<ReturnType<typeof createThreadStore>> = [];
    const openStore = () => {
      const store = createThreadStore({ rootDir, sweepIntervalMs: 0 });
      stores.push(store);
      return store;
    };
    t.after(async () => {
      for (const store of stores) store.close();
      await fs.rm(rootDir, { recursive: true, force: true });
    });

    const first = createTestHost({ store: openStore() });
    const threadId = await first.createThread();
    await first.orchestrator.ingestionSink(threadId, leftoverRows(threadId));
    await first.settle();
    await first.stop();
    const before = (await first.store.readAll(threadId)).events.length;

    const next = createTestHost({ store: openStore() });
    await next.orchestrator.reconcile();
    const read = await next.orchestrator.readThread(threadId);
    await next.settle();
    await next.stop();
    assertNothingRunning(snapshotItems(read));
    const onDisk = (await next.store.readAll(threadId)).events;
    assert.deepEqual(closingsIn(onDisk.slice(before)), LEFTOVER_CLOSINGS);

    const third = createTestHost({ store: openStore() });
    await third.orchestrator.reconcile();
    await third.orchestrator.readThread(threadId);
    await third.settle();
    await third.stop();
    assert.equal((await third.store.readAll(threadId)).events.length, onDisk.length);
  });

  it("closes every running task, even more than the roster lists at once", async () => {
    const first = createTestHost();
    const threadId = await first.createThread();
    const fleet = 105;
    await first.orchestrator.ingestionSink(
      threadId,
      Array.from({ length: fleet }, (_, i) =>
        sunkRow(threadId, `fleet-${i}`, "task.started", {
          taskId: `fleet-${i}`,
          agentKind: "agent",
          taskType: "local_agent",
          title: `Agent ${i}`,
          toolUseId: `toolu_fleet_${i}`
        })
      )
    );
    await first.settle();
    await first.stop();
    const logLength = first.store.logs.get(threadId)!.length;

    const next = createTestHost({ store: first.store });
    await next.orchestrator.reconcile();
    const read = await next.orchestrator.readThread(threadId);
    await next.settle();
    const appended = first.store.logs.get(threadId)!.slice(logLength);
    assert.equal(closingsIn(appended).length, fleet);
    assert.deepEqual(
      new Set(closingsIn(appended).map(([, taskId]) => taskId)),
      new Set(Array.from({ length: fleet }, (_, i) => `fleet-${i}`))
    );
    const activities = snapshotItems(read).filter((item): item is ThreadActivityItem => item.kind === "activity");
    assert.deepEqual(
      foldSubagentActivities(activities, { sessionLive: true }).filter((row) => row.status === "running"),
      []
    );
    await next.stop();

    const third = createTestHost({ store: first.store });
    await third.orchestrator.reconcile();
    await third.orchestrator.readThread(threadId);
    await third.settle();
    assert.equal(first.store.logs.get(threadId)!.length, logLength + fleet, "a second load appends nothing");
    await third.stop();
  });
});
