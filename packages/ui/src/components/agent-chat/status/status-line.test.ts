import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveContextMeter,
  formatAutoCompactionSentence,
  formatContextTokens,
  formatContextUsage
} from "./context-meter.ts";
import { formatPlanProgress, planIsRunning, resolveStatusLine } from "./status-line.ts";

const TURN = "2026-09-21T10:00:00.000Z";

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
  assert.equal(formatContextUsage(model), "50k/200k");
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
  assert.equal(formatContextUsage(model), "12k");
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

test("context token formatting keeps a decimal only where it carries information", () => {
  assert.equal(formatContextTokens(0), "0");
  assert.equal(formatContextTokens(999), "999");
  assert.equal(formatContextTokens(1_200), "1.2k");
  assert.equal(formatContextTokens(9_000), "9k");
  assert.equal(formatContextTokens(128_000), "128k");
  assert.equal(formatContextTokens(1_500_000), "1.5m");
  assert.equal(formatContextTokens(null), "0");
});

test("the auto-compaction sentence states a reported threshold exactly", () => {
  assert.equal(
    formatAutoCompactionSentence("Opus 4", 180_000),
    "Compacts automatically at 180,000 tokens."
  );
  assert.equal(
    formatAutoCompactionSentence("Opus 4", null),
    "Context for Opus 4 compacts automatically when needed."
  );
  assert.equal(
    formatAutoCompactionSentence(null, null),
    "Context compacts automatically when needed."
  );
});

test("a provider that says auto-compaction is OFF is believed over the vague copy", () => {
  // `false` is a verdict the adapter proved (Claude's `isAutoCompactEnabled`);
  // `undefined` only means nobody asked, and keeps the reassuring sentence.
  assert.equal(
    formatAutoCompactionSentence("Opus 4", null, false),
    "Auto-compaction is off."
  );
  assert.equal(
    formatAutoCompactionSentence("Opus 4", 180_000, false),
    "Auto-compaction is off.",
    "a stale threshold must not read as a promise the provider will act on it"
  );
  assert.equal(
    formatAutoCompactionSentence("Opus 4", 180_000, true),
    "Compacts automatically at 180,000 tokens."
  );
  assert.equal(
    formatAutoCompactionSentence("Opus 4", null, undefined),
    "Context for Opus 4 compacts automatically when needed."
  );
});

test("the meter carries the auto-compaction verdict through to its model", () => {
  const off = deriveContextMeter({
    usedTokens: 1_000,
    maxTokens: 200_000,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: true,
    compactsAutomatically: false
  });
  assert.equal(off?.compactsAutomatically, false);

  const unknown = deriveContextMeter({
    usedTokens: 1_000,
    maxTokens: 200_000,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: true,
    compactsAutomatically: null
  });
  assert.equal(unknown?.compactsAutomatically, undefined, "unknown stays unknown");
});

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

test("a running turn shimmers its activity label", () => {
  const model = resolveStatusLine({
    connection: "synchronized",
    turnStartedAt: TURN,
    activityLabel: "Editing src/index.ts"
  });
  assert.equal(model.label, "Editing src/index.ts");
  assert.equal(model.live, true);
  assert.equal(model.pulse, true);
  assert.equal(model.ticking, true);
  assert.equal(model.tone, "info");
});

test("a turn with no label yet still reads as working", () => {
  assert.equal(
    resolveStatusLine({ connection: "synchronized", turnStartedAt: TURN, activityLabel: "  " })
      .label,
    "Working"
  );
  assert.equal(
    resolveStatusLine({ connection: "synchronized", turnStartedAt: TURN, activityLabel: null })
      .label,
    "Working"
  );
});

test("a settled thread is muted, static and untimed", () => {
  const model = resolveStatusLine({
    connection: "synchronized",
    turnStartedAt: null,
    activityLabel: "Editing src/index.ts"
  });
  assert.equal(model.label, "Ready");
  assert.equal(model.tone, "muted");
  assert.equal(model.live, false);
  assert.equal(model.pulse, false);
  assert.equal(model.ticking, false);
});

test("a degraded connection outranks the turn, but the elapsed timer keeps running", () => {
  const reconnecting = resolveStatusLine({
    connection: "reconnecting",
    turnStartedAt: TURN,
    activityLabel: "Editing src/index.ts"
  });
  assert.equal(reconnecting.label, "Reconnecting…");
  assert.equal(reconnecting.ticking, true);

  const failed = resolveStatusLine({
    connection: "error",
    turnStartedAt: TURN,
    activityLabel: "Editing src/index.ts"
  });
  assert.equal(failed.label, "Disconnected");
  assert.equal(failed.tone, "danger");
  assert.equal(failed.live, false);
  assert.equal(failed.ticking, false);

  const idle = resolveStatusLine({
    connection: "idle",
    turnStartedAt: null,
    activityLabel: null
  });
  assert.equal(idle.label, "Idle");
  assert.equal(idle.pulse, false);
});

test("plan progress is counted from the steps, never persisted", () => {
  assert.equal(formatPlanProgress(null), null);
  assert.equal(
    formatPlanProgress({ createdAt: TURN, turnId: null, steps: [] }),
    null
  );
  const plan = {
    createdAt: TURN,
    turnId: null,
    steps: [
      { step: "one", status: "completed" as const },
      { step: "two", status: "inProgress" as const },
      { step: "three", status: "pending" as const }
    ]
  };
  assert.equal(formatPlanProgress(plan), "1/3");
  assert.equal(planIsRunning(plan), true);
  assert.equal(
    planIsRunning({ ...plan, steps: plan.steps.map((step) => ({ ...step, status: "completed" as const })) }),
    false
  );
});
