/**
 * Test-only helpers: real temporary git repositories.
 *
 * The checkpoint service is almost entirely a conversation with `git`, so its
 * tests talk to real repositories rather than to a mocked process runner —
 * a fake would only assert that we still pass the arguments we already wrote.
 * Nothing here is imported by production code.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.invalid"
} as const;

export interface TempRepo {
  /** The work tree. */
  dir: string;
  /** A throwaway HOME, so no global gitconfig can reach these repos. */
  home: string;
  /**
   * What the service is handed: PATH and HOME only. No identity — a capture
   * must supply its own, and must not depend on the user's git config.
   */
  gitEnv: Record<string, string>;
  /** Run git in the work tree with a full identity (the "user" acting). */
  git(...args: string[]): Promise<string>;
  /** Run git without taking the index lock, for read-only assertions. */
  gitReadOnly(...args: string[]): Promise<string>;
  /** Run git with a stdin body (`update-ref --stdin`). */
  gitStdin(stdin: string, ...args: string[]): Promise<string>;
  /** Entries directly inside the repository's git common dir. */
  gitCommonDirEntries(): Promise<string[]>;
  write(relativePath: string, contents: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createTempRepo(options: { init?: boolean } = {}): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "orq-ckpt-"));
  const dir = join(root, "work");
  const home = join(root, "home");
  await run("mkdir", ["-p", dir, home]);

  const gitEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1"
  };

  const repo: TempRepo = {
    dir,
    home,
    gitEnv,
    git: async (...args: string[]) => {
      const { stdout } = await run("git", args, {
        cwd: dir,
        env: { ...gitEnv, ...IDENTITY },
        maxBuffer: 32 * 1024 * 1024
      });
      return stdout;
    },
    gitReadOnly: async (...args: string[]) => {
      const { stdout } = await run("git", args, {
        cwd: dir,
        env: { ...gitEnv, ...IDENTITY, GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: 32 * 1024 * 1024
      });
      return stdout;
    },
    gitStdin: async (stdin: string, ...args: string[]) => {
      const child = spawn("git", args, { cwd: dir, env: { ...gitEnv, ...IDENTITY } });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.stdin.end(stdin);
      const code = await new Promise<number>((resolve) => {
        child.once("close", (value) => resolve(value ?? 0));
      });
      if (code !== 0) {
        throw new Error(`git ${args[0]} exited ${code}: ${Buffer.concat(errors).toString("utf8")}`);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    gitCommonDirEntries: async () => {
      const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: dir,
        env: { ...gitEnv, ...IDENTITY }
      });
      return (await readdir(stdout.trim())).sort();
    },
    write: async (relativePath: string, contents: string) => {
      const target = join(dir, relativePath);
      const parent = target.slice(0, target.lastIndexOf("/"));
      await run("mkdir", ["-p", parent]);
      await writeFile(target, contents, "utf8");
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };

  if (options.init !== false) {
    await repo.git("init", "-q", "-b", "main", ".");
  }
  return repo;
}

/** Everything a capture must leave byte-identical. */
export interface UserGitState {
  indexSha: string;
  head: string;
  branches: string;
  stashes: string;
  status: string;
  headReflog: string;
}

export async function snapshotUserGitState(repo: TempRepo): Promise<UserGitState> {
  // Read the index bytes FIRST: a later `git status` would refresh its stat
  // cache and rewrite it for reasons that have nothing to do with us. Every
  // command below runs with GIT_OPTIONAL_LOCKS=0 for the same reason.
  const indexBytes = await readFile(join(repo.dir, ".git", "index")).catch(() => Buffer.alloc(0));
  return {
    indexSha: createHash("sha256").update(indexBytes).digest("hex"),
    head: await readFile(join(repo.dir, ".git", "HEAD"), "utf8"),
    branches: await repo.gitReadOnly("for-each-ref", "--format=%(refname) %(objectname)", "refs/"),
    stashes: await repo.gitReadOnly("stash", "list"),
    status: await repo.gitReadOnly("status", "--porcelain"),
    headReflog: await repo.gitReadOnly("reflog", "--format=%H %gs").catch(() => "")
  };
}

/** The paths a checkpoint ref's tree contains, sorted. */
export async function treePaths(repo: TempRepo, ref: string): Promise<string[]> {
  const stdout = await repo.gitReadOnly("ls-tree", "-r", "--name-only", `${ref}^{commit}`);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export async function refNames(repo: TempRepo, pattern: string): Promise<string[]> {
  const stdout = await repo.gitReadOnly("for-each-ref", "--format=%(refname)", pattern);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}
