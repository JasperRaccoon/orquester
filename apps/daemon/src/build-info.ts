// The version and git commit the daemon runs, read once at boot for `GET /api/info`.
//
// The version is the repository's root package.json. The commit comes from the checkout's git
// metadata, read as files (HEAD, loose ref, packed-refs; a linked worktree's `.git` file and
// `commondir` followed) without spawning git; a tree without `.git` falls back to the stamp
// `./deploy.sh` writes at the repository root (VERSION_STAMP_FILE). Anything unreadable is null.

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Written by deploy/lib/remote-update.sh: `{ "commit": "<sha>", "version": "…", "deployedAt": "…" }`. */
export const VERSION_STAMP_FILE = ".orquester-version.json";

export interface BuildInfo {
  version: string | null;
  commit: string | null;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The nearest directory at or above `start` whose package.json is the `orquester` workspace root. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (readJson(join(dir, "package.json"))?.name === "orquester") return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The git directory of a checkout: `.git` itself, or the one a linked worktree's `.git` file names. */
function gitDirOf(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "")?.[1];
  if (!pointer) return null;
  return isAbsolute(pointer) ? pointer : resolve(root, pointer);
}

/** The commit HEAD points at, read from the git files; null when it cannot be told. */
export function readGitCommit(root: string): string | null {
  const gitDir = gitDirOf(root);
  if (gitDir === null) return null;
  const head = readText(join(gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  // A linked worktree keeps its own HEAD; branches live in the main repository's git dir.
  const common = readText(join(gitDir, "commondir"))?.trim();
  const dirs = [gitDir, ...(common ? [isAbsolute(common) ? common : resolve(gitDir, common)] : [])];
  for (const dir of dirs) {
    const loose = readText(join(dir, ref))?.trim();
    if (loose && SHA.test(loose)) return loose;
    for (const line of (readText(join(dir, "packed-refs")) ?? "").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && sha && SHA.test(sha)) return sha;
    }
  }
  return null;
}

/** The version and commit of the checkout at `root` (git first, then the deploy's stamp). */
export function readBuildInfo(root: string | null): BuildInfo {
  if (root === null) return { version: null, commit: null };
  const pkg = readJson(join(root, "package.json"));
  const stamp = readJson(join(root, VERSION_STAMP_FILE));
  const stampCommit = typeof stamp?.commit === "string" && SHA.test(stamp.commit) ? stamp.commit : null;
  const version = typeof pkg?.version === "string" && pkg.version ? pkg.version : typeof stamp?.version === "string" && stamp.version ? stamp.version : null;
  return { version, commit: readGitCommit(root) ?? stampCommit };
}

/** The running daemon's build info, from the checkout this module was loaded from. */
export function daemonBuildInfo(): BuildInfo {
  return readBuildInfo(findRepoRoot(dirname(fileURLToPath(import.meta.url))));
}
