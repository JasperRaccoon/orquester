import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, aggregateRows } from "./usage-tokens.ts";

test("estimateCostUsd multiplies by the per-million price table", () => {
  // claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 per 1M
  const cost = estimateCostUsd("claude", "claude-opus-4-8", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 30);
});

test("unknown model yields null cost", () => {
  assert.equal(estimateCostUsd("claude", "made-up-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test("aggregateRows groups by agent/model/day and sums tokens", () => {
  const rows = aggregateRows([
    { agent: "claude", model: "claude-opus-4-8", day: "2026-07-07", input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
    { agent: "claude", model: "claude-opus-4-8", day: "2026-07-07", input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 15);
  assert.equal(rows[0].outputTokens, 5);
  assert.equal(rows[0].costSource, "api_equivalent");
});
