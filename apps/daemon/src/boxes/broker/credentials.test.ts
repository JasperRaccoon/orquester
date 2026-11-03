import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeFileAtomic } from "../../agent-hooks.ts";
import { boxLoginFile, claudeBoxCredentials, claudeRefreshLockPaths, grantFromCredentials, isOwnBoxLogin, nodeCredentialFiles } from "./credentials.ts";
import { claudeCreds, codexAuth, grokAuth, jwt, NOW } from "./testing.ts";

test("grants are built field by field: no refresh token, id token or other secret survives", () => {
  const claude = grantFromCredentials("claude", claudeCreds("a", NOW));
  const codex = grantFromCredentials("codex", codexAuth(1_900_000_000));
  const grok = grantFromCredentials("grok", grokAuth("g", NOW));
  assert.equal(claude?.accessToken, "a");
  assert.equal(codex?.expiresAt, 1_900_000_000_000);
  assert.equal(grok?.expiresAt, NOW);
  for (const grant of [claude, codex, grok]) assert.doesNotMatch(JSON.stringify(grant), /SECRET/);
});

test("unusable files give no grant", () => {
  assert.equal(grantFromCredentials("claude", "not json"), null);
  assert.equal(grantFromCredentials("claude", JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "r" } })), null);
  // Codex without a workspace id cannot log in with chatgptAuthTokens.
  assert.equal(grantFromCredentials("codex", JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }) } })), null);
  assert.equal(grantFromCredentials("grok", JSON.stringify({ "https://auth.x.ai::c": { key: "" } })), null);
});

test("codex falls back to the token's chatgpt_account_id claim; unknown expiries are null", () => {
  const grant = grantFromCredentials(
    "codex",
    JSON.stringify({ tokens: { access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "ws-claim" } }) } })
  );
  assert.deepEqual(grant?.extra, { chatgptAccountId: "ws-claim" });
  assert.equal(grant?.expiresAt, null);
  assert.equal(grantFromCredentials("claude", JSON.stringify({ claudeAiOauth: { accessToken: "a" } }))?.expiresAt, null);
});

test("a lent Codex login has the verified shape; its id token holds the access token's claims, not the real one", () => {
  const accessToken = jwt({
    exp: 1_900_000_000,
    "https://api.openai.com/profile": { email: "owner@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "ws-claim", chatgpt_plan_type: "pro" }
  });
  const hostFile = JSON.stringify({ tokens: { access_token: accessToken, account_id: "ws-1", id_token: jwt({ email: "codex-id-token-SECRET@example.com" }), refresh_token: "codex-refresh-SECRET" } });
  const { filename, content } = boxLoginFile("codex", grantFromCredentials("codex", hostFile)!, NOW);
  assert.equal(filename, "auth.json");
  assert.doesNotMatch(content, /SECRET/);
  const file = JSON.parse(content);
  assert.deepEqual(Object.keys(file).sort(), ["OPENAI_API_KEY", "auth_mode", "last_refresh", "lentBy", "tokens"]);
  assert.equal(file.OPENAI_API_KEY, null);
  assert.equal(file.auth_mode, "chatgpt");
  assert.equal(file.last_refresh, new Date(NOW).toISOString());
  assert.deepEqual({ ...file.tokens, id_token: "" }, { id_token: "", access_token: accessToken, refresh_token: "", account_id: "ws-1" });
  const [header, claims, signature] = file.tokens.id_token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "none" });
  assert.ok(signature.length > 0);
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    email: "owner@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "ws-claim", chatgpt_plan_type: "pro" }
  });
});

test("an access token that is not a readable JWT still gives a parseable id token", () => {
  const { content } = boxLoginFile("codex", { accessToken: "opaque", expiresAt: null, extra: { chatgptAccountId: "ws-1" } }, NOW);
  const parts = JSON.parse(content).tokens.id_token.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], "base64url").toString()), {});
});

test("a lent Claude login carries no refresh token", () => {
  const { filename, content } = boxLoginFile("claude", grantFromCredentials("claude", claudeCreds("access", NOW))!, NOW);
  assert.equal(filename, ".credentials.json");
  assert.equal(JSON.parse(content).claudeAiOauth.accessToken, "access");
  assert.doesNotMatch(content, /SECRET|refreshToken/);
});

test("a login on a box is ours only if it says so, or is exactly what an older daemon wrote", () => {
  const grant = { accessToken: "access", expiresAt: NOW, extra: { chatgptAccountId: "ws-1", scopes: "user:inference", subscriptionType: "max" } };
  const older = { claudeAiOauth: { accessToken: "a", expiresAt: NOW, scopes: [], subscriptionType: "max", rateLimitTier: "t" } };
  for (const ours of [boxLoginFile("claude", grant, NOW).content, boxLoginFile("codex", grant, NOW).content, JSON.stringify(claudeBoxCredentials(grant, NOW)), JSON.stringify(older)]) {
    assert.equal(isOwnBoxLogin(ours, null), true, ours);
  }
  const marked = { lentBy: "orquester" };
  for (const real of [
    "not json",
    "[]",
    "{}",
    // An access-token-only real login, the kind `runRefresh` knows exists.
    JSON.stringify({ claudeAiOauth: { accessToken: "a" } }),
    JSON.stringify({ ...older, mcpOAuth: { server: { accessToken: "m" } } }),
    JSON.stringify({ claudeAiOauth: { ...older.claudeAiOauth, oauthAccount: "x" } }),
    JSON.stringify({ OPENAI_API_KEY: null, auth_mode: "chatgpt", tokens: { id_token: "i", access_token: "a", refresh_token: "", account_id: "w" } }),
    // Someone signed in over a login of ours, and the CLI kept the marker.
    JSON.stringify({ ...marked, claudeAiOauth: { accessToken: "a", refreshToken: "r" } }),
    JSON.stringify({ ...marked, tokens: { access_token: "a", refresh_token: "r" } }),
    JSON.stringify({ ...marked, OPENAI_API_KEY: "sk-real" })
  ]) {
    assert.equal(isOwnBoxLogin(real, null), false, real);
  }
  // The very bytes of the host's login are that login, whatever they look like.
  const same = JSON.stringify(older);
  assert.equal(isOwnBoxLogin(same, same), false);
});

test("nodeCredentialFiles: missing files read as null, lock ages, and the watch sees a rename-replace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "orq-broker-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  await mkdir(home);
  const files = nodeCredentialFiles(base);
  const path = join(home, "auth.json");
  assert.equal(await files.read(path), null);
  assert.equal(await files.ageOfNewest(claudeRefreshLockPaths(home)), null);
  const lock = join(home, ".oauth_refresh.lock");
  await mkdir(lock);
  const modified = new Date("2026-10-20T00:00:00Z");
  await utimes(lock, modified, modified);
  t.mock.timers.enable({ apis: ["Date"], now: modified.getTime() + 1_000 });
  assert.equal(await files.ageOfNewest(claudeRefreshLockPaths(home)), 1_000);

  await writeFile(path, "one");
  const changed = new Promise<void>((resolve) => {
    const stop = files.watch(path, () => {
      stop();
      resolve();
    });
  });
  await writeFileAtomic(path, "two", 0o600);
  await changed;
  assert.equal(await files.read(path), "two");
});
