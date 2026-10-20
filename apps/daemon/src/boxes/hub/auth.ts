/**
 * Box secrets the hub mints and checks (spec §5 "Authentication"). Bootstrap
 * tokens and box credentials are both `<boxId>.<32 random bytes, base64url>`:
 * the prefix names the record to check, so a bearer token alone authenticates
 * the agent-binary route. Only SHA-256 hex digests are stored
 * (`StoredBox.bootstrapTokenHash`, `StoredBox.credentialHash`), and they are
 * compared in constant time.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function mintBoxSecret(boxId: string): string {
  return `${boxId}.${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/** The box id a minted secret names; null when it is not one. */
export function boxIdOfSecret(secret: string): string | null {
  if (secret.length > 512) return null;
  const dot = secret.lastIndexOf(".");
  if (dot <= 0) return null;
  const boxId = secret.slice(0, dot);
  const random = secret.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(random) || !/^[A-Za-z0-9_-]{1,128}$/.test(boxId)) return null;
  return boxId;
}

/** Constant-time check of `secret` against a stored SHA-256 hex digest. */
export function secretMatches(secret: string, storedHash: string | undefined): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashSecret(secret), "hex"), Buffer.from(storedHash, "hex"));
}

/**
 * The `aud` claim of a JWT, read WITHOUT verifying it — only to pick which of
 * the daemon's audiences to verify against. Null when unreadable.
 */
export function unverifiedJwtAudience(jwt: string): string[] | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { aud?: unknown };
    if (typeof payload.aud === "string") return [payload.aud];
    if (Array.isArray(payload.aud) && payload.aud.every((a) => typeof a === "string")) return payload.aud as string[];
    return null;
  } catch {
    return null;
  }
}
