/**
 * Inline chat images' shared module (spec 2026-11-10 §9): the reference
 * reader on a tool row (slimmed or not), Codex's `image_generation` item, and
 * the image sources an agent names.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { imageToolReferenceOfActivityPayload, parseChatImageSource, readImageToolReference } from "./chat-images.ts";
import { boundSessionToolData, sessionToolMarkedData } from "./session-tools.ts";

const REGISTERED = new Set(["show_image", "generate_image", "html_render"]);
const IMAGE_ID = "thread_1-0f8e4c1a-1111-4222-8333-944445555666-png";
const REF = { title: "Before / after", images: [{ attachmentId: IMAGE_ID, mimeType: "image/png", width: 1024, height: 768, caption: "after" }] };

function claudeRow(tool: string, result: unknown): Record<string, unknown> {
  return {
    itemType: "mcp_tool_call",
    status: "completed",
    data: {
      toolName: `mcp__orquester__${tool}`,
      result: { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: JSON.stringify(result) }] }
    }
  };
}

const ingested = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  data: boundSessionToolData(sessionToolMarkedData(row.data, REGISTERED))
});

test("a show_image row's images read back, from the result and after the slimming", () => {
  const row = ingested(claudeRow("show_image", { imageRef: REF, attachments: [IMAGE_ID] }));
  assert.deepEqual(imageToolReferenceOfActivityPayload(row), REF);
});

test("an unmarked row, another session tool, or a user's same-named server shows no image", () => {
  assert.equal(imageToolReferenceOfActivityPayload(claudeRow("show_image", { imageRef: REF })), undefined);
  assert.equal(imageToolReferenceOfActivityPayload(ingested(claudeRow("html_render", { imageRef: REF }))), undefined);
  const other = { ...claudeRow("show_image", { imageRef: REF }), data: { toolName: "mcp__other__show_image", result: { content: JSON.stringify({ imageRef: REF }) } } };
  assert.equal(imageToolReferenceOfActivityPayload(ingested(other)), undefined);
});

test("a Codex image_generation item carries its images on data.imageRef", () => {
  assert.deepEqual(imageToolReferenceOfActivityPayload({ itemType: "image_generation", data: { imageRef: REF } }), REF);
  assert.equal(imageToolReferenceOfActivityPayload({ itemType: "unknown", data: { imageRef: REF } }), undefined);
});

test("an image whose id is a path is dropped, and a reference with none left is none", () => {
  assert.equal(readImageToolReference({ images: [{ attachmentId: "../../etc/passwd" }, { attachmentId: "a/b" }] }), undefined);
  assert.deepEqual(readImageToolReference({ images: [{ attachmentId: "x/y" }, { attachmentId: IMAGE_ID }] }), { images: [{ attachmentId: IMAGE_ID }] });
});

test("recent:N and attachment:<id> parse; paths and out-of-range values do not", () => {
  assert.deepEqual(parseChatImageSource("recent:1"), { kind: "recent", n: 1 });
  assert.deepEqual(parseChatImageSource(`attachment:${IMAGE_ID}`), { kind: "attachment", attachmentId: IMAGE_ID });
  for (const value of ["recent:0", "recent:51", "attachment:../x", "attachment:", "/tmp/shot.png", "assets/a.png", 3]) {
    assert.equal(parseChatImageSource(value), null, String(value));
  }
});
