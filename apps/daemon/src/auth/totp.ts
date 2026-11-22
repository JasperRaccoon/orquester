/**
 * RFC 6238 time-based one-time passwords on `node:crypto` alone: HMAC-SHA1, 6 digits, 30-second
 * steps, the current step ±1 accepted. Secrets are 20 random bytes, carried as RFC 4648 base32
 * without padding (what authenticator apps take). No third-party code in the login check.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of the current one a code may come from (clock drift, a slow typist). */
const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 → bytes. Case, spaces and `=` padding are ignored; any other symbol throws. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) throw new Error("Not base32");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** A new authenticator secret (20 random bytes), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The 30-second step `atMs` falls in. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

function codeForStep(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(binary).padStart(TOTP_DIGITS, "0");
}

/**
 * The step `code` is valid for at `atMs` (current ±1), or null. Steps at or before `afterStep` are
 * never accepted (a code already used, replayed). Every candidate is computed and compared in
 * constant time; the latest matching step wins.
 */
export function matchTotp(secret: string, code: string, atMs: number, afterStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const given = Buffer.from(code, "utf8");
  const current = totpStep(atMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    if (step < 0) continue;
    const ok = timingSafeEqual(Buffer.from(codeForStep(key, step), "utf8"), given);
    if (ok && step > afterStep) matched = step;
  }
  return matched;
}

/**
 * What the enrollment QR code encodes:
 * `otpauth://totp/Orquester:<username>@<host>?secret=…&issuer=Orquester&algorithm=SHA1&digits=6&period=30`.
 * Without a username the account is just the host.
 */
export function otpauthUri(input: { secret: string; username: string; host: string }): string {
  const account = input.username ? `${input.username}@${input.host}` : input.host;
  const label = `${encodeURIComponent("Orquester")}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: "Orquester",
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
