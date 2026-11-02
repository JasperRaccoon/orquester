import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { aliasesHaveCycle, canonicalModel, estimateCostParts, priceSlice, resolvePricingKey, setUsagePricingConfig, usagePricingRevision } from "./usage-pricing.ts";

afterEach(() => setUsagePricingConfig({ overrides: {}, aliases: {} }));

const M = 1_000_000;
const tokens = (over: Partial<{ input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number }> = {}) => ({
  input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, ...over
});

test("an override beats the built-in table, and its omitted cache rates inherit the model's built-in ones", () => {
  setUsagePricingConfig({ overrides: { "claude-opus-5-5": { input: 2, output: 8 } }, aliases: {} });
  const priced = priceSlice("claude-opus-5-5", "standard", tokens({ input: M, cacheRead: M, cacheWrite: M, output: M }))!;
  // input 2 + read (built-in 0.2) + 5m write (built-in 5) + output 8
  assert.equal(priced.costUsd, 15.2);
  assert.equal(priced.rateSource, "override");
  assert.equal(priced.cacheSavingsUsd, 1.8);
});

test("an override for an unknown model bills cache reads and writes at its input rate unless given", () => {
  setUsagePricingConfig({ overrides: { "house-model": { input: 2, output: 8, cacheRead: 0.5 } }, aliases: {} });
  const priced = priceSlice("house-model", "standard", tokens({ input: M, cacheRead: M, cacheWrite: M, output: M }))!;
  assert.equal(priced.costUsd, 2 + 0.5 + 2 + 8);
  assert.equal(priced.cacheSavingsUsd, 1.5);
});

test("an override matches the exact id, then the id without its context tag or date suffix", () => {
  setUsagePricingConfig({ overrides: { "claude-opus-4-8": { input: 1, output: 1 } }, aliases: {} });
  assert.equal(priceSlice("claude-opus-4-8-20260115", "standard", tokens({ input: M }))!.costUsd, 1);
  assert.equal(priceSlice("claude-opus-4-8[1m]", "standard", tokens({ input: M }))!.costUsd, 1);
  assert.equal(priceSlice("Claude-Opus-4-8", "standard", tokens({ input: M }))!.rateSource, "builtin");
});

test("a mapped model is priced as its target, and a mapping cycle is ignored", () => {
  setUsagePricingConfig({ overrides: {}, aliases: { "my-proxy-opus": "claude-opus-5-5", a: "b", b: "a" } });
  assert.equal(canonicalModel("my-proxy-opus"), "claude-opus-5-5");
  assert.equal(canonicalModel("a"), "a");
  assert.equal(estimateCostParts("my-proxy-opus", { input: M, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })!.input, 4);
  assert.equal(aliasesHaveCycle({ a: "b", b: "c" }), false);
  assert.equal(aliasesHaveCycle({ a: "b", b: "c", c: "a" }), true);
});

test("fast requests bill at the model's fast tier, and at standard rates when it has none", () => {
  const fast = priceSlice("claude-opus-5-5", "fast", tokens({ input: M, output: M }))!;
  assert.equal(fast.costUsd, 8 + 40);
  assert.equal(priceSlice("claude-sonnet-5-5", "fast", tokens({ input: M }))!.costUsd, 2);
  assert.equal(priceSlice("gpt-6-astra", "ultrafast", tokens({ output: M }))!.costUsd, 300);
});

test("models the table can't place are unpriced: family slugs and unknown ids", () => {
  for (const model of ["opus", "default", "<synthetic>", "made-up"]) assert.equal(resolvePricingKey(model), null, model);
  assert.equal(resolvePricingKey("anthropic/claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(resolvePricingKey("claude-sonnet-5-5"), "claude-sonnet-5-5");
});

test("a key absorbs date, version and release suffixes, never a name part that makes another model", () => {
  for (const [model, key] of [
    ["claude-opus-4-8-20260115", "claude-opus-4-8"],
    ["claude-sonnet-4-5-2025-09-29", "claude-sonnet-4-5"],
    ["gpt-5.4-codex-preview", "gpt-5.4-codex"],
    ["grok-4.20-0309-non-reasoning", "grok-4.20"],
    ["o4-mini-2025-04-16", "o4-mini"],
    ["gemini-2.5-flash-preview-05-20", "gemini-2.5-flash"]
  ]) assert.equal(resolvePricingKey(model), key, model);
  for (const model of [
    "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5-codex-mini", "o3-mini", "o3-pro", "gpt-5.2-pro", "gpt-5.5-pro",
    "gpt-5.4-nano", "gemini-2.5-flash-lite", "gpt-5-mini-2025-08-07"
  ]) assert.equal(resolvePricingKey(model), null, model);
});

test("installing prices bumps the revision the scanners reprice on", () => {
  const before = usagePricingRevision();
  setUsagePricingConfig({ overrides: {}, aliases: {} });
  assert.equal(usagePricingRevision(), before + 1);
});
