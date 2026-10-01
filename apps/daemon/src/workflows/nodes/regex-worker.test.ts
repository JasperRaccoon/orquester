import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { evaluateRulesAsync, type ExpressionContext } from "@orquester/api";

import { createRegexMatcher } from "./regex-worker.ts";

const ctx = (input: unknown): ExpressionContext => ({ nodes: {}, input, trigger: null, run: {}, project: {}, secrets: {} });

describe("the matches operator runs in a worker with a hard timeout", () => {
  const matcher = createRegexMatcher();
  after(() => matcher.close());

  test("an ordinary pattern answers", async () => {
    assert.deepEqual(await matcher.match({ source: "^fe(at)?", flags: "i", text: "Feature/x" }), { result: true });
    assert.deepEqual(await matcher.match({ source: "^fix", flags: "", text: "feature/x" }), { result: false });
  });

  test("a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works", async () => {
    const started = Date.now();
    let loopProgress = false;
    const probe = setImmediate(() => { loopProgress = true; });
    const slow = await matcher.match({ source: "a*a*a*a*a*a*a*b", flags: "", text: "a".repeat(100_000) })
      .finally(() => clearImmediate(probe));
    const elapsed = Date.now() - started;
    assert.equal(slow.result, false);
    assert.match(slow.warning ?? "", /pattern took longer than \d+ ms to search and was stopped/);
    assert.ok(elapsed < 3_000, `stopped promptly (${elapsed} ms)`);
    assert.ok(loopProgress, "the event loop progresses before the search settles");
    assert.deepEqual(await matcher.match({ source: "b$", flags: "", text: "ab" }), { result: true }, "a fresh worker answers");
  });
});

describe("rule warnings never keep a secret's prefix", () => {
  test("a clipped value is redacted before the clip", async () => {
    const secret = "S".repeat(40) + "-very-long-secret-value-that-passes-sixty-chars";
    const evaluated = await evaluateRulesAsync(
      "all",
      [{ left: "{{ input }}", op: "gt", right: "3" }],
      { ...ctx(secret), secrets: { TOKEN: secret } },
      async () => ({ result: false })
    );
    assert.equal(evaluated.result, false);
    const text = evaluated.warnings.join("\n");
    assert.ok(!text.includes("SSSSSSSSSS"), text);
    assert.match(text, /«secret:TOKEN»/);
  });
});
