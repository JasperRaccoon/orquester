/**
 * E5 (a conversation already open elsewhere) and E6 (a resumed thread's
 * timeline is empty) — the two §6.1/§4.1 resume blockers the E2E run found
 * against real CLIs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DomainEvent,
  RuntimeEvent,
  ThreadActivityItem,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import { isAgentChatCommandError } from "./errors.ts";
import { createScriptedAdapter, createTestHost, type TestHost } from "./testing/index.ts";

let seq = 0;
const cmd = (): string => `rh-${(seq += 1)}`;

function activities(host: TestHost, threadId: string): ThreadActivityItem[] {
  return (host.store.logs.get(threadId) ?? [])
    .filter(
      (event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
        event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);
}

/** What an adapter's `projectHistory` is expected to produce (§4.1). */
function historyEvents(threadId: string, snapshot: ThreadSnapshot): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const raw = { source: "host.history" as const, payload: null };
  for (const turn of snapshot.turns) {
    out.push({
      eventId: `h-${turn.id}-start`,
      threadId,
      createdAt: "1970-01-01T00:00:00.000Z",
      turnId: turn.id,
      type: "turn.started",
      payload: {},
      raw
    } as unknown as RuntimeEvent);
    for (const [index, item] of turn.items.entries()) {
      const { role, text } = item as { role: string; text: string };
      out.push({
        eventId: `h-${turn.id}-${index}`,
        threadId,
        createdAt: "1970-01-01T00:00:00.000Z",
        turnId: turn.id,
        itemId: `h-${turn.id}-${index}`,
        type: "item.completed",
        payload: {
          itemType: role === "user" ? "user_message" : "assistant_message",
          status: "completed",
          title: text,
          detail: text
        },
        raw
      } as unknown as RuntimeEvent);
    }
    out.push({
      eventId: `h-${turn.id}-end`,
      threadId,
      createdAt: "1970-01-01T00:00:00.000Z",
      turnId: turn.id,
      type: "turn.completed",
      payload: { state: "completed", tokenUsage: { usageStatus: "unavailable" } },
      raw
    } as unknown as RuntimeEvent);
  }
  return out;
}

const SNAPSHOT: ThreadSnapshot = {
  threadId: "thread-1",
  turns: [
    {
      id: "old-turn-1",
      items: [
        { role: "user", text: "remember the token SWORDFISH" },
        { role: "assistant", text: "noted" }
      ]
    }
  ]
};

describe("E6: a resumed thread replays the provider's own history", () => {
  it("projects it through ingestion before the session is announced", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      history: SNAPSHOT,
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot)
    });
    const host = createTestHost({ adapters: { claude } });
    const threadId = await host.createThread({
      resume: { home: "account", conversationId: "conv-1" }
    });

    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "what token?" });
    await host.settle();

    const kinds = host.ingestion.ingested.map((event) => event.type);
    assert.deepEqual(
      kinds,
      ["turn.started", "item.completed", "item.completed", "turn.completed"],
      "the conversation being resumed reaches ingestion"
    );
    // Every projected event is marked historical, so nothing downstream treats
    // it as new work.
    assert.ok(
      host.ingestion.ingested.every((event) => event.raw?.source === "host.history"),
      "history is marked, not disguised as live"
    );
    // …and it lands BEFORE the session is announced ready.
    const readThreadIndex = claude.calls.findIndex((call) => call.kind === "readThread");
    const sendTurnIndex = claude.calls.findIndex((call) => call.kind === "sendTurn");
    assert.ok(readThreadIndex >= 0 && readThreadIndex < sendTurnIndex);
    await host.stop();
  });

  it("says so in the timeline when the adapter cannot replay history", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const threadId = await host.createThread({
      refId: "grok",
      resume: { home: "account", conversationId: "conv-2" }
    });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hi" });
    await host.settle();

    const notice = activities(host, threadId).find(
      (row) => row.summary === "History not available for this provider"
    );
    assert.ok(notice, "an empty timeline must be explained, not just empty");
    assert.equal(notice?.tone, "info");
    await host.stop();
  });

  it("does not replay history into a thread that already has one", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      history: SNAPSHOT,
      projectHistory: (snapshot) => historyEvents("thread-1", snapshot)
    });
    const host = createTestHost({ adapters: { claude } });
    const threadId = await host.createThread({
      resume: { home: "account", conversationId: "conv-3" }
    });
    // A turn of its own first: the thread now has items.
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();
    const ingestedAfterFirst = host.ingestion.ingested.length;

    // A restart re-enters `startSession` with the same cursor.
    await claude.stopSession(threadId);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "second" });
    await host.settle();

    assert.equal(
      host.ingestion.ingested.length,
      ingestedAfterFirst,
      "history is replayed at most once, and never over a live timeline"
    );
    await host.stop();
  });
});

