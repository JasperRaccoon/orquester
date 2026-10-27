/**
 * Claude adapter — the `env` a chat's settings files hand the CLI, read the way Claude Code 2.1.307
 * reads them, for the two keys the launch must see before the CLI does (`launch.ts`):
 * `NODE_OPTIONS` (the flag-tier value replaces theirs, so theirs goes first) and
 * `ENABLE_TOOL_SEARCH` (an auto mode is switched to `true` at the flag tier).
 *
 * Claude Code applies settings `env` over the process env, per key, highest source first: flag
 * (`--settings`), local, project, user. Where it reads them:
 * - user: `<CLAUDE_CONFIG_DIR>/settings.json`;
 * - project: `<cwd>/.claude/settings.json`;
 * - local: `<root>/.claude/settings.local.json`, where `root` is the main checkout of the cwd's git
 *   repository (a worktree's `.git` file → its gitdir → `commondir`). It stays the cwd on Windows, outside a
 *   repository, when the root is the cwd or the home, and when the root, its `.git` or its
 *   `.claude` is not owned by the CLI's user. When `root` is not the cwd, a `settings.local.json`
 *   an older Claude Code left in the cwd still applies, under the root's.
 *
 * A profile chat carries the user's settings at the flag tier instead (`profile-launch.ts`), so the
 * user's env wins there; a managed profile without built-in tools loads no settings file at all.
 *
 * Box chats read the project's files in the box (`projectFs`). The ownership and home checks of the
 * local file's root are the CLI's own process facts, which only this machine can answer; in a box
 * the root is kept when it has a `.git`.
 *
 * Static imports only (AGENTS.md: no dynamic `import()` under `agent-host`).
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { isPlainObject, readJsonObject, type ClaudeNamesFs } from "../../../agent-isolation/claude-names.ts";
import { HostProjectFs } from "../../../boxes/remote/fs/project-fs.ts";
import { claudeConfigDir } from "./config-dir.ts";

type Doc = Record<string, unknown>;

/** Which settings files a launch loads (`launch.ts` `settingSources`). */
type ClaudeSettingsSources = "global" | "profile" | "isolated";

const HOST_FS: ClaudeNamesFs = new HostProjectFs();

/** git's pointer files are a line long; anything past this is not one. */
const MAX_POINTER_BYTES = 64 * 1024;

/**
 * Each loaded settings file's `env` object, highest precedence first; a file without one (missing,
 * unreadable, not an object) is left out.
 */
export async function claudeSettingsEnvs(input: {
  /** The env the child's is built from: its `CLAUDE_CONFIG_DIR` (and `HOME`) locate the user file. */
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  sources: ClaudeSettingsSources;
  /** The CLI's target OS (a box's, when remote). Windows keeps its local file in the cwd. */
  platform?: NodeJS.Platform;
  /**
   * boxes: where the project's files are read — a box chat's project lives in its box (the host
   * directory is an empty stub). The user file is the host account home's, the source of truth the
   * box's copy is synced from.
   */
  projectFs?: ClaudeNamesFs;
  /**
   * The CLI's `HOME` (its env's; this process's home when unset): a repository rooted there keeps
   * its local file in the cwd. This machine only.
   */
  home?: string;
}): Promise<Doc[]> {
  const user = join(claudeConfigDir(input.env), "settings.json");
  const fs = input.projectFs ?? HOST_FS;
  const files: Array<{ path: string; fs: ClaudeNamesFs }> = [];
  if (input.sources !== "isolated") {
    const cwd = resolve(input.cwd);
    const localDir = (input.platform ?? process.platform) === "win32"
      ? cwd
      : await claudeLocalSettingsDir(cwd, fs, input.projectFs === undefined ? { home: input.home } : undefined);
    const local = (dir: string): { path: string; fs: ClaudeNamesFs } => ({ path: join(dir, ".claude", "settings.local.json"), fs });
    files.push(local(localDir));
    if (localDir !== cwd) files.push(local(cwd));
    files.push({ path: join(cwd, ".claude", "settings.json"), fs });
  }
  // Global: the lowest source. A profile chat's (and an isolated one's) rides the flag tier: the highest.
  if (input.sources === "global") files.push({ path: user, fs: HOST_FS });
  else files.unshift({ path: user, fs: HOST_FS });
  const docs = await Promise.all(files.map((file) => readJsonObject(file.path, file.fs)));
  return docs.flatMap((doc) => (isPlainObject(doc?.env) ? [doc.env] : []));
}

/** The `NODE_OPTIONS` the CLI would take from its settings files: the highest string one. */
export function claudeSettingsNodeOptions(envs: readonly Doc[]): string | undefined {
  for (const env of envs) {
    if (typeof env.NODE_OPTIONS === "string") return env.NODE_OPTIONS;
  }
  return undefined;
}

