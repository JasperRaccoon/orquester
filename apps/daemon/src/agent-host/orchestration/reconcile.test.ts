/**
 * §3.3 reconcile, asserted headlessly (spec §9: "tested headlessly, not only by
 * restarting a real daemon"). Every restart flavour is driven through a
 * scripted adapter and a temporary in-memory store; the assertions are on the
 * resulting head and on which continuation call the adapter received.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent } from "@orquester/api/agent-chat";

import { CONTINUATION_FAILED_MESSAGE, CONTINUATION_PROMPT } from "../host-protocol.ts";
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

    const next = createTestHost({ store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(next.adapter.calls.length, 0);
    assert.equal(sessionEvents(first.store, threadId).length, 0);
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

  it("an intentional stop writes a marker for every running thread and clears it on abort", async () => {
    const { store, threadId, first } = await threadInFlight();
    const marked = await first.orchestrator.markThreadsForContinuation();
    assert.deepEqual(marked, [threadId]);
    assert.deepEqual(headOf(store, threadId).continueAfterRestart, { turnId: "turn-1" });

    await first.orchestrator.clearContinuationMarkers(marked);
    assert.equal(headOf(store, threadId).continueAfterRestart, undefined);
    await first.stop();
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
