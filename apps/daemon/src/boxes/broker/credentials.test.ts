import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeFileAtomic } from "../../agent-hooks.ts";
import { claudeRefreshLockPaths, grantFromCredentials, nodeCredentialFiles } from "./credentials.ts";
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

test("nodeCredentialFiles: missing files read as null, lock ages, and the watch sees a rename-replace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "orq-broker-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  await mkdir(home);
  const files = nodeCredentialFiles(base, () => Date.now());
  const path = join(home, "auth.json");
  assert.equal(await files.read(path), null);
  assert.equal(await files.ageOfNewest(claudeRefreshLockPaths(home)), null);
  await mkdir(join(home, ".oauth_refresh.lock"));
  const age = await files.ageOfNewest(claudeRefreshLockPaths(home));
  assert.ok(age !== null && age < 60_000);

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