describe("E5: a conversation already open elsewhere is never silently forked", () => {
  it("refuses the resume and names the tab that owns it", async () => {
    const host = createTestHost();
    const owner = await host.createThread({ threadId: "owner-1" });
    await host.orchestrator.command(owner, "turn", { commandId: cmd(), input: "go" });
    await host.settle();

    // The owner announces the provider conversation it holds.
    const consumed = host.orchestrator.consume(host.adapter);
    host.adapter.emit({
      eventId: "ts",
      threadId: owner,
      createdAt: host.clock.nowIso(),
      type: "thread.started",
      payload: { providerThreadId: "conv-shared" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      () =>
        host.orchestrator.createThread({
          threadId: "second-1",
          projectPath: "/work/project",
          cwd: "/work/project",
          title: "Second",
          refId: "claude",
          accountId: "acc1",
          home: "account",
          modelSelection: { model: "test-model" },
          runtimeMode: "approval-required",
          resume: { home: "account", conversationId: "conv-shared" }
        }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMMAND_REJECTED" &&
        /already open in "Test thread"/.test(error.message) &&
        (error.detail as { code: string }).code === "RESUME_UNAVAILABLE"
    );

    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("allows it once the owning session is gone", async () => {
    const host = createTestHost();
    const owner = await host.createThread({ threadId: "owner-2" });
    await host.orchestrator.command(owner, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    const consumed = host.orchestrator.consume(host.adapter);
    host.adapter.emit({
      eventId: "ts",
      threadId: owner,
      createdAt: host.clock.nowIso(),
      type: "thread.started",
      payload: { providerThreadId: "conv-free" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));

    await host.orchestrator.command(owner, "session/stop", { commandId: cmd() });
    await host.settle();

    const head = await host.orchestrator.createThread({
      threadId: "second-2",
      projectPath: "/work/project",
      cwd: "/work/project",
      title: "Second",
      refId: "claude",
      accountId: "acc1",
      home: "account",
      modelSelection: { model: "test-model" },
      runtimeMode: "approval-required",
      resume: { home: "account", conversationId: "conv-free" }
    });
    assert.equal(head.id, "second-2");

    host.adapter.close();
    await consumed;
    await host.stop();
  });

  it("forks instead of refusing where the adapter declares it", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      capabilities: { supportsSessionFork: true }
    });
    const host = createTestHost({ adapters: { claude } });
    const owner = await host.createThread({ threadId: "owner-3" });
    await host.orchestrator.command(owner, "turn", { commandId: cmd(), input: "go" });
    await host.settle();
    const consumed = host.orchestrator.consume(claude);
    claude.emit({
      eventId: "ts",
      threadId: owner,
      createdAt: host.clock.nowIso(),
      type: "thread.started",
      payload: { providerThreadId: "conv-forkable" }
    } as unknown as RuntimeEvent);
    await new Promise((resolve) => setImmediate(resolve));

    const head = await host.orchestrator.createThread({
      threadId: "second-3",
      projectPath: "/work/project",
      cwd: "/work/project",
      title: "Second",
      refId: "claude",
      accountId: "acc1",
      home: "account",
      modelSelection: { model: "test-model" },
      runtimeMode: "approval-required",
      resume: { home: "account", conversationId: "conv-forkable" }
    });
    assert.equal(head.id, "second-3", "a forkable provider may share a conversation");

    claude.close();
    await consumed;
    await host.stop();
  });
});
