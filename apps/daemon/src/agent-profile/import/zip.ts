/**
 * Agent profile imports — extracting an uploaded `.zip` (spec §6) with
 * `yauzl`, refusing the whole archive on any entry that could land outside
 * the destination or is not a plain file or directory:
 *
 * - absolute paths, drive letters, `..` segments, NUL (yauzl's own
 *   `validateFileName` runs first; backslashes are read as `/`);
 * - symlinks (unix mode `0o120000` in the external attributes), encrypted
 *   entries;
 * - more than `maxEntries` entries, or more than `maxBytes` uncompressed —
 *   counted from the declared sizes AND from the bytes actually inflated, so
 *   a lying header is caught too.
 *
 * Files are created with `wx` (never overwriting, never through a link — the
 * tree holds none) and mode 0644, or 0755 when the entry was executable.
 * `__MACOSX/` resource-fork entries are skipped. On a refusal the caller
 * removes the destination.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { isAgentProfileError, profileErrors } from "../errors.ts";

export interface ZipLimits {
  maxEntries: number;
  maxBytes: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function refuse(message: string): never {
  throw profileErrors.importFailed(`The zip file was refused: ${message}`);
}

/** The entry's path segments; throws on anything that is not a plain relative path. */
export function zipEntrySegments(fileName: string): string[] {
  if (fileName.includes("\0") || fileName.includes("\\")) refuse(`"${fileName.replaceAll("\0", "\\0")}" has an invalid name.`);
  if (fileName.startsWith("/") || /^[A-Za-z]:/.test(fileName)) refuse(`"${fileName}" is an absolute path.`);
  const segments = fileName.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === ".." || segment === ".")) refuse(`"${fileName}" leaves the archive's folder.`);
  return segments;
}

/** Extracts `file` into the existing, empty directory `dest`. */
export async function extractZip(file: string, dest: string, limits: ZipLimits): Promise<{ files: number }> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(file, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    });
  } catch (error) {
    throw profileErrors.importFailed(`The upload is not a readable zip file (${(error as Error).message}).`);
  }
  try {
    if (zip.entryCount > limits.maxEntries) refuse(`it has more than ${limits.maxEntries} entries.`);
    let entries = 0;
    let declared = 0;
    let inflated = 0;
    let files = 0;
    for await (const entry of zip.eachEntry()) {
      entries += 1;
      if (entries > limits.maxEntries) refuse(`it has more than ${limits.maxEntries} entries.`);
      const segments = zipEntrySegments(entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0o177777;
      const type = mode & S_IFMT;
      if (type === S_IFLNK) refuse(`"${entry.fileName}" is a symlink.`);
      const isDir = entry.fileName.endsWith("/") || type === S_IFDIR;
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) refuse(`"${entry.fileName}" is not a file or folder.`);
      if (entry.isEncrypted()) refuse(`"${entry.fileName}" is encrypted.`);
      if (segments.length === 0 || segments[0] === "__MACOSX") continue;
      if (isDir) {
        await makeDir(join(dest, ...segments), entry.fileName);
        continue;
      }
      declared += entry.uncompressedSize;
      if (declared > limits.maxBytes) refuse(`it holds more than ${limits.maxBytes} bytes uncompressed.`);
      await makeDir(join(dest, ...segments.slice(0, -1)), entry.fileName);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          inflated += chunk.length;
          if (inflated > limits.maxBytes) {
            callback(profileErrors.importFailed(`The zip file was refused: it holds more than ${limits.maxBytes} bytes uncompressed.`));
          } else {
            callback(null, chunk);
          }
        }
      });
      const out = createWriteStream(join(dest, ...segments), { flags: "wx", mode: mode & 0o111 ? 0o755 : 0o644 });
      await pipeline(await zip.openReadStreamPromise(entry), counter, out);
      files += 1;
    }
    return { files };
  } catch (error) {
    if (isAgentProfileError(error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") refuse("two entries share one path.");
    throw profileErrors.importFailed(`The zip file could not be extracted (${(error as Error).message}).`);
  } finally {
    zip.close();
  }
}

async function makeDir(path: string, shown: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o755 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") refuse(`"${shown}" clashes with a file of the same name.`);
    throw error;
  }
}
