import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAgentFromBlob, claudePlanFromBlob, parseCodexIdentity, parseGrokIdentity } from "./agent-account-identity.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

test("detects claude by claudeAiOauth", () => {
  assert.equal(detectAgentFromBlob({ claudeAiOauth: { accessToken: "x" } }), "claude");
});

test("detects codex by tokens.access_token", () => {
  assert.equal(detectAgentFromBlob({ tokens: { access_token: "x" } }), "codex");
});

test("returns null for unknown shapes", () => {
  assert.equal(detectAgentFromBlob({ foo: 1 }), null);
  assert.equal(detectAgentFromBlob("nope"), null);
});

test("claude plan from subscriptionType", () => {
  assert.equal(claudePlanFromBlob({ claudeAiOauth: { subscriptionType: "max" } }), "max");
  assert.equal(claudePlanFromBlob({ claudeAiOauth: {} }), null);
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

test("codex detection wins over grok when both shapes could match", () => {
  // A codex auth.json has `tokens`; a grok entry key always contains `::`.
  assert.equal(detectAgentFromBlob({ tokens: { access_token: "x" }, [GROK_KEY]: { key: "t" } }), "codex");
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
