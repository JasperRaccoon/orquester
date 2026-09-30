import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";

/** `FamilyWild`: the entry matches any host address. */
const FAMILY_WILD = 0xffff;
export const MIT_MAGIC_COOKIE = "MIT-MAGIC-COOKIE-1";
/** MIT-MAGIC-COOKIE-1 cookies are 16 bytes (what `xauth generate` writes). */
export const XAUTH_COOKIE_BYTES = 16;

/**
 * One `.Xauthority` entry in the binary format libXau reads: family (u16 BE),
 * then address, display number, auth name and auth data, each a u16 BE length
 * followed by the bytes. Written directly because `xauth` may not be installed.
 *
 * The desktop's single entry is `FamilyWild` with an empty address AND an empty
 * display number, so it matches whatever display `-displayfd` picks (libXau
 * treats an empty number as a wildcard); the X server loads every cookie in
 * its `-auth` file regardless of those fields.
 */
export function encodeXauthorityEntry(cookie: Buffer): Buffer {
  const field = (bytes: Buffer): Buffer => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD, 0);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from(MIT_MAGIC_COOKIE, "latin1")),
    field(cookie)
  ]);
}

/** Write a fresh random cookie to `path` (mode 0600, replacing any old file). */
export async function writeXauthority(path: string): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, encodeXauthorityEntry(randomBytes(XAUTH_COOKIE_BYTES)), { mode: 0o600 });
}
