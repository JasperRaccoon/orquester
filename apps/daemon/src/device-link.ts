import { EventEmitter } from "node:events";
import type { DeviceLink, DeviceLinkStatus } from "@orquester/api";

/** Floor for the poll interval, whatever the authorization server asks for. */
const POLL_INTERVAL_MS = 3000;

/** A device-code prompt as the authorization server issued it. */
export interface DeviceAuthPrompt<H> {
  url: string;
  userCode: string;
  /** Opaque polling handle — never shown to the user. */
  handle: H;
  /** Server-mandated minimum seconds between polls (RFC 8628 `interval`). */
  intervalSec: number;
  expiresIn: number;
}

export type DeviceAuthStart<H> =
  | { ok: true; value: DeviceAuthPrompt<H> }
  | { ok: false; error: string; status?: number };

export type DeviceAuthPoll<T> =
  | { status: "wait"; slowDown?: boolean }
  | { status: "ok"; tokens: T }
  | { status: "error"; error: string };

/** One provider's device-code authorization and token-polling protocol. */
export interface DeviceAuth<H, T> {
  start(): Promise<DeviceAuthStart<H>>;
  poll(handle: H): Promise<DeviceAuthPoll<T>>;
}

type DeviceLinkStartResult =
  | { ok: true; link: DeviceLink }
  | { ok: false; code: "conflict" | "upstream"; error: string; status?: number };

interface DeviceLinkOptions<H, T> {
  /** The provider as the user knows it, for messages ("a Grok link…"). */
  name: string;
  auth: DeviceAuth<H, T>;
  /** The agent CLI's native credential file for a granted link. */
  credential(tokens: T): Record<string, unknown>;
  /** Import a CLI-shaped credential blob as a managed account. */
  importAccount(content: string): Promise<unknown>;
}

interface PendingLink<H> {
  link: DeviceLink;
  handle: H;
  expiresAtMs: number;
  intervalMs: number;
}

/**
 * A device-code account link (Settings → Accounts). The daemon drives the
 * provider's device flow directly — the same endpoints and client as the CLI's
 * own device login — and on approval the tokens become a managed account. The
 * pending session is in-memory by design: it dies with the daemon, and the
 * device code simply expires on the authorization server. Nothing it exposes
 * is a secret — the URL and user code are meant to be typed into a browser.
 * Emits `changed` with the new status on every move.
 */
export class DeviceLinkService<H, T> {
  readonly events = new EventEmitter();
  private pending: PendingLink<H> | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: DeviceLinkOptions<H, T>) {}

  status(): DeviceLinkStatus {
    return {
      state: this.pending ? "linking" : "idle",
      link: this.pending?.link ?? null,
      lastError: this.lastError
    };
  }

  /** Start a link. Nothing here waits on the user: a background poll watches
   *  for the verdict. */
  async start(): Promise<DeviceLinkStartResult> {
    const conflict = { ok: false, code: "conflict", error: `a ${this.opts.name} link is already in progress` } as const;
    if (this.pending) return conflict;
    const res = await this.opts.auth.start();
    if (!res.ok) return { ok: false, code: "upstream", error: res.error, ...(res.status ? { status: res.status } : {}) };
    // A start that raced another one lost: the first stays the pending link.
    if (this.pending) return conflict;
    const expiresAtMs = Date.now() + res.value.expiresIn * 1000;
    const link: DeviceLink = {
      url: res.value.url,
      userCode: res.value.userCode,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
    const pending: PendingLink<H> = {
      link,
      handle: res.value.handle,
      expiresAtMs,
      intervalMs: Math.max(res.value.intervalSec * 1000, POLL_INTERVAL_MS)
    };
    this.pending = pending;
    // A fresh attempt supersedes the previous verdict.
    this.lastError = null;
    this.changed();
    void this.poll(pending, res.value.expiresIn);
    return { ok: true, link };
  }

  /** Abandon a pending link. Purely local: the device code expires on its own.
   *  Idempotent — nothing pending is a no-op. */
  cancel(): DeviceLinkStatus {
    if (this.pending) {
      this.pending = null;
      this.changed();
    }
    return this.status();
  }

  /**
   * Watch a device-code grant to its verdict. Bounded by both the code's expiry
   * and an attempt cap, so neither a frozen clock nor an endpoint stuck
   * on `authorization_pending` can spin forever. Honors RFC 8628 `slow_down` by
   * widening the interval.
   */
  private async poll(attempt: PendingLink<H>, expiresIn: number): Promise<void> {
    let intervalMs = attempt.intervalMs;
    const maxAttempts = Math.ceil((expiresIn * 1000) / intervalMs) + 1;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      // Cancelled or superseded — this poll is stale.
      if (this.pending !== attempt) return;
      if (Date.now() >= attempt.expiresAtMs) break;
      const res = await this.opts.auth.poll(attempt.handle);
      if (res.status === "wait") {
        if (res.slowDown) intervalMs += 5000; // RFC 8628 §3.5
        continue;
      }
      if (res.status === "ok") {
        await this.complete(attempt, res.tokens);
        return;
      }
      this.end(attempt, res.error || "authorization failed");
      return;
    }
    this.end(attempt, "device authorization expired");
  }

  private async complete(attempt: PendingLink<H>, tokens: T): Promise<void> {
    if (this.pending !== attempt) return;
    this.pending = null;
    try {
      await this.opts.importAccount(JSON.stringify(this.opts.credential(tokens)));
      this.lastError = null;
    } catch (error) {
      console.error(`${this.opts.name} device link: importing the linked account failed`, error);
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  private end(attempt: PendingLink<H>, reason: string): void {
    if (this.pending !== attempt) return;
    this.pending = null;
    this.lastError = reason;
    this.changed();
  }

  private changed(): void {
    this.events.emit("changed", this.status());
  }
}
