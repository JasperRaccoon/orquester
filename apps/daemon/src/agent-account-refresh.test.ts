import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAccountsToRefresh, mergeClaudeRefreshedCreds, refreshClaudeToken, REFRESH_MARGIN_MS } from "./agent-account-refresh.ts";
import type { AgentAccountRecord } from "@orquester/config";

function rec(id: string, agent: "claude" | "codex" = "claude"): AgentAccountRecord {
  return { id, agent, label: id, email: null, plan: null, needsReauth: false, createdAt: "t", importedAt: "t" };
}

test("selects idle accounts with soon/unknown expiry, skips live and far-future", () => {
  const now = 1_000_000;
  const accts = [rec("live"), rec("soon"), rec("far"), rec("unknown")];
  const live = new Set(["live"]);
  const expiries = new Map<string, number | null>([
    ["live", now + 60_000],
    ["soon", now + REFRESH_MARGIN_MS - 1],
    ["far", now + REFRESH_MARGIN_MS + 10 * 60_000],
    ["unknown", null]
  ]);
  const picked = selectAccountsToRefresh(accts, live, expiries, now, REFRESH_MARGIN_MS).map((a) => a.id).sort();
  assert.deepEqual(picked, ["soon", "unknown"]);
});

test("mergeClaudeRefreshedCreds preserves other fields", () => {
  const merged = mergeClaudeRefreshedCreds(
    { claudeAiOauth: { accessToken: "old", refreshToken: "oldr", expiresAt: 1, scopes: ["a"], subscriptionType: "max" } },
    { access_token: "new", refresh_token: "newr", expires_at: 2 }
  );
  assert.equal(merged.claudeAiOauth.accessToken, "new");
  assert.equal(merged.claudeAiOauth.refreshToken, "newr");
  assert.equal(merged.claudeAiOauth.expiresAt, 2);
  assert.deepEqual(merged.claudeAiOauth.scopes, ["a"]);
  assert.equal(merged.claudeAiOauth.subscriptionType, "max");
});

test("refreshClaudeToken maps a 200 body", async () => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_at: 9 }), { status: 200 });
  const out = await refreshClaudeToken("r", fake);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.access_token, "A");
    assert.equal(out.refresh_token, "R");
  }
});

test("refreshClaudeToken flags invalid_grant", async () => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  const out = await refreshClaudeToken("r", fake);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.invalidGrant, true);
});
