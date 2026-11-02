import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsagePricingFile, patchUsagePricingFile, serializeUsagePricingFile } from "./index.ts";

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

test("an edit replaces the edited model's entries only; invalid entries and fields a newer writer added are written back", () => {
  const read = parseUsagePricingFile({
    overrides: {
      "house-model": { input: 2, output: 8, tier: "batch" },
      " edited ": { input: 1, output: 1 },
      "future-model": { input: "per-request", output: 1 }
    },
    aliases: { "my-model": "claude-opus-5-5", "bad": 3 }
  });
  assert.deepEqual(read.overrides["house-model"], { input: 2, output: 8 });
  const next = patchUsagePricingFile(read, { overrides: { edited: { input: 3, output: 4 } }, aliases: { "my-model": null } });
  assert.deepEqual(serializeUsagePricingFile(next), {
    version: 1,
    overrides: { "house-model": { input: 2, output: 8, tier: "batch" }, "future-model": { input: "per-request", output: 1 }, edited: { input: 3, output: 4 } },
    aliases: { bad: 3 }
  });
  assert.deepEqual(next.overrides, { "house-model": { input: 2, output: 8 }, edited: { input: 3, output: 4 } });
});

test("a file that is not an object reads as no prices", () => {
  const none = { overrides: {}, aliases: {}, extra: {}, raw: { overrides: {}, aliases: {} } };
  assert.deepEqual(parseUsagePricingFile([1, 2]), none);
  assert.deepEqual(parseUsagePricingFile(null), none);
});
