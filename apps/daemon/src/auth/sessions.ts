/**
 * The remote transport's revocable credentials, `auth-sessions.json` (`@orquester/config`).
 *
 * - A password login mints a DEVICE session; Settings → Server mints named API tokens. A token is
 *   `orq_` + 32 random bytes; only its SHA-256 digest is stored, so the file (or a backup of it)
 *   never authenticates anyone.
 * - Device sessions lapse after {@link DEVICE_SESSION_IDLE_MS} without use (the expiry slides on
 *   every use); API tokens last until revoked.
 * - A use stamps `lastUsedAt` in memory at once and on disk at most every
 *   {@link LAST_USED_PERSIST_MS} per session, so a busy client does not rewrite the file per request.
 * - The device sessions belong to one password: {@link AuthSessionStore.syncPassword} revokes them
 *   all when the stored hash changes, whichever way it changed (the config route, a hand edit, the
 *   deploy script's rotation).
 *
 * The durability model of `agent-tools/service.ts`: atomic 0600 writes, serialized; a file this
 * build cannot parse is moved aside and no session is honoured (fail closed); a file that cannot be
 * read makes the store read-only for this run, so nothing is written over it and no login succeeds.
 * Whatever the file holds that this build does not know is written back verbatim.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rename } from "node:fs/promises";

import { AUTH_SESSION_LABEL_MAX, AUTH_TOKEN_PREFIX, isAuthTokenShape, type AuthSessionKind, type AuthSessionSummary } from "@orquester/api";
import {
  createDefaultAuthSessionsFile,
  parseAuthSessionsFile,
  serializeAuthSessionsFile,
  type AuthSessionRecord,
  type AuthSessionsFile
} from "@orquester/config";

import { writeFileAtomic } from "../agent-hooks.ts";

/** A device session lapses after this long without a request. */
export const DEVICE_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** `lastUsedAt` reaches the disk at most this often per session. */
export const LAST_USED_PERSIST_MS = 5 * 60 * 1000;

/** The store refuses to mint while it is read-only (its file could not be read). */
export class AuthSessionsUnavailableError extends Error {
  constructor() {
    super("Sign-in is unavailable until auth-sessions.json is readable and Orquester restarts.");
    this.name = "AuthSessionsUnavailableError";
  }
}

/**
 * A login checked against a password hash the device sessions are no longer bound to: the
 * password changed while the check ran, so it must not mint a session.
 */
export class StalePasswordError extends Error {
  constructor() {
    super("The password changed while signing in. Sign in again.");
    this.name = "StalePasswordError";
  }
}

export interface AuthSessionStoreOptions {
  /** Absent: memory only (route tests). */
  file?: string;
  now?: () => number;
  logger?: Pick<Console, "warn" | "error">;
}

/** A verified bearer: the session it belongs to. */
export interface VerifiedAuthSession {
  id: string;
  kind: AuthSessionKind;
}

/** SHA-256 of a token: the only form of it the store keeps (as hex on disk). */
function digestOf(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Digest of the bcrypt hash the device sessions were issued under (never the hash itself). */
function fingerprintOf(passwordHash: string | undefined): string {
  return createHash("sha256").update(`orquester-auth-password\u0000${passwordHash ?? ""}`).digest("hex");
}

/** A label as stored: single line, trimmed, capped. */
export function cleanLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, AUTH_SESSION_LABEL_MAX);
}

/** A short device label from a user agent ("Chrome on macOS"), or a generic one. */
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const app = /\bElectron\//.test(ua)
    ? "Orquester desktop"
    : /\bEdg\//.test(ua)
      ? "Edge"
      : /\bFirefox\//.test(ua)
        ? "Firefox"
        : /\b(Chrome|CriOS)\//.test(ua)
          ? "Chrome"
          : /\bSafari\//.test(ua)
            ? "Safari"
            : null;
  const os = /\biPhone\b/.test(ua)
    ? "iPhone"
    : /\biPad\b/.test(ua)
      ? "iPad"
      : /\bAndroid\b/.test(ua)
        ? "Android"
        : /\bMac OS X\b|\bMacintosh\b/.test(ua)
          ? "macOS"
          : /\bWindows\b/.test(ua)
            ? "Windows"
            : /\bLinux\b/.test(ua)
              ? "Linux"
              : null;
  if (app && os) return `${app} on ${os}`;
  return app ?? os ?? (ua ? cleanLabel(ua, "Unknown device") : "Unknown device");
}

