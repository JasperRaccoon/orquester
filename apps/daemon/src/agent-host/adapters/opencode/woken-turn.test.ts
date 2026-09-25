/**
 * OpenCode adapter — the turn a background answer wakes the parent into,
 * across a host restart (fixtures README observation 27).
 *
 * The woken reply's turn is the adapter's own (`claimReply` in
 * `normalize.ts`): ingestion writes it as it writes any turn a provider
 * started — a `thread.session-set` that runs it, and no `/turn` command behind
 * it. A host that dies mid-reply runs none of its teardown, so the next host's
 * reconcile must settle that turn as it settles any (§3.3): at the time its
 * process last wrote, never left running.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isMessageStreaming,
  messageStreamingContext,
  type RuntimeEvent,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../../services.ts";
import { createScriptedAdapter, createTestHost } from "../../orchestration/testing/index.ts";
import { normalizeOpenCodeEvent } from "./normalize.ts";
import { createSessionState } from "./state.ts";
import { createHostIngestion, HOST_THREAD_ID } from "./testing/host.ts";
import { injectedAnswer, WOKEN_AT_MS, wokenReply } from "./testing/woken.ts";

const SESSION = "ses_parent";
/** One clock for the frames, the adapter and ingestion: when the parent woke. */
const WOKEN_AT = new Date(WOKEN_AT_MS).toISOString();

/** A background answer, and the parent's reply to it streaming: what the adapter emits for it. */
function wokenMidReply(): RuntimeEvent[] {
  const state = createSessionState({
    threadId: HOST_THREAD_ID,
    openCodeSessionId: SESSION,
    directory: "/work/project",
    runtimeMode: "approval-required"
  });
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => WOKEN_AT };
  const reply = wokenReply({
    sessionId: SESSION,
    promptId: "msg_injected",
    replyId: "msg_woken",
    text: "The child found README.md."
  });
  return [
    ...injectedAnswer({ sessionId: SESSION, promptId: "msg_injected", childId: "ses_child", answer: "Found it." }),
    ...reply.begins,
    ...reply.streams
  ].flatMap((frame) => normalizeOpenCodeEvent(state, frame, ctx).events);
}

describe("a woken reply's turn across a host restart", () => {
  it("is settled by the next host's reconcile, at the time its process last wrote, like any turn", async () => {
    const opencode = () => createScriptedAdapter({ id: "opencode" });
    const first = createTestHost({ adapters: { opencode: opencode() } });
    const threadId = await first.createThread({ refId: "opencode", home: "system" });
    assert.equal(threadId, HOST_THREAD_ID);

    // What the host's real ingestion writes for it, sunk into the host's log.
    const ingestion = createHostIngestion({ startIso: WOKEN_AT });
    await ingestion.ingest(wokenMidReply());
    const written = ingestion.log().slice(1);
    assert.ok(written.some((event) => event.type === "thread.session-set"));
    await first.orchestrator.ingestionSink(
      threadId,
      written.map(({ seq: _seq, ...event }) => event as AppendableDomainEvent)
    );
    await first.settle();
    const head = first.store.heads.get(threadId);
    assert.deepEqual([head?.session.status, head?.session.activeTurnId], ["running", "msg_injected"]);
    const lastWrite = written.at(-1)!.occurredAt;
    await first.stop();

    // The host died with the reply streaming; the next one starts an hour later.
    const next = createTestHost({ store: first.store, continuationEnabled: () => false, adapters: { opencode: opencode() } });
    next.clock.set(Date.parse(lastWrite) + 3_600_000);
    await next.orchestrator.reconcile();
    await next.settle();

    const read = await next.orchestrator.readThread(threadId);
    assert.equal(read.kind, "snapshot");
    if (read.kind !== "snapshot") return;
    const turn = read.thread.turns.find((candidate) => candidate.turnId === "msg_injected");
    assert.deepEqual(
      [turn?.state, turn?.completedAt],
      ["failed", lastWrite],
      "settled when its process died, not at the restart, and never left running"
    );
    assert.notEqual(read.thread.head?.session.status, "running");
    // The reply's words stay as the log has them, and read as settled.
    const answer = read.thread.items.find(
      (item): item is ThreadMessageItem => item.kind === "message" && item.role === "assistant"
    );
    assert.ok(answer !== undefined);
    assert.equal(answer.turnId, "msg_injected");
    assert.equal(isMessageStreaming(answer, messageStreamingContext(read.thread)), false);
    await next.stop();
  });
});
