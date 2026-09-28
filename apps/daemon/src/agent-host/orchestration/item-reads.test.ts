/**
 * The orchestrator's item reads over the REAL store (`createThreadStore`): `GET …/items/:itemId` and
 * `GET …/items/:itemId/output?offset=&maxBytes=` reach the store's own paths — its item cursor and tool-output cache —
 * which the host's HTTP and MCP harnesses, running on the in-memory fake, never do.
 * Message reconstruction after retention is owned by store/tool-output.test.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { runtimeEventToActivities } from "../ingestion/activities.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createThreadStore } from "../store/index.ts";
import { createTestHost } from "./testing/index.ts";

/** A test host running the public item reads against the durable store. */
async function realStoreHost(t: { after(fn: () => unknown): void }) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-item-reads-"));
  const store = createThreadStore({ rootDir });
  const host = createTestHost({ store });
  t.after(async () => {
    await host.stop();
    store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { host };
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
  it("reads the complete resident message after streamed deltas", async (t) => {
    const { host } = await realStoreHost(t);
    const threadId = await host.createThread();
    // A message streamed in many deltas, then settled by a frame whose empty text keeps the body.
    const deltas = Array.from({ length: 60 }, (_, i) => `chunk ${i} ✓ 😀 "quoted" \\ \n`);
    await host.orchestrator.ingestionSink(threadId, [...deltas.map((text) => said(threadId, "assistant:1", text, true)), said(threadId, "assistant:1", "", false)]);
    await host.settle();

    const resident = await host.orchestrator.readItem(threadId, "assistant:1");

    assert.deepEqual([resident?.kind, resident?.kind === "message" ? resident.text : null], ["message", deltas.join("")]);
  });

  it("an agent's launch prompt: the snapshot carries it slimmed and flagged, the item read serves it as stored", async (t) => {
    const { host } = await realStoreHost(t);
    const threadId = await host.createThread();
    // Past the wire's 16 KiB cap, within the host's at-rest bound: the one
    // range where the drill-in's "load the whole prompt" read has more.
    const prompt = `Audit the store.\n${"Context line — ✓.\n".repeat(1_100)}`;
    assert.ok(prompt.length > 16_384 && prompt.length <= 32_000);
    const [start] = runtimeEventToActivities({
      eventId: "re-start",
      threadId,
      createdAt: "2026-09-24T10:00:00.000Z",
      type: "task.started",
      payload: { taskId: "agent-1", taskType: "subagent", description: "Audit", prompt }
    });
    await host.orchestrator.ingestionSink(threadId, [
      sinkEvent(threadId, "thread.activity-appended", { activity: start })
    ]);
    await host.settle();

    const read = await host.orchestrator.readThread(threadId);
    assert.ok(read.kind === "snapshot");
    const wire = read.thread.items.find((item) => item.id === "re-start");
    const wirePayload = (wire?.kind === "activity" ? wire.payload : null) as Record<string, unknown> | null;
    assert.ok(wirePayload !== null && typeof wirePayload.prompt === "string");
    assert.ok(prompt.startsWith((wirePayload.prompt as string).slice(0, -1)), "the wire copy is the prompt's head");
    assert.ok((wirePayload.prompt as string).length < prompt.length);
    assert.equal(wirePayload.truncated, true, "the snapshot says the item read has more");

    const stored = await host.orchestrator.readItem(threadId, "re-start");
    assert.equal(stored?.kind === "activity" ? (stored.payload as Record<string, unknown>).prompt : null, prompt);
  });

  it("serves output windows including newly appended output and completion", async (t) => {
    const { host } = await realStoreHost(t);
    const threadId = await host.createThread();
    await host.orchestrator.ingestionSink(threadId, [
      shellRow(threadId, "shell-start", "tool.started", { itemType: "command_execution" }),
      shellRow(threadId, "o1", "tool.output", { streamKind: "command_output", delta: "one\n" }),
      shellRow(threadId, "o2", "tool.output", { streamKind: "command_output", delta: "  two\n" })
    ]);
    await host.settle();

    const first = await host.orchestrator.readToolOutputWindow(threadId, "shell-start", { offset: 0, maxBytes: 4 });
    assert.deepEqual(first, { toolUseId: "bgshell:task-1", offset: 0, text: "one\n", totalBytes: 10, nextOffset: 4, complete: false, truncated: false });

    await host.orchestrator.ingestionSink(threadId, [
      shellRow(threadId, "o3", "tool.output", { streamKind: "command_output", delta: "three\n" }),
      shellRow(threadId, "shell-done", "tool.completed", { itemType: "command_execution" })
    ]);
    await host.settle();

    const next = await host.orchestrator.readToolOutputWindow(threadId, "shell-start", { offset: 4, maxBytes: 100 });
    assert.deepEqual(next, { toolUseId: "bgshell:task-1", offset: 4, text: "  two\nthree\n", totalBytes: 16, complete: true, truncated: false });

    assert.deepEqual(await host.orchestrator.readToolOutput(threadId, "shell-start"), { toolUseId: "bgshell:task-1", output: "one\n  two\nthree\n", complete: true, truncated: false });
  });
});
