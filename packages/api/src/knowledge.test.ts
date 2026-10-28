import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeMergeKeep, knowledgeWorkerTextSize } from "./knowledge.ts";

test("knowledgeWorkerTextSize: a text's UTF-8 bytes once JSON-escaped, without the quotes, so sizes add up", () => {
  const samples = ["", "plain ascii", 'quote " and \\ backslash', "lines\n\r\ttabs\b\f", "\u0001\u001f controls", "é · ≤ — 中文", "emoji 😀 and 𝄞", "lone \ud800 high", "lone \udc00 low", "\udc00\ud800 reversed"];
  for (const text of samples) {
    assert.equal(knowledgeWorkerTextSize(text), Buffer.byteLength(JSON.stringify(text), "utf8") - 2, JSON.stringify(text));
  }
  assert.equal(knowledgeWorkerTextSize(samples.join("")), samples.reduce((sum, text) => sum + knowledgeWorkerTextSize(text), 0));
});

test("knowledgeMergeKeep: the oldest by savedAt instant; the same instant keeps the smaller id; an unreadable date counts as oldest", () => {
  const a = { id: "ke_bbbbbbbbbbbb", savedAt: "2026-10-01T10:00:00.000Z" };
  const b = { id: "ke_aaaaaaaaaaaa", savedAt: "2026-10-20T10:00:00.000Z" };
  assert.equal(knowledgeMergeKeep([b, a])?.id, "ke_bbbbbbbbbbbb");
  assert.equal(knowledgeMergeKeep([a, b])?.id, "ke_bbbbbbbbbbbb");
  // 07:00Z: older than 10:00Z although it reads later as text.
  const offset = { id: "ke_cccccccccccc", savedAt: "2026-10-01T12:00:00+05:00" };
  assert.equal(knowledgeMergeKeep([a, offset, b])?.id, "ke_cccccccccccc");
  const tie = { id: "ke_aaaaaaaaaaaa", savedAt: a.savedAt };
  assert.equal(knowledgeMergeKeep([a, tie])?.id, "ke_aaaaaaaaaaaa");
  assert.equal(knowledgeMergeKeep([tie, a])?.id, "ke_aaaaaaaaaaaa");
  const undated = { id: "ke_zzzzzzzzzzzz", savedAt: "" };
  assert.equal(knowledgeMergeKeep([a, undated])?.id, "ke_zzzzzzzzzzzz");
  assert.equal(knowledgeMergeKeep([]), null);
});
