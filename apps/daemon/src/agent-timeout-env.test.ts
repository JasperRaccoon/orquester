import { test } from "node:test";
import assert from "node:assert/strict";
import { cliproxyHomeDir } from "@orquester/config";
import { claudeTimeoutEnv } from "./agent-timeout-env.ts";
import { buildAgentLaunchEnv } from "./index.ts";

// A directory that does not exist: cliproxyContributor's file reads (token +
// state) are best-effort, so it still contributes CLAUDE_CONFIG_DIR from it.
const DAEMON_DIR = "/nonexistent/orquester-test-daemon-dir";

test("returns null for every non-claude launcher", () => {
  assert.equal(claudeTimeoutEnv("codex", 30), null);
  assert.equal(claudeTimeoutEnv("opencode", 30), null);
  assert.equal(claudeTimeoutEnv("gemini", 30), null);
  assert.equal(claudeTimeoutEnv("deepseek", 30), null);
  assert.equal(claudeTimeoutEnv("", 30), null);
});

test("covers every claude-family launcher with all three keys", () => {
  for (const id of ["claude", "claudex", "claudemix"]) {
    const result = claudeTimeoutEnv(id, 30);
    assert.ok(result, `${id} must receive timeout env`);
    assert.deepEqual(result.env, {
      API_TIMEOUT_MS: "1800000",
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1800000",
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1800000"
    });
  }
});

test("converts minutes to milliseconds at both bounds", () => {
  assert.equal(claudeTimeoutEnv("claude", 1)?.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "60000");
  assert.equal(claudeTimeoutEnv("claude", 30)?.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "1800000");
});

// These exercise the real launch seam (buildAgentLaunchEnv IS the body of the
// session manager's resolveExtraEnv), so dropping the timeout contributor from
// the daemon's composition fails them.
test("a claude-family launch carries the timeout env, and cliproxy still wins collisions", () => {
  const merged = buildAgentLaunchEnv(
    "claudemix",
    { accountId: "acct-1" },
    30,
    { env: { CLAUDE_CONFIG_DIR: "/from-account" }, accountId: "acct-1" },
    DAEMON_DIR
  );
  assert.ok(merged);
  assert.equal(merged.env.API_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  // cliproxyContributor is the outermost `b`, so it wins the collision...
  assert.equal(merged.env.CLAUDE_CONFIG_DIR, cliproxyHomeDir(DAEMON_DIR, "claudemix"));
  // ...while the managed account still supplies the effective accountId.
  assert.equal(merged.accountId, "acct-1");
});

test("plain claude (no cliproxy contribution) still carries the timeout env", () => {
  const merged = buildAgentLaunchEnv("claude", {}, 15, null, DAEMON_DIR);
  assert.ok(merged);
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "900000");
});

test("a non-claude launcher composes to no timeout keys", () => {
  const merged = buildAgentLaunchEnv("codex", {}, 30, { env: { CODEX_HOME: "/x" } }, DAEMON_DIR);
  assert.ok(merged);
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, undefined);
  assert.equal(merged.env.API_TIMEOUT_MS, undefined);
  assert.equal(merged.env.CODEX_HOME, "/x");
});
