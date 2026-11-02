import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bucket, historyResponse, projectBucket, tokens } from "./fixtures.test-helpers";
import { deriveModelDetail, deriveUsageView } from "./usage-view.logic";

// Two days of Claude and Codex, plus one unpriced Codex model and a reported Grok turn.
const data = historyResponse({
  buckets: [
    bucket({
      period: 1,
      agent: "claude",
      model: "claude-opus-5",
      tokens: tokens({ input: 100, cacheRead: 700, cacheWrite: 200, output: 50, reasoning: 0 }),
      costUsd: 6,
      cost: { input: 1, cacheRead: 2, cacheWrite: 1, output: 2 },
      cacheSavingsUsd: 3
    }),
    bucket({
      period: 3,
      agent: "claude",
      model: "claude-opus-5",
      speed: "fast",
      tokens: tokens({ input: 50, output: 50 }),
      costUsd: 4,
      cost: { input: 1, cacheRead: 0, cacheWrite: 0, output: 3 }
    }),
    bucket({
      period: 3,
      agent: "codex",
      model: "gpt-6-sol",
      tokens: tokens({ input: 200, cacheRead: 600, output: 200, reasoning: 80 }),
      costUsd: 10,
      cost: { input: 4, cacheRead: 2, cacheWrite: 0, output: 4 }
    }),
    bucket({
      period: 3,
      agent: "codex",
      model: "gpt-6-mystery",
      tokens: tokens({ input: 3000, output: 1000 }),
      costUsd: null,
      costSource: "unpriced",
      unpricedTokens: 4000
    }),
    bucket({
      period: 5,
      agent: "grok",
      model: "grok-build",
      tokens: tokens({ input: 100 }),
      costUsd: 0.5,
      costSource: "reported"
    })
  ],
  projectBuckets: [
    projectBucket({ project: "acme/web", agent: "claude", model: "claude-opus-5", tokens: tokens({ input: 1000 }), costUsd: 8 }),
    projectBucket({ project: "acme/web", agent: "codex", model: "gpt-6-sol", tokens: tokens({ input: 500 }), costUsd: 2 }),
    projectBucket({ project: "", agent: "codex", model: "gpt-6-mystery", tokens: tokens({ input: 4000 }), costUsd: null, unpricedTokens: 4000 })
  ],
  sessions: {
    total: 9,
    byAgent: { claude: 4, codex: 3, grok: 2 },
    byModel: { "claude:claude-opus-5": 4, "codex:gpt-6-sol": 2, "codex:gpt-6-mystery": 1, "grok:grok-build": 2 },
    byProject: { "acme/web": 5, "": 1 }
  }
});

describe("deriveUsageView", () => {
  it("totals tokens and the known cost, leaving unpriced tokens out of cost", () => {
    const { totals } = deriveUsageView(data, "cost", []);
    assert.equal(totals.processed, 1050 + 100 + 1000 + 4000 + 100);
    assert.equal(totals.costUsd, 20.5);
    assert.equal(totals.unpricedTokens, 4000);
    assert.equal(totals.unpricedShare, 4000 / 6250);
    assert.equal(totals.sessions, 9);
    assert.equal(totals.activePeriods, 3);
    assert.equal(totals.cacheSavingsUsd, 3);
    // Cache writes are input that missed the cache.
    assert.equal(totals.cachedInputShare, 1300 / (3450 + 1300 + 200));
    // The reported Grok cost has no split: it is "Other".
    assert.deepEqual(totals.costByType, { input: 6, cacheRead: 4, cacheWrite: 1, output: 9, other: 0.5 });
    assert.deepEqual(totals.costBySpeed, { standard: 16.5, fast: 4, ultrafast: 0 });
  });

  it("gives every agent its share of the known cost and of tokens, in the fixed agent order", () => {
    const rows = deriveUsageView(data, "cost", []).agentRows;
    assert.deepEqual(
      rows.map((r) => [r.agent, r.costUsd, r.costShare, r.tokenShare, r.sessions]),
      [
        ["codex", 10, 10 / 20.5, 5000 / 6250, 3],
        ["claude", 10, 10 / 20.5, 1150 / 6250, 4],
        ["grok", 0.5, 0.5 / 20.5, 100 / 6250, 2]
      ]
    );
  });

  it("leaves hidden agents out of every figure", () => {
    const view = deriveUsageView(data, "cost", ["codex", "grok"]);
    assert.deepEqual(view.agents, ["claude"]);
    assert.equal(view.totals.costUsd, 10);
    assert.equal(view.totals.processed, 1150);
    assert.equal(view.totals.sessions, 4);
    assert.deepEqual(view.models.map((m) => m.key), ["claude:claude-opus-5"]);
    assert.deepEqual(view.periodRows.map((p) => p.period), ["2026-10-30", "2026-10-28"]);
    assert.deepEqual(view.projects.map((p) => [p.project, p.costUsd, p.share]), [["acme/web", 8, 1]]);
  });

  it("zero-fills each agent's series over every period of the window", () => {
    const { series } = deriveUsageView(data, "tokens", []);
    const claude = series.find((s) => s.agent === "claude");
    assert.deepEqual(claude?.values, [0, 1050, 0, 100, 0, 0, 0]);
    assert.equal(series.every((s) => s.values.length === data.periods.length), true);
  });

  it("sorts models by cost on Cost, with unpriced ones last, and by tokens on Tokens", () => {
    const byCost = deriveUsageView(data, "cost", []).models;
    assert.deepEqual(byCost.map((m) => m.key), ["claude:claude-opus-5", "codex:gpt-6-sol", "grok:grok-build", "codex:gpt-6-mystery"]);
    const mystery = byCost.at(-1)!;
    assert.equal(mystery.costUsd, null);
    assert.equal(mystery.costShare, null);
    const byTokens = deriveUsageView(data, "tokens", []).models;
    assert.deepEqual(byTokens.map((m) => m.key), ["codex:gpt-6-mystery", "claude:claude-opus-5", "codex:gpt-6-sol", "grok:grok-build"]);
  });

  it("rolls project buckets up per project with their sessions and shares", () => {
    const projects = deriveUsageView(data, "tokens", []).projects;
    assert.deepEqual(
      projects.map((p) => [p.project, p.workspace, p.name, p.sessions, p.processed, p.costUsd, p.share]),
      [
        ["", null, "", 1, 4000, null, 4000 / 5500],
        ["acme/web", "acme", "web", 5, 1500, 10, 1500 / 5500]
      ]
    );
  });
});

describe("deriveModelDetail", () => {
  it("prices per 1M tokens over priced tokens only, and counts cache writes as misses", () => {
    const partly = historyResponse({
      buckets: [
        bucket({
          period: 0,
          agent: "grok",
          model: "grok-build",
          tokens: tokens({ input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 1_000_000 }),
          costUsd: 3,
          costSource: "reported",
          unpricedTokens: 1_000_000
        })
      ]
    });
    const detail = deriveModelDetail(partly, "grok:grok-build", "cost", [])!;
    assert.equal(detail.perMillionUsd, 1);
    assert.equal(detail.cacheHitRate, 0.5);
  });

  it("has no per-1M price and charts tokens when the model's cost is unknown", () => {
    const detail = deriveModelDetail(data, "codex:gpt-6-mystery", "cost", [])!;
    assert.equal(detail.costUnknown, true);
    assert.equal(detail.perMillionUsd, null);
    assert.equal(detail.chartMetric, "tokens");
    assert.deepEqual(detail.values, [0, 0, 0, 4000, 0, 0, 0]);
  });
});
