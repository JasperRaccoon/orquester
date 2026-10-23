import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent } from "@orquester/api/agent-chat";

import { isAgentChatCommandError } from "./errors.ts";
import { createTestHost, type TestHost } from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `cmd-${(commandSeq += 1)}`;

const EXPIRES_AT = "2026-10-22T13:00:00.000Z";

function ingested(host: TestHost, threadId: string, type: DomainEvent["type"], payload: unknown, id: string): DomainEvent {
  return {
    eventId: id,
    threadId,
    type,
    payload,
    occurredAt: host.clock.nowIso(),
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as DomainEvent;
}

/** One completed turn whose last request wrote a 1h cache over `usedTokens` of context. */
async function idleThread(host: TestHost, usedTokens = 250_000): Promise<{ threadId: string; turnId: string }> {
  const threadId = await host.createThread();
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "build it" });
  await host.settle();
  await host.orchestrator.ingestionSink(threadId, [
    ingested(
      host,
      threadId,
      "thread.activity-appended",
      {
        activity: {
          kind: "activity",
          id: "usage-1",
          tone: "info",
          activityKind: "context-window.updated",
          summary: "Context window updated",
          payload: { usedTokens, maxTokens: 1_000_000, promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: EXPIRES_AT },
          turnId: host.adapter.turnIds.at(-1) ?? null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso()
        }
      },
      "usage-1"
    ),
    ingested(host, threadId, "thread.session-set", { session: { status: "ready", activeTurnId: null } }, "settle")
  ]);
  await host.settle();
  const turnId = host.orchestrator.summary(threadId)?.latestTurn?.turnId;
  assert.ok(turnId, "the turn settled with the provider's id");
  return { threadId, turnId };
}

function compactCalls(host: TestHost): number {
  return host.adapter.calls.filter((call) => call.kind === "compact").length;
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isAgentChatCommandError(error));
    return error.code;
  }
  assert.fail("the command was accepted");
}

describe("idle compaction on the host", () => {
  it("the summary reports the cache the latest completed turn left, and nothing once it was compacted", async () => {
    const host = createTestHost();
    const { threadId, turnId } = await idleThread(host);
    assert.deepEqual(host.orchestrator.summary(threadId)?.idleCompaction, {
      turnId,
      usedTokens: 250_000,
      promptCacheExpiresAt: EXPIRES_AT,
      promptCacheTtlMs: 3_600_000
    });

    await host.orchestrator.command(threadId, "compact", { commandId: `idle-compact:${threadId}:${turnId}`, idle: { turnId } });
    await host.settle();
    assert.equal(compactCalls(host), 1);
    const sent = (host.store.logs.get(threadId) ?? []).filter((event) => event.type === "thread.message-sent").at(-1);
    assert.deepEqual(
      sent?.type === "thread.message-sent" ? [sent.payload.text, sent.payload.sentBy] : null,
      ["/compact", "idle-compaction"]
    );
    // Never a compaction of a compaction.
    assert.equal(host.orchestrator.summary(threadId)?.idleCompaction, null);
    await host.stop();
  });

  it("the same command id again is answered from its receipt: one compaction", async () => {
    const host = createTestHost();
    const { threadId, turnId } = await idleThread(host);
    const commandId = `idle-compact:${threadId}:${turnId}`;
    const first = await host.orchestrator.command(threadId, "compact", { commandId, idle: { turnId } });
    await host.settle();
    const again = await host.orchestrator.command(threadId, "compact", { commandId, idle: { turnId } });
    await host.settle();
    assert.deepEqual(again, first);
    assert.equal(compactCalls(host), 1);
    await host.stop();
  });

  it("refuses without a receipt when the chat moved on or is not idle; the same id compacts once it is idle", async () => {
    const host = createTestHost();
    const { threadId, turnId } = await idleThread(host);
    const before = (host.store.logs.get(threadId) ?? []).length;
    assert.equal(await rejected(host.orchestrator.command(threadId, "compact", { commandId: cmd(), idle: { turnId: "older-turn" } })), "TURN_NOT_IDLE");
    assert.equal(await rejected(host.orchestrator.command(threadId, "compact", { commandId: cmd(), idle: { turnId: "" } })), "INVALID_COMMAND");

    await host.orchestrator.ingestionSink(threadId, [
      ingested(
        host,
        threadId,
        "thread.activity-appended",
        {
          activity: {
            kind: "activity",
            id: "approval:r1",
            tone: "approval",
            activityKind: "approval.requested",
            summary: "Run a command?",
            payload: { requestId: "r1", requestKind: "command" },
            turnId: null,
            createdAt: host.clock.nowIso(),
            updatedAt: host.clock.nowIso()
          }
        },
        "approval-1"
      )
    ]);
    await host.settle();
    const withApproval = (host.store.logs.get(threadId) ?? []).length;
    assert.equal(withApproval, before + 1);
    const commandId = cmd();
    assert.equal(await rejected(host.orchestrator.command(threadId, "compact", { commandId, idle: { turnId } })), "TURN_NOT_IDLE");
    assert.equal((host.store.logs.get(threadId) ?? []).length, withApproval, "nothing was recorded");
    assert.equal(compactCalls(host), 0);

    // The approval is answered: the SAME id, retried inside the window, compacts — no receipt
    // replays the refusal.
    await host.orchestrator.ingestionSink(threadId, [
      ingested(
        host,
        threadId,
        "thread.activity-appended",
        {
          activity: {
            kind: "activity",
            id: "approval-resolved:r1",
            tone: "approval",
            activityKind: "approval.resolved",
            summary: "Approval resolved",
            payload: { requestId: "r1", decision: "accept" },
            turnId: null,
            createdAt: host.clock.nowIso(),
            updatedAt: host.clock.nowIso()
          }
        },
        "approval-resolved-1"
      )
    ]);
    await host.settle();
    await host.orchestrator.command(threadId, "compact", { commandId, idle: { turnId } });
    await host.settle();
    assert.equal(compactCalls(host), 1);
    await host.stop();
  });

  it("a new turn replaces the candidate; a plain compaction is not labelled", async () => {
    const host = createTestHost();
    const { threadId, turnId } = await idleThread(host);
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "one more thing" });
    await host.settle();
    assert.equal(host.orchestrator.summary(threadId)?.idleCompaction, null, "a running turn is not idle");
    assert.equal(await rejected(host.orchestrator.command(threadId, "compact", { commandId: cmd(), idle: { turnId } })), "TURN_NOT_IDLE");
    await host.stop();

    const plain = createTestHost();
    const idle = await idleThread(plain);
    await plain.orchestrator.command(idle.threadId, "compact", { commandId: cmd() });
    await plain.settle();
    const sent = (plain.store.logs.get(idle.threadId) ?? []).filter((event) => event.type === "thread.message-sent").at(-1);
    assert.equal(sent?.type === "thread.message-sent" ? sent.payload.sentBy : "missing", undefined);
    await plain.stop();
  });

  it("a host restarted on the same log reports the same candidate", async () => {
    const host = createTestHost();
    const { threadId, turnId } = await idleThread(host);
    const before = host.orchestrator.summary(threadId)?.idleCompaction;
    await host.orchestrator.stop();
    const next = createTestHost({ store: host.store });
    await next.orchestrator.readThread(threadId);
    assert.deepEqual(next.orchestrator.summary(threadId)?.idleCompaction, before);
    assert.equal(next.orchestrator.summary(threadId)?.idleCompaction?.turnId, turnId);
    await next.stop();
  });
});
