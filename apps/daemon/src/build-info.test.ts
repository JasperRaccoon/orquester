import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { testAuthSessions } from "./auth/testing.ts";
import { findRepoRoot, readBuildInfo, readGitCommit, VERSION_STAMP_FILE } from "./build-info.ts";
import { createServer } from "./index.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-build-info-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "orquester", version: "1.2.3" }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("finds the workspace root above a nested directory", async () => {
  const nested = join(root, "apps", "daemon", "src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "apps", "daemon", "package.json"), JSON.stringify({ name: "@orquester/daemon" }));
  assert.equal(findRepoRoot(nested), root);
  assert.equal(findRepoRoot(tmpdir()), null);
});

test("reads the commit from a branch, packed refs, a detached HEAD and a linked worktree", async () => {
  const git = join(root, ".git");
  await mkdir(join(git, "refs", "heads"), { recursive: true });
  await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(git, "refs", "heads", "main"), `${A}\n`);
  assert.equal(readGitCommit(root), A);

  await rm(join(git, "refs", "heads", "main"));
  await writeFile(join(git, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/main\n`);
  assert.equal(readGitCommit(root), B);

  await writeFile(join(git, "HEAD"), `${C}\n`);
  assert.equal(readGitCommit(root), C);

  // A worktree: `.git` is a file naming its git dir, whose branches live in the common dir.
  const tree = join(root, "wt");
  const wtGit = join(git, "worktrees", "wt");
  await mkdir(tree, { recursive: true });
  await mkdir(wtGit, { recursive: true });
  await writeFile(join(tree, ".git"), `gitdir: ${wtGit}\n`);
  await writeFile(join(wtGit, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(wtGit, "commondir"), "../..\n");
  assert.equal(readGitCommit(tree), B);

  await writeFile(join(git, "HEAD"), "ref: refs/heads/gone\n");
  assert.equal(readGitCommit(root), null);
});

test("falls back to the deploy stamp when there is no .git, and to null without either", async () => {
  assert.deepEqual(readBuildInfo(root), { version: "1.2.3", commit: null });
  await writeFile(join(root, VERSION_STAMP_FILE), JSON.stringify({ commit: A, version: "1.2.3", deployedAt: "2026-10-22T00:00:00Z" }));
  assert.deepEqual(readBuildInfo(root), { version: "1.2.3", commit: A });
  await writeFile(join(root, VERSION_STAMP_FILE), JSON.stringify({ commit: "not-a-sha" }));
  assert.deepEqual(readBuildInfo(root), { version: "1.2.3", commit: null });
  await writeFile(join(root, VERSION_STAMP_FILE), "{broken");
  assert.deepEqual(readBuildInfo(root), { version: "1.2.3", commit: null });
  assert.deepEqual(readBuildInfo(null), { version: null, commit: null });

  // Git, when present, wins over a stale stamp.
  await writeFile(join(root, VERSION_STAMP_FILE), JSON.stringify({ commit: A }));
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), `${B}\n`);
  assert.deepEqual(readBuildInfo(root), { version: "1.2.3", commit: B });
});

test("GET /api/info reports the version and commit, behind auth on the remote transport", async () => {
  type Args = Parameters<typeof createServer>;
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = "admin";
  config.transports.http.passwordHash = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
  const { authSessions, bearer } = await testAuthSessions();
  const dir = "/nonexistent-orquester-build-info-test";
  const resolved = { daemonDir: dir, baseDir: dir, workspacesDir: dir, workspacesMetaFile: `${dir}/workspaces.json`, fsRoot: dir } as unknown as Args[1];
  const services = { buildInfo: { version: "1.2.3", commit: A }, authSessions } as unknown as Args[4];
  const app = createServer(config, resolved, createDefaultClientConfig(`${dir}/daemon.sock`), createWriteStream("/dev/null"), services, {
    authRequired: true,
    mode: "remote"
  });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/info" })).statusCode, 401);
    const res = await app.inject({ method: "GET", url: "/api/info", headers: { authorization: bearer } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { version: string; commit: string };
    assert.equal(body.version, "1.2.3");
    assert.equal(body.commit, A);
  } finally {
    await app.close();
  }
});
