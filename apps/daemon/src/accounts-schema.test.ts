import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountsConfig, serializeAccountsConfig } from "@orquester/config";

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

// Rollback safety: the serialized file must stay parseable by the PRE-provider
// accountSchema (which required `githubLogin` and numeric `githubKeyId`), so a
// deploy rollback does not wipe connected GitHub accounts.
test("serialize mirrors githubLogin/githubKeyId on github records for old-daemon compat", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [legacyAccount] });
  const out = serializeAccountsConfig(cfg) as { accounts: Array<Record<string, unknown>> };
  assert.equal(out.accounts[0].githubLogin, "octo");
  assert.equal(out.accounts[0].githubKeyId, 123);
  assert.equal(out.accounts[0].login, "octo"); // new fields still present for the new daemon
});

test("serialize does not mirror legacy fields onto bitbucket records", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [{
    id: "b1", label: "bb", provider: "bitbucket-cloud", login: "nick", loginRef: "{u-1}",
    email: "n@x.com", gitName: "N", gitEmail: "n@x.com", publicKey: "ssh-ed25519 AAAA n",
    keyPath: "/keys/b1", remoteKeyId: "{key-uuid}", token: "t", createdAt: "2026-08-03T00:00:00.000Z"
  }] });
  const out = serializeAccountsConfig(cfg) as { accounts: Array<Record<string, unknown>> };
  assert.equal(out.accounts[0].githubLogin, undefined);
  assert.equal(out.accounts[0].githubKeyId, undefined);
});

test("serialize→parse round-trips to the identical config", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [legacyAccount] });
  assert.deepEqual(parseAccountsConfig(JSON.parse(JSON.stringify(serializeAccountsConfig(cfg)))), cfg);
});

test("serialize skips a non-numeric remoteKeyId (old schema required a number)", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [{ ...legacyAccount }] });
  cfg.accounts[0].remoteKeyId = "{not-a-number}";
  const out = serializeAccountsConfig(cfg) as { accounts: Array<Record<string, unknown>> };
  assert.equal(out.accounts[0].githubKeyId, undefined);
  assert.equal(out.accounts[0].githubLogin, "octo");
});
