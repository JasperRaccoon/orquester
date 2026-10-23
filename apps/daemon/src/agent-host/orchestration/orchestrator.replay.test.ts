/**
 * A reconnect with nothing new (`GET …/events?after=<head>`) answers an empty replay without
 * reading the log at all; a reconnect with something new still reads it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestHost } from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `cmd-${(commandSeq += 1)}`;

describe("reconnect replay", () => {
  it("an up-to-date cursor answers an empty replay with no log read; an older one reads it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
    await host.settle();
    let tailReads = 0;
    const readTail = host.store.readTail.bind(host.store);
    host.store.readTail = async (id, afterSeq) => {
      tailReads += 1;
      return readTail(id, afterSeq);
    };
    const snapshot = await host.orchestrator.readThread(threadId);
    assert.equal(snapshot.kind, "snapshot");
    const head = (snapshot as { thread: { seq: number } }).thread.seq;
    assert.ok(head > 1);

    const upToDate = await host.orchestrator.readThread(threadId, head);
    assert.deepEqual(upToDate, { kind: "events", seq: head, events: [] });
    assert.equal(tailReads, 0, "nothing new: the log is not read");

    const behind = await host.orchestrator.readThread(threadId, head - 1);
    assert.equal(behind.kind, "events");
    assert.equal((behind as { events: unknown[] }).events.length, 1);
    assert.equal(tailReads, 1);
    await host.stop();
  });
});
