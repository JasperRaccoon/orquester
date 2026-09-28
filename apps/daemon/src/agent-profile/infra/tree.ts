/**
 * Agent profile — copying and moving files and directory trees without ever
 * following a symlink inside them. Backups and the stash copy symlinks as
 * symlinks (the item comes back byte for byte); imports refuse or skip them
 * (a cloned repo's link could point anywhere on the host).
 */

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { profileErrors } from "../errors.ts";

/** What `lstat` says a path is; `other` is a socket, FIFO or device. */
export type PathKind = "file" | "dir" | "symlink" | "other";

/** What `lstat` says `path` is — a symlink is never followed — or `null` when nothing is there. */
export async function pathKind(path: string): Promise<PathKind | null> {
  let st: Stats;
  try {
    st = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  return kindOf(st);
}

function kindOf(st: Stats): PathKind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

/** ENOENT, or ENOTDIR (a path component is a file): both mean "nothing there". */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** How a copy treats a symlink it meets inside the tree. */
export type SymlinkPolicy = "preserve" | "skip" | "refuse";

export interface CopyEntryOptions {
  symlinks: SymlinkPolicy;
  /** Follow `src` itself when it is a symlink (its contents are still never followed). */
  followRoot?: boolean;
  /** fsync every copied file before it is considered done (a move across filesystems). */
  fsync?: boolean;
}

export interface CopyResult {
  /** Regular files copied. */
  files: number;
  /** Paths relative to the source root that were left out: skipped symlinks, sockets, FIFOs, devices. */
  skipped: string[];
}

/**
 * Copies the file, directory or symlink at `src` to `dest`, which must not
 * exist. Modes are kept; timestamps are not. Special files are skipped. On a
 * refused symlink it throws `IMPORT_FAILED` and leaves whatever it had copied —
 * {@link copyTree} cleans up; internal callers copy into a temp path.
 */
export async function copyEntry(src: string, dest: string, options: CopyEntryOptions): Promise<CopyResult> {
  const result: CopyResult = { files: 0, skipped: [] };
  const st = options.followRoot ? await stat(src) : await lstat(src);
  await copyNode(src, dest, "", st, options, result);
  return result;
}

async function copyNode(
  src: string,
  dest: string,
  rel: string,
  st: Stats,
  options: CopyEntryOptions,
  result: CopyResult
): Promise<void> {
  const shown = rel === "" ? basename(src) : rel;
  if (st.isSymbolicLink()) {
    if (options.symlinks === "preserve") {
      await symlink(await readlink(src), dest);
    } else if (options.symlinks === "skip") {
      result.skipped.push(shown);
    } else {
      throw profileErrors.importFailed(`"${shown}" is a symlink; symlinks are not imported.`);
    }
    return;
  }
  if (st.isDirectory()) {
    // Owner-writable while filling it: a 0555 source directory would refuse its own children.
    await mkdir(dest, { mode: 0o700 });
    for (const name of (await readdir(src)).sort()) {
      const child = join(src, name);
      await copyNode(child, join(dest, name), rel === "" ? name : `${rel}/${name}`, await lstat(child), options, result);
    }
    await chmod(dest, st.mode & 0o777);
    return;
  }
  if (st.isFile()) {
    await copyFile(src, dest, constants.COPYFILE_EXCL);
    if (options.fsync) {
      await fsyncFile(dest);
    }
    await chmod(dest, st.mode & 0o777);
    result.files += 1;
    return;
  }
  result.skipped.push(shown);
}

/** Best effort: a file the owner cannot read (mode 0200) is left to the kernel's own flush. */
async function fsyncFile(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Copies a skill directory (or one file) from `src` to `dest` for an import
 * or a copy between agents. `src` itself may be a symlink — the host symlinks
 * skill directories — and is followed; a symlink INSIDE it is refused
 * (`IMPORT_FAILED`, nothing left at `dest`) or skipped (listed in `skipped`),
 * per `refuseSymlinks`. `dest` must not exist; its parent is created.
 */
export async function copyTree(src: string, dest: string, options: { refuseSymlinks: boolean }): Promise<CopyResult> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    return await copyEntry(src, dest, { symlinks: options.refuseSymlinks ? "refuse" : "skip", followRoot: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Moves `src` (a file, directory or symlink — never followed) to `dest`, which
 * must not exist: a rename on the same filesystem; across filesystems a copy
 * into a temp sibling of `dest` (symlinks preserved, files fsynced), a rename
 * into place, then the source removed.
 */
export async function moveEntry(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
  }
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomUUID()}.tmp`);
  try {
    await copyEntry(src, tmp, { symlinks: "preserve", fsync: true });
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rm(src, { recursive: true, force: true });
}
