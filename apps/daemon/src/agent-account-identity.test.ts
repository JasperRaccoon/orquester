import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLoginStatus, detectAgentFromBlob, parseCodexIdentity, parseGrokIdentity } from "./agent-account-identity.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

test("returns null for unknown shapes", () => {
  assert.equal(detectAgentFromBlob({ foo: 1 }), null);
  assert.equal(detectAgentFromBlob("nope"), null);
});

test("Claude login expiry uses the refresh lifetime, not routine access-token rotation", () => {
  const expiresAt = Date.parse("2026-10-12T12:00:00Z");
  const refreshTokenExpiresAt = Date.parse("2026-10-19T12:00:00Z");
  const oauth = { accessToken: "secret", refreshToken: "refresh-secret", expiresAt, refreshTokenExpiresAt };
  assert.deepEqual(claudeLoginStatus({ claudeAiOauth: oauth }), {
    loginExpiresAt: "2026-10-19T12:00:00.000Z", needsReauth: false
  });
  assert.deepEqual(claudeLoginStatus({ claudeAiOauth: { ...oauth, refreshTokenExpiresAt: undefined } }), { needsReauth: false });
  assert.deepEqual(claudeLoginStatus({ claudeAiOauth: { accessToken: "secret", expiresAt } }), {
    loginExpiresAt: "2026-10-12T12:00:00.000Z", needsReauth: false
  });
  assert.equal(claudeLoginStatus({ claudeAiOauth: { ...oauth, accessToken: "", refreshToken: "" } }).needsReauth, true);
  for (const expiry of [NaN, Infinity, 1e30, "tomorrow", null]) {
    assert.equal(claudeLoginStatus({ claudeAiOauth: { accessToken: "secret", expiresAt: expiry } }).loginExpiresAt, undefined);
  }
  assert.deepEqual(claudeLoginStatus(null), { needsReauth: true });
});

test("codex identity from id_token JWT and account_id", () => {
  const blob = {
    tokens: {
      access_token: "a",
      account_id: "acc-123",
      id_token: jwt({ email: "me@example.com", chatgpt_account_id: "ignored-when-account_id-present" })
    }
  };
  const id = parseCodexIdentity(blob);
  assert.equal(id.email, "me@example.com");
  assert.equal(id.accountId, "acc-123");
});

test("codex accountId falls back to JWT chatgpt_account_id", () => {
  const blob = { tokens: { access_token: "a", id_token: jwt({ email: "e@e.com", chatgpt_account_id: "from-jwt" }) } };
  assert.equal(parseCodexIdentity(blob).accountId, "from-jwt");
});

const GROK_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

test("detects grok by the issuer::client keyed entry with a key", () => {
  assert.equal(detectAgentFromBlob({ [GROK_KEY]: { key: "tok", refresh_token: "r" } }), "grok");
  // No access token in the entry → not a grok credential.
  assert.equal(detectAgentFromBlob({ [GROK_KEY]: { refresh_token: "r" } }), null);
});

test("grok identity prefers the auth.x.ai entry and reads email/user_id", () => {
  const blob = {
    "https://other.example::c1": { key: "k1", email: "wrong@example.com" },
    [GROK_KEY]: { key: "k2", email: "me@example.com", user_id: "u-1" }
  };
  const id = parseGrokIdentity(blob);
  assert.equal(id.email, "me@example.com");
  assert.equal(id.userId, "u-1");
  assert.equal(parseGrokIdentity({ foo: 1 }).email, null);
});
