/**
 * Agent profile — the write backups (spec §4.1). Before every write or delete
 * the previous file (or the whole directory, for a directory delete) is copied
 * to `<appdir>/daemon/agent-profile/backups/<agent>/<stamp>-<basename>`; each
 * agent keeps a ring of its newest `keep` entries. There is no UI for them —
 * they are the owner's undo by hand, and the verify-failed rollback's source.
 *
 * Entries sort by name: the stamp is a fixed-width UTC time, so lexical order
 * is age order. Backups are 0700 directories; a copied file keeps its own mode
 * (a 0600 `.claude.json` stays 0600).
 */

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeSegment } from "./names.ts";
import { copyEntry, pathKind } from "./tree.ts";

/** The ring size per agent when none is given (spec §4.1). */
export const PROFILE_BACKUPS_KEEP = 50;

export interface ProfileBackupsOptions {
  /** `agentProfileBackupsDir(appdir)`. */
  dir: string;
  /** Entries kept per agent; the oldest beyond it are deleted after each save. */
  keep?: number;
  now?: () => Date;
}

/** `20260928T101112345Z`: fixed width, so name order is time order. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export class ProfileBackups {
  readonly dir: string;
  private readonly keep: number;
  private readonly now: () => Date;

  constructor(options: ProfileBackupsOptions) {
    this.dir = options.dir;
    this.keep = Math.max(1, Math.floor(options.keep ?? PROFILE_BACKUPS_KEEP));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Copies what is at `path` now — a file, a directory tree, or a symlink as a
   * symlink (never followed) — into the agent's ring, then prunes the ring.
   * Answers the backup's path, or `null` when nothing is at `path` (a new file
   * has no previous version).
   */
  async save(agent: string, path: string): Promise<string | null> {
    assertSafeSegment(agent);
    if ((await pathKind(path)) === null) {
      return null;
    }
    const agentDir = join(this.dir, agent);
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const base = basename(path);
    const at = stamp(this.now());
    // Two saves inside one millisecond: `~2`, `~3`, … keep both, sorting after the first.
    let target = join(agentDir, `${at}-${base}`);
    for (let n = 2; (await pathKind(target)) !== null; n += 1) {
      target = join(agentDir, `${at}~${n}-${base}`);
    }
    await copyEntry(path, target, { symlinks: "preserve" });
    await this.prune(agentDir);
    return target;
  }

  /**
   * Puts a backup back at `target` (the verify-failed rollback): a file is
   * copied beside `target` and renamed over it; a directory or symlink replaces
   * whatever is at `target`. The backup itself stays in the ring.
   */
  async restore(backupPath: string, target: string): Promise<void> {
    const kind = await pathKind(backupPath);
    if (kind === null) {
      throw new Error(`Backup ${backupPath} no longer exists.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.restore`);
    try {
      await copyEntry(backupPath, tmp, { symlinks: "preserve", fsync: true });
      if (kind !== "file") {
        // rename() cannot replace a non-empty directory; a file can be renamed over.
        await rm(target, { recursive: true, force: true });
      }
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The agent's backups, oldest first. */
  async list(agent: string): Promise<string[]> {
    assertSafeSegment(agent);
    const agentDir = join(this.dir, agent);
    return (await this.entries(agentDir)).map((name) => join(agentDir, name));
  }

  private async entries(agentDir: string): Promise<string[]> {
    try {
      return (await readdir(agentDir)).filter((name) => !name.startsWith(".")).sort();
    } catch {
      return [];
    }
  }

  private async prune(agentDir: string): Promise<void> {
    const names = await this.entries(agentDir);
    for (const name of names.slice(0, Math.max(0, names.length - this.keep))) {
      await rm(join(agentDir, name), { recursive: true, force: true });
    }
  }
}
