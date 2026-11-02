import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsagePricingFile, serializeUsagePricingFile } from "./index.ts";

test("a malformed price or mapping is dropped on its own, and unknown fields survive a rewrite", () => {
  const parsed = parseUsagePricingFile({
    version: 1,
    note: "kept",
    overrides: {
      " gpt-6-astra ": { input: 10, output: 50, cacheRead: 1 },
      "negative": { input: -1, output: 2 },
      "no-output": { input: 1 },
      "": { input: 1, output: 1 }
    },
    aliases: { "my-model": "claude-opus-5-5", "self": "self", "bad": 3 }
  });
  assert.deepEqual(parsed.overrides, { "gpt-6-astra": { input: 10, output: 50, cacheRead: 1 } });
  assert.deepEqual(parsed.aliases, { "my-model": "claude-opus-5-5" });
  assert.equal(serializeUsagePricingFile(parsed).note, "kept");
});

test("a file that is not an object reads as no prices", () => {
  assert.deepEqual(parseUsagePricingFile([1, 2]), { overrides: {}, aliases: {}, extra: {} });
  assert.deepEqual(parseUsagePricingFile(null), { overrides: {}, aliases: {}, extra: {} });
});
