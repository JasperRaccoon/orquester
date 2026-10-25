/**
 * Crash-safe resume (§3.3), headlessly. A "crash" is a host stopped with no
 * teardown (`TestHost.stop()`: the adapters close, nothing settles the turn) —
 * what an OOM kill, an uncaught error or a killed tmux session leaves: a head
 * that still reads running. The next host resumes such a turn exactly as it
 * continues a deploy's handover — the same opt-in, cursor and closed-tab rules —
 * says so in the chat, and counts: a turn that keeps taking the host down is
 * resumed at most twice in a row, never in a loop.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent, RuntimeEvent } from "@orquester/api/agent-chat";

import {
  CONTINUATION_FAILED_MESSAGE,
  CONTINUATION_PROMPT,
  CRASH_RESUME_LIMIT_MESSAGE,
  CRASH_RESUME_SUMMARY,
  type HostThreadBox
} from "../host-protocol.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type FakeThreadStore,
  type TestHost,
  type TestHostOptions
} from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `cr-${(commandSeq += 1)}`;

type HostOptions = TestHostOptions;

/** A host whose turn ids start after `firstTurn` — a provider never reuses an id. */
function hostFrom(firstTurn: number, options: HostOptions = {}): TestHost {
  const adapter = createScriptedAdapter({ id: "claude" });
  // Burn ids on a thread no test reads.
  for (let i = 1; i < firstTurn; i += 1) {
    void adapter.sendTurn({ threadId: "burn", input: "", attachments: [], interactionMode: "default" });
  }
  return createTestHost({ ...options, adapters: { claude: adapter } });
}

/** A thread mid-turn on a host that then crashed. */
async function crashedMidTurn(options: HostOptions = {}): Promise<{ store: FakeThreadStore; threadId: string; first: TestHost }> {
  const first = createTestHost(options);
  const threadId = await first.createThread();
  await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
  await first.settle();
  assert.equal(first.store.heads.get(threadId)?.session.status, "running");
  await first.stop();
  return { store: first.store, threadId, first };
}

const resumesOf = (host: TestHost, threadId: string) =>
  host.adapter.calls.filter(
    (call) => call.kind === "sendTurn" && call.threadId === threadId && (call.detail as { input?: string }).input === CONTINUATION_PROMPT
  );

const activitiesOf = (store: FakeThreadStore, threadId: string) =>
  (store.logs.get(threadId) ?? []).flatMap((event: DomainEvent) =>
    event.type === "thread.activity-appended" ? [event.payload.activity] : []
  );

const crashNotes = (store: FakeThreadStore, threadId: string) =>
  activitiesOf(store, threadId).filter((activity) => activity.summary === CRASH_RESUME_SUMMARY);

function headOf(store: FakeThreadStore, threadId: string) {
  const head = store.heads.get(threadId);
  assert.ok(head);
  return head;
}

