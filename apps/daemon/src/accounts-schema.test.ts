import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountsConfig } from "@orquester/config";

const legacyAccount = {
  id: "a1", label: "work", githubLogin: "octo", gitName: "Octo", gitEmail: "o@x.com",
  publicKey: "ssh-ed25519 AAAA octo", keyPath: "/keys/a1", githubKeyId: 123,
  token: "ghp_x", createdAt: "2025-01-01T00:00:00.000Z"
};

test("legacy github account payload migrates (githubLogin→login, githubKeyId→remoteKeyId, provider default)", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [legacyAccount] });
  const a = cfg.accounts[0];
  assert.equal(a.provider, "github");
  assert.equal(a.login, "octo");
  assert.equal(a.remoteKeyId, "123");
  assert.equal((a as Record<string, unknown>).githubLogin, undefined);
});

test("new-shape bitbucket-server account round-trips", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [{
    id: "b1", label: "corp", provider: "bitbucket-server", login: "jdoe",
    loginRef: "jdoe", baseUrl: "https://bb.corp.com/bitbucket",
    caCertPath: "/keys/b1.ca.pem", sshHost: "bb.corp.com:7999",
    gitName: "J Doe", gitEmail: "j@corp.com", publicKey: "ssh-ed25519 AAAA j",
    keyPath: "/keys/b1", token: "t", tokenExpiresAt: "2027-01-01T00:00:00.000Z",
    createdAt: "2026-08-03T00:00:00.000Z"
  }] });
  const a = cfg.accounts[0];
  assert.equal(a.provider, "bitbucket-server");
  assert.equal(a.baseUrl, "https://bb.corp.com/bitbucket");
  assert.equal(a.sshHost, "bb.corp.com:7999");
});

test("already-migrated payload is untouched (idempotent)", () => {
  const once = parseAccountsConfig({ version: 1, accounts: [legacyAccount] });
  const twice = parseAccountsConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});
