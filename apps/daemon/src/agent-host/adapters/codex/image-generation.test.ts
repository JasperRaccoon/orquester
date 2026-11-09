/**
 * Codex adapter — Codex's own image tool (design 2026-11-10 §9.4), against
 * the scripted mock peer: a completed `imageGeneration` item's picture is
 * stored as a thread attachment and its row carries only the reference; a
 * failed item is a failed row that says why.
 *
 * The item frames are observed-shape, built from the generated binding
 * (`_generated/protocol/ImageGenerationItem.ts`) with a tiny valid PNG: no
 * capture of the tool is committed (fixtures README observation 26).
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { imageToolReferenceOfActivityPayload, type RuntimeEvent } from "@orquester/api/agent-chat";

import { AsyncEventQueue } from "./event-queue.ts";
import { CodexSession } from "./session.ts";
import { EventCollector, createFakeContext, writeMockCodexServer } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const STORED_ID = "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-png";
/** A valid 1×1 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function rig() {
  const server = writeMockCodexServer({ turns: [] });
  cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
  const stored: Array<{ threadId: string; name: string; mimeType: string; bytes: string; encoding?: string }> = [];
  const { context } = createFakeContext({
    storeAttachment: async (threadId, input) => {
      stored.push({ threadId, ...input });
      return STORED_ID;
    }
  });
  const queue = new AsyncEventQueue<RuntimeEvent>();
  const events = new EventCollector(queue);
  let seq = 0;
  const session = new CodexSession({
    context,
    threadId: "thread-1",
    cwd: process.cwd(),
    bin: server.bin,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    runtimeMode: "approval-required",
    modelSelection: { model: "gpt-5.5" },
    emit: (draft) => {
      queue.push({ ...draft, eventId: `ev-${++seq}`, threadId: "thread-1", createdAt: "2026-11-10T00:00:00.000Z" } as RuntimeEvent);
    },
    onClosed: () => undefined
  });
  cleanups.push(async () => {
    await session.stop();
    queue.close();
  });
  return {
    session,
    events,
    stored,
    notify: async (method: string, params: unknown) => {
      server.notify(method, params);
      await session.readThread();
    }
  };
}

const imageItem = (overrides: Record<string, unknown> = {}) => ({
  type: "imageGeneration",
  id: "ig-1",
  status: "completed",
  revisedPrompt: "A red fox in the snow",
  result: PNG_BASE64,
  failure: null,
  ...overrides
});

const agentMessage = (id: string) => ({
  type: "agentMessage",
  id,
  text: "here it is",
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null
});

type ItemEvent = Extract<RuntimeEvent, { type: "item.started" | "item.completed" }>;
const find = (events: RuntimeEvent[], type: ItemEvent["type"], itemId: string) =>
  events.findIndex((event) => event.type === type && event.itemId === itemId);

describe("codex — its own image tool", () => {
  it("stores a completed image as an attachment and writes only its reference, ahead of what came after", async () => {
    const r = rig();
    await r.session.start();
    const threadId = (r.session.summary().resumeCursor as { threadId: string }).threadId;
    await r.notify("item/started", { item: imageItem({ status: "in_progress", result: "" }), threadId, turnId: "t", startedAtMs: 1 });
    await r.notify("item/completed", { item: imageItem(), threadId, turnId: "t", completedAtMs: 2 });
    await r.notify("item/completed", { item: agentMessage("msg-after"), threadId, turnId: "t", completedAtMs: 3 });
    await r.events.waitFor((event) => event.type === "item.completed" && event.itemId === "msg-after", "the later message");
    const events = r.events.events;

    const started = events[find(events, "item.started", "ig-1")] as ItemEvent;
    assert.equal(started.payload.itemType, "image_generation");
    assert.equal(started.payload.status, "inProgress");
    assert.equal(imageToolReferenceOfActivityPayload(started.payload), undefined, "no image while it is generating");

    assert.equal(r.stored.length, 1, "stored once");
    assert.equal(r.stored[0]!.threadId, "thread-1");
    assert.equal(r.stored[0]!.mimeType, "image/png");
    assert.equal(r.stored[0]!.name, "codex-image.png");
    assert.equal(r.stored[0]!.encoding, "base64");
    assert.equal(r.stored[0]!.bytes, PNG_BASE64);

    const index = find(events, "item.completed", "ig-1");
    const completed = events[index] as ItemEvent;
    assert.equal(completed.payload.status, "completed");
    assert.deepEqual(imageToolReferenceOfActivityPayload(completed.payload), {
      images: [{ attachmentId: STORED_ID, mimeType: "image/png", width: 1, height: 1, caption: "A red fox in the snow" }],
      revisedPrompt: "A red fox in the snow"
    });
    assert.ok(!JSON.stringify(completed.payload).includes(PNG_BASE64.slice(0, 40)), "no image bytes in the event");
    assert.ok(index < find(events, "item.completed", "msg-after"), "the image row keeps its place before the later frame");
  });

  it("a failed or empty image is a failed row that says why, and nothing is stored", async () => {
    const r = rig();
    await r.session.start();
    const threadId = (r.session.summary().resumeCursor as { threadId: string }).threadId;
    const failure = { type: "usageLimitExceeded", limitId: "codex", resetsAt: 1_800_000_000 };
    await r.notify("item/completed", {
      item: imageItem({ id: "ig-limit", status: "failed", result: "", failure }),
      threadId,
      turnId: "t",
      completedAtMs: 1
    });
    await r.notify("item/completed", { item: imageItem({ id: "ig-empty", result: "" }), threadId, turnId: "t", completedAtMs: 2 });
    await r.events.waitFor((event) => event.type === "item.completed" && event.itemId === "ig-empty", "the empty image");
    const events = r.events.events;

    const limited = events[find(events, "item.completed", "ig-limit")] as ItemEvent;
    assert.equal(limited.payload.itemType, "image_generation");
    assert.equal(limited.payload.status, "failed");
    assert.match(limited.payload.detail ?? "", /^Codex image generation failed: usage limit reached; it resets at 2027-01-15T08:00:00.000Z$/);

    const empty = events[find(events, "item.completed", "ig-empty")] as ItemEvent;
    assert.equal(empty.payload.status, "failed");
    assert.equal(empty.payload.detail, "Codex image generation returned no image");
    assert.equal(imageToolReferenceOfActivityPayload(empty.payload), undefined);
    assert.equal(r.stored.length, 0);
  });
});
