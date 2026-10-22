// auth-sessions.json — the remote transport's revocable login sessions and API tokens.
//
//   <appdir>/daemon/auth-sessions.json   (`authSessionsPath`, index.ts)
//
// This module imports only zod: the path helper lives in index.ts, which re-exports this file.
//
// A record holds the SHA-256 digest of its bearer token, never the token. `device` records come
// from a password login and expire after an idle window (`expiresAt` slides with use); `api`
// records are named tokens for external clients and have no `expiresAt` (they last until
// revoked). `passwordFingerprint` is a digest of the bcrypt hash the device sessions were issued
// under: when the password changes, the daemon revokes every device session.
//
// Tolerance (AGENTS.md): unknown top-level keys and unknown fields of a record are kept and written
// back unchanged; a record that does not read (or has a kind this build does not know) is kept
// verbatim (`unreadableSessions`) and never accepted as a bearer. Anything that is not a version-1
// file THROWS, so the daemon moves it aside and starts with no sessions (fail closed).
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

/** `device`: a password login (sliding idle expiry). `api`: a named token (no expiry). */
export type AuthSessionKind = "device" | "api";

export const authSessionRecordSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().max(500),
    kind: z.enum(["device", "api"]),
    /** Lowercase hex SHA-256 of the bearer token. */
    tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    /** Device sessions only; an API token never expires until revoked. */
    expiresAt: z.string().optional()
  })
  .passthrough();
export type AuthSessionRecord = z.infer<typeof authSessionRecordSchema>;

export interface AuthSessionsFile {
  version: 1;
  /** Digest of the password hash the device sessions belong to; absent until first recorded. */
  passwordFingerprint?: string;
  sessions: AuthSessionRecord[];
  /** Records this build cannot read, kept verbatim and never honoured. */
  unreadableSessions: unknown[];
  /** Every top-level key this build does not know, exactly as found. */
  extra?: Record<string, unknown>;
}

export function createDefaultAuthSessionsFile(): AuthSessionsFile {
  return { version: 1, sessions: [], unreadableSessions: [] };
}

const KNOWN_KEYS = new Set(["version", "passwordFingerprint", "sessions"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read `auth-sessions.json`. Tolerant of what another build of the same version wrote; THROWS on
 * anything that is not a version-1 file (not an object, another `version`, `sessions` not a list).
 * A record whose id or token digest repeats an earlier one is kept but never honoured.
 */
export function parseAuthSessionsFile(raw: unknown): AuthSessionsFile {
  if (!isPlainRecord(raw)) throw new Error("Not an auth-sessions file (not an object)");
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`Not a version-1 auth-sessions file (version ${JSON.stringify(raw.version)})`);
  }
  if (raw.sessions !== undefined && !Array.isArray(raw.sessions)) {
    throw new Error("Not an auth-sessions file (sessions is not a list)");
  }
  const sessions: AuthSessionRecord[] = [];
  const unreadableSessions: unknown[] = [];
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const entry of (raw.sessions as unknown[] | undefined) ?? []) {
    const parsed = authSessionRecordSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id) && !digests.has(parsed.data.tokenDigest)) {
      ids.add(parsed.data.id);
      digests.add(parsed.data.tokenDigest);
      sessions.push(parsed.data);
    } else {
      unreadableSessions.push(entry);
    }
  }
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_KEYS.has(key)));
  return {
    version: 1,
    ...(typeof raw.passwordFingerprint === "string" ? { passwordFingerprint: raw.passwordFingerprint } : {}),
    sessions,
    unreadableSessions,
    ...(Object.keys(extra).length > 0 ? { extra } : {})
  };
}

/** The file as written: unknown keys first, then the known ones; unreadable records after the readable ones. */
export function serializeAuthSessionsFile(file: AuthSessionsFile): string {
  return JSON.stringify(
    {
      ...(file.extra ?? {}),
      version: 1,
      ...(file.passwordFingerprint !== undefined ? { passwordFingerprint: file.passwordFingerprint } : {}),
      sessions: [...file.sessions, ...file.unreadableSessions]
    },
    null,
    2
  );
}
