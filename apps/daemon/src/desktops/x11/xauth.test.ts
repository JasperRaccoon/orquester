import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { encodeXauthEntry, findMitCookie, MIT_MAGIC_COOKIE, parseXauthority, readXauthCookie, writeXauthority } from "./xauth.ts";

const hex = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ""), "hex");
const cookie = hex("00112233445566778899aabbccddeeff");

test("parses the single FamilyWild entry the daemon writes", () => {
  // family 0xffff, address "", number "", name "MIT-MAGIC-COOKIE-1", 16-byte data — all lengths big-endian.
  const file = hex(`ffff 0000 0000 0012 4d49542d4d414749432d434f4f4b49452d31 0010 00112233445566778899aabbccddeeff`);
  const entries = parseXauthority(file);
  assert.deepEqual(entries, [{ family: 0xffff, address: Buffer.alloc(0), number: "", name: MIT_MAGIC_COOKIE, data: cookie }]);
  assert.deepEqual(encodeXauthEntry(entries[0]!), file);
  assert.deepEqual(findMitCookie(entries, 7), { name: MIT_MAGIC_COOKIE, data: cookie });
});

test("picks the first MIT cookie whose number is empty or the display", () => {
  const other = hex("ffffffffffffffffffffffffffffffff");
  const file = Buffer.concat([
    encodeXauthEntry({ family: 0x100, address: Buffer.from("host"), number: "3", name: MIT_MAGIC_COOKIE, data: other }),
    encodeXauthEntry({ family: 0x100, address: Buffer.from("host"), number: "5", name: "XDM-AUTHORIZATION-1", data: other }),
    encodeXauthEntry({ family: 0x100, address: Buffer.from("host"), number: "5", name: MIT_MAGIC_COOKIE, data: cookie })
  ]);
  const entries = parseXauthority(file);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.address.toString(), "host");
  assert.deepEqual(findMitCookie(entries, 5)?.data, cookie);
  assert.deepEqual(findMitCookie(entries, 3)?.data, other);
  assert.equal(findMitCookie(entries, 9), null);
});

test("rejects a truncated file and accepts an empty one", () => {
  assert.deepEqual(parseXauthority(Buffer.alloc(0)), []);
  assert.throws(() => parseXauthority(hex("ffff 0000 0000 0012 4d49")), /truncated/);
  assert.throws(() => parseXauthority(hex("ff")), /truncated/);
});

test("replaces the authority file with a private wildcard cookie readable on any display", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-xauth-"));
  try {
    const path = join(dir, "Xauthority");
    await writeFile(path, "old authority file", { mode: 0o644 });
    await writeXauthority(path);
    const bytes = await readFile(path);
    const header = hex("ffff 0000 0000 0012 4d49542d4d414749432d434f4f4b49452d31 0010");
    assert.deepEqual(bytes.subarray(0, header.length), header);
    assert.equal(bytes.length, header.length + 16);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readXauthCookie(path, 12), { name: MIT_MAGIC_COOKIE, data: bytes.subarray(header.length) });
    await writeXauthority(path);
    assert.notDeepEqual(await readFile(path), bytes, "each host start gets a new cookie");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
