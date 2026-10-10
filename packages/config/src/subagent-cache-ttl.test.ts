import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultAppConfig,
  parseAppConfig,
  parseSubagentCacheTtlState,
  subagentCacheTtlStateFile
} from "./index.ts";

test("the subagent cache lifetime defaults to auto", () => {
  assert.equal(createDefaultAppConfig().agents.claudeSubagentCacheTtl, "auto");
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 10 } }).agents.claudeSubagentCacheTtl, "auto");
});

test("each subagent cache lifetime mode is preserved and anything else is rejected", () => {
  for (const mode of ["auto", "1h", "5m"] as const) {
    assert.equal(parseAppConfig({ agents: { claudeSubagentCacheTtl: mode } }).agents.claudeSubagentCacheTtl, mode);
  }
  assert.throws(() => parseAppConfig({ agents: { claudeSubagentCacheTtl: "2h" } }));
  assert.throws(() => parseAppConfig({ agents: { claudeSubagentCacheTtl: true } }));
});

test("the auto decision is kept in the daemon dir", () => {
  assert.equal(subagentCacheTtlStateFile("/base"), "/base/daemon/subagent-cache-ttl.json");
});

test("a stored auto decision round-trips", () => {
  const state = {
    version: 1,
    ttl: "1h",
    checkedAt: 1_000,
    nextCheckAt: 2_000,
    outcome: "hold",
    requests: 900,
    changePct: -3.2
  };
  assert.deepEqual(parseSubagentCacheTtlState(state), state);
  assert.deepEqual(parseSubagentCacheTtlState({ ...state, outcome: "insufficient", changePct: null }), {
    ...state,
    outcome: "insufficient",
    changePct: null
  });
});

test("a stored auto decision that cannot be trusted reads as none", () => {
  assert.equal(parseSubagentCacheTtlState(null), null);
  assert.equal(parseSubagentCacheTtlState("1h"), null);
  assert.equal(parseSubagentCacheTtlState({ version: 2, ttl: "1h", checkedAt: 1, nextCheckAt: 2, outcome: "1h", requests: 1, changePct: 0 }), null);
  assert.equal(parseSubagentCacheTtlState({ version: 1, ttl: "30m", checkedAt: 1, nextCheckAt: 2, outcome: "1h", requests: 1, changePct: 0 }), null);
  assert.equal(parseSubagentCacheTtlState({ version: 1, ttl: "1h", checkedAt: "soon", nextCheckAt: 2, outcome: "1h", requests: 1, changePct: 0 }), null);
});
