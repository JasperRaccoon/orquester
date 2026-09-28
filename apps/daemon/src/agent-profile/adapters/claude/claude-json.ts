/**
 * Agent profile — `~/.claude.json` edits under Claude Code's own lock (spec §4.1).
 *
 * `~/.claude.json` is Claude's live state file: every running session rewrites
 * it (startup counters, per-project state, caches). Claude 2.1.280 guards its
 * own writes with `proper-lockfile` on `<file>.lock` (the path as given, not
 * resolved). We take the SAME lock, re-read the file inside it, change only
 * `mcpServers` (every other key is written back exactly as parsed), write it
 * atomically through the infra (mode kept — the file is 0600 — backup first,
 * re-parse verified), and release. A read outside the lock is only ever used
 * for display and revision checks.
 */

import { lock, type LockOptions } from "proper-lockfile";
import { profileErrors } from "../../errors.ts";
import { type ProfileBackups, readTextIfExists, writeProfileFileVerified } from "../../infra/index.ts";
import { isRecord, parseJsonText } from "./settings.ts";

/** The lock settings Claude's own writers are compatible with (see the module header). */
export const CLAUDE_JSON_LOCK_OPTIONS: LockOptions = {
  realpath: false,
  retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
  stale: 10_000
};

export type ClaudeJsonDoc = Record<string, unknown>;

/** Parses the file's text; throws an `Error` naming the problem (never quoting the file) when it is not a JSON object. */
export function parseClaudeJson(text: string): ClaudeJsonDoc {
  const parsed = parseJsonText(text);
  if (!isRecord(parsed)) {
    throw new Error("the top level is not a JSON object");
  }
  return parsed;
}

/** `mcpServers` as a record; `{}` when absent. Throws when it is there but not an object. */
export function mcpServersOf(doc: ClaudeJsonDoc): Record<string, unknown> {
  const servers = doc.mcpServers;
  if (servers === undefined) {
    return {};
  }
  if (!isRecord(servers)) {
    throw new Error("mcpServers is not an object");
  }
  return servers;
}

/**
 * The document, or `null` when the file does not exist. Throws an `Error`
 * when it does not parse (the caller turns that into a `fileErrors` entry).
 */
export async function readClaudeJson(path: string): Promise<ClaudeJsonDoc | null> {
  const text = await readTextIfExists(path);
  return text === null ? null : parseClaudeJson(text);
}

export interface ClaudeJsonUpdateOptions {
  backups: ProfileBackups;
  agent: string;
  /** Test seam: extra `proper-lockfile` options (a custom `fs`, shorter retries). */
  lockOptions?: Partial<LockOptions>;
}

/**
 * Runs `mutate` on a fresh copy of `mcpServers`, read INSIDE Claude's lock, and
 * writes the file back with only that key replaced. `mutate` may throw (a
 * conflict found on the fresh copy) — nothing is written then; nor when it
 * leaves the servers unchanged. Answers whatever `mutate` answered.
 *
 * A file that does not parse is refused with 409 `CONFIG_UNREADABLE`; a lock
 * that cannot be taken in ~10 s, or that was taken over before the write
 * (compromised), is a 409 `PROFILE_CONFLICT`.
 */
export async function updateClaudeJsonMcpServers<T>(
  path: string,
  mutate: (servers: Record<string, unknown>) => T,
  options: ClaudeJsonUpdateOptions
): Promise<T> {
  let release: () => Promise<void>;
  // proper-lockfile's default `onCompromised` THROWS from a timer — an
  // uncaught exception that would end the daemon. Record it instead (as
  // Claude's own writer logs it) and refuse to write.
  let compromised = false;
  try {
    release = await lock(path, {
      ...CLAUDE_JSON_LOCK_OPTIONS,
      lockfilePath: `${path}.lock`,
      ...options.lockOptions,
      onCompromised: () => {
        compromised = true;
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw profileErrors.conflict(`${path} stayed locked by a running Claude session. Try again in a moment.`);
    }
    throw error;
  }
  try {
    const text = await readTextIfExists(path);
    let doc: ClaudeJsonDoc;
    let servers: Record<string, unknown>;
    try {
      doc = text === null ? {} : parseClaudeJson(text);
      servers = { ...mcpServersOf(doc) };
    } catch (error) {
      throw profileErrors.unreadable(path, error instanceof Error ? error.message : String(error));
    }
    const before = JSON.stringify(servers);
    const result = mutate(servers);
    if (JSON.stringify(servers) === before) {
      return result;
    }
    if (compromised) {
      throw profileErrors.conflict(`${path}'s lock was taken over by another process; nothing was written. Try again.`);
    }
    // Replace the one key in place: every other key, and their order, stays as parsed.
    const next: ClaudeJsonDoc = { ...doc, mcpServers: servers };
    const trailingNewline = text === null || text.endsWith("\n") ? "\n" : "";
    await writeProfileFileVerified(path, `${JSON.stringify(next, null, 2)}${trailingNewline}`, {
      backups: options.backups,
      agent: options.agent,
      defaultMode: 0o600,
      verify: (written) => mcpServersOf(parseClaudeJson(written))
    });
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}
