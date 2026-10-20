/**
 * Agent host — when a box CLI's access token needs a fresh one (spec
 * 2026-10-19 §7, Claude Code row; spikes doc (a)).
 *
 * A CLI in a box holds only an access token — it can never refresh, so it can
 * never race the host's refresher. Claude reads its token from a
 * refresh-token-free `.credentials.json` in the box's config dir and re-reads
 * that file on its next request, so before the token's remaining life drops
 * under {@link BOX_TOKEN_RESTART_MARGIN_MS} the file is rewritten with a fresh
 * grant BETWEEN turns — before each turn is sent and when one ends
 * (`BoxLaunch.refreshCredentials`). No restart is needed.
 *
 * A token that was ALREADY inside the margin when the CLI got it (the broker
 * could not do better) is not "stale" until its last
 * {@link BOX_TOKEN_HARD_FLOOR_MS}: asking again before every turn for an
 * equally short token would gain nothing.
 */

export const BOX_TOKEN_RESTART_MARGIN_MS = 30 * 60_000;
export const BOX_TOKEN_HARD_FLOOR_MS = 5 * 60_000;
/** What a spawn asks the broker for: comfortably more than the restart margin. */
export const BOX_TOKEN_MIN_VALID_SECONDS = 45 * 60;

interface TrackedToken {
  expiresAt: number;
  /** The token's remaining life when the CLI got it. */
  initialLifeMs: number;
}

export class BoxTokenTracker {
  private readonly tokens = new Map<string, TrackedToken>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The CLI of `threadId` was started with a token expiring at `expiresAt` (epoch ms; null = unknown). */
  note(threadId: string, expiresAt: number | null): void {
    if (expiresAt === null || !Number.isFinite(expiresAt)) {
      this.tokens.delete(threadId);
      return;
    }
    this.tokens.set(threadId, { expiresAt, initialLifeMs: expiresAt - this.now() });
  }

  forget(threadId: string): void {
    this.tokens.delete(threadId);
  }

  /** The token's remaining life, or null when none is tracked. */
  remainingMs(threadId: string): number | null {
    const token = this.tokens.get(threadId);
    return token === undefined ? null : token.expiresAt - this.now();
  }

  /** True when the live CLI's token must be replaced before its next turn. */
  stale(threadId: string): boolean {
    const token = this.tokens.get(threadId);
    if (token === undefined) return false;
    const remaining = token.expiresAt - this.now();
    const margin = token.initialLifeMs <= BOX_TOKEN_RESTART_MARGIN_MS ? BOX_TOKEN_HARD_FLOOR_MS : BOX_TOKEN_RESTART_MARGIN_MS;
    return remaining < margin;
  }
}
