/**
 * Agent profile — the ONLY way an adapter writes or deletes an agent's files
 * (spec §4.5). Every write:
 *
 *  1. goes to the REAL file: `target` is resolved through every symlink (a
 *     dangling one included, to the file it names), so a link into a dotfiles
 *     repo or a managed account home's shared link is written through and
 *     never replaced by a regular file — the `writeFileAtomic` rule of
 *     `agent-hooks.ts`, extended to paths that do not exist yet;
 *  2. keeps the existing file's mode (a 0600 `.claude.json` stays 0600), else
 *     uses `defaultMode`;
 *  3. is preceded by a backup of the previous version (`ProfileBackups`);
 *  4. is atomic: a unique temp file in the same directory, fsynced, renamed over.
 *
 * `writeProfileFileVerified` adds the re-parse check: a file that no longer
 * parses is put back from its backup and the mutation fails with 500
 * `WRITE_VERIFY_FAILED`.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readlink, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { profileErrors } from "../errors.ts";
import type { ProfileBackups } from "./backups.ts";
import { isMissing, pathKind } from "./tree.ts";

/** Symlink hops followed before giving up, as the kernel does (`ELOOP`). */
const MAX_SYMLINK_HOPS = 40;

interface ProfileWriteOptions {
  backups: ProfileBackups;
  /** The backup ring the previous version goes to (`claude`, `codex`, …). */
  agent: string;
  /** Mode of a file that does not exist yet; an existing file keeps its own. Default 0644. */
  defaultMode?: number;
}

export interface ProfileWriteResult {
  /** The real path written (symlinks resolved). */
  path: string;
  /** Where the previous version was saved; `null` when the file is new. */
  backup: string | null;
}

/**
 * The real path a write of `target` lands on: `realpath(target)` when it
 * exists; otherwise the realpath of its nearest existing ancestor plus the
 * rest, following any dangling symlink on the way to the file it names.
 */
export async function resolveWriteTarget(target: string): Promise<string> {
  return resolveReal(resolve(target), 0);
}

async function resolveReal(path: string, hops: number): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  const parent = dirname(path);
  if (parent === path) {
    return path;
  }
  const realParent = await resolveReal(parent, hops);
  const candidate = join(realParent, basename(path));
  let link: string;
  try {
    link = await readlink(candidate);
  } catch {
    // Not a symlink (nothing there yet): this is the path to create.
    return candidate;
  }
  if (hops >= MAX_SYMLINK_HOPS) {
    throw profileErrors.invalid(`${path}: too many levels of symbolic links.`);
  }
  return resolveReal(resolve(realParent, link), hops + 1);
}

/**
 * Writes `content` to the real file behind `target` (see the module header):
 * parents created, previous version backed up, mode kept, temp + fsync +
 * rename. Refuses with `INVALID_REQUEST` when the target is a directory.
 */
export async function writeProfileFile(
  target: string,
  content: string | Uint8Array,
  options: ProfileWriteOptions
): Promise<ProfileWriteResult> {
  const real = await resolveWriteTarget(target);
  const kind = await pathKind(real);
  if (kind !== null && kind !== "file") {
    throw profileErrors.invalid(`${target} is not a regular file.`);
  }
  const mode = kind === "file" ? (await stat(real)).mode & 0o777 : (options.defaultMode ?? 0o644);
  const dir = dirname(real);
  await mkdir(dir, { recursive: true });
  const backup = await options.backups.save(options.agent, real);
  // Hidden and unique: concurrent writers never share a temp file, and a scan
  // of the directory never lists a half-written `*.md`.
  const tmp = join(dir, `.${basename(real)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // open()'s mode passes through the umask; the file's own mode must not.
    await chmod(tmp, mode);
    await rename(tmp, real);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDir(dir);
  return { path: real, backup };
}

/** Best effort: makes the rename itself durable where the filesystem allows opening a directory. */
async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported here; the data itself is already synced.
  }
}

interface VerifiedWriteOptions extends ProfileWriteOptions {
  /**
   * The parser the adapter reads this file with; it throws when the text does
   * not parse. Runs on the text re-read from disk after the write.
   */
  verify: (text: string) => unknown;
}

/**
 * {@link writeProfileFile}, then re-read the file and run `verify` on it. When
 * it throws, the previous version is put back (or the new file removed, when
 * there was none) and `WRITE_VERIFY_FAILED` is thrown.
 */
export async function writeProfileFileVerified(
  target: string,
  content: string | Uint8Array,
  options: VerifiedWriteOptions
): Promise<ProfileWriteResult> {
  const result = await writeProfileFile(target, content, options);
  try {
    await options.verify(await readFile(result.path, "utf8"));
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    try {
      if (result.backup !== null) {
        await options.backups.restore(result.backup, result.path);
      } else {
        await rm(result.path, { force: true });
      }
    } catch (restoreError) {
      detail += `; putting the previous version back also failed: ${
        restoreError instanceof Error ? restoreError.message : String(restoreError)
      }`;
    }
    throw profileErrors.verifyFailed(target, detail);
  }
  return result;
}

/**
 * Backs up, then deletes, the file or directory at `target`. When `target`
 * itself is a symlink only the link goes (and only the link is backed up) —
 * a symlinked skill directory's real contents are never touched. Answers
 * `removed: false` when nothing was there.
 */
export async function removeProfilePath(
  target: string,
  options: Omit<ProfileWriteOptions, "defaultMode">
): Promise<{ removed: boolean; backup: string | null }> {
  const kind = await pathKind(target);
  if (kind === null) {
    return { removed: false, backup: null };
  }
  const backup = await options.backups.save(options.agent, target);
  if (kind === "dir") {
    await rm(target, { recursive: true, force: true });
  } else {
    await unlink(target);
  }
  return { removed: true, backup };
}

/** The file's text, or `null` when it does not exist. Any other read error is thrown. */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}
