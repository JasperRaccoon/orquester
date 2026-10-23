/**
 * A rate gate in front of one forge host's REST API, per account: at most a few requests in
 * flight, and one shared pause once the host answers 429.
 *
 * Without it every request spends its own 429 — a startup sweep over many repos, or a Bitbucket
 * DC poll that pages through ~30 requests, keeps the quota exhausted by asking again. While the
 * gate is paused nothing reaches the host:
 * - a background read (the git-trigger poller's listings) fails at once with a `rate_limited`
 *   `GitRemoteError` carrying `retryAfterMs`, which the poller already waits out;
 * - a request a user is waiting on fails at once too, saying how long to wait, rather than
 *   adding to the flood.
 *
 * The pause comes from the 429's Retry-After (or the provider's rate-limit reset), else 60 s.
 *
 * Adapted from T3 Code (MIT): packages/source-control-bitbucket/src/server/BitbucketApi.ts
 */

import { createHash } from "node:crypto";

import type { ProviderCreds } from "./types";
import { GitRemoteError } from "./types";

/** Who is waiting on a request: the poller in the background, or a user. */
export type RequestMode = "background" | "interactive";

/** Requests in flight per host and account (Bitbucket). */
export const RATE_GATE_SLOTS = 4;

/** How long a 429 without a usable Retry-After pauses the host. */
export const DEFAULT_RATE_PAUSE_MS = 60_000;

export interface HostRateGateOptions {
  /** Concurrent requests; `Infinity` leaves concurrency alone and keeps only the pause. */
  slots?: number;
  defaultPauseMs?: number;
  now?: () => number;
}

export class HostRateGate {
  readonly #slots: number;
  readonly #defaultPauseMs: number;
  readonly #now: () => number;
  readonly #waiters: Array<() => void> = [];
  #active = 0;
  #pausedUntil = 0;

  /** `label` names the host in messages ("Bitbucket", "GitHub", a DC instance's host). */
  constructor(
    readonly label: string,
    options: HostRateGateOptions = {}
  ) {
    this.#slots = Math.max(1, options.slots ?? RATE_GATE_SLOTS);
    this.#defaultPauseMs = options.defaultPauseMs ?? DEFAULT_RATE_PAUSE_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Milliseconds left of the current pause; 0 when not paused. */
  pausedForMs(): number {
    return Math.max(0, this.#pausedUntil - this.#now());
  }

  /** Start (or extend — never shorten) the host-wide pause. */
  pause(ms?: number): number {
    const length = ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : this.#defaultPauseMs;
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + length);
    return this.pausedForMs();
  }

  /**
   * Run one request through the gate: refused while paused, then queued for a slot (and checked
   * again, since a pause may have started meanwhile). A `rate_limited` failure pauses the host
   * and is rethrown carrying the pause as its `retryAfterMs`.
   */
  async run<T>(mode: RequestMode, request: () => Promise<T>): Promise<T> {
    this.#refuseWhilePaused(mode);
    await this.#acquire();
    try {
      this.#refuseWhilePaused(mode);
      return await request();
    } catch (error) {
      if (error instanceof GitRemoteError && error.kind === "rate_limited") {
        const wait = this.pause(error.retryAfterMs);
        throw error.retryAfterMs !== undefined
          ? error
          : new GitRemoteError(error.status, error.message, error.kind, error.httpStatus, wait);
      }
      throw error;
    } finally {
      this.#release();
    }
  }

  #refuseWhilePaused(mode: RequestMode): void {
    const wait = this.pausedForMs();
    if (wait <= 0) return;
    const seconds = Math.ceil(wait / 1000);
    throw new GitRemoteError(
      429,
      mode === "interactive"
        ? `${this.label} is rate limiting this account; try again in ${seconds} s.`
        : `${this.label} is rate limiting this account; the next try is in ${seconds} s.`,
      "rate_limited",
      undefined,
      wait
    );
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#slots) {
      this.#active += 1;
      return;
    }
    // The releasing request hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#active -= 1;
  }
}

const gates = new Map<string, HostRateGate>();

/**
 * Who a host counts requests against: a digest of the token (never the token itself, which
 * stays out of every key and message), or `anonymous` for a public read.
 */
function accountKeyOf(creds: Pick<ProviderCreds, "token" | "email"> | null): string {
  if (!creds?.token) return "anonymous";
  return createHash("sha256").update(`${creds.email ?? ""}\u0000${creds.token}`).digest("hex").slice(0, 16);
}

/** The one gate for `host` and the account behind `creds`, made on first use. */
export function rateGateFor(
  host: string,
  label: string,
  creds: Pick<ProviderCreds, "token" | "email"> | null,
  options?: HostRateGateOptions
): HostRateGate {
  const key = `${host.toLowerCase()}\u0000${accountKeyOf(creds)}`;
  let gate = gates.get(key);
  if (!gate) {
    gate = new HostRateGate(label, options);
    gates.set(key, gate);
  }
  return gate;
}

/** Forget every gate and its pause (tests: one test's 429 must not pause the next). */
export function resetRateGates(): void {
  gates.clear();
}
