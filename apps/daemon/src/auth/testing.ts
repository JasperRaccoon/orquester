/**
 * Route tests: an in-memory session store holding one live device session, and its bearer. Hand
 * `authSessions` to `createServer`'s services and send `bearer` as the `Authorization` header (or
 * `token` as `?token=`).
 */

import { createHmac } from "node:crypto";

import { AuthSessionStore } from "./sessions.ts";

export async function testAuthSessions(): Promise<{ authSessions: AuthSessionStore; token: string; bearer: string }> {
  const authSessions = new AuthSessionStore();
  const { token } = await authSessions.create("device", "route test");
  return { authSessions, token, bearer: `Bearer ${token}` };
}

/**
 * The 6-digit authenticator code for a base32 `secret` at `atMs`, computed here from RFC 6238
 * independently of `totp.ts` (what an authenticator app on the phone would show).
 */
export function authenticatorCode(secret: string, atMs: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.toUpperCase()].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[19]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
