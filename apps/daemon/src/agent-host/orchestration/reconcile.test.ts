/**
 * §3.3 reconcile, asserted headlessly (spec §9: "tested headlessly, not only by
 * restarting a real daemon"). Every restart flavour is driven through a
 * scripted adapter and a temporary in-memory store; the assertions are on the
 * resulting head and on which continuation call the adapter received — and on
 * what a thread's first load closes of the work a dead process left open (one
 * of those on the real store, for what reaches the disk). The late rows those
 * closings write stretch an old turn's range in the thread index, and so does
 * a background agent's late completion: the "Load older" walks over a real
 * index are here, a rewind that keeps such a turn among them — whose late
 * rows past the rewind's cut stay on a page once the window evicts them.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  decodeHistoryCursor,
  derivePendingRequests,
  foldSubagentActivities,
  foldThread,
  openWorkOf,
  type DomainEvent,
  type ThreadActivityItem,
  type ThreadHistoryPage,
  type ThreadItem
} from "@orquester/api/agent-chat";

import {
  CONTINUATION_FAILED_MESSAGE,
  CONTINUATION_PROMPT,
  CONTINUATION_SEND_FAILED_MESSAGE
} from "../host-protocol.ts";
import { createThreadIndex, type ThreadIndex } from "../index/index.ts";
import { MAX_LATE_REFERENCE_BYTES } from "../index/indexer.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "../store/index.ts";
import { LEFTOVER_CALL_DETAIL } from "./leftover-work.ts";
import { HISTORY_PAGE_ACTIVITIES, PENDING_TURN_GRACE_MS } from "./orchestrator.ts";
import {
  createRecordingLogger,
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
    }),
    // The subagent asks between parent turns: an approval and a structured
    // question the dead process can never answer…
    sunkRow(threadId, "agent-approval", "approval.requested", {
      requestId: "req-approval",
      requestKind: "command",
      requestType: "command_execution_approval",
      dismissible: false,
      detail: "rm -rf build"
    }, { tone: "approval", agentId: "agent-1" }),
    sunkRow(threadId, "agent-question", "user-input.requested", {
      requestId: "req-question",
      questions: [PICK],
      dismissible: false
    }, { agentId: "agent-1" }),
    // …and an async question, which a later user message answers.
    sunkRow(threadId, "async-question", "user-input.requested", {
      requestId: "req-async",
      questions: [PICK],
      dismissible: true,
      responseMode: "message"
    }, { turnId: "turn-1" })
  ];
}

/** A structured question with one option. */
const PICK = { id: "q1", header: "Pick", question: "Which one?", options: [{ label: "A", description: "a" }] };

/**
 * The closings `leftoverRows` owes, in the order a first load appends them —
 * the parked requests first, as a teardown settles them, but never the async
 * question; and no message: one still streaming is left as the log has it.
 */
const LEFTOVER_CLOSINGS = [
  ["approval.resolved", "req-approval"],
  ["user-input.resolved", "req-question"],
  ["tool.completed", "toolu_parent"],
  ["tool.completed", "bgshell:shell-1"],
  ["tool.completed", "toolu_agent_call"],
  // The shell's item before its task, as the adapters close one.
  ["task.completed", "shell-1"],
  ["task.completed", "agent-1"]
];

/**
 * Each closing an event appended: its row kind and the unit it ends. A
 * message's `streaming: false` is listed too, so one written by mistake shows.
 */
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
    } else if (
      activity.activityKind === "approval.resolved" ||
      activity.activityKind === "user-input.resolved"
    ) {
      closings.push([activity.activityKind, String(payload.requestId)]);
    }
  }
  return closings;
}

/**
 * "Open ⇒ running", read as every reader reads it once a session is live
 * again: no open call, no open background task, no active roster row, no
 * request but the async question — and the idle child still idle. A message
 * still streaming is left as the log has it.
 */
