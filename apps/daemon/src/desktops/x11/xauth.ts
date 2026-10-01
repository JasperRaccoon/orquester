// Xauthority file format (read and written by libXau): repeated entries of a big-endian
// u16 family followed by address, display number, auth name and auth data, each a big-endian u16
// length plus bytes.

import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

import type { XAuthData } from "./protocol.ts";

export const MIT_MAGIC_COOKIE = "MIT-MAGIC-COOKIE-1";

export interface XauthEntry {
  family: number;
  address: Buffer;
  /** Display number as written (ASCII digits), or "" for any display. */
  number: string;
  name: string;
  data: Buffer;
}

export function parseXauthority(buf: Buffer): XauthEntry[] {
  const entries: XauthEntry[] = [];
  let offset = 0;
  const field = (): Buffer => {
    if (offset + 2 > buf.length) throw new Error("Xauthority entry is truncated");
    const length = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + length > buf.length) throw new Error("Xauthority entry is truncated");
    const value = Buffer.from(buf.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  while (offset < buf.length) {
    if (offset + 2 > buf.length) throw new Error("Xauthority entry is truncated");
    const family = buf.readUInt16BE(offset);
    offset += 2;
    const address = field();
    const number = field().toString("latin1");
    const name = field().toString("latin1");
    const data = field();
    entries.push({ family, address, number, name, data });
  }
  return entries;
}

/** The first MIT-MAGIC-COOKIE-1 entry for `display` (or for any display). */
export function findMitCookie(entries: readonly XauthEntry[], display: number): XAuthData | null {
  const entry = entries.find((e) => e.name === MIT_MAGIC_COOKIE && (e.number === "" || e.number === String(display)));
  return entry ? { name: entry.name, data: entry.data } : null;
}

export async function readXauthCookie(path: string, display: number): Promise<XAuthData | null> {
  return findMitCookie(parseXauthority(await readFile(path)), display);
}

/** One Xauthority entry (the daemon writes a single FamilyWild entry). Used by tests and host setup. */
export function encodeXauthEntry(entry: XauthEntry): Buffer {
  const parts: Buffer[] = [];
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n, 0);
    return b;
  };
  const field = (value: Buffer): void => {
    parts.push(u16(value.length), value);
  };
  parts.push(u16(entry.family));
  field(entry.address);
  field(Buffer.from(entry.number, "latin1"));
  field(Buffer.from(entry.name, "latin1"));
  field(entry.data);
  return Buffer.concat(parts);
}

/**
 * Replace the host's authority file with a fresh 16-byte MIT cookie (0600).
 * FamilyWild and an empty display number match whatever `-displayfd` picks.
 */
export async function writeXauthority(path: string): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, encodeXauthEntry({
    family: 0xffff,
    address: Buffer.alloc(0),
    number: "",
    name: MIT_MAGIC_COOKIE,
    data: randomBytes(16)
  }), { mode: 0o600 });
}
