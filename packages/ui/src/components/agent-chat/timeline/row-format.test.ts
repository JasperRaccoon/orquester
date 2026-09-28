import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeUnifiedDiff } from "./row-format";

test("looksLikeUnifiedDiff recognises a patch and rejects ordinary output", () => {
  assert.ok(looksLikeUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"));
  assert.ok(looksLikeUnifiedDiff("@@ -1,2 +1,3 @@\n a\n+b"));
  assert.ok(!looksLikeUnifiedDiff("Everything is fine\nno patch here"));
  assert.ok(!looksLikeUnifiedDiff(""));
});
