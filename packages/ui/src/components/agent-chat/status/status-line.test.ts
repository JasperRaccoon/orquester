import test from "node:test";
import assert from "node:assert/strict";
import { deriveContextMeter } from "./context-meter.ts";

// ---------------------------------------------------------------------------
// Meter maths
// ---------------------------------------------------------------------------

test("the meter reports a percentage only when a context window is reported", () => {
  const model = deriveContextMeter({
    usedTokens: 50_000,
    maxTokens: 200_000,
    autoCompactAtTokens: 180_000,
    totalProcessedTokens: 640_000,
    reportsContextWindow: true
  });
  assert.ok(model);
  assert.equal(model.usedPercentage, 25);
  assert.equal(model.remainingTokens, 150_000);
  assert.equal(model.degraded, false);
});

test("without maxTokens there is no ring and no percentage — never a zero", () => {
  const model = deriveContextMeter({
    usedTokens: 12_400,
    maxTokens: null,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: true
  });
  assert.ok(model);
  assert.equal(model.maxTokens, null);
  assert.equal(model.usedPercentage, null);
  assert.equal(model.remainingTokens, null);
  assert.equal(model.degraded, true);
});

test("an adapter that does not report a context window degrades even if a max leaks through", () => {
  const model = deriveContextMeter({
    usedTokens: 1_000,
    maxTokens: 200_000,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: false
  });
  assert.ok(model);
  assert.equal(model.maxTokens, null);
  assert.equal(model.usedPercentage, null);
  assert.equal(model.degraded, true);
});

test("usage past the window clamps at 100% and never reports negative remaining", () => {
  const model = deriveContextMeter({
    usedTokens: 220_000,
    maxTokens: 200_000,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: true
  });
  assert.ok(model);
  assert.equal(model.usedPercentage, 100);
  assert.equal(model.remainingTokens, 0);
});

test("no usage frame yet means no meter at all, not a zeroed one", () => {
  assert.equal(
    deriveContextMeter({
      usedTokens: null,
      maxTokens: 200_000,
      autoCompactAtTokens: null,
      totalProcessedTokens: null,
      reportsContextWindow: true
    }),
    null
  );
  assert.equal(
    deriveContextMeter({
      usedTokens: -1,
      maxTokens: null,
      autoCompactAtTokens: null,
      totalProcessedTokens: null,
      reportsContextWindow: true
    }),
    null
  );
});

test("zero and non-finite extras are dropped rather than shown", () => {
  const model = deriveContextMeter({
    usedTokens: 10,
    maxTokens: 0,
    autoCompactAtTokens: 0,
    totalProcessedTokens: Number.NaN,
    reportsContextWindow: true
  });
  assert.ok(model);
  assert.equal(model.maxTokens, null);
  assert.equal(model.autoCompactAtTokens, null);
  assert.equal(model.totalProcessedTokens, null);
});
