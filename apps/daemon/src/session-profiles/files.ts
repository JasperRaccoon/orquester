/**
 * Agent Profiles — the file helpers the imports, the plugin flow and the export share:
 *
 * - {@link measureTree}: walks a tree WITHOUT following a symlink and refuses one (and any
 *   socket, FIFO or device), and refuses a tree past its file or byte cap — run before anything
 *   is copied into a profile;
 * - {@link normalizeProfileModes}: a copied tree's directories 0700 and files 0600 (0700 when the
 *   source was executable: a plugin's hook script must still run) — the profile layout's modes;
 * - {@link buildZip}: an in-memory `.zip` writer (deflate, UTF-8 names, unix modes) for the
 *   export; `agent-profile/import/zip.ts` reads it back with the importer's safety rules.
 */

import { crc32, deflateRawSync } from "node:zlib";
import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sessionProfileErrors as errors } from "./errors.ts";
import { PROFILE_DIR_MODE, PROFILE_FILE_MODE } from "./layout.ts";

export interface TreeCaps {
  maxFiles: number;
  maxBytes: number;
}

/** What a skill copied into a profile may hold. */
export const SKILL_TREE_CAPS: TreeCaps = { maxFiles: 2000, maxBytes: 50 * 1024 * 1024 };
/** What a plugin copied into a profile's plugin cache may hold. */
export const PLUGIN_TREE_CAPS: TreeCaps = { maxFiles: 20_000, maxBytes: 200 * 1024 * 1024 };

/**
 * The files and bytes under `root` (a file or a directory, itself `lstat`ed — never followed).
 * Throws 400 `INVALID_ITEM` naming `label` and the first symlink or special file, or the cap
 * passed.
 */
export async function measureTree(root: string, caps: TreeCaps, label: string): Promise<{ files: number; bytes: number }> {
  const totals = { files: 0, bytes: 0 };
  const visit = async (path: string, rel: string): Promise<void> => {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw errors.invalidItem(`${label}: "${rel || "."}" is a symlink; symlinks are not copied into a profile.`);
    if (st.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), rel === "" ? name : `${rel}/${name}`);
      return;
    }
    if (!st.isFile()) throw errors.invalidItem(`${label}: "${rel || "."}" is not a file or folder.`);
    totals.files += 1;
    totals.bytes += st.size;
    if (totals.files > caps.maxFiles) throw errors.invalidItem(`${label} holds more than ${caps.maxFiles} files.`);
    if (totals.bytes > caps.maxBytes) throw errors.invalidItem(`${label} is larger than ${Math.round(caps.maxBytes / 1024 / 1024)} MB.`);
  };
  await visit(root, "");
  return totals;
}

/** Directories 0700, files 0600 — 0700 when any execute bit was set. Never follows a symlink (there are none: see {@link measureTree}). */
export async function normalizeProfileModes(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await chmod(path, PROFILE_DIR_MODE);
    for (const name of await readdir(path)) await normalizeProfileModes(join(path, name));
    return;
  }
  if (st.isFile()) await chmod(path, st.mode & 0o111 ? PROFILE_DIR_MODE : PROFILE_FILE_MODE);
}

/** One file of a zip: a `/`-separated relative path, its bytes, its unix mode bits. */
export interface ZipEntry {
  path: string;
  data: Buffer;
  mode: number;
}

/** MS-DOS time and date of `when` (local time, 2-second resolution; 1980 at the earliest). */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  };
}

/** A `.zip` of `entries` (deflated; stored when that is not smaller). Regular files only; parents are implied. */
export function buildZip(entries: readonly ZipEntry[], when: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100000 | (entry.mode & 0o777)) << 16) >>> 0, 38); // a regular file
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
