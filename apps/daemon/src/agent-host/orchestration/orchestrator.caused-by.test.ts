/**
 * The host's pass-through of `TurnCommandBody.causedBy` (unified MCP design 2026-10-15 §8.4): a
 * new turn records it on its `thread.turn-start-requested` (folded onto `Turn.causedBy`); a steer
 * leaves the running turn's own; a user turn has none; a value that does not parse is dropped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent } from "@orquester/api/agent-chat";

import { isAgentChatCommandError } from "./errors.ts";
import { createTestHost, type TestHost } from "./testing/index.ts";

let seq = 0;
const cmd = (): string => `caused-${(seq += 1)}`;

function starts(host: TestHost, threadId: string): Array<Record<string, unknown>> {
  return (host.store.logs.get(threadId) ?? [])
    .filter((event: DomainEvent) => event.type === "thread.turn-start-requested")
    .map((event) => event.payload as unknown as Record<string, unknown>);
}

async function turns(host: TestHost, threadId: string) {
  const read = await host.orchestrator.readThread(threadId);
  assert.ok(read.kind === "snapshot");
  return read.thread.turns;
}

describe("causedBy on turn commands", () => {
  it("a caused turn persists its exchange; a steer into it keeps that exchange", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    const causedBy = { threadId: "requester", exchangeId: "ex-1", hop: 2 };
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "from another chat", causedBy });
    await host.settle();
    // The turn is still running (the scripted adapter never ends it): this is a steer.
    await host.orchestrator.command(threadId, "turn", {
      commandId: cmd(),
      input: "steered by someone else",
      causedBy: { threadId: "other", exchangeId: "ex-2", hop: 5 }
    });
    await host.settle();
    const recorded = starts(host, threadId);
    assert.equal(recorded.length, 1, "a steer opens no turn");
    assert.deepEqual(recorded[0]!.causedBy, causedBy);
    const folded = await turns(host, threadId);
    assert.deepEqual(folded[0]!.causedBy, causedBy, "the running turn keeps its own exchange");
    assert.equal(folded.some((turn) => turn.causedBy?.exchangeId === "ex-2"), false, "the steer's exchange lands nowhere");
    await host.stop();
  });

  it("a user turn carries none, and a malformed causedBy is dropped", async () => {
    for (const body of [{}, { causedBy: { threadId: "", exchangeId: "x", hop: 1 } }, { causedBy: "ex-1" }]) {
      const host = createTestHost();
      const threadId = await host.createThread();
      await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello", ...body });
      await host.settle();
      assert.equal("causedBy" in starts(host, threadId)[0]!, false, JSON.stringify(body));
      assert.equal((await turns(host, threadId))[0]!.causedBy, undefined);
      await host.stop();
    }
  });

  it("ifIdle: a new turn on an idle thread; with a turn active, refused (not recorded) instead of steering", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first", ifIdle: true });
    await host.settle();
    assert.equal(starts(host, threadId).length, 1, "idle: it starts a turn");
    const id = cmd();
    const before = (host.store.logs.get(threadId) ?? []).length;
    await assert.rejects(
      host.orchestrator.command(threadId, "turn", { commandId: id, input: "would steer", ifIdle: true }),
      (error: unknown) =>
        isAgentChatCommandError(error) &&
        error.code === "COMMAND_REJECTED" &&
        (error.detail as { reason?: unknown } | undefined)?.reason === "turn-not-idle"
    );
    assert.equal((host.store.logs.get(threadId) ?? []).length, before, "nothing appended");
    assert.equal(host.store.receipts.has(id), false, "not recorded: the same id may land later");
    // Without the precondition the same message steers, as before.
    await host.orchestrator.command(threadId, "turn", { commandId: id, input: "steers" });
    await host.settle();
    assert.equal(starts(host, threadId).length, 1);
    await host.stop();
  });

  it("ifIdle: a turn requested but not yet started (no settle in between) is not idle — never a steer into the user's turn", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    // The user's turn: no settle, so it may still be the pending row (sendTurn not returned).
    const user = host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "the user's turn" });
    const id = cmd();
    await assert.rejects(
      host.orchestrator.command(threadId, "turn", { commandId: id, input: "a reply-bound message", ifIdle: true }),
      (error: unknown) => isAgentChatCommandError(error) && (error.detail as { reason?: unknown } | undefined)?.reason === "turn-not-idle"
    );
    await user;
    await host.settle();
    const userMessages = (host.store.logs.get(threadId) ?? []).filter(
      (event) => event.type === "thread.message-sent" && (event.payload as { role?: string }).role === "user"
    );
    assert.equal(userMessages.length, 1, "the message never joined the user's turn");
    assert.equal(host.store.receipts.has(id), false);
    await host.stop();
  });

  it("ifIdle: a turn queued behind a compaction is not idle", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "first" });
    await host.settle();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "settle",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "ready", activeTurnId: null } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ] as never);
    let releaseCompact: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCompact = () => resolve();
    });
    const compact = host.adapter.compact.bind(host.adapter);
    host.adapter.compact = async (id: string) => {
      await gate;
      return compact(id);
    };
    await host.orchestrator.command(threadId, "compact", { commandId: cmd() });
    await new Promise((resolve) => setImmediate(resolve));
    // No turn is active (the first settled): only the compaction in flight makes it busy.
    const read = await host.orchestrator.readThread(threadId);
    assert.ok(read.kind === "snapshot");
    assert.equal(read.thread.head.session.activeTurnId, null, "an activeTurnId-only check would let it through");
    await assert.rejects(
      host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "during compaction", ifIdle: true }),
      (error: unknown) => isAgentChatCommandError(error) && (error.detail as { reason?: unknown } | undefined)?.reason === "turn-not-idle"
    );
    // A user turn is queued behind it; still not idle for a reply-bound one.
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "queued by the user" });
    await assert.rejects(
      host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "behind the queue", ifIdle: true }),
      (error: unknown) => isAgentChatCommandError(error) && (error.detail as { reason?: unknown } | undefined)?.reason === "turn-not-idle"
    );
    releaseCompact();
    await host.settle();
    await host.stop();
  });
});
