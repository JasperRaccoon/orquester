/**
 * Public item reads over the real store: resident streamed messages and full
 * prompts remain readable even when the wire snapshot slims their content.
 * Retained-message reconstruction and output windows belong to store/tool-output.test.ts.
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
});
