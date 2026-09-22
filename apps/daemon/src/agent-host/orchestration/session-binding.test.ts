/**
 * The resume cursor is structurally unloseable (spec §3.3, §4.1).
 *
 * The regression these guard: a `thread.session-set` carrying
 * `{status:"ready", activeTurnId:null}` replaced the head's session block whole
 * and took the cursor with it. After the next drain-restart the orchestrator
 * started a FRESH provider session and the conversation's context was gone
 * (2026-09-22, thread c8979f6a). The fold now carries the cursor forward, but
 * these tests deliberately defeat that carry-forward — they strip the cursor
 * from the head AND from every event in the log — so that what is asserted is
 * the binding alone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent, ThreadHead } from "@orquester/api/agent-chat";

import { CONTINUATION_PROMPT } from "../host-protocol.ts";
import { createTestHost, type FakeThreadStore, type TestHost } from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `sb-${(commandSeq += 1)}`;

const headOf = (store: FakeThreadStore, threadId: string): ThreadHead => {
  const head = store.heads.get(threadId);
  assert.ok(head, "the head was persisted");
  return head;
};

/**
 * Rewrite the thread exactly as a bundle without the fold's carry-forward left
 * it: no cursor on the head, and none in any `thread.session-set` it wrote.
 */
function stripCursorFromEventSourcedState(store: FakeThreadStore, threadId: string): void {
  const head = headOf(store, threadId);
  const { resumeCursor: _dropped, ...session } = head.session;
  void _dropped;
  store.heads.set(threadId, { ...head, session });
  const log = store.logs.get(threadId) ?? [];
  store.logs.set(
    threadId,
    log.map((event) => {
      if (event.type !== "thread.session-set") return event;
      const { resumeCursor: _also, ...rest } = event.payload.session;
      void _also;
      return { ...event, payload: { ...event.payload, session: rest } } as DomainEvent;
    })
  );
}

/** A thread that ran one turn, so a cursor has been learned. */
async function threadWithACursor(
  options: { continuationEnabled?: boolean } = {}
): Promise<{ store: FakeThreadStore; threadId: string; first: TestHost }> {
  const first = createTestHost(
    options.continuationEnabled === undefined
      ? {}
      : { continuationEnabled: () => options.continuationEnabled === true }
  );
  const threadId = await first.createThread();
  await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
  await first.settle();
  assert.deepEqual(
    first.store.bindings.get(threadId)?.resumeCursor,
    { cursor: "turn-1" },
    "the turn's cursor reached the binding"
  );
  return { store: first.store, threadId, first };
}

describe("the provider session binding (§3.3, §4.1)", () => {
  it("records what the session start and the turn learned", async () => {
    const { store, threadId, first } = await threadWithACursor();
    const binding = store.bindings.get(threadId);
    assert.ok(binding);
    assert.equal(binding.threadId, threadId);
    assert.equal(binding.adapter, "claude");
    assert.equal(binding.adapterKey, "claude", "the registry id the session launched from");
    assert.equal(binding.runtimeMode, "approval-required");
    assert.equal(binding.providerInstanceId, "account:acc1");
    assert.equal(binding.status, "running");
    await first.stop();
  });

  it("a session-set that dropped the cursor still resumes — the binding carries it", async () => {
    const { store, threadId, first } = await threadWithACursor();
    await first.stop();
    stripCursorFromEventSourcedState(store, threadId);
    assert.equal(headOf(store, threadId).session.resumeCursor, undefined);

    // A new host on the same store: lazy recovery (§4.1) starts the session.
    const next = createTestHost({ store });
    await next.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await next.settle();

    assert.deepEqual(
      next.adapter.lastStart?.resumeCursor,
      { cursor: "turn-1" },
      "the restarted host resumed the SAME provider session"
    );
    await next.stop();
  });

  it("…and without the binding it would not have — the control", async () => {
    const { store, threadId, first } = await threadWithACursor();
    await first.stop();
    stripCursorFromEventSourcedState(store, threadId);
    store.bindings.delete(threadId);

    const next = createTestHost({ store });
    await next.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await next.settle();

    assert.equal(next.adapter.lastStart?.resumeCursor, undefined);
    await next.stop();
  });

  it("falls back to the head's cursor for a thread written before bindings existed (§8)", async () => {
    const { store, threadId, first } = await threadWithACursor();
    await first.stop();
    // The head keeps its cursor; the binding file is what a rollback removes.
    store.bindings.delete(threadId);

    const next = createTestHost({ store });
    await next.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
    await next.settle();

    assert.deepEqual(next.adapter.lastStart?.resumeCursor, { cursor: "turn-1" });
    await next.stop();
  });

  it("a settle that names no cursor never rewrites the binding's", async () => {
    const { store, threadId, first } = await threadWithACursor();
    // Exactly the event that caused the incident: ready, no active turn, no cursor.
    await first.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await first.settle();
    assert.deepEqual(store.bindings.get(threadId)?.resumeCursor, { cursor: "turn-1" });
    await first.stop();
  });

  it("the reconcile resumes from the binding when the head has no cursor at all", async () => {
    const { store, threadId, first } = await threadWithACursor({ continuationEnabled: true });
    await first.stop();
    stripCursorFromEventSourcedState(store, threadId);

    const next = createTestHost({ store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();

    const sends = next.adapter.calls.filter((call) => call.kind === "sendTurn");
    assert.equal(sends.length, 1);
    assert.equal((sends[0]?.detail as { input: string }).input, CONTINUATION_PROMPT);
    assert.deepEqual(next.adapter.lastStart?.resumeCursor, { cursor: "turn-1" });
    assert.equal(headOf(store, threadId).continueAfterRestart, undefined);
    await next.stop();
  });

  it("an intentional stop marks a thread whose head lost its cursor but whose binding kept it", async () => {
    const { store, threadId, first } = await threadWithACursor({ continuationEnabled: true });
    stripCursorFromEventSourcedState(store, threadId);
    // The runtime's fold is what `markThreadsForContinuation` reads, so reload
    // this thread on a fresh host rather than mutating a live one behind its back.
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => true });
    const marked = await next.orchestrator.markThreadsForContinuation();
    assert.deepEqual(marked, [threadId]);
    assert.deepEqual(headOf(store, threadId).continueAfterRestart, { turnId: "turn-1" });
    await next.stop();
  });

  it("a thread with no cursor anywhere is not marked", async () => {
    const { store, threadId, first } = await threadWithACursor({ continuationEnabled: true });
    stripCursorFromEventSourcedState(store, threadId);
    store.bindings.delete(threadId);
    await first.stop();

    const next = createTestHost({ store, continuationEnabled: () => true });
    assert.deepEqual(await next.orchestrator.markThreadsForContinuation(), []);
    assert.equal(headOf(store, threadId).continueAfterRestart, undefined);
    await next.stop();
  });

  it("a create-time resume seeds the binding before any session is started", async () => {
    const host = createTestHost();
    const threadId = await host.createThread({
      resume: { home: "account", conversationId: "conv-abc" }
    });
    await host.settle();
    const binding = host.store.bindings.get(threadId);
    assert.ok(binding, "the binding exists as soon as the thread does");
    assert.notEqual(binding.resumeCursor, null);
    await host.stop();
  });
});
