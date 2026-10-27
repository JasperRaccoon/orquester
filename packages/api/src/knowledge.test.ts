import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeMergeKeep } from "./knowledge.ts";

test("knowledgeMergeKeep: the oldest by savedAt instant; the same instant keeps the smaller id; an unreadable date counts as oldest", () => {
  const a = { id: "ke_bbbbbbbbbbbb", savedAt: "2026-10-01T10:00:00.000Z" };
  const b = { id: "ke_aaaaaaaaaaaa", savedAt: "2026-10-20T10:00:00.000Z" };
  assert.equal(knowledgeMergeKeep([b, a]), a);
  assert.equal(knowledgeMergeKeep([a, b]), a);
  // 07:00Z: older than 10:00Z although it reads later as text.
  const offset = { id: "ke_cccccccccccc", savedAt: "2026-10-01T12:00:00+05:00" };
  assert.equal(knowledgeMergeKeep([a, offset, b]), offset);
  const tie = { id: "ke_aaaaaaaaaaaa", savedAt: a.savedAt };
  assert.equal(knowledgeMergeKeep([a, tie]), tie);
  assert.equal(knowledgeMergeKeep([tie, a]), tie);
  const undated = { id: "ke_zzzzzzzzzzzz", savedAt: "" };
  assert.equal(knowledgeMergeKeep([a, undated]), undated);
  assert.equal(knowledgeMergeKeep([]), null);
});
