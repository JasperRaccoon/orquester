import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentLaunchEnv } from "./index.ts";

// These exercise the real launch seam (buildAgentLaunchEnv IS the body of the
// session manager's resolveExtraEnv), so dropping the timeout contributor from
// the daemon's composition fails them.
test("a claude launch under a managed account carries the timeout env and keeps the account", () => {
  const merged = buildAgentLaunchEnv("claude", 30, { env: { CLAUDE_CONFIG_DIR: "/from-account" }, accountId: "acct-1" });
  assert.ok(merged);
  assert.equal(merged.env.API_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  // The timeout keys collide with nothing: the account's home is untouched...
  assert.equal(merged.env.CLAUDE_CONFIG_DIR, "/from-account");
  // ...and the managed account still supplies the effective accountId.
  assert.equal(merged.accountId, "acct-1");
});

test("plain claude (no managed account) still carries the timeout env", () => {
  const merged = buildAgentLaunchEnv("claude", 15, null);
  assert.ok(merged);
  assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "900000");
});

test("a non-claude launcher composes to no timeout keys", () => {
  for (const id of ["codex", "grok", "claudex", "claudemix"]) {
    const merged = buildAgentLaunchEnv(id, 30, { env: { CODEX_HOME: "/x" } });
    assert.ok(merged);
    assert.equal(merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, undefined, id);
    assert.equal(merged.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, undefined, id);
    assert.equal(merged.env.API_TIMEOUT_MS, undefined, id);
    assert.equal(merged.env.CODEX_HOME, "/x", id);
  }
});
