/**
 * Checkpoints — capturing one tree into a hidden ref (spec §5.4).
 *
 * The whole capture runs against an **isolated temporary index** placed inside
 * the repository's git common dir (not `TMPDIR`, so it shares the object store
 * and survives `ProtectSystem=strict`), with a fixed author/committer identity
 * so a capture never depends on the user's git config. The user's index, HEAD,
 * branches, stash and visible reflog are never written.
 *
 * `git add -A` → `git write-tree` → `git commit-tree` → `git update-ref`.
 *
 * Ported from T3 Code (MIT): apps/server/src/vcs/GitVcsDriver.ts
 */

import { isUtf8 } from "node:buffer";
import { copyFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

import { GitError, GitExitError, type GitRunner } from "./git.ts";

/** `VcsProcess.CHECKPOINT_CAPTURE_OPERATION` — the retrying operation. */
export const CHECKPOINT_CAPTURE_OPERATION = "checkpoints.capture";

const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT_MS = 5_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * `core.fsmonitor=false` keeps a user's fsmonitor daemon out of our private
 * index; `sparse.expectFilesOutsideOfPatterns` stops git from pruning entries
 * that exist on disk but sit outside the sparse cone.
 */
const INDEX_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "sparse.expectFilesOutsideOfPatterns=false"
] as const;

/**
 * Git renames loose objects and refs into place without fsync by default, so
 * an unclean restart can leave 0-byte files under `refs/orquester/**` that
 * break every later fetch and push. Checkpoint writes flush before they are
 * published; macOS defaults to writeout-only, which does not reach the disk.
 */
const DURABLE_WRITE = [
  "-c",
  "core.fsync=objects,reference",
  "-c",
  "core.fsyncMethod=fsync"
] as const;

const IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Orquester",
  GIT_AUTHOR_EMAIL: "orquester@localhost",
  GIT_COMMITTER_NAME: "Orquester",
  GIT_COMMITTER_EMAIL: "orquester@localhost"
};

/** The git env vars a nested-repo probe must NOT inherit from this capture. */
const NESTED_REPO_ENV: Record<string, string | undefined> = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined
};

export interface CaptureInput {
  cwd: string;
  /** The full ref name to publish, from `checkpointRefForThreadTurn`. */
  ref: string;
  /** Names the temp index; a seam so a test can make it deterministic. */
  uuid: string;
}