function assertNothingRunning(items: readonly ThreadItem[]): void {
  const activities = items.filter((item): item is ThreadActivityItem => item.kind === "activity");
  assert.deepEqual(openWorkOf(activities), { calls: [], tasks: [] });
  const pending = derivePendingRequests(activities);
  assert.deepEqual(
    [...pending.approvals, ...pending.userInputs].map((request) => request.requestId),
    ["req-async"]
  );
  assert.deepEqual(
    foldSubagentActivities(activities, { sessionLive: true }).map((row) => [row.id, row.status]),
    [
      ["shell-1", "interrupted"],
      ["agent-1", "interrupted"],
      ["codex-child", "idle"]
    ]
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

  it("a thread's first load closes every open call and active task the fold shows — an idle child and a streaming message untouched", async () => {
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
    // A task's stop rides its start's turn, though no turn is running now.
    assert.deepEqual(
      appended.flatMap((event) =>
        event.type === "thread.activity-appended" && event.payload.activity.activityKind === "task.completed"
          ? [event.payload.activity.turnId]
          : []
      ),
      ["turn-1", "turn-1"]
    );

    // The first reader's snapshot already has nothing running.
    const items = snapshotItems(read);
    assertNothingRunning(items);
    // Nothing was written for the message: it is left streaming, as the log has it.
    const message = items.find((item) => item.id === "assistant:agent-1:m1");
    assert.deepEqual(
      message?.kind === "message" ? [message.text, message.streaming] : null,
      ["Looking at the tests", true]
    );
    await next.stop();
  });

  it("cancels a dead host's parked requests on a thread at rest — a background subagent's — and keeps the async question", async () => {
    const { store, threadId, logLength } = await idleThreadWithLeftovers();
    const next = createTestHost({ store });
    await next.orchestrator.reconcile();
    const read = await next.orchestrator.readThread(threadId);
    const resolutionsIn = (events: readonly DomainEvent[]) =>
      events.flatMap((event) =>
        event.type === "thread.activity-appended" && event.payload.activity.activityKind.endsWith(".resolved")
          ? [{ activity: event.payload.activity, metadata: event.metadata }]
          : []
      );
    const resolutions = resolutionsIn(store.logs.get(threadId)!.slice(logLength));
    // The host's own cancellation — "Request cancelled", "Question cancelled",
    // on the turn a Stop would use (none: the thread is at rest), the envelope
    // naming the request. Nobody answered, and no row says anyone did.
    assert.deepEqual(resolutions, [
      {
        activity: {
          kind: "activity",
          id: "settle-cancel:req-approval",
          tone: "info",
          activityKind: "approval.resolved",
          summary: "Request cancelled",
          payload: { requestId: "req-approval", decision: "cancel" },
          turnId: null,
          createdAt: next.clock.nowIso(),
          updatedAt: next.clock.nowIso()
        },
        metadata: { requestId: "req-approval" }
      },
      {
        activity: {
          kind: "activity",
          id: "settle-cancel:req-question",
          tone: "info",
          activityKind: "user-input.resolved",
          summary: "Question cancelled",
          payload: { requestId: "req-question" },
          turnId: null,
          createdAt: next.clock.nowIso(),
          updatedAt: next.clock.nowIso()
        },
        metadata: { requestId: "req-question" }
      }
    ]);
    // The first reader's card list: the async question alone, still answerable by a message.
    assert.equal(read.kind, "snapshot");
    if (read.kind !== "snapshot") return;
    assert.deepEqual(read.thread.pending.approvals, []);
    assert.deepEqual(
      read.thread.pending.userInputs.map((question) => [question.requestId, question.responseMode]),
      [["req-async", "message"]]
    );

    // Row for row what the Stop path writes for the same requests on a live
    // thread — which cancels the async question as well; the first load must not.
    const twin = await next.createThread({ threadId: "twin" });
    await next.orchestrator.ingestionSink(twin, leftoverRows(twin));
    await next.settle();
    const before = store.logs.get(twin)!.length;
    await next.orchestrator.command(twin, "session/stop", { commandId: cmd() });
    await next.settle();
    const stopped = resolutionsIn(store.logs.get(twin)!.slice(before));
    assert.deepEqual(
      stopped.filter(({ activity }) => (activity.payload as { requestId: string }).requestId !== "req-async"),
      resolutions
    );
    assert.equal(stopped.length, 3, "Stop cancels the async question too");
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

// ---------------------------------------------------------------------------
// "Load older" over a real thread index
// ---------------------------------------------------------------------------

/** A real thread index in a temp dir: the message spans, late references and revert cuts are its own rules. */
async function realIndex(t: { after(fn: () => unknown): void }): Promise<ThreadIndex> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-leftover-history-"));
  const index = createThreadIndex({ filePath: path.join(dir, "index.sqlite"), logger: createRecordingLogger() });
  t.after(async () => {
    index.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return index;
}

/** One sink call per event, as `seedTurn` feeds a turn: the pending-turn rule reads each on its own. */
async function sinkEach(host: TestHost, threadId: string, events: AppendableDomainEvent[]): Promise<void> {
  for (const event of events) {
    await host.orchestrator.ingestionSink(threadId, [event]);
  }
}

const startTurn = (host: TestHost, threadId: string, turnId: string): Promise<void> =>
  sinkEach(host, threadId, [
    sunk(threadId, "thread.message-sent", {
      messageId: `user:${turnId}`,
      role: "user",
      text: `prompt for ${turnId}`,
      streaming: false,
      turnId: null
    }),
    sunk(threadId, "thread.turn-start-requested", {
      turnId: null,
      messageId: `user:${turnId}`,
      interactionMode: "default"
    }),
    sunk(threadId, "thread.session-set", { session: { status: "running", activeTurnId: turnId } })
  ]);

const settleTurn = (host: TestHost, threadId: string): Promise<void> =>
  sinkEach(host, threadId, [
    sunk(threadId, "thread.session-set", { session: { status: "ready", activeTurnId: null } })
  ]);

const parentRows = (host: TestHost, threadId: string, turnId: string, count: number): Promise<void> =>
  host.orchestrator.ingestionSink(
    threadId,
    Array.from({ length: count }, (_, i) => sunkRow(threadId, `${turnId}-row-${i}`, "runtime.warning", {}, { turnId }))
  );

/** Every page below `before`, each page's own cursor followed down. */
async function walkHistory(host: TestHost, threadId: string, before: string | null): Promise<ThreadHistoryPage[]> {
  const pages: ThreadHistoryPage[] = [];
  let cursor = before;
  while (cursor !== null) {
    assert.ok(pages.length < 50, "paging terminates");
    const page = await host.orchestrator.readHistory(threadId, { before: cursor });
    pages.push(page);
    cursor = page.page.beforeCursor;
  }
  return pages;
}

/** Every row id the log wrote: each activity's, each message's. */
function everyRowOf(store: FakeThreadStore, threadId: string): Set<string> {
  return new Set(
    store.logs.get(threadId)!.flatMap((event) =>
      event.type === "thread.activity-appended"
        ? [event.payload.activity.id]
        : event.type === "thread.message-sent"
          ? [event.payload.messageId]
          : []
    )
  );
}

/**
 * "Load older" loses no row: every activity and message the log ever wrote is
 * in the window or on a page, and no activity is on two pages. (A row the
 * window keeps out of age order — the call's opening row — may be on a page
 * too; readers dedupe by id.)
 */
function assertNothingLost(
  store: FakeThreadStore,
  threadId: string,
  window: readonly ThreadItem[],
  pages: readonly ThreadHistoryPage[]
): void {
  const paged = pages.flatMap((page) => page.items.filter((item) => item.kind === "activity").map((item) => item.id));
  assert.equal(new Set(paged).size, paged.length, "no activity on two pages");
  const shown = new Set([...window, ...pages.flatMap((page) => page.items)].map((item) => item.id));
  assert.deepEqual([...everyRowOf(store, threadId)].filter((id) => !shown.has(id)), [], "nothing is lost");
}

describe("reconcile — Load older after a first load closed an old turn's leftovers", () => {

  /**
   * A thread whose host died long after an OLD turn opened a call it never
   * closed and a subagent's words it never settled: o-1 left both, then o-2
   * (`o2Rows` parent rows) and o-3 filled the window past its limit — the fold
   * keeps the open call's opening row whatever its age (`open-work.ts`).
   */
  async function oldLeftovers(t: { after(fn: () => unknown): void }, o2Rows: number) {
    const index = await realIndex(t);
    const first = createTestHost({ index });
    const threadId = await first.createThread();
    await startTurn(first, threadId, "o-1");
    await first.orchestrator.ingestionSink(threadId, [
      sunkRow(threadId, "old-start", "tool.started", {
        itemType: "command_execution",
        toolUseId: "toolu_old",
        status: "inProgress",
        title: "Bash",
        data: { toolName: "Bash", input: {} }
      }, { turnId: "o-1", status: "inProgress" }),
      sunkRow(threadId, "old-update", "tool.updated", {
        itemType: "command_execution",
        toolUseId: "toolu_old",
        status: "inProgress",
        title: "Bash",
        data: { toolName: "Bash", input: { command: "npm run build" } }
      }, { turnId: "o-1", status: "inProgress" }),
      sunk(threadId, "thread.message-sent", {
        messageId: "assistant:agent-old:m1",
        role: "assistant",
        text: "Still looking",
        streaming: true,
        turnId: null,
        agentId: "agent-old"
      })
    ]);
    await parentRows(first, threadId, "o-1", 40);
    await settleTurn(first, threadId);
    for (const [turnId, count] of [
      ["o-2", o2Rows],
      ["o-3", 300]
    ] as const) {
      await startTurn(first, threadId, turnId);
      await parentRows(first, threadId, turnId, count);
      await settleTurn(first, threadId);
    }
    await first.settle();
    await index.drain();
    await first.stop();
    const store = first.store;
    return { store, index, threadId, logLength: store.logs.get(threadId)!.length };
  }

  /** The first load, then the snapshot a client reads once the index has taken the closer. */
  async function firstLoad(store: FakeThreadStore, index: ThreadIndex, threadId: string) {
    const next = createTestHost({ store, index });
    await next.orchestrator.reconcile();
    await next.orchestrator.readThread(threadId);
    await next.settle();
    await index.drain();
    const read = await next.orchestrator.readThread(threadId);
    assert.equal(read.kind, "snapshot");
    if (read.kind !== "snapshot") throw new Error("unreachable");
    assert.equal(read.thread.history?.hasOlder, true, "the window has evicted: there is history to page");
    return { next, window: read.thread.items, before: read.thread.history?.beforeCursor ?? null };
  }

  it("a small thread: the closer stretches the old turn over itself, within the bound, and no row is lost", async (t) => {
    const { store, index, threadId, logLength } = await oldLeftovers(t, 300);
    const { next, window, before } = await firstLoad(store, index, threadId);
    const appended = store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), [["tool.completed", "toolu_old"]]);
    assert.equal(appended.length, 1, "the call's closer, and nothing for the message");

    // The closer names o-1 less than MAX_LATE_REFERENCE_BYTES past o-2's start,
    // so the index's late-reference rule grows o-1's range over it
    // (`extendReferenced`), overlapping o-2 and o-3…
    const closer = appended[0]!;
    const closerAt = store.logs.get(threadId)!.length - 1;
    const o1 = index.turnById(threadId, "o-1");
    const o2 = index.turnById(threadId, "o-2");
    assert.ok(o1 && o2);
    assert.ok((closerAt + 1) * 1000 - o2.firstByte <= MAX_LATE_REFERENCE_BYTES, "a small thread");
    assert.equal(o1.lastSeq, closer.seq, "stretched over the closer");

    // …and "Load older" still serves every row once.
    const pages = await walkHistory(next, threadId, before);
    assert.ok(pages.length >= 1);
    assertNothingLost(store, threadId, window, pages);
    await next.stop();
  });

  it("a big thread: the closer never stretches the old turn past the bound, and no row is lost", async (t) => {
    const { store, index, threadId, logLength } = await oldLeftovers(t, 2_200);
    const o1Before = index.turnById(threadId, "o-1");
    const o2 = index.turnById(threadId, "o-2");
    assert.ok(o1Before && o2);
    assert.equal(o1Before.endByte, o2.firstByte, "o-1 ends where o-2 begins");
    const { next, window, before } = await firstLoad(store, index, threadId);
    const appended = store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), [["tool.completed", "toolu_old"]]);
    assert.equal(appended.length, 1);

    // More than MAX_LATE_REFERENCE_BYTES of log past o-2's start: the closer
    // names o-1, and o-1's range does not move.
    const closerAt = store.logs.get(threadId)!.length - 1;
    assert.ok((closerAt + 1) * 1000 - o2.firstByte > MAX_LATE_REFERENCE_BYTES, "a big thread");
    assert.deepEqual(index.turnById(threadId, "o-1"), o1Before);

    const pages = await walkHistory(next, threadId, before);
    assert.ok(pages.length >= 1);
    assertNothingLost(store, threadId, window, pages);
    await next.stop();
  });
});

describe("Load older after a rewind keeps a turn a late row stretched", () => {
  /**
   * A background agent `agent-<turn>` launched in `turnId`, with a call it
   * started there — a row its later rows stamp with the same turn, however
   * late they land (the Claude normaliser's `ToolInFlight.turnId`).
   */
  const launchAgent = (host: TestHost, threadId: string, turnId: string): Promise<void> =>
    host.orchestrator.ingestionSink(threadId, [
      sunkRow(threadId, `launch:${turnId}`, "task.started", {
        taskId: `agent-${turnId}`,
        agentKind: "agent",
        taskType: "local_agent",
        title: "Explore the repo",
        toolUseId: `toolu_launch:${turnId}`
      }, { turnId }),
      sunkRow(threadId, `call-start:${turnId}`, "tool.started", {
        itemType: "command_execution",
        toolUseId: `toolu_bg:${turnId}`,
        status: "inProgress",
        title: "Bash",
        agentId: `agent-${turnId}`,
        data: { toolName: "Bash", input: { command: "npm run build" } }
      }, { turnId, agentId: `agent-${turnId}`, status: "inProgress" })
    ]);

  /** That call's completion, landing while a later turn runs — stamped with the turn it started in. */
  const completeAgentCall = (host: TestHost, threadId: string, turnId: string): Promise<void> =>
    host.orchestrator.ingestionSink(threadId, [
      sunkRow(threadId, `call-done:${turnId}`, "tool.completed", {
        itemType: "command_execution",
        toolUseId: `toolu_bg:${turnId}`,
        status: "completed",
        title: "Bash",
        agentId: `agent-${turnId}`,
        data: { toolName: "Bash", input: { command: "npm run build" } }
      }, { turnId, agentId: `agent-${turnId}`, status: "completed" })
    ]);

  /** The seq of the line that wrote row `id`. */
  const seqOfRow = (host: TestHost, threadId: string, id: string): number => {
    const line = host.store.logs.get(threadId)!.find(
      (event) =>
        (event.type === "thread.activity-appended" && event.payload.activity.id === id) ||
        (event.type === "thread.message-sent" && event.payload.messageId === id)
    );
    assert.ok(line, `a line for ${id}`);
    return line.seq;
  };

  const rewind = async (host: TestHost, threadId: string, targetTurnCount: number): Promise<void> => {
    await host.orchestrator.command(threadId, "revert", { commandId: cmd(), targetTurnCount });
    await host.settle();
  };

  /** A turn of `count` parent rows, prompt to settle. */
  const plainTurn = async (host: TestHost, threadId: string, turnId: string, count: number): Promise<void> => {
    await startTurn(host, threadId, turnId);
    await parentRows(host, threadId, turnId, count);
    await settleTurn(host, threadId);
  };

  /** The window a client reads once the index has taken every append, and the cursor of the history below it. */
  async function readWindow(host: TestHost, index: ThreadIndex, threadId: string) {
    await host.settle();
    await index.drain();
    const read = await host.orchestrator.readThread(threadId);
    assert.equal(read.kind, "snapshot");
    if (read.kind !== "snapshot") throw new Error("unreachable");
    assert.equal(read.thread.history?.hasOlder, true, "the window has evicted: there is history to page");
    return { window: read.thread.items, before: read.thread.history?.beforeCursor ?? null };
  }

  /**
   * The rows a rewind removed: every activity on one of `turnIds`, and the
   * prompt that opened each (the fold drops a removed turn's prompt with it).
   */
  function removedRows(store: FakeThreadStore, threadId: string, turnIds: readonly string[]): Set<string> {
    const removed = new Set<string>();
    for (const event of store.logs.get(threadId)!) {
      if (event.type === "thread.activity-appended") {
        const { activity } = event.payload;
        if (activity.turnId !== null && turnIds.includes(activity.turnId)) removed.add(activity.id);
      } else if (event.type === "thread.message-sent") {
        const { messageId, turnId } = event.payload;
        if ((turnId !== null && turnIds.includes(turnId)) || turnIds.some((id) => messageId === `user:${id}`)) {
          removed.add(messageId);
        }
      }
    }
    return removed;
  }

  /**
   * "Load older" after the rewinds that removed `removedTurnIds`: none of
   * their rows is on a page or in the window, and every other row the log
   * wrote is on one of them — no activity on two pages. `unserved` names the
   * kept rows a test expects neither to show.
   */
  function assertRewoundHistory(
    store: FakeThreadStore,
    threadId: string,
    window: readonly ThreadItem[],
    pages: readonly ThreadHistoryPage[],
    removedTurnIds: readonly string[],
    unserved: ReadonlySet<string> = new Set()
  ): void {
    const removed = removedRows(store, threadId, removedTurnIds);
    assert.ok(removed.size > 0, "the rewind removed rows");
    const paged = pages.flatMap((page) => page.items.filter((item) => item.kind === "activity").map((item) => item.id));
    assert.equal(new Set(paged).size, paged.length, "no activity on two pages");
    const pagedRows = new Set(pages.flatMap((page) => page.items.map((item) => item.id)));
    assert.deepEqual([...removed].filter((id) => pagedRows.has(id)), [], "no page serves a removed turn's row");
    const shown = new Set([...window.map((item) => item.id), ...pagedRows]);
    assert.deepEqual([...removed].filter((id) => shown.has(id)), [], "nor does the window");
    assert.deepEqual(
      [...everyRowOf(store, threadId)].filter((id) => !removed.has(id) && !shown.has(id)),
      [...unserved],
      "and every kept turn's row is still served"
    );
  }

  it("a background agent's call that starts in r-1 and completes during r-2, then a rewind to r-1", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await startTurn(host, threadId, "r-1");
    await launchAgent(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 40);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 100);
    await completeAgentCall(host, threadId, "r-1");
    await parentRows(host, threadId, "r-2", 100);
    await settleTurn(host, threadId);
    await host.settle();
    await index.drain();
    // The completion names r-1 well within MAX_LATE_REFERENCE_BYTES of r-2's
    // start: the index grows r-1's range over r-2's first rows.
    assert.equal(index.turnById(threadId, "r-1")?.lastSeq, seqOfRow(host, threadId, "call-done:r-1"), "r-1 stretched over r-2");

    await rewind(host, threadId, 1);
    await plainTurn(host, threadId, "r-3", 600);
    const { window, before } = await readWindow(host, index, threadId);
    assertRewoundHistory(host.store, threadId, window, await walkHistory(host, threadId, before), ["r-2"]);
    await host.stop();
  });

  it("the same with a first-load closer on the old turn: a host died with r-1's agent call open", async (t) => {
    const index = await realIndex(t);
    const first = createTestHost({ index });
    const threadId = await first.createThread();
    await startTurn(first, threadId, "r-1");
    await launchAgent(first, threadId, "r-1");
    await parentRows(first, threadId, "r-1", 40);
    await settleTurn(first, threadId);
    await plainTurn(first, threadId, "r-2", 200);
    await first.settle();
    await index.drain();
    await first.stop();

    // The next host's first load closes the agent's call and stops its task,
    // on r-1 — the turn each started in — after every row of r-2.
    const next = createTestHost({ store: first.store, index });
    const logLength = first.store.logs.get(threadId)!.length;
    await next.orchestrator.reconcile();
    await next.orchestrator.readThread(threadId);
    await next.settle();
    await index.drain();
    const appended = first.store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), [
      ["tool.completed", "toolu_bg:r-1"],
      ["task.completed", "agent-r-1"]
    ]);
    assert.equal(index.turnById(threadId, "r-1")?.lastSeq, appended.at(-1)!.seq, "r-1 stretched over all of r-2");

    await rewind(next, threadId, 1);
    await plainTurn(next, threadId, "r-3", 600);
    const { window, before } = await readWindow(next, index, threadId);
    assertRewoundHistory(first.store, threadId, window, await walkHistory(next, threadId, before), ["r-2"]);
    await next.stop();
  });

  it("several rewinds, each keeping a turn a late row stretched", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    // r-1's agent call completes during r-2; a rewind to r-1 removes r-2.
    await startTurn(host, threadId, "r-1");
    await launchAgent(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 40);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 60);
    await completeAgentCall(host, threadId, "r-1");
    await parentRows(host, threadId, "r-2", 60);
    await settleTurn(host, threadId);
    await rewind(host, threadId, 1);
    // r-3's completes during r-4; a rewind to two turns keeps r-1 and r-3 and removes r-4.
    await startTurn(host, threadId, "r-3");
    await launchAgent(host, threadId, "r-3");
    await parentRows(host, threadId, "r-3", 40);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-4");
    await parentRows(host, threadId, "r-4", 60);
    await completeAgentCall(host, threadId, "r-3");
    await parentRows(host, threadId, "r-4", 60);
    await settleTurn(host, threadId);
    await host.settle();
    await index.drain();
    assert.equal(index.turnById(threadId, "r-3")?.lastSeq, seqOfRow(host, threadId, "call-done:r-3"), "r-3 stretched over r-4");
    await rewind(host, threadId, 2);
    assert.deepEqual(
      [index.turnByOrdinal(threadId, 1)?.turnId, index.turnByOrdinal(threadId, 2)?.turnId, index.totalTurns(threadId)],
      ["r-1", "r-3", 2]
    );

    await plainTurn(host, threadId, "r-5", 600);
    const { window, before } = await readWindow(host, index, threadId);
    assertRewoundHistory(host.store, threadId, window, await walkHistory(host, threadId, before), ["r-2", "r-4"]);
    await host.stop();
  });

  // -------------------------------------------------------------------------
  // A kept turn's late rows past the cut, once the window has evicted them
  // -------------------------------------------------------------------------

  /** `count` rows of the agent `agentId`, in `turnId`: they fill its own window (200) and evict its oldest rows. */
  const agentRows = (host: TestHost, threadId: string, agentId: string, turnId: string, count: number): Promise<void> =>
    host.orchestrator.ingestionSink(
      threadId,
      Array.from({ length: count }, (_, i) =>
        sunkRow(threadId, `${agentId}:${turnId}-row-${i}`, "runtime.warning", {}, { turnId, agentId })
      )
    );

  /** `turnId`'s turn-end capture, landing after the next turn's prompt — a slow capture on a big tree. */
  const lateCapture = (host: TestHost, threadId: string, turnId: string, turnCount: number): Promise<void> =>
    host.orchestrator.ingestionSink(threadId, [
      sunk(threadId, "thread.turn-diff-completed", {
        turnCount,
        turnId,
        ref: `turn/${turnCount}`,
        status: "ready",
        files: [{ path: "src/app.ts", additions: 3, deletions: 1 }],
        assistantMessageId: null,
        completedAt: "2026-09-24T10:00:00.000Z"
      })
    ]);

  /** A background shell `shell-<turn>` started in `turnId`: its item's opening row, there. */
  const startShell = (host: TestHost, threadId: string, turnId: string): Promise<void> =>
    host.orchestrator.ingestionSink(threadId, [
      sunkRow(threadId, `shell-start:${turnId}`, "tool.started", {
        itemType: "command_execution",
        toolUseId: `bgshell:shell-${turnId}`,
        status: "inProgress",
        title: "Background shell",
        agentId: `shell-${turnId}`,
        data: { toolName: "Bash", input: { command: "npm run dev" }, background: true }
      }, { turnId, agentId: `shell-${turnId}`, status: "inProgress" })
    ]);

  /** That shell's `lines` output rows and its completion, landing later — each stamped with the turn it started in. */
  const shellOutput = (host: TestHost, threadId: string, turnId: string, lines: number): Promise<void> =>
    host.orchestrator.ingestionSink(threadId, [
      ...Array.from({ length: lines }, (_, i) =>
        sunkRow(threadId, `shell-line:${turnId}:${i}`, "tool.output", {
          toolUseId: `bgshell:shell-${turnId}`,
          streamKind: "command_output",
          delta: `ready in ${i} ms\n`
        }, { turnId, agentId: `shell-${turnId}` })
      ),
      sunkRow(threadId, `shell-done:${turnId}`, "tool.completed", {
        itemType: "command_execution",
        toolUseId: `bgshell:shell-${turnId}`,
        status: "completed",
        title: "Background shell",
        agentId: `shell-${turnId}`,
        data: { toolName: "Bash", input: { command: "npm run dev" }, background: true }
      }, { turnId, agentId: `shell-${turnId}`, status: "completed" })
    ]);

  /** The pages that hold row `id`. */
  const pagesHolding = (pages: readonly ThreadHistoryPage[], id: string): ThreadHistoryPage[] =>
    pages.filter((page) => page.items.some((item) => item.id === id));

  const activityCount = (page: ThreadHistoryPage): number =>
    page.items.filter((item) => item.kind === "activity").length;

  it("a rewind to r-1: once evicted, r-1's late completion and capture are on a page, no row of r-2", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await startTurn(host, threadId, "r-1");
    await launchAgent(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 40);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 100);
    await completeAgentCall(host, threadId, "r-1");
    await lateCapture(host, threadId, "r-1", 1);
    await parentRows(host, threadId, "r-2", 100);
    await settleTurn(host, threadId);
    await rewind(host, threadId, 1);
    // The agent works on in r-3 and its own window evicts the call; the parent's evicts the rest of r-1.
    await startTurn(host, threadId, "r-3");
    await agentRows(host, threadId, "agent-r-1", "r-3", 300);
    await parentRows(host, threadId, "r-3", 600);
    await settleTurn(host, threadId);
    const { window, before } = await readWindow(host, index, threadId);
    assert.ok(!window.some((item) => item.id === "call-done:r-1"), "the window evicted the completion");

    const pages = await walkHistory(host, threadId, before);
    const holding = pagesHolding(pages, "call-done:r-1");
    assert.equal(holding.length, 1, "the completion is on exactly one page");
    assert.ok(holding[0]!.turns.some((turn) => turn.turnId === "r-1"), "which lists the turn it belongs to");
    assert.deepEqual(
      pages.flatMap((page) => page.checkpoints.map((checkpoint) => checkpoint.turnId)),
      ["r-1"],
      "r-1's late capture is on a page too"
    );
    assertRewoundHistory(host.store, threadId, window, pages, ["r-2"]);
    await host.stop();
  });

  it("a rewind to r-1: once evicted, a first-load closer on r-1 is on a page", async (t) => {
    const index = await realIndex(t);
    const first = createTestHost({ index });
    const threadId = await first.createThread();
    await startTurn(first, threadId, "r-1");
    await first.orchestrator.ingestionSink(threadId, [
      sunkRow(threadId, "parent-call:r-1", "tool.started", {
        itemType: "command_execution",
        toolUseId: "toolu_parent:r-1",
        status: "inProgress",
        title: "Bash",
        data: { toolName: "Bash", input: { command: "npm test" } }
      }, { turnId: "r-1", status: "inProgress" })
    ]);
    await parentRows(first, threadId, "r-1", 40);
    await settleTurn(first, threadId);
    await plainTurn(first, threadId, "r-2", 200);
    await first.settle();
    await index.drain();
    await first.stop();

    // The next host's first load closes the parent's call on r-1, after every row of r-2.
    const next = createTestHost({ store: first.store, index });
    const logLength = first.store.logs.get(threadId)!.length;
    await next.orchestrator.reconcile();
    await next.orchestrator.readThread(threadId);
    await next.settle();
    await index.drain();
    const appended = first.store.logs.get(threadId)!.slice(logLength);
    assert.deepEqual(closingsIn(appended), [["tool.completed", "toolu_parent:r-1"]]);
    const closer = appended[0]!;
    const closerId = closer.type === "thread.activity-appended" ? closer.payload.activity.id : "";
    assert.ok(closerId.length > 0);

    await rewind(next, threadId, 1);
    await plainTurn(next, threadId, "r-3", 600);
    const { window, before } = await readWindow(next, index, threadId);
    assert.ok(!window.some((item) => item.id === closerId), "the window evicted the closer");
    const pages = await walkHistory(next, threadId, before);
    assert.equal(pagesHolding(pages, closerId).length, 1, "the closer is on exactly one page");
    assertRewoundHistory(first.store, threadId, window, pages, ["r-2"]);
    await next.stop();
  });

  it("several rewinds: each kept turn's late rows are on a page once evicted, a removed turn's never", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    // r-1's agent call completes during r-2; a rewind to r-1 removes r-2 and the agent r-2 launched.
    await startTurn(host, threadId, "r-1");
    await launchAgent(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 40);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await launchAgent(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 60);
    await completeAgentCall(host, threadId, "r-1");
    await parentRows(host, threadId, "r-2", 60);
    await settleTurn(host, threadId);
    await rewind(host, threadId, 1);
    // r-3's call completes during r-4 — and so does r-2's, a removed turn's; a rewind to two turns keeps r-1 and r-3.
    await startTurn(host, threadId, "r-3");
    await launchAgent(host, threadId, "r-3");
    await parentRows(host, threadId, "r-3", 40);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-4");
    await parentRows(host, threadId, "r-4", 60);
    await completeAgentCall(host, threadId, "r-3");
    await completeAgentCall(host, threadId, "r-2");
    await parentRows(host, threadId, "r-4", 60);
    await settleTurn(host, threadId);
    await rewind(host, threadId, 2);
    // Both kept agents work on in r-5: their own windows evict their calls.
    await startTurn(host, threadId, "r-5");
    await agentRows(host, threadId, "agent-r-1", "r-5", 300);
    await agentRows(host, threadId, "agent-r-3", "r-5", 300);
    await parentRows(host, threadId, "r-5", 600);
    await settleTurn(host, threadId);
    const { window, before } = await readWindow(host, index, threadId);
    for (const id of ["call-done:r-1", "call-done:r-3"]) {
      assert.ok(!window.some((item) => item.id === id), `the window evicted ${id}`);
    }

    const pages = await walkHistory(host, threadId, before);
    for (const id of ["call-done:r-1", "call-done:r-3"]) {
      assert.equal(pagesHolding(pages, id).length, 1, `${id} is on exactly one page`);
    }
    assertRewoundHistory(host.store, threadId, window, pages, ["r-2", "r-4"]);
    await host.stop();
  });

  it("a kept turn's late rows count toward a page's activities: no page folds more than a lossless one", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    // r-1 starts a dev server, which prints 300 lines during r-2 — every one of them r-1's row.
    await startTurn(host, threadId, "r-1");
    await startShell(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 300);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 50);
    await shellOutput(host, threadId, "r-1", 300);
    await parentRows(host, threadId, "r-2", 50);
    await settleTurn(host, threadId);
    await rewind(host, threadId, 1);
    await plainTurn(host, threadId, "r-3", 600);
    const { window, before } = await readWindow(host, index, threadId);
    assert.ok(!window.some((item) => item.id === "shell-line:r-1:0"), "the window evicted the shell's first lines");

    const pages = await walkHistory(host, threadId, before);
    for (const page of pages) {
      assert.ok(activityCount(page) <= HISTORY_PAGE_ACTIVITIES, `a page of ${activityCount(page)} activities`);
    }
    assertRewoundHistory(host.store, threadId, window, pages, ["r-2"]);
    await host.stop();
  });

  it("a cut with more late rows than a page holds is served without them, as before, and says so", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await startTurn(host, threadId, "r-1");
    await startShell(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 300);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 50);
    await shellOutput(host, threadId, "r-1", 600);
    await parentRows(host, threadId, "r-2", 50);
    await settleTurn(host, threadId);
    await rewind(host, threadId, 1);
    await plainTurn(host, threadId, "r-3", 600);
    const { window, before } = await readWindow(host, index, threadId);

    const pages = await walkHistory(host, threadId, before);
    const late = new Set([...Array.from({ length: 600 }, (_, i) => `shell-line:r-1:${i}`), "shell-done:r-1"]);
    assert.deepEqual(
      pages.flatMap((page) => page.items.map((item) => item.id)).filter((id) => late.has(id)),
      [],
      "no page serves the cut's late rows"
    );
    for (const page of pages) {
      assert.ok(activityCount(page) <= HISTORY_PAGE_ACTIVITIES, `a page of ${activityCount(page)} activities`);
    }
    // What the window no longer holds of them is all that is missing.
    const inWindow = new Set(window.map((item) => item.id));
    const unserved = new Set([...everyRowOf(host.store, threadId)].filter((id) => late.has(id) && !inWindow.has(id)));
    assert.ok(unserved.size > 0, "the window evicted some of them");
    assertRewoundHistory(host.store, threadId, window, pages, ["r-2"], unserved);
    assert.ok(
      host.logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("late rows")),
      "the host says a page went without them"
    );
    await host.stop();
  });

  it("a page lists a late row's turn only when it lists no later one: a rewind of it reaches the page either way", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    // r-1's agent call completes during r-3, more than MAX_LATE_REFERENCE_BYTES past r-2's start — so r-1's range
    // stays where r-2 begins — and a rewind to two turns keeps r-1 and r-2.
    await startTurn(host, threadId, "r-1");
    await launchAgent(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 40);
    await settleTurn(host, threadId);
    await plainTurn(host, threadId, "r-2", 2_200);
    await startTurn(host, threadId, "r-3");
    await parentRows(host, threadId, "r-3", 50);
    await completeAgentCall(host, threadId, "r-1");
    await settleTurn(host, threadId);
    await host.settle();
    await index.drain();
    assert.equal(index.turnById(threadId, "r-1")?.endByte, index.turnById(threadId, "r-2")?.firstByte, "r-1 never stretched");
    await rewind(host, threadId, 2);
    await startTurn(host, threadId, "r-4");
    await agentRows(host, threadId, "agent-r-1", "r-4", 300);
    await parentRows(host, threadId, "r-4", 600);
    await settleTurn(host, threadId);
    const { window, before } = await readWindow(host, index, threadId);
    const pages = await walkHistory(host, threadId, before);
    const [holding] = pagesHolding(pages, "call-done:r-1");
    assert.ok(holding, "the completion is on a page");
    const listed = holding.turns.map((turn) => turn.turnId);
    assert.ok(listed.includes("r-2"), "which meets r-2, after r-1: a rewind that removes r-1 removes r-2 too");
    assert.ok(!listed.includes("r-1"), "so r-1 is left to the page that holds its own rows");
    assert.ok(pages.some((page) => page !== holding && page.turns.some((turn) => turn.turnId === "r-1")));
    assertRewoundHistory(host.store, threadId, window, pages, ["r-3"]);
    await host.stop();
  });

  it("late rows written after the rewind: a page of them alone lists their turn, and the index's count is not doubled", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await startTurn(host, threadId, "r-1");
    await startShell(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 40);
    await settleTurn(host, threadId);
    await plainTurn(host, threadId, "r-2", 50);
    await rewind(host, threadId, 1);
    // The dev server r-1 started prints on after the rewind, before the next prompt: a thousand rows of r-1 that
    // no turn's range holds, each one an activity the index positions.
    await shellOutput(host, threadId, "r-1", 1_000);
    await plainTurn(host, threadId, "r-3", 600);
    const { window, before } = await readWindow(host, index, threadId);
    const pages = await walkHistory(host, threadId, before);
    const shellOnly = pages.filter((page) => page.items.length > 0 && page.items.every((item) => item.id.startsWith("shell-")));
    assert.ok(shellOnly.length > 0, "a page holds nothing but the shell's lines");
    for (const page of shellOnly) {
      assert.deepEqual(page.turns.map((turn) => turn.turnId), ["r-1"], "and lists their turn, which no range of it meets");
      assert.equal(activityCount(page), HISTORY_PAGE_ACTIVITIES, "a whole page: the index counts those rows already");
    }
    assertRewoundHistory(host.store, threadId, window, pages, ["r-2"]);
    await host.stop();
  });

  it("a thread with no rewind: every page is exactly its block of the log, folded — late rows as ever", async (t) => {
    const index = await realIndex(t);
    const host = createTestHost({ index });
    const threadId = await host.createThread();
    await startTurn(host, threadId, "r-1");
    await launchAgent(host, threadId, "r-1");
    await parentRows(host, threadId, "r-1", 300);
    await settleTurn(host, threadId);
    await startTurn(host, threadId, "r-2");
    await parentRows(host, threadId, "r-2", 100);
    await completeAgentCall(host, threadId, "r-1");
    await lateCapture(host, threadId, "r-1", 1);
    await parentRows(host, threadId, "r-2", 600);
    await settleTurn(host, threadId);
    const { window, before } = await readWindow(host, index, threadId);
    const capture = host.store.logs.get(threadId)!.find((event) => event.type === "thread.turn-diff-completed");
    assert.equal(index.turnById(threadId, "r-1")?.lastSeq, capture?.seq, "r-1 stretched over r-2's start");

    const pages = await walkHistory(host, threadId, before);
    assert.ok(pages.length >= 2);
    const log = host.store.logs.get(threadId)!;
    let end = decodeHistoryCursor(before!, threadId)!.beforeSeq!;
    for (const page of pages) {
      const cursor = page.page.beforeCursor;
      const start = cursor === null ? 1 : decodeHistoryCursor(cursor, threadId)!.beforeSeq!;
      const folded = foldThread(log.filter((event) => event.seq >= start && event.seq < end));
      assert.deepEqual(page.items.map((item) => item.id), folded.items.map((item) => item.id));
      assert.deepEqual(page.checkpoints, folded.checkpoints);
      end = start;
    }
    assertNothingLost(host.store, threadId, window, pages);
    await host.stop();
  });
});