describe("crash-safe resume (§3.3)", () => {
  it("a crash mid-turn: the next host resumes it once, and says the host stopped unexpectedly", async () => {
    const { store, threadId } = await crashedMidTurn();
    const next = hostFrom(2, { store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();

    assert.equal(resumesOf(next, threadId).length, 1);
    assert.deepEqual(next.adapter.lastStart?.resumeCursor, { cursor: "turn-1" }, "from the crashed turn's cursor");
    const notes = crashNotes(store, threadId);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.activityKind, "runtime.warning");
    assert.equal(notes[0]!.turnId, "turn-1", "on the turn that was running");
    assert.match(String((notes[0]!.payload as { detail?: unknown }).detail), /attempt 1 of 2/);
    const head = headOf(store, threadId);
    assert.equal(head.session.status, "running");
    assert.equal(head.continueAfterRestart, undefined, "the marker is cleared on success");
    assert.deepEqual(head.crashResumedTurn, { turnId: "turn-2", attempt: 1 }, "the count rides the resumed turn");

    // Once: the same host never resumes it again.
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 1);
    await next.stop();
  });

  it("follows the same opt-in as a deploy's handover: an opted-out project is settled, not resumed", async () => {
    const { store, threadId } = await crashedMidTurn();
    const next = hostFrom(2, { store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 0);
    assert.equal(headOf(store, threadId).session.status, "error");
    assert.equal(headOf(store, threadId).session.activeTurnId, null);
    assert.equal(headOf(store, threadId).continueAfterRestart, undefined);
    assert.equal(headOf(store, threadId).session.lastError, CONTINUATION_FAILED_MESSAGE);
    assert.deepEqual(crashNotes(store, threadId), []);
    await next.stop();
  });

  it("a crash after the turn settled resumes nothing — even when meta.json lagged behind the log", async () => {
    const first = createTestHost({ continuationEnabled: () => true });
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "short job" });
    await first.settle();
    const runningHead = structuredClone(headOf(first.store, threadId));
    // The settle ingestion writes when the turn ends on its own.
    await first.orchestrator.ingestionSink(threadId, [
      {
        eventId: "done",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "ready", activeTurnId: null }, turn: { turnId: "turn-1" } },
        occurredAt: first.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      } as unknown as Parameters<TestHost["orchestrator"]["ingestionSink"]>[1][number]
    ]);
    await first.settle();
    await first.stop();
    assert.notEqual(headOf(first.store, threadId).session.status, "running", "the turn settled before the crash");
    const logLength = first.store.logs.get(threadId)!.length;

    const next = hostFrom(2, { store: first.store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 0);
    assert.deepEqual(crashNotes(first.store, threadId), []);
    await next.stop();

    // The log is the record: a head written before the settle reached it still resumes nothing.
    first.store.heads.set(threadId, runningHead);
    const third = hostFrom(3, { store: first.store, continuationEnabled: () => true });
    await third.orchestrator.reconcile();
    await third.settle();
    assert.equal(resumesOf(third, threadId).length, 0);
    assert.deepEqual(crashNotes(first.store, threadId), []);
    assert.ok(first.store.logs.get(threadId)!.length >= logLength);
    await third.stop();
  });

  it("a host that keeps dying during the resumed turn: resumed twice, then settled — no loop", async () => {
    const { store, threadId } = await crashedMidTurn();
    const second = hostFrom(2, { store, continuationEnabled: () => true });
    await second.orchestrator.reconcile();
    await second.settle();
    assert.equal(resumesOf(second, threadId).length, 1);
    await second.stop(); // crash during the first resume's turn

    const third = hostFrom(3, { store, continuationEnabled: () => true });
    await third.orchestrator.reconcile();
    await third.settle();
    assert.equal(resumesOf(third, threadId).length, 1, "the second attempt");
    assert.deepEqual(headOf(store, threadId).crashResumedTurn, { turnId: "turn-3", attempt: 2 });
    assert.match(String((crashNotes(store, threadId).at(-1)!.payload as { detail?: unknown }).detail), /attempt 2 of 2/);
    await third.stop(); // and again

    const fourth = hostFrom(4, { store, continuationEnabled: () => true });
    await fourth.orchestrator.reconcile();
    await fourth.settle();
    assert.equal(resumesOf(fourth, threadId).length, 0, "not a third time");
    const head = headOf(store, threadId);
    assert.equal(head.session.status, "error");
    assert.equal(head.session.lastError, CRASH_RESUME_LIMIT_MESSAGE);
    assert.equal(head.crashResumedTurn, undefined);
    assert.equal(head.continueAfterRestart, undefined);
    assert.equal(crashNotes(store, threadId).length, 2);
    await fourth.stop();

    // Settled for good: a later host does nothing.
    const fifth = hostFrom(5, { store, continuationEnabled: () => true });
    await fifth.orchestrator.reconcile();
    await fifth.settle();
    assert.equal(resumesOf(fifth, threadId).length, 0);
    await fifth.stop();
  });

  it("a host that dies between preparing the resume and sending it counts that attempt too", async () => {
    const { store, threadId } = await crashedMidTurn();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const dying = hostFrom(attempt + 1, { store, continuationEnabled: () => true });
      // The host dies the moment the provider is asked: what is on disk then is all the next
      // host finds — restored after this host's own failure handling ran.
      let onDisk: { head: unknown; log: DomainEvent[]; binding: unknown; snapshot: unknown } | null = null;
      dying.adapter.startSession = async () => {
        onDisk = {
          head: structuredClone(store.heads.get(threadId)),
          log: [...store.logs.get(threadId)!],
          binding: structuredClone(store.bindings.get(threadId)),
          snapshot: structuredClone(store.snapshots.get(threadId))
        };
        throw new Error("the host died here");
      };
      await dying.orchestrator.reconcile();
      await dying.settle();
      await dying.stop();
      assert.ok(onDisk !== null);
      const crashed = onDisk as { head: unknown; log: DomainEvent[]; binding: unknown; snapshot: unknown };
      if (crashed.snapshot === undefined) store.snapshots.delete(threadId);
      else store.snapshots.set(threadId, crashed.snapshot as NonNullable<ReturnType<typeof store.snapshots.get>>);
      store.heads.set(threadId, crashed.head as ReturnType<typeof headOf>);
      store.logs.set(threadId, crashed.log);
      store.bindings.set(threadId, crashed.binding as NonNullable<ReturnType<typeof store.bindings.get>>);
      assert.deepEqual(
        { prepared: headOf(store, threadId).continueAfterRestart?.prepared, attempt: headOf(store, threadId).continueAfterRestart?.crashAttempt },
        { prepared: true, attempt },
        "the prepared marker carries its attempt"
      );
    }
    const last = hostFrom(4, { store, continuationEnabled: () => true });
    await last.orchestrator.reconcile();
    await last.settle();
    assert.equal(resumesOf(last, threadId).length, 0);
    assert.equal(headOf(store, threadId).session.lastError, CRASH_RESUME_LIMIT_MESSAGE);
    await last.stop();
  });

  it("the count starts over once a resumed turn ends on its own", async () => {
    const { store, threadId } = await crashedMidTurn();
    const second = hostFrom(2, { store, continuationEnabled: () => true });
    const consumed = second.orchestrator.consume(second.adapter);
    await second.orchestrator.reconcile();
    await second.settle();
    assert.deepEqual(headOf(store, threadId).crashResumedTurn, { turnId: "turn-2", attempt: 1 });
    second.adapter.emit({
      eventId: "done-2",
      threadId,
      turnId: "turn-2",
      createdAt: second.clock.nowIso(),
      type: "turn.completed",
      payload: { state: "completed" }
    } as unknown as RuntimeEvent);
    await second.settle();
    assert.equal(headOf(store, threadId).crashResumedTurn, undefined, "cleared when the resumed turn ends");
    second.adapter.close();
    await consumed;
    await second.stop();
  });

  it("a thread closed or deleted while the host was down is settled, never resumed", async () => {
    const { store, threadId } = await crashedMidTurn();
    const next = hostFrom(2, { store, continuationEnabled: () => true, isThreadClosed: (id) => id === threadId });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 0);
    assert.equal(headOf(store, threadId).session.status, "error");
    assert.deepEqual(crashNotes(store, threadId), []);
    await next.stop();
  });

  it("a newer message the user sent wins: the older running turn is not resumed in its place", async () => {
    const { store, threadId, first } = await crashedMidTurn();
    // The log as the crash left it: a turn requested after the running one.
    const log = store.logs.get(threadId)!;
    for (const [type, payload] of [
      ["thread.message-sent", { messageId: "user:newer", role: "user", text: "do this instead", streaming: false, turnId: null }],
      ["thread.turn-start-requested", { turnId: null, messageId: "user:newer", interactionMode: "default" }]
    ] as const) {
      log.push({
        seq: log.length + 1,
        eventId: `newer-${log.length + 1}`,
        threadId,
        type,
        payload,
        occurredAt: first.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      } as DomainEvent);
    }
    const next = hostFrom(2, { store, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 0, "turn-1 is never continued over the newer message");
    assert.deepEqual(crashNotes(store, threadId), []);
    await next.stop();
  });

  it("a box thread resumes in its box", async () => {
    const box = { boxId: "box-1", socketPath: "/run/box-1.sock", sys: {}, paths: {}, tooling: {} } as unknown as HostThreadBox;
    const first = createTestHost();
    const threadId = await first.createThread();
    first.launchConfigs.entries.set(threadId, { ...(first.launchConfigs.entries.get(threadId) ?? {}), box });
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    await first.stop();

    const next = hostFrom(2, { store: first.store, launchConfigs: first.launchConfigs, continuationEnabled: () => true });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 1);
    assert.deepEqual(next.adapter.lastStart?.box, box, "the session starts in the thread's box");
    await next.stop();
  });

  it("a deploy's handover is not a crash: no note, no count", async () => {
    const first = createTestHost({ continuationEnabled: () => true });
    const threadId = await first.createThread();
    await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "long job" });
    await first.settle();
    assert.deepEqual(await first.orchestrator.markThreadsForContinuation(), [threadId]);
    await first.stop(); // the teardown wrote nothing: the marker names the running turn

    const next = hostFrom(2, { store: first.store, continuationEnabled: () => false });
    await next.orchestrator.reconcile();
    await next.settle();
    assert.equal(resumesOf(next, threadId).length, 1, "the marker alone decides, as before");
    assert.deepEqual(crashNotes(first.store, threadId), []);
    assert.equal(headOf(first.store, threadId).crashResumedTurn, undefined);
    await next.stop();
  });
});