/** True when `cwd` sits inside a git work tree. A non-git project skips silently. */
export async function isInsideWorkTree(runner: GitRunner, cwd: string): Promise<boolean> {
  try {
    const result = await runner.run({
      operation: "checkpoints.isInsideWorkTree",
      cwd,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowNonZeroExit: true,
      timeoutMs: 10_000,
      maxOutputBytes: 4_096
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    // A missing directory, no git binary, a hung probe: all of them mean
    // "no checkpoints here", never "fail the turn".
    return false;
  }
}

export async function resolveGitCommonDir(runner: GitRunner, cwd: string): Promise<string> {
  const result = await runner.run({
    operation: "checkpoints.resolveGitCommonDir",
    cwd,
    args: ["rev-parse", "--git-common-dir"],
    maxOutputBytes: 64 * 1024
  });
  const gitCommonDir = result.stdout.trim();
  return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
}

export async function hasHeadCommit(
  runner: GitRunner,
  cwd: string,
  env?: Record<string, string | undefined>
): Promise<boolean> {
  const result = await runner.run({
    operation: CHECKPOINT_CAPTURE_OPERATION,
    cwd,
    args: ["rev-parse", "--verify", "HEAD"],
    allowNonZeroExit: true,
    maxOutputBytes: 4_096,
    ...(env === undefined ? {} : { env })
  });
  return result.exitCode === 0;
}

/** The commit a checkpoint ref points at, or null when the ref is absent. */
export async function resolveCheckpointCommit(
  runner: GitRunner,
  cwd: string,
  ref: string
): Promise<string | null> {
  const result = await runner.run({
    operation: "checkpoints.resolveCheckpointCommit",
    cwd,
    args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    allowNonZeroExit: true,
    maxOutputBytes: 4_096
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const commit = result.stdout.trim();
  return commit.length > 0 ? commit : null;
}

/**
 * Capture the working tree (tracked + staged + untracked-nonignored) into
 * `input.ref`. Ignored files are never staged: `-A` respects `.gitignore`, so
 * a checkpoint is exactly what the diff shows.
 */
export async function captureCheckpoint(runner: GitRunner, input: CaptureInput): Promise<void> {
  const operation = CHECKPOINT_CAPTURE_OPERATION;
  const { cwd, ref } = input;

  const gitCommonDir = await resolveGitCommonDir(runner, cwd);
  const tempIndexPath = path.join(gitCommonDir, `orq-checkpoint-index-${input.uuid}`);
  const captureEnv: Record<string, string | undefined> = {
    ...IDENTITY_ENV,
    GIT_INDEX_FILE: tempIndexPath
  };

  // Forced process termination can leave git's private index lock behind, and
  // a stale lock poisons every later capture.
  const cleanupTempIndex = async (): Promise<void> => {
    await Promise.all([
      rm(tempIndexPath, { force: true }).catch(() => {}),
      rm(`${tempIndexPath}.lock`, { force: true }).catch(() => {})
    ]);
  };

  try {
    const headExists = await hasHeadCommit(runner, cwd, captureEnv);
    let sparseCheckout = await isSparseCheckout(runner, cwd, captureEnv);
    if (sparseCheckout) {
      // `git add --sparse` only exists from 2.25; without it the flag below
      // would fail the whole capture on an old git.
      const help = await runner.run({
        operation,
        cwd,
        args: ["add", "-h"],
        allowNonZeroExit: true,
        env: captureEnv,
        maxOutputBytes: 64 * 1024
      });
      sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
    }

    if (headExists) {
      const reusedIndex = await reuseLiveIndex(runner, {
        cwd,
        tempIndexPath,
        captureEnv,
        sparseCheckout
      });
      if (!reusedIndex) {
        if (sparseCheckout) {
          const cone = await runner.run({
            operation,
            cwd,
            args: ["config", "--bool", "core.sparseCheckoutCone"],
            allowNonZeroExit: true,
            env: captureEnv,
            maxOutputBytes: 4_096
          });
          // Rebuilding a non-cone index loses exclusions; refuse rather than
          // publish false deletions for present-but-skipped files.
          if (cone.stdout.trim() !== "true") {
            throw new GitError(
              operation,
              "cannot rebuild a checkpoint index for a non-cone sparse checkout"
            );
          }
        }
        await cleanupTempIndex();
        await runner.run({
          operation,
          cwd,
          // A fresh sparse index represents excluded directories without
          // marking them deleted.
          args: sparseCheckout
            ? [...INDEX_CONFIG, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
            : ["read-tree", "HEAD"],
          env: captureEnv,
          retryTransient: true
        });
      }
    }

    await stageWorkingTree(runner, { cwd, captureEnv, sparseCheckout, operation });

    const writeTree = await runner.run({
      operation,
      cwd,
      args: [...INDEX_CONFIG, ...DURABLE_WRITE, "write-tree"],
      env: captureEnv,
      retryTransient: true
    });
    const treeOid = writeTree.stdout.trim();
    if (treeOid.length === 0) {
      throw new GitError(operation, "git write-tree returned an empty tree oid");
    }

    const commitTree = await runner.run({
      operation,
      cwd,
      args: [...DURABLE_WRITE, "commit-tree", treeOid, "-m", `orquester checkpoint ref=${ref}`],
      env: captureEnv,
      retryTransient: true
    });
    const commitOid = commitTree.stdout.trim();
    if (commitOid.length === 0) {
      throw new GitError(operation, "git commit-tree returned an empty commit oid");
    }

    await runner.run({
      operation,
      cwd,
      args: [...DURABLE_WRITE, "update-ref", ref, commitOid],
      env: captureEnv,
      retryTransient: true
    });
  } finally {
    await cleanupTempIndex();
  }
}

async function isSparseCheckout(
  runner: GitRunner,
  cwd: string,
  captureEnv: Record<string, string | undefined>
): Promise<boolean> {
  const sparseConfig = await runner.run({
    operation: CHECKPOINT_CAPTURE_OPERATION,
    cwd,
    args: ["config", "--bool", "core.sparseCheckout"],
    allowNonZeroExit: true,
    env: captureEnv,
    maxOutputBytes: 4_096
  });
  return sparseConfig.stdout.trim() === "true";
}

/**
 * Copy the live index and reset it to HEAD, keeping its stat data so `git add`
 * does not have to re-hash the whole tree — and, on a sparse checkout, so
 * present-but-skipped files are not published as deletions.
 *
 * Returns false when the index carries any manual flag (a lowercase `ls-files
 * -v` tag, or a skip-worktree bit that the sparse rules do not explain), in
 * which case the caller rebuilds a fresh index instead.
 */
async function reuseLiveIndex(
  runner: GitRunner,
  input: {
    cwd: string;
    tempIndexPath: string;
    captureEnv: Record<string, string | undefined>;
    sparseCheckout: boolean;
  }
): Promise<boolean> {
  const operation = CHECKPOINT_CAPTURE_OPERATION;
  const { cwd, tempIndexPath, captureEnv, sparseCheckout } = input;
  try {
    const indexPathResult = await runner.run({
      operation,
      cwd,
      args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      maxOutputBytes: 64 * 1024
    });
    const livePath = indexPathResult.stdout.trim();
    const stats = await stat(livePath);
    // Stay below the source timestamp even if Date rounded up, preserving
    // git's racy-timestamp check.
    const indexTime = Math.floor((stats.mtimeMs - 1) / 1000);
    if (indexTime <= 0) {
      return false;
    }
    await copyFile(livePath, tempIndexPath);
    // Retain stat data only where the copied index already matches HEAD.
    await runner.run({
      operation,
      cwd,
      args: [...INDEX_CONFIG, "read-tree", "--reset", "HEAD"],
      env: captureEnv,
      retryTransient: true
    });
    // read-tree can rewrite the index, so restore its racy timestamp after.
    await utimes(tempIndexPath, indexTime, indexTime);

    const scan = createIndexFlagScanner(sparseCheckout);
    await runner.run({
      operation,
      cwd,
      args: [...INDEX_CONFIG, "ls-files", "--full-name", "--sparse", "-v", "-z"],
      env: captureEnv,
      // Inspect every tag but retain almost nothing: the scanner sees each
      // chunk before the cap is applied.
      maxOutputBytes: 4_096,
      onStdoutChunk: scan.push
    });

    if (scan.skippedPaths.length > 0 && !scan.specialFlags()) {
      const selected = await runner.run({
        operation,
        cwd,
        args: [...INDEX_CONFIG, "sparse-checkout", "check-rules", "-z"],
        stdin: `${scan.skippedPaths.join("\0")}\0`,
        env: captureEnv,
        maxOutputBytes: 1
      });
      // Any selected skipped file carries a manual flag, not a sparse exclusion.
      if (selected.stdout.length > 0 || selected.stdoutTruncated) {
        return false;
      }
    }
    // Sparse git clears skip-worktree for present files; a manual flag still
    // needs a full reset.
    return !scan.specialFlags();
  } catch {
    return false;
  }
}

/**
 * Scans `git ls-files -v -z` output byte by byte. Each record is
 * `<tag><space><path>\0`; a lowercase tag means assume-unchanged, and `S`
 * means skip-worktree — manual when the checkout is not sparse.
 */
function createIndexFlagScanner(sparseCheckout: boolean): {
  push: (chunk: Buffer) => void;
  specialFlags: () => boolean;
  skippedPaths: string[];
} {
  let special = false;
  let recordStart = true;
  let skipped = false;
  let record: number[] = [];
  const skippedPaths: string[] = [];

  const push = (chunk: Buffer): void => {
    for (const byte of chunk) {
      if (recordStart) {
        skipped = byte === 83; // "S"
      }
      if (skipped && sparseCheckout) {
        if (byte !== 0) {
          record.push(byte);
        } else {
          if (record.at(-1) !== 47) {
            // not "/": a file, not a sparse directory entry
            const name = Buffer.from(record).subarray(2);
            if (!isUtf8(name)) {
              special = true;
            } else {
              skippedPaths.push(name.toString("utf8"));
            }
          }
          record = [];
        }
      }
      if (recordStart && ((byte >= 97 && byte <= 122) || (!sparseCheckout && byte === 83))) {
        special = true;
      }
      recordStart = byte === 0;
    }
  };

  return { push, specialFlags: () => special, skippedPaths };
}

/**
 * `git add -A -- .`, with one bounded retry that excludes untracked embedded
 * repositories: git refuses to stage a nested repo that has no commit yet.
 * Discovery happens only after staging fails, so an ordinary checkpoint never
 * pays for another file scan.
 */
async function stageWorkingTree(
  runner: GitRunner,
  input: {
    cwd: string;
    captureEnv: Record<string, string | undefined>;
    sparseCheckout: boolean;
    operation: string;
  }
): Promise<void> {
  const { cwd, captureEnv, sparseCheckout, operation } = input;

  const stageFiles = (exclusions: readonly string[], signal?: AbortSignal): Promise<unknown> =>
    runner.run({
      operation,
      cwd,
      // Preserve absent skipped entries, but capture present nonignored files
      // outside the cone.
      args: [
        ...INDEX_CONFIG,
        ...DURABLE_WRITE,
        "add",
        ...(sparseCheckout ? ["--sparse"] : []),
        "-A",
        "--",
        ".",
        ...exclusions
      ],
      env: captureEnv,
      retryTransient: true,
      ...(signal === undefined ? {} : { signal })
    });

  try {
    await stageFiles([]);
    return;
  } catch (error) {
    if (!(error instanceof GitExitError)) {
      throw error;
    }
    // One budget covers discovery, queued git admission, probes and the retry.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECKPOINT_RECOVERY_TIMEOUT_MS);
    timer.unref?.();
    try {
      const exclusions = await findUnstageableNestedRepos(runner, {
        cwd,
        captureEnv,
        operation,
        signal: controller.signal
      });
      if (exclusions.length === 0) {
        throw error;
      }
      await stageFiles(exclusions, controller.signal);
    } catch (retryError) {
      if (retryError === error) {
        throw error;
      }
      // The original failure stands: the recovery is a best effort, not a
      // second class of error.
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function findUnstageableNestedRepos(
  runner: GitRunner,
  input: {
    cwd: string;
    captureEnv: Record<string, string | undefined>;
    operation: string;
    signal: AbortSignal;
  }
): Promise<string[]> {
  const { cwd, captureEnv, operation, signal } = input;
  const untracked = await runner.run({
    operation,
    cwd,
    args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
    env: captureEnv,
    maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
    signal
  });
  if (untracked.stdoutTruncated) {
    return [];
  }
  const candidates = untracked.stdout
    .split("\0")
    .filter((entry) => entry.length > 0 && entry.endsWith("/"));
  // Refuse excessive recovery work before probing any nested repository.
  if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) {
    return [];
  }

  const exclusions: string[] = [];
  for (const entry of candidates) {
    if (signal.aborted) {
      return [];
    }
    const nestedCwd = path.join(cwd, entry);
    const hasGitDir = await pathExists(path.join(nestedCwd, ".git"));
    if (!hasGitDir) {
      continue;
    }
    // Discover the child's own repository instead of inheriting ours.
    const nestedHasCommit = await hasHeadCommit(runner, nestedCwd, {
      ...captureEnv,
      ...NESTED_REPO_ENV
    });
    if (!nestedHasCommit) {
      exclusions.push(`:(exclude,literal)${entry}`);
    }
  }
  return exclusions;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