export class AuthSessionStore {
  private state: AuthSessionsFile = createDefaultAuthSessionsFile();
  private readOnly = false;
  private writes: Promise<void> = Promise.resolve();
  /** Session id → the `lastUsedAt` (ms) last written to disk. */
  private readonly persistedUse = new Map<string, number>();
  private readonly revokeListeners = new Set<(ids: string[]) => void>();

  constructor(private readonly opts: AuthSessionStoreOptions = {}) {}

  // -------------------------------------------------------------------------
  // Load / persist
  // -------------------------------------------------------------------------

  /** Read the file. Missing → no sessions. Never throws. Drops lapsed device sessions. */
  async load(): Promise<void> {
    this.state = createDefaultAuthSessionsFile();
    this.readOnly = false;
    this.persistedUse.clear();
    if (!this.opts.file) return;
    let text: string;
    try {
      text = await readFile(this.opts.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.readOnly = true;
      this.opts.logger?.error(`auth-sessions.json could not be read (${code ?? "unknown error"}); no remote session is honoured and sign-in is refused until it is fixed and the daemon restarts.`);
      return;
    }
    try {
      this.state = parseAuthSessionsFile(JSON.parse(text));
    } catch (error) {
      await this.quarantine(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.state.unreadableSessions.length > 0) {
      this.opts.logger?.warn(`auth-sessions.json: ${this.state.unreadableSessions.length} record(s) this build cannot read are never honoured; they stay in the file.`);
    }
    for (const session of this.state.sessions) this.persistedUse.set(session.id, Date.parse(session.lastUsedAt) || 0);
    if (this.pruneLapsed()) void this.persist();
  }

  private async quarantine(detail: string): Promise<void> {
    const file = this.opts.file!;
    const aside = `${file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(file, aside);
      this.opts.logger?.warn(`auth-sessions.json is corrupt (${detail}); moved it to ${aside}. Every remote client signs in again.`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.readOnly = true;
      this.opts.logger?.error(`auth-sessions.json is corrupt (${detail}) and could not be moved aside (${code ?? "unknown error"}); sign-in is refused until it is fixed and the daemon restarts.`);
    }
    this.state = createDefaultAuthSessionsFile();
  }

  /** Wait for every queued write. */
  flush(): Promise<void> {
    return this.writes;
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.readOnly || !this.opts.file) return;
      try {
        // Always 0600: digests are not bearers, but the file says who signed in from where and when.
        await writeFileAtomic(this.opts.file, `${serializeAuthSessionsFile(this.state)}\n`, 0o600, false);
      } catch (error) {
        this.opts.logger?.error("Failed to persist auth-sessions.json", error instanceof Error ? error.name : typeof error);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Drop device sessions past their expiry. True when any was dropped. */
  private pruneLapsed(): boolean {
    const now = this.now();
    const kept = this.state.sessions.filter((session) => !this.lapsed(session, now));
    if (kept.length === this.state.sessions.length) return false;
    for (const session of this.state.sessions) if (!kept.includes(session)) this.persistedUse.delete(session.id);
    this.state = { ...this.state, sessions: kept };
    return true;
  }

  private lapsed(session: AuthSessionRecord, now: number): boolean {
    if (session.kind !== "device") return false;
    // A device record without a readable expiry is treated as lapsed (fail closed).
    const expiresAt = session.expiresAt === undefined ? NaN : Date.parse(session.expiresAt);
    return !(expiresAt > now);
  }

  // -------------------------------------------------------------------------
  // Password binding
  // -------------------------------------------------------------------------

  /**
   * Bind the device sessions to `passwordHash`: the first call records it; a later different hash
   * revokes every device session (API tokens stay). Returns how many were revoked.
   */
  async syncPassword(passwordHash: string | undefined): Promise<number> {
    if (this.readOnly) return 0;
    const fingerprint = fingerprintOf(passwordHash);
    if (this.state.passwordFingerprint === fingerprint) return 0;
    const first = this.state.passwordFingerprint === undefined;
    this.state = { ...this.state, passwordFingerprint: fingerprint };
    const revoked = first ? [] : this.removeWhere((session) => session.kind === "device");
    await this.persist();
    this.announce(revoked);
    return revoked.length;
  }

  // -------------------------------------------------------------------------
  // Mint / verify
  // -------------------------------------------------------------------------

  /**
   * Mint a token. The token is returned once; only its digest is kept. `checkedHash`: the password
   * hash a login verified against. When the device sessions are already bound to another one (the
   * password changed while bcrypt ran), nothing is minted ({@link StalePasswordError}); when the
   * change is still on its way, the session is minted and that change's sync revokes it.
   */
  async create(
    kind: AuthSessionKind,
    label: string,
    checkedHash?: string
  ): Promise<{ token: string; session: AuthSessionSummary }> {
    if (this.readOnly) throw new AuthSessionsUnavailableError();
    if (
      checkedHash !== undefined &&
      this.state.passwordFingerprint !== undefined &&
      this.state.passwordFingerprint !== fingerprintOf(checkedHash)
    ) {
      throw new StalePasswordError();
    }
    const token = `${AUTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    const stamp = new Date(now).toISOString();
    const record: AuthSessionRecord = {
      id: randomUUID(),
      label: cleanLabel(label, kind === "api" ? "API token" : "Unknown device"),
      kind,
      tokenDigest: digestOf(token).toString("hex"),
      createdAt: stamp,
      lastUsedAt: stamp,
      ...(kind === "device" ? { expiresAt: new Date(now + DEVICE_SESSION_IDLE_MS).toISOString() } : {})
    };
    this.pruneLapsed();
    this.state = { ...this.state, sessions: [...this.state.sessions, record] };
    this.persistedUse.set(record.id, now);
    await this.persist();
    return { token, session: this.summary(record, record.id) };
  }

  /**
   * The live session `token` belongs to, or null. The digest is compared against EVERY record in
   * constant time (no early exit), so the answer's timing does not depend on which record matched.
   * `touch` (the default) stamps the use and slides a device session's expiry.
   */
  verify(token: string | undefined, touch = true): VerifiedAuthSession | null {
    if (this.readOnly || !isAuthTokenShape(token)) return null;
    const digest = digestOf(token);
    let match: AuthSessionRecord | null = null;
    for (const session of this.state.sessions) {
      const stored = Buffer.from(session.tokenDigest, "hex");
      if (stored.length === digest.length && timingSafeEqual(stored, digest)) match = session;
    }
    if (!match) return null;
    const now = this.now();
    if (this.lapsed(match, now)) {
      if (this.pruneLapsed()) void this.persist();
      return null;
    }
    if (touch) this.touch(match, now);
    return { id: match.id, kind: match.kind };
  }

  private touch(session: AuthSessionRecord, now: number): void {
    const updated: AuthSessionRecord = {
      ...session,
      lastUsedAt: new Date(now).toISOString(),
      ...(session.kind === "device" ? { expiresAt: new Date(now + DEVICE_SESSION_IDLE_MS).toISOString() } : {})
    };
    this.state = { ...this.state, sessions: this.state.sessions.map((entry) => (entry === session ? updated : entry)) };
    if (now - (this.persistedUse.get(session.id) ?? 0) >= LAST_USED_PERSIST_MS) {
      this.persistedUse.set(session.id, now);
      void this.persist();
    }
  }

  // -------------------------------------------------------------------------
  // List / revoke
  // -------------------------------------------------------------------------

  /** Live sessions, the current one first, then most recently used. */
  list(currentId: string | null): AuthSessionSummary[] {
    const now = this.now();
    return this.state.sessions
      .filter((session) => !this.lapsed(session, now))
      .map((session) => this.summary(session, currentId))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /** Revoke one session or API token. False when there is none with that id. */
  async revoke(id: string): Promise<boolean> {
    const revoked = this.removeWhere((session) => session.id === id);
    if (revoked.length === 0) return false;
    await this.persist();
    this.announce(revoked);
    return true;
  }

  /** Revoke every session and API token except `keepId` (none kept when null). */
  async revokeAllExcept(keepId: string | null): Promise<number> {
    const revoked = this.removeWhere((session) => session.id !== keepId);
    if (revoked.length > 0) {
      await this.persist();
      this.announce(revoked);
    }
    return revoked.length;
  }

  /** Called with the revoked ids after each revocation (to close their open streams). */
  onRevoked(listener: (ids: string[]) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  private removeWhere(predicate: (session: AuthSessionRecord) => boolean): string[] {
    if (this.readOnly) return [];
    const removed = this.state.sessions.filter(predicate).map((session) => session.id);
    if (removed.length === 0) return [];
    this.state = { ...this.state, sessions: this.state.sessions.filter((session) => !predicate(session)) };
    for (const id of removed) this.persistedUse.delete(id);
    return removed;
  }

  private announce(ids: string[]): void {
    if (ids.length === 0) return;
    for (const listener of this.revokeListeners) {
      try {
        listener(ids);
      } catch (error) {
        this.opts.logger?.warn("auth-sessions: revoke listener failed", error instanceof Error ? error.message : String(error));
      }
    }
  }

  private summary(session: AuthSessionRecord, currentId: string | null): AuthSessionSummary {
    return {
      id: session.id,
      label: session.label,
      kind: session.kind,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.kind === "device" ? (session.expiresAt ?? null) : null,
      current: session.id === currentId
    };
  }
}
