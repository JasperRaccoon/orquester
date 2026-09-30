import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectAccountsToRefresh,
  mergeClaudeRefreshedCreds,
  refreshClaudeToken,
  mergeCodexRefreshedTokens,
  refreshCodexToken
} from "./agent-account-refresh.ts";
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
    ["soon", now + 60_000],
    ["far", now + 3_600_000],
    ["unknown", null]
  ]);
  const picked = selectAccountsToRefresh(accts, live, expiries, now, 900_000).map((a) => a.id).sort();
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

test("mergeClaudeRefreshedCreds converts expires_in to an absolute expiresAt (ms)", () => {
  const merged = mergeClaudeRefreshedCreds(
    { claudeAiOauth: { accessToken: "old", expiresAt: 1 } },
    { access_token: "a", refresh_token: "r", expires_in: 3600 },
    1_000
  );
  assert.equal(merged.claudeAiOauth.expiresAt, 1_000 + 3_600_000);
});

test("refreshClaudeToken maps a 200 body", async (t) => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_at: 9 }), { status: 200 });
  t.mock.method(globalThis, "fetch", fake);
  const out = await refreshClaudeToken("r");
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.access_token, "A");
    assert.equal(out.refresh_token, "R");
  }
});

test("refreshClaudeToken flags invalid_grant", async (t) => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  t.mock.method(globalThis, "fetch", fake);
  const out = await refreshClaudeToken("r");
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.invalidGrant, true);
});

test("refreshClaudeToken parses expires_in", async (t) => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600 }), { status: 200 });
  t.mock.method(globalThis, "fetch", fake);
  const out = await refreshClaudeToken("r");
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.expires_in, 3600);
});

test("refreshCodexToken flags invalid_grant", async (t) => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  t.mock.method(globalThis, "fetch", fake);
  const out = await refreshCodexToken("r");
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.invalidGrant, true);
});

test("mergeCodexRefreshedTokens preserves account_id and overwrites tokens", () => {
  const merged = mergeCodexRefreshedTokens(
    { tokens: { access_token: "old", refresh_token: "oldr", id_token: "oldi", account_id: "acc" }, OPENAI_API_KEY: null },
    { access_token: "new", refresh_token: "newr", id_token: "newi" }
  );
  assert.equal(merged.tokens.access_token, "new");
  assert.equal(merged.tokens.refresh_token, "newr");
  assert.equal(merged.tokens.id_token, "newi");
  assert.equal(merged.tokens.account_id, "acc");
  assert.equal(merged.OPENAI_API_KEY, null);
});
