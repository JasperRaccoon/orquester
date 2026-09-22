/**
 * The commit the code on disk was checked out at, read WITHOUT the git binary.
 *
 * Why it exists: the agent host survives a deploy on purpose (§3.1 — it lives
 * in a tmux service session so in-flight turns outlive the daemon restart),
 * and the supervisor only replaced it when {@link AGENT_HOST_PROTOCOL_VERSION}
 * changed. A code-only deploy therefore left the old host running old code
 * for as long as it lived — every fix that touches `agent-host/**` was invisible
 * until someone stopped the host by hand. The host reports the stamp it
 * started from in `/health`; the daemon computes its own at boot from the same
 * checkout; a difference is the §3.1 case-3 drain-restart.
 *
 * Deploys land as `git reset --hard origin/main` in `/opt/orquester`, so HEAD
 * is exactly the identity that moves. Anything unreadable — no `.git`, a
 * detached layout this does not understand — yields `null`, and a `null` on
 * either side never triggers a restart (the protocol version still does).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_HOPS = 8;

/** Resolve `.git` for `dir`, following a worktree's `gitdir:` pointer file. */
function gitDirOf(dir: string): { gitDir: string; commonDir: string } | null {
  let cursor = resolve(dir);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const candidate = join(cursor, ".git");
    if (existsSync(candidate)) {
      const info = statSync(candidate);
      if (info.isDirectory()) {
        return { gitDir: candidate, commonDir: candidate };
      }
      // A worktree: `.git` is a file "gitdir: <path>"; refs live in commondir.
      const pointer = readFileSync(candidate, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) return null;
      const gitDir = isAbsolute(match[1]!) ? match[1]! : resolve(cursor, match[1]!);
      const commonFile = join(gitDir, "commondir");
      const commonDir = existsSync(commonFile)
        ? resolve(gitDir, readFileSync(commonFile, "utf8").trim())
        : gitDir;
      return { gitDir, commonDir };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

function resolveRef(commonDir: string, ref: string): string | null {
  const loose = join(commonDir, ref);
  if (existsSync(loose)) {
    const sha = readFileSync(loose, "utf8").trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }
  const packed = join(commonDir, "packed-refs");
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, "utf8").split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return null;
}

/** The commit `dir`'s checkout is at, or `null` when it cannot be read. */
export function readCodeStamp(dir: string): string | null {
  try {
    const dirs = gitDirOf(dir);
    if (!dirs) return null;
    const head = readFileSync(join(dirs.gitDir, "HEAD"), "utf8").trim();
    const symbolic = /^ref:\s*(.+)$/.exec(head);
    if (!symbolic) {
      return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
    }
    return resolveRef(dirs.commonDir, symbolic[1]!.trim());
  } catch {
    return null;
  }
}

/**
 * True when two stamps are both known and differ. Unknown on either side is
 * never a mismatch: the protocol version remains the hard gate.
 */
export function codeStampsDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a !== b;
}
