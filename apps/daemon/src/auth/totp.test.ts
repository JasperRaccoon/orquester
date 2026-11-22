/**
 * TOTP (`auth/totp.ts`) against the RFC 6238 appendix B SHA-1 vectors (cut to 6 digits), the ±1
 * step window, replay refusal, base32 and the enrollment URI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { base32Decode, base32Encode, generateTotpSecret, matchTotp, otpauthUri } from "./totp.ts";

// RFC 6238's SHA-1 key: ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("the RFC 6238 SHA-1 vectors verify at their time and step", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  const vectors: Array<[seconds: number, code: string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"]
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(matchTotp(RFC_SECRET, code, seconds * 1000), Math.floor(seconds / 30), `T=${seconds}`);
  }
});

test("a code is accepted one step either side and no further; a used step is refused", () => {
  // 287082 is step 1 (seconds 30–59).
  assert.equal(matchTotp(RFC_SECRET, "287082", 0), 1, "one step early");
  assert.equal(matchTotp(RFC_SECRET, "287082", 89_000), 1, "one step late");
  assert.equal(matchTotp(RFC_SECRET, "287082", 90_000), null, "two steps late");
  assert.equal(matchTotp(RFC_SECRET, "287082", 59_000, 1), null, "its step was already used");
  assert.equal(matchTotp(RFC_SECRET, "287083", 59_000), null);
  assert.equal(matchTotp(RFC_SECRET, "28708", 59_000), null);
  assert.equal(matchTotp(RFC_SECRET, "2870820", 59_000), null);
});

test("base32 round-trips any bytes and a new secret is 20 bytes", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 6, 19, 20, 33]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
  assert.deepEqual(base32Decode("mzxw 6ytb oi======"), Buffer.from("foobar"), "RFC 4648 vector, any case and padding");
  assert.throws(() => base32Decode("MZXW1"));
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
  assert.notEqual(generateTotpSecret(), secret);
});

test("the otpauth URI names the server and encodes the account", () => {
  const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", username: "admin", host: "agents.example.io:8443" });
  assert.equal(uri, "otpauth://totp/Orquester:admin%40agents.example.io%3A8443?secret=JBSWY3DPEHPK3PXP&issuer=Orquester&algorithm=SHA1&digits=6&period=30");
  const odd = new URL(otpauthUri({ secret: "JBSWY3DPEHPK3PXP", username: "a b/c?", host: "h" }));
  assert.equal(decodeURIComponent(odd.pathname), "/Orquester:a b/c?@h");
  assert.equal(odd.searchParams.get("secret"), "JBSWY3DPEHPK3PXP");
});
