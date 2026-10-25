/**
 * Agent host — the thread-scoped session-tool credentials (design §1.2).
 *
 * Every provider session that reaches the loopback endpoint (Codex, Grok,
 * OpenCode) is issued a fresh random credential: 32 bytes, base64url. The
 * host keeps only its SHA-256 → `{threadId, grantId}`; the raw value leaves
 * this module once, to the adapter, which hands it to its provider through
 * child env or a protocol frame — never argv, never a log, never a file.
 *
 * Issuing for a thread revokes that thread's earlier credentials (a relaunch
 * makes the old one useless at once), and an adapter revokes its own when its
 * session ends. An unknown or revoked credential is a 401 at the endpoint, so
 * a credential can only ever act as the one thread it was issued for.
 *
 * Ported in spirit from T3 Code (MIT): `apps/server/src/mcp/McpSessionRegistry.ts`
 * (hash-only storage, revoke-on-reissue). Differs: no liveness window — the
 * host revokes on every session end it sees, and a host restart forgets them
 * all, so nothing outlives the process that issued it.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

/** What a verified credential resolves to. */
export interface SessionToolGrantScope {
  readonly threadId: string;
  /** One issue; what an in-flight call is filed under, so a revoke can abort it. */
  readonly grantId: string;
}

export interface IssuedCredential extends SessionToolGrantScope {
  /** The raw credential. Handed to the provider once; never stored here. */
  readonly token: string;
}

const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export class SessionToolCredentials {
  /** SHA-256 hex → scope. */
  private readonly byHash = new Map<string, SessionToolGrantScope>();
  private readonly revokeListeners = new Set<(scope: SessionToolGrantScope) => void>();

  /** Issue a credential for `threadId`, revoking every earlier one of that thread. */
  issue(threadId: string): IssuedCredential {
    this.revokeThread(threadId);
    const token = randomBytes(32).toString("base64url");
    const scope: SessionToolGrantScope = { threadId, grantId: randomUUID() };
    this.byHash.set(hashToken(token), scope);
    return { ...scope, token };
  }

  /** The scope of a live credential, or null for an unknown, revoked or malformed one. */
  verify(token: string | undefined): SessionToolGrantScope | null {
    if (token === undefined || token.length === 0 || token.length > 512) {
      return null;
    }
    return this.byHash.get(hashToken(token)) ?? null;
  }

  /** Revoke one issue. Idempotent. */
  revokeGrant(grantId: string): void {
    this.revokeWhere((scope) => scope.grantId === grantId);
  }

  /** Revoke every credential of a thread. Idempotent. */
  revokeThread(threadId: string): void {
    this.revokeWhere((scope) => scope.threadId === threadId);
  }

  revokeAll(): void {
    this.revokeWhere(() => true);
  }

  /** Told after each revoke, so the calls a credential started are aborted with it. */
  onRevoke(listener: (scope: SessionToolGrantScope) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private revokeWhere(predicate: (scope: SessionToolGrantScope) => boolean): void {
    for (const [hash, scope] of [...this.byHash]) {
      if (!predicate(scope)) continue;
      this.byHash.delete(hash);
      for (const listener of this.revokeListeners) listener(scope);
    }
  }
}

/** The credential in an `Authorization: Bearer …` header, or undefined. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value === undefined ? null : /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1];
}
