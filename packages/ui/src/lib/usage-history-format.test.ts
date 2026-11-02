import { test } from "node:test";
import assert from "node:assert/strict";

import { formatDayShort, formatPercent, formatTokens, formatUsd, formatWindow, labelForModel, sortAgents } from "./usage-history-format.ts";

test("token counts keep three significant digits and drop all-zero decimals", () => {
  assert.equal(formatTokens(89_812_345_678), "89.8B");
  assert.equal(formatTokens(13_500_000_000), "13.5B");
  assert.equal(formatTokens(1_250_000), "1.25M");
  assert.equal(formatTokens(512_000), "512K");
  assert.equal(formatTokens(2_000_000), "2M");
  assert.equal(formatTokens(999), "999");
});

test("money is never abbreviated, tiny amounts don't read as zero, and unknown is not $0", () => {
  assert.equal(formatUsd(11_944.02), "$11,944.02");
  assert.equal(formatUsd(0.001), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(null), "—");
});

test("shares show one decimal, and a tiny non-zero share is not rounded to zero", () => {
  assert.equal(formatPercent(0.15), "15.0%");
  assert.equal(formatPercent(0.0004), "<0.1%");
  assert.equal(formatPercent(0), "0%");
});

test("day labels read the viewer-zone day as written, and the window spans first to last", () => {
  assert.equal(formatDayShort("2026-09-08"), "Sep 8");
  assert.equal(formatWindow(["2026-10-04", "2026-10-05", "2026-11-02"], "day", "UTC"), "Oct 4 – Nov 2");
});

test("agents keep a fixed order with unknown ones after", () => {
  assert.deepEqual(sortAgents(["zeta", "claude", "opencode", "codex"]), ["codex", "claude", "opencode", "zeta"]);
});

test("model labels shorten known families and leave others alone", () => {
  assert.equal(labelForModel("claude-opus-4-8-20260115"), "Opus 4.8");
  assert.equal(labelForModel("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(labelForModel("grok-build"), "grok-build");
});
