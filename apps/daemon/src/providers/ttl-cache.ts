/**
 * Minimal per-key TTL memoizer for provider listings. Bitbucket Cloud's REST
 * budget has a ~1,000 req/h floor and the repo picker re-lists workspaces +
 * repos on every open — a short TTL absorbs that without ever serving stale
 * data for long. Failed fetches are not cached. The clock is injectable for
 * tests only.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async get(key: string, fetcher: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at <= this.ttlMs) {
      return hit.value;
    }
    const value = await fetcher();
    this.entries.set(key, { at: this.now(), value });
    return value;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
