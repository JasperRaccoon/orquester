/**
 * Pull request watch reads — the conditional-request cache (spec 2026-10-14 §5 "PR watch"). Each
 * GET a watch makes remembers its ETag and decoded answer, keyed by WHO read it (a hash of the
 * token, never the token) and the path, so the next read sends `If-None-Match` and a 304 reuses the
 * answer. On GitHub a 304 does not count against the primary rate limit only for an AUTHORIZED
 * request; an anonymous 304 still spends one of its 60 an hour (it saves the transfer, not the
 * quota). Bitbucket counts every request. Bounded, least recently used out.
 * Memory only: a restart reads each once in full.
 */

import { createHash } from "node:crypto";

export interface CachedRead {
  etag: string;
  data: unknown;
  /** The next page's path, when the answer was paged. */
  next?: string;
}

const MAX_ENTRIES = 1_000;

/** "anonymous", or a short hash of the credential: the cache key never holds a secret. */
export function readerKey(secret: string | null | undefined): string {
  return secret ? createHash("sha256").update(secret).digest("hex").slice(0, 16) : "anonymous";
}

export class WatchReadCache {
  private readonly entries = new Map<string, CachedRead>();

  get(key: string): CachedRead | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // Least recently used out: a hit moves to the back.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: CachedRead): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
