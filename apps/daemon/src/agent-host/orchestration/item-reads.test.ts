/**
 * The orchestrator's item reads over the REAL store (`createThreadStore`): `GET …/items/:itemId` and
 * `GET …/items/:itemId/output?offset=&maxBytes=` reach the store's own paths — its item cursor and tool-output cache —
 * which the host's HTTP and MCP harnesses, running on the in-memory fake, never do. And the one read the store is
 * spared: a message the thread's resident fold still holds.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { MESSAGE_RETENTION_LIMIT, MESSAGE_RETENTION_SLACK } from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "../store/index.ts";
import { createTestHost } from "./testing/index.ts";

type RealStore = ReturnType<typeof createThreadStore>;

/** A test host whose orchestrator runs on the real store, with its item reads counted and its log reads recorded. */
async function realStoreHost(t: { after(fn: () => unknown): void }) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-item-reads-"));
  const reads: Array<[string, number, number]> = [];
  const store: RealStore = createThreadStore({ rootDir, sweepIntervalMs: 0, onLogRead: (threadId, from, to) => reads.push([threadId, from, to]) });
  const calls = { readItem: 0, readToolOutputWindow: 0 };
  const readItem = store.readItem.bind(store);
  const readToolOutputWindow = store.readToolOutputWindow.bind(store);
  store.readItem = (threadId, itemId) => {
    calls.readItem += 1;
    return readItem(threadId, itemId);
  };
  store.readToolOutputWindow = (threadId, itemId, window) => {
    calls.readToolOutputWindow += 1;
    return readToolOutputWindow(threadId, itemId, window);
  };
  const host = createTestHost({ store });
  t.after(async () => {
    await host.stop();
    store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { host, store, calls, reads, readItem };
}

let eventCount = 0;
function sinkEvent(threadId: string, type: string, payload: unknown): AppendableDomainEvent {
  eventCount += 1;
  return { eventId: `ev-${eventCount}`, threadId, type, payload, occurredAt: "2026-09-24T10:00:00.000Z", commandId: null, causationEventId: null, metadata: {} } as AppendableDomainEvent;
}
const said = (threadId: string, messageId: string, text: string, streaming: boolean): AppendableDomainEvent =>
  sinkEvent(threadId, "thread.message-sent", { messageId, role: "assistant", text, streaming, turnId: null });
const shellRow = (threadId: string, id: string, activityKind: string, payload: Record<string, unknown>): AppendableDomainEvent =>
  sinkEvent(threadId, "thread.activity-appended", {
    activity: { kind: "activity", id, tone: "tool", activityKind, summary: activityKind, payload: { toolUseId: "bgshell:task-1", ...payload }, turnId: null, createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z" }
  });

describe("the orchestrator's item reads over the real store", () => {
  it("answers a message its resident fold holds from the fold — equal to the store's whole-log fold — never asking the store", async (t) => {
    const { host, calls, readItem } = await realStoreHost(t);
    const threadId = await host.createThread();
    // A message streamed in many deltas, then settled by a frame whose empty text keeps the body.
    const deltas = Array.from({ length: 60 }, (_, i) => `chunk ${i} ✓ 😀 "quoted" \\ \n`);
    await host.orchestrator.ingestionSink(threadId, [...deltas.map((text) => said(threadId, "assistant:1", text, true)), said(threadId, "assistant:1", "", false)]);
    await host.settle();

    const resident = await host.orchestrator.readItem(threadId, "assistant:1");
    assert.equal(calls.readItem, 0, "the store was not asked");
    assert.deepEqual([resident?.kind, resident?.kind === "message" ? resident.text : null], ["message", deltas.join("")]);
    // What the store answers for it, from the log: the same merged message, field for field.
    assert.deepEqual(resident, await readItem(threadId, "assistant:1"));
  });

  it("reads a message retention dropped from the fold, and any activity, through the store", async (t) => {
    const { host, calls, readItem } = await realStoreHost(t);
    const threadId = await host.createThread();
    // One past the batch trim's threshold: the fold cuts messages back to the limit, the oldest first.
    const count = MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK + 1;
    const messages = Array.from({ length: count }, (_, i) => said(threadId, `m-${i}`, `message ${i}`, false));
    for (let i = 0; i < count; i += 500) await host.orchestrator.ingestionSink(threadId, messages.slice(i, i + 500));
    await host.orchestrator.ingestionSink(threadId, [shellRow(threadId, "shell-start", "tool.started", { itemType: "command_execution" })]);
    await host.settle();
    const read = await host.orchestrator.readThread(threadId);
    assert.ok(read.kind === "snapshot");
    assert.equal(read.thread.items.some((item) => item.id === "m-0"), false, "precondition: retention dropped the oldest message");

    const dropped = await host.orchestrator.readItem(threadId, "m-0");
    assert.equal(calls.readItem, 1, "a message the fold no longer holds goes to the store");
    assert.deepEqual(dropped, await readItem(threadId, "m-0"), "and the store's answer is the answer");
    const activity = await host.orchestrator.readItem(threadId, "shell-start");
    assert.equal(calls.readItem, 2, "an activity always goes to the store: the log, not the projection, is its authority");
    assert.equal(activity?.kind === "activity" ? activity.activityKind : null, "tool.started");
    // The newest message is still in the fold: no store read.
    assert.equal((await host.orchestrator.readItem(threadId, `m-${count - 1}`))?.kind, "message");
    assert.equal(calls.readItem, 2);
  });

  it("serves a tool call's output windows from the real store's cache: after the first page, only the log's tail is read", async (t) => {
    const { host, store, calls, reads } = await realStoreHost(t);
    const threadId = await host.createThread();
    await host.orchestrator.ingestionSink(threadId, [
      shellRow(threadId, "shell-start", "tool.started", { itemType: "command_execution" }),
      shellRow(threadId, "o1", "tool.output", { streamKind: "command_output", delta: "one\n" }),
      shellRow(threadId, "o2", "tool.output", { streamKind: "command_output", delta: "  two\n" })
    ]);
    await host.settle();

    const first = await host.orchestrator.readToolOutputWindow(threadId, "shell-start", { offset: 0, maxBytes: 4 });
    assert.deepEqual(first, { toolUseId: "bgshell:task-1", offset: 0, text: "one\n", totalBytes: 10, nextOffset: 4, complete: false, truncated: false });
    assert.equal(calls.readToolOutputWindow, 1, "delegated to the store");

    const before = await store.logLength(threadId);
    await host.orchestrator.ingestionSink(threadId, [
      shellRow(threadId, "o3", "tool.output", { streamKind: "command_output", delta: "three\n" }),
      shellRow(threadId, "shell-done", "tool.completed", { itemType: "command_execution" })
    ]);
    await host.settle();
    const after = await store.logLength(threadId);
    reads.length = 0;
    const next = await host.orchestrator.readToolOutputWindow(threadId, "shell-start", { offset: 4, maxBytes: 100 });
    assert.deepEqual(next, { toolUseId: "bgshell:task-1", offset: 4, text: "  two\nthree\n", totalBytes: 16, complete: true, truncated: false });
    assert.deepEqual(reads, [[threadId, before, after], [threadId, before, after]], "the item's tail, then the join's: never the log from its start");
    assert.deepEqual(await host.orchestrator.readToolOutput(threadId, "shell-start"), { toolUseId: "bgshell:task-1", output: "one\n  two\nthree\n", complete: true, truncated: false });
  });
});
