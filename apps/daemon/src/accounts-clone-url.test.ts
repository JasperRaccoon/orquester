import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AccountError } from "./account-error";
import { AccountsService } from "./accounts";

const urls = { sshUrl: "ssh://git@bb.corp.com:7999/PRJ/repo.git", httpsUrl: "https://bb.corp.com/scm/PRJ/repo.git" };

async function harness(t: TestContext, keyUploadPending = false, token = "fake-token", fail?: (args: string[]) => string | null) {
  const root = await mkdtemp(join(tmpdir(), "orq-clone-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = join(root, "keys");
  await mkdir(keys);
  const config = join(root, "accounts.json");
  await writeFile(config, JSON.stringify({ version: 1, accounts: [{
    id: "dc", label: "corp", provider: "bitbucket-server", login: "user", baseUrl: "https://bb.corp.com",
    gitName: "User", gitEmail: "u@example.invalid", publicKey: "ssh-ed25519 AAAA", keyPath: join(keys, "dc"),
    ...(token ? { token } : {}), keyUploadPending, createdAt: "2026-01-01T00:00:00.000Z"
  }] }));
  const commands: string[][] = [];
  const service = new AccountsService(config, keys, {
    refreshKnownHosts: false,
    exec: async (_file, args) => {
      commands.push(args);
      const stderr = fail?.(args);
      if (stderr) throw Object.assign(new Error(`Command failed: git\n${stderr}`), { stderr, code: 128 });
      return { stdout: "", stderr: "" };
    }
  });
  return { root, service, commands };
}

test("prefers SSH when the account's key is installed on the provider", async (t) => {
  const { root, service, commands } = await harness(t);
  assert.deepEqual(await service.cloneCreatedRepo("dc", urls, "repo", root), { transport: "ssh" });
  assert.ok(commands[0].includes("ssh://git@bb.corp.com:7999/PRJ/repo.git"));
  assert.ok(!commands[0].includes("https://bb.corp.com/scm/PRJ/repo.git"));
});

test("falls back to HTTPS while a DC key upload is still pending", async (t) => {
  const { root, service, commands } = await harness(t, true);
  await service.cloneCreatedRepo("dc", urls, "repo", root);
  assert.ok(commands[0].includes("https://bb.corp.com/scm/PRJ/repo.git"));
  assert.ok(!commands[0].includes("ssh://git@bb.corp.com:7999/PRJ/repo.git"));
});

test("uses whichever transport exists when only one is offered", async (t) => {
  const { root, service, commands } = await harness(t, true);
  await service.cloneCreatedRepo("dc", { sshUrl: urls.httpsUrl, httpsUrl: urls.httpsUrl }, "https", root);
  await service.cloneCreatedRepo("dc", { sshUrl: urls.sshUrl }, "ssh", root);
  assert.ok(commands[0].includes("https://bb.corp.com/scm/PRJ/repo.git"));
  assert.ok(commands[1].includes("ssh://git@bb.corp.com:7999/PRJ/repo.git"));
  await assert.rejects(service.cloneCreatedRepo("dc", { sshUrl: "" }, "none", root),
    (error: unknown) => error instanceof AccountError && error.status === 502);
  assert.equal(commands.length, 2);
});

const refusedOverSsh = (args: string[]) =>
  args.includes(urls.sshUrl) ? "git@bb.corp.com: Permission denied (publickey).\nfatal: Could not read from remote repository." : null;

test("a created repo whose SSH key is refused is cloned over its reported HTTPS URL", async (t) => {
  const { root, service, commands } = await harness(t, false, "fake-token", refusedOverSsh);
  const result = await service.cloneCreatedRepo("dc", urls, "repo", root);
  assert.equal(result.transport, "https");
  assert.ok(commands[1].includes(urls.httpsUrl));
});

test("with no token, a refused key is retried over HTTPS only for a repo known to be public", async (t) => {
  const { root, service, commands } = await harness(t, false, "", refusedOverSsh);
  await assert.rejects(service.cloneCreatedRepo("dc", { ...urls, private: true }, "private", root));
  assert.equal(commands.length, 1);
  assert.equal((await service.cloneCreatedRepo("dc", { ...urls, private: false }, "public", root)).transport, "https");
  assert.equal(commands.length, 3);
});
