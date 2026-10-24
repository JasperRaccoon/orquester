/**
 * The remote transport's per-IP throttle on failed authentication: bearer checks (the HTTP hook)
 * and password guesses (login, password verify).
 */

/**
 * Per-IP failed-login throttle with escalating lockout. Single-user, so real
 * failures are rare: 5 fails within the window → locked out, with the lockout
 * doubling on each subsequent breach (15 min, 30, 60 … capped). Keyed on the
 * proxy-supplied client IP (X-Forwarded-For); this is defense-in-depth on top
 * of fail2ban (OS-layer ban on the daemon's 401 log lines, Phase 0).
 */
export class LoginThrottle {
  private readonly state = new Map<
    string,
    { fails: number; lockedUntil: number; strikes: number; burstStartAt: number }
  >();
  private static readonly MAX_FAILS = 5;
  private static readonly BASE_LOCKOUT_MS = 15 * 60 * 1000;
  private static readonly MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
  // One login attempt fans out into several authenticated requests (workspaces,
  // sessions, registry, events, …), so a single wrong password yields a burst of
  // near-simultaneous 401s. Collapse failures within this window into ONE counted
  // attempt so a lone typo can't trip the lockout instantly.
  private static readonly BURST_WINDOW_MS = 2000;
  // Bound the per-IP map: only sweep once it grows past this, then drop entries
  // that are neither locked nor part of a recent burst.
  private static readonly PRUNE_THRESHOLD = 1024;
  private static readonly STALE_AFTER_MS = 10 * 60 * 1000;

  /** Ms remaining on an active lockout for this IP, or 0 if not locked. */
  retryAfterMs(ip: string): number {
    const entry = this.state.get(ip);
    if (!entry || entry.lockedUntil <= Date.now()) {
      return 0;
    }
    return entry.lockedUntil - Date.now();
  }

  /**
   * Record a failed attempt; locks the IP once MAX_FAILS is reached. `perAttempt` counts every
   * call (a password guess at the login or verify route): the burst collapse below is for one
   * stale bearer's fan-out of 401s, and would otherwise let a guesser try freely inside each window.
   */
  recordFailure(ip: string, perAttempt = false): void {
    const entry = this.state.get(ip) ?? { fails: 0, lockedUntil: 0, strikes: 0, burstStartAt: 0 };
    const now = Date.now();
    this.prune(now);
    // Burst collapse: failures arriving within BURST_WINDOW_MS of the FIRST failure
    // of the current burst belong to one login attempt's fan-out (or a rapid
    // auto-reconnect), so they don't count. The window is anchored to that first
    // failure and is NEVER refreshed — otherwise a sustained stream of guesses
    // (even 1/sec) would keep the window alive forever and pin `fails` at 1, so the
    // IP would never lock. Anchoring lets a real fan-out collapse to one strike
    // while a continuous attack advances ~one strike per BURST_WINDOW_MS.
    if (!perAttempt && entry.fails > 0 && now - entry.burstStartAt < LoginThrottle.BURST_WINDOW_MS) {
      this.state.set(ip, entry);
      return;
    }
    entry.burstStartAt = now;
    entry.fails += 1;
    if (entry.fails >= LoginThrottle.MAX_FAILS) {
      const lockout = Math.min(
        LoginThrottle.BASE_LOCKOUT_MS * 2 ** entry.strikes,
        LoginThrottle.MAX_LOCKOUT_MS
      );
      entry.lockedUntil = Date.now() + lockout;
      entry.strikes += 1;
      entry.fails = 0;
    }
    this.state.set(ip, entry);
  }

  // Opportunistic eviction so a distinct-IP spray can't grow `state` without
  // bound: entries that are neither locked nor mid-burst carry no useful state.
  // Cheap by default; sweeps the whole map only once it gets large.
  private prune(now: number): void {
    if (this.state.size <= LoginThrottle.PRUNE_THRESHOLD) {
      return;
    }
    for (const [ip, entry] of this.state) {
      if (entry.lockedUntil <= now && now - entry.burstStartAt > LoginThrottle.STALE_AFTER_MS) {
        this.state.delete(ip);
      }
    }
  }

  /** Clear an IP's failure count after a successful auth. */
  recordSuccess(ip: string): void {
    this.state.delete(ip);
  }
}

/**
 * Client IP used to key the login throttle.
 *
 * TRUSTED-HOP ASSUMPTION: exactly ONE trusted proxy (Caddy) fronts the daemon on
 * loopback. Caddy's default `reverse_proxy` APPENDS the real client IP to whatever
 * the client sent, so `X-Forwarded-For` is `<client-supplied…>, <real-client-ip>`
 * — the entry we trust is the RIGHTMOST one (the hop Caddy added), never the
 * leftmost (which is fully attacker-controlled and would let an attacker rotate it
 * per request to evade the per-IP throttle).
 *
 * With `trustProxy: "127.0.0.1"` set on the remote Fastify instance, proxy-addr
 * already computes exactly this (request.ip = closest untrusted address = the
 * rightmost XFF hop), so request.ip is authoritative; the manual rightmost parse
 * below is a belt-and-suspenders fallback that still refuses the client-controlled
 * leftmost value. If the deployment ever inserts more than one proxy hop, both
 * trustProxy and this helper must be updated together.
 */
export function clientIp(request: { headers: Record<string, unknown>; ip: string }): string {
  if (request.ip) {
    return request.ip;
  }
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (typeof raw === "string" && raw.length > 0) {
    const parts = raw.split(",");
    return parts[parts.length - 1]!.trim();
  }
  return request.ip;
}
