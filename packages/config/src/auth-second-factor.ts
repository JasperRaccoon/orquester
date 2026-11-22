// auth-second-factor.json — the remote login's second factor (authenticator codes + recovery codes).
//
//   <appdir>/daemon/auth-second-factor.json   (`authSecondFactorPath`, index.ts)
//
// This module imports only zod: the path helper lives in index.ts, which re-exports this file.
//
// `totp` present → the factor is on. `totp.secret` is the RFC 4648 base32 authenticator secret
// (the one value in the file that authenticates; the file is 0600), `lastUsedStep` the latest
// 30-second step a code was accepted for (no step at or before it is accepted again).
// `recoveryCodes` hold SHA-256 hex digests of the one-time recovery codes, never the codes.
// `lastFailedChallenge` is the latest correct-password-wrong-code attempt, until dismissed.
//
// Absent file → the factor is off (deleting it is the documented server-side reset). Unlike
// `auth-sessions.json`, a file that is not a readable version-1 file is NOT moved aside: the parse
// THROWS and the daemon treats the factor as on and unusable (fail closed).
//
// Tolerance (AGENTS.md): unknown top-level keys and unknown fields of `totp`, a recovery code or
// `lastFailedChallenge` are kept and written back unchanged; a recovery-code record that does not
// read is kept verbatim (`unreadableRecoveryCodes`) and never accepted.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

export const authTotpRecordSchema = z
  .object({
    /** RFC 4648 base32, no padding. */
    secret: z.string().regex(/^[A-Z2-7]{16,}$/),
    enabledAt: z.string(),
    /** Latest accepted 30-second step (`floor(unixSeconds / 30)`); -1 before any. */
    lastUsedStep: z.number().int().min(-1)
  })
  .passthrough();
export type AuthTotpRecord = z.infer<typeof authTotpRecordSchema>;

export const authRecoveryCodeRecordSchema = z
  .object({
    /** Lowercase hex SHA-256 of the normalised code. */
    digest: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .passthrough();
export type AuthRecoveryCodeRecord = z.infer<typeof authRecoveryCodeRecordSchema>;

export const authFailedChallengeRecordSchema = z
  .object({
    at: z.string(),
    ip: z.string().max(200)
  })
  .passthrough();
export type AuthFailedChallengeRecord = z.infer<typeof authFailedChallengeRecordSchema>;

export interface AuthSecondFactorFile {
  version: 1;
  totp?: AuthTotpRecord;
  recoveryCodes: AuthRecoveryCodeRecord[];
  /** Recovery-code records this build cannot read, kept verbatim and never accepted. */
  unreadableRecoveryCodes: unknown[];
  lastFailedChallenge?: AuthFailedChallengeRecord;
  /** Every top-level key this build does not know, exactly as found. */
  extra?: Record<string, unknown>;
}

export function createDefaultAuthSecondFactorFile(): AuthSecondFactorFile {
  return { version: 1, recoveryCodes: [], unreadableRecoveryCodes: [] };
}

const KNOWN_KEYS = new Set(["version", "totp", "recoveryCodes", "lastFailedChallenge"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read `auth-second-factor.json`. THROWS on anything that is not a version-1 file (not an object,
 * another `version`, a `totp` that does not read, `recoveryCodes` not a list): the caller must then
 * treat the factor as on and unusable. A `lastFailedChallenge` that does not read is dropped (it is
 * a notice, not a credential).
 */
export function parseAuthSecondFactorFile(raw: unknown): AuthSecondFactorFile {
  if (!isPlainRecord(raw)) throw new Error("Not a second-factor file (not an object)");
  if (raw.version !== 1) {
    throw new Error(`Not a version-1 second-factor file (version ${JSON.stringify(raw.version)})`);
  }
  let totp: AuthTotpRecord | undefined;
  if (raw.totp !== undefined) {
    const parsed = authTotpRecordSchema.safeParse(raw.totp);
    if (!parsed.success) throw new Error("Not a second-factor file (totp does not read)");
    totp = parsed.data;
  }
  if (raw.recoveryCodes !== undefined && !Array.isArray(raw.recoveryCodes)) {
    throw new Error("Not a second-factor file (recoveryCodes is not a list)");
  }
  const recoveryCodes: AuthRecoveryCodeRecord[] = [];
  const unreadableRecoveryCodes: unknown[] = [];
  const digests = new Set<string>();
  for (const entry of (raw.recoveryCodes as unknown[] | undefined) ?? []) {
    const parsed = authRecoveryCodeRecordSchema.safeParse(entry);
    if (parsed.success && !digests.has(parsed.data.digest)) {
      digests.add(parsed.data.digest);
      recoveryCodes.push(parsed.data);
    } else {
      unreadableRecoveryCodes.push(entry);
    }
  }
  const failed = authFailedChallengeRecordSchema.safeParse(raw.lastFailedChallenge);
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_KEYS.has(key)));
  return {
    version: 1,
    ...(totp ? { totp } : {}),
    recoveryCodes,
    unreadableRecoveryCodes,
    ...(failed.success ? { lastFailedChallenge: failed.data } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {})
  };
}

/** The file as written: unknown keys first, then the known ones; unreadable codes after the readable ones. */
export function serializeAuthSecondFactorFile(file: AuthSecondFactorFile): string {
  return JSON.stringify(
    {
      ...(file.extra ?? {}),
      version: 1,
      ...(file.totp ? { totp: file.totp } : {}),
      recoveryCodes: [...file.recoveryCodes, ...file.unreadableRecoveryCodes],
      ...(file.lastFailedChallenge ? { lastFailedChallenge: file.lastFailedChallenge } : {})
    },
    null,
    2
  );
}
