/**
 * Config sync — a minimal tar writer for bulk pushes (`tar-write` channels): regular files only
 * (POSIX ustar headers, a pax `path` record for names ustar cannot hold), each file's mode and
 * whole-second mtime, owner 0. Directories are not archived: the extracting `tar` creates the
 * parents of every entry itself, and sync creates empty ones on its own.
 *
 * The bytes come from each file's host realpath as it is when the packer reaches it; the header
 * names the size an `fstat` gave at open, and a file that shrinks meanwhile is padded with zeros
 * (its host hash then moves, so the next pass pushes it again). A file that cannot be opened is
 * left out of the archive and of {@link packTar}'s `written` map.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";

const BLOCK = 512;
const READ_CHUNK = 256 * 1024;

export interface TarFileEntry {
  /** POSIX path inside the archive (relative, plain names only). */
  name: string;
  /** Host file the bytes come from. */
  source: string;
  mode: number;
}

function octal(value: number, width: number): string {
  const digits = Math.max(0, Math.floor(value)).toString(8);
  if (digits.length > width - 1) throw new RangeError(`tar header field too small for ${value}`);
  return `${digits.padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mode: number, mtimeSec: number, type: "0" | "x"): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode & 0o7777, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(mtimeSec, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest);
}

/** A pax record `"<len> <key>=<value>\n"`, `len` counting the whole record. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body);
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
  return Buffer.from(`${length}${body}`, "utf8");
}

/** The header block(s) of one file: a pax extended header first when ustar cannot hold its name. */
export function fileHeader(name: string, size: number, mode: number, mtimeMs: number): Buffer {
  const mtime = Math.floor(mtimeMs / 1000);
  if (/^[\x20-\x7e]*$/.test(name) && name.length <= 100) return header(name, size, mode, mtime, "0");
  const records = paxRecord("path", name);
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").slice(-100);
  return Buffer.concat([header("PaxHeader", records.length, 0o644, mtime, "x"), records, padding(records.length), header(fallback, size, mode, mtime, "0")]);
}

/**
 * The archive of `entries`, as chunks. `written` gets each archived entry's byte count (by
 * name); `onEntry` runs after each entry's bytes were handed on.
 */
export async function* packTar(
  entries: readonly TarFileEntry[],
  written: Map<string, number>,
  onEntry?: (name: string) => void
): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    let handle;
    try {
      handle = await open(entry.source, constants.O_RDONLY);
    } catch {
      continue; // removed (or unreadable) since the walk: the next pass looks again
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) continue;
      const size = info.size;
      yield fileHeader(entry.name, size, entry.mode, info.mtimeMs);
      let left = size;
      while (left > 0) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, left));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) {
          yield Buffer.alloc(left);
          break;
        }
        yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        left -= bytesRead;
      }
      yield padding(size);
      written.set(entry.name, size);
    } finally {
      await handle.close();
    }
    onEntry?.(entry.name);
  }
  yield Buffer.alloc(BLOCK * 2);
}
