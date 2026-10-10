import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentLaunchEnv } from "./index.ts";

test("a claude launch under a managed account carries the timeout env and keeps the account", () => {
  const merged = buildAgentLaunchEnv("claude", { timeoutMinutes: 30, subagentCacheTtl: "5m" }, {
    env: { CLAUDE_CONFIG_DIR: "/from-account", API_TIMEOUT_MS: "1" },
    unset: ["ANTHROPIC_API_KEY"],
    accountId: "acct-1"
  });
  assert.ok(merged);
  assert.equal(merged.env.API_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_CONFIG_DIR, "/from-account");
  assert.equal(merged.accountId, "acct-1");
  assert.deepEqual(merged.unset, ["ANTHROPIC_API_KEY"]);
});

test("plain claude (no managed account) still carries the timeout env", () => {
  const merged = buildAgentLaunchEnv("claude", { timeoutMinutes: 15, subagentCacheTtl: "5m" }, null);
  assert.ok(merged);
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "900000");
});

test("a non-claude launcher composes to no timeout keys", () => {
  for (const id of ["codex", "grok", "claudex", "claudemix"]) {
    const merged = buildAgentLaunchEnv(id, { timeoutMinutes: 30, subagentCacheTtl: "1h" }, { env: { CODEX_HOME: "/x" } });
    assert.ok(merged);
    assert.equal(merged.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, undefined, id);
    assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, undefined, id);
    assert.equal(merged.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, undefined, id);
    assert.equal(merged.env.API_TIMEOUT_MS, undefined, id);
    assert.equal(merged.env.CODEX_HOME, "/x", id);
  }
});

test("a claude launch carries the subagent cache lifetime, over whatever the account env says", () => {
  for (const ttl of ["1h", "5m"] as const) {
    const merged = buildAgentLaunchEnv(
      "claude",
      { timeoutMinutes: 30, subagentCacheTtl: ttl },
      { env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "stale" } }
    );
    assert.equal(merged?.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, ttl);
  }
  assert.equal(
    buildAgentLaunchEnv("claude", { timeoutMinutes: 30, subagentCacheTtl: "1h" }, null)?.env
      .CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL,
    "1h"
  );
});
