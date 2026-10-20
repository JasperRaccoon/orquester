// Which stored GitHub token a link preview reads with (`AccountsService.githubReadCredential`):
// the workspace's bound account, then the owner's own account, then any GitHub account with a
// token — never a tokenless or non-GitHub one.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountsService } from "../accounts.ts";

const base = { gitName: "T", gitEmail: "t@example.invalid", publicKey: "ssh-ed25519 AAAA t", createdAt: "2026-10-01T00:00:00.000Z" };

async function withAccounts(accounts: unknown[], body: (service: AccountsService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orq-github-credential-"));
  try {
    await writeFile(join(root, "accounts.json"), JSON.stringify({ version: 1, accounts }));
    await body(new AccountsService(join(root, "accounts.json"), join(root, "keys"), { refreshKnownHosts: false }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ACCOUNTS = [
  { ...base, id: "bb", label: "bb", provider: "bitbucket-cloud", login: "acme", keyPath: "/k/bb", token: "bb-token", email: "a@b.c" },
  { ...base, id: "ssh-only", label: "s", provider: "github", login: "acme", keyPath: "/k/s" },
  { ...base, id: "work", label: "w", provider: "github", login: "worker", keyPath: "/k/w", token: "work-token" },
  { ...base, id: "acme", label: "a", provider: "github", login: "Acme", keyPath: "/k/a", token: "acme-token" }
];

test("prefers the workspace's bound account, then the owner's, then any with a token", async () => {
  await withAccounts(ACCOUNTS, async (service) => {
    assert.deepEqual(await service.githubReadCredential({ owner: "acme", preferredAccountId: "work" }), {
      accountId: "work",
      token: "work-token"
    });
    assert.deepEqual(await service.githubReadCredential({ owner: "ACME" }), { accountId: "acme", token: "acme-token" });
    assert.deepEqual(await service.githubReadCredential({ owner: "someone-else", preferredAccountId: null }), {
      accountId: "work",
      token: "work-token"
    });
    // A bound account without a token (or not GitHub) is passed over.
    assert.equal((await service.githubReadCredential({ owner: "x", preferredAccountId: "ssh-only" }))?.accountId, "work");
    assert.equal((await service.githubReadCredential({ owner: "x", preferredAccountId: "bb" }))?.accountId, "work");
  });
});

test("answers null when no GitHub account has a token", async () => {
  await withAccounts([ACCOUNTS[0], ACCOUNTS[1]], async (service) => {
    assert.equal(await service.githubReadCredential({ owner: "acme" }), null);
  });
  await withAccounts([], async (service) => {
    assert.equal(await service.githubReadCredential({ owner: "acme" }), null);
  });
});
