/**
 * The host's pass-through of `TurnCommandBody.causedBy` (unified MCP design 2026-10-15 §8.4): a
 * new turn records it on its `thread.turn-start-requested` (folded onto `Turn.causedBy`); a steer
 * leaves the running turn's own; a user turn has none; a value that does not parse is dropped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent } from "@orquester/api/agent-chat";

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
});
