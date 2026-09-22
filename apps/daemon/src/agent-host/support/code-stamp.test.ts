import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { codeStampsDiffer, readCodeStamp } from "./code-stamp.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "code-stamp-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("readCodeStamp", () => {
  it("resolves a symbolic HEAD through a loose ref", async () => {
    await withRepo(async (root) => {
      await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(root, ".git", "refs", "heads", "main"), `${SHA_A}\n`);
      assert.equal(readCodeStamp(root), SHA_A);
      // From a subdirectory too — the host's cwd is the repo root, but be safe.
      await mkdir(join(root, "apps", "daemon"), { recursive: true });
      assert.equal(readCodeStamp(join(root, "apps", "daemon")), SHA_A);
    });
  });

  it("falls back to packed-refs and reads a detached HEAD verbatim", async () => {
    await withRepo(async (root) => {
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(
        join(root, ".git", "packed-refs"),
        `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/heads/main\n^${SHA_A}\n`
      );
      assert.equal(readCodeStamp(root), SHA_B);
      await writeFile(join(root, ".git", "HEAD"), `${SHA_A}\n`);
      assert.equal(readCodeStamp(root), SHA_A);
    });
  });

  it("follows a worktree's gitdir pointer and its commondir for refs", async () => {
    await withRepo(async (root) => {
      const main = join(root, "main");
      await mkdir(join(main, ".git", "refs", "heads"), { recursive: true });
      await mkdir(join(main, ".git", "worktrees", "wt"), { recursive: true });
      await writeFile(join(main, ".git", "refs", "heads", "feature"), `${SHA_B}\n`);
      await writeFile(join(main, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feature\n");
      await writeFile(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
      const wt = join(root, "wt");
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
      assert.equal(readCodeStamp(wt), SHA_B);
    });
  });

  it("is null outside a repository and never throws", async () => {
    await withRepo(async (root) => {
      assert.equal(readCodeStamp(root), null);
      assert.equal(readCodeStamp(join(root, "missing")), null);
    });
  });
});

describe("codeStampsDiffer", () => {
  it("only two known, different stamps differ", () => {
    assert.equal(codeStampsDiffer(SHA_A, SHA_B), true);
    assert.equal(codeStampsDiffer(SHA_A, SHA_A), false);
    assert.equal(codeStampsDiffer(null, SHA_A), false);
    assert.equal(codeStampsDiffer(SHA_A, undefined), false);
    assert.equal(codeStampsDiffer(null, null), false);
  });
});