/**
 * The `ENABLE_TOOL_SEARCH` the CLI would run with: the highest settings file that sets it, else the
 * process env's. A settings value that is not a string reads as unknown (`undefined`) without
 * falling through: whatever the CLI makes of it, it is not one a launch should override.
 */
export function claudeToolSearchSetting(
  envs: readonly Doc[],
  processEnv: Readonly<Record<string, string | undefined>>
): string | undefined {
  for (const env of envs) {
    const value = env.ENABLE_TOOL_SEARCH;
    if (value !== undefined) return typeof value === "string" ? value : undefined;
  }
  return processEnv.ENABLE_TOOL_SEARCH;
}

/** Where Claude Code reads `.claude/settings.local.json` for `cwd` (resolved). */
async function claudeLocalSettingsDir(cwd: string, fs: ClaudeNamesFs, host: { home?: string } | undefined): Promise<string> {
  const checkout = await gitCheckoutOf(cwd, fs);
  if (checkout === null) return cwd;
  const root = await canonicalGitRoot(checkout, fs);
  if (root === cwd) return cwd;
  if (host === undefined) return (await kindOf(join(root, ".git"), fs, false)) !== null ? root : cwd;
  const home = host.home ?? homedir();
  const realHome = await realpath(home).catch(() => resolve(home));
  if ((await realpath(root).catch(() => root)) === realHome) return cwd;
  return (await ownedByThisUser(root)) ? root : cwd;
}

/** The nearest directory from `cwd` up holding a `.git` (a directory, or a worktree's file); null outside one. */
async function gitCheckoutOf(cwd: string, fs: ClaudeNamesFs): Promise<string | null> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const kind = await kindOf(join(dir, ".git"), fs, true);
    if (kind === "dir" || kind === "file") return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * A worktree's main checkout: its `.git` file names `<main>/.git/worktrees/<name>`, whose
 * `commondir` leads back to `<main>/.git` and whose `gitdir` points back at the worktree. Anything
 * that does not line up keeps the checkout itself. A bare repository's worktree resolves to the bare
 * repository when it has no `.git` of its own (whose local file then never qualifies: no `.git`).
 */
async function canonicalGitRoot(checkout: string, fs: ClaudeNamesFs): Promise<string> {
  const pointer = await readPointer(join(checkout, ".git"), fs);
  if (pointer === undefined || !pointer.startsWith("gitdir:")) return checkout;
  const gitDir = resolve(checkout, pointer.slice("gitdir:".length).trim());
  const commonDirText = await readPointer(join(gitDir, "commondir"), fs);
  if (commonDirText === undefined) return checkout;
  const commonDir = resolve(gitDir, commonDirText);
  if (dirname(gitDir) !== join(commonDir, "worktrees")) return checkout;
  const backPointer = await readPointer(join(gitDir, "gitdir"), fs);
  if (backPointer === undefined || resolve(gitDir, backPointer) !== join(checkout, ".git")) return checkout;
  if (basename(commonDir) !== ".git") {
    return (await kindOf(join(commonDir, ".git"), fs, false)) !== null ? checkout : commonDir;
  }
  return dirname(commonDir);
}

/** A git pointer file's text, trimmed; undefined when it is missing, unreadable, or not a file. */
async function readPointer(path: string, fs: ClaudeNamesFs): Promise<string | undefined> {
  if ((await kindOf(path, fs, true)) !== "file") return undefined;
  try {
    const bytes = await fs.read(path, { length: MAX_POINTER_BYTES + 1 });
    return bytes.length > MAX_POINTER_BYTES ? undefined : bytes.toString("utf8").trim();
  } catch {
    return undefined;
  }
}

async function kindOf(path: string, fs: ClaudeNamesFs, followSymlinks: boolean): Promise<string | null> {
  return fs.stat(path, { followSymlinks }).then(
    (st) => st?.kind ?? null,
    () => null
  );
}

/**
 * Claude Code's ownership check of a local file's root: the root, its `.git` and its `.claude`
 * (when present) all belong to the CLI's user — this process's, as a local CLI runs as it.
 */
async function ownedByThisUser(root: string): Promise<boolean> {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) return false;
  try {
    const [rootUid, gitUid] = [(await stat(root)).uid, (await lstat(join(root, ".git"))).uid];
    const claudeUid = await lstat(join(root, ".claude")).then(
      (info) => info.uid,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    );
    return rootUid === uid && gitUid === uid && (claudeUid === null || claudeUid === uid);
  } catch {
    return false;
  }
}
