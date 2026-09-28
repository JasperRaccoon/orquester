// GitService.remoteUrl / currentBranch — the project-side reads the git trigger (repo kind
// "project") resolves its repository from.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { GitService } from "./git";

const exec = promisify(execFile);

async function withRepo(fn: (dir: string, git: (...args: string[]) => Promise<unknown>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-remote-"));
  const git = (...args: string[]) =>
    exec("git", args, { cwd: dir, env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null" } });
  try {
    await git("init", "-q", "-b", "main");
    await fn(dir, git);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("remoteUrl reads origin (or a named remote) and strips a password", async () => {
  await withRepo(async (dir, git) => {
    const service = new GitService();
    assert.equal(await service.remoteUrl(dir), null);
    await git("remote", "add", "origin", "git@github.com:octo-org/hello-world.git");
    await git("remote", "add", "upstream", "https://x-access-token:ghp_secret@github.com/up/hello-world.git");
    assert.equal(await service.remoteUrl(dir), "git@github.com:octo-org/hello-world.git");
    assert.equal(
      await service.remoteUrl(dir, "upstream"),
      "https://x-access-token@github.com/up/hello-world.git"
    );
    assert.equal(await service.remoteUrl(dir, "missing"), null);
    assert.equal(await service.remoteUrl(dir, "--help"), null);
  });
});

test("remoteUrl is null outside a repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-remote-none-"));
  try {
    assert.equal(await new GitService().remoteUrl(dir), null);
    assert.equal(await new GitService().currentBranch(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("currentBranch names the branch, even unborn; null when detached", async () => {
  await withRepo(async (dir, git) => {
    const service = new GitService();
    assert.equal(await service.currentBranch(dir), "main");
    await git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "x");
    await git("checkout", "-q", "-b", "feature/x");
    assert.equal(await service.currentBranch(dir), "feature/x");
    await git("checkout", "-q", "--detach");
    assert.equal(await service.currentBranch(dir), null);
  });
});
