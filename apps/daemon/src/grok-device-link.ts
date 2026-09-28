import { EventEmitter } from "node:events";
import type { GrokDeviceLink, GrokDeviceLinkStatus } from "@orquester/api";
import { grokAuthJsonFromDeviceTokens, httpGrokDeviceAuth, type GrokDeviceAuth, type GrokDeviceTokens } from "./grok-device-auth.ts";

/** Floor for the poll interval, whatever the authorization server asks for. */
const POLL_INTERVAL_MS = 3000;

export type GrokLinkStartResult =
  | { ok: true; link: GrokDeviceLink }
  | { ok: false; code: "conflict" | "upstream"; error: string; status?: number };

export interface GrokDeviceLinkOptions {
  /** Import a grok-CLI-shaped `auth.json` blob as a managed grok account. */
  importAccount(content: string): Promise<unknown>;
  /** Defaults to the real auth.x.ai client; tests inject a fake. */
  deviceAuth?: GrokDeviceAuth;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/**
 * The Grok account's device-code link (Settings → Accounts). The daemon drives
 * the RFC 8628 flow directly against auth.x.ai — the same endpoints and client
 * as `grok login --device-auth` — and on approval the tokens become a managed
 * grok account. The pending session is in-memory by design: it dies with the
 * daemon, and the device code simply expires on the authorization server.
 * Nothing it exposes is a secret — the URL and user code are meant to be typed
 * into a browser. Emits `changed` with the new status on every move.
 */
export class GrokDeviceLinkService {
  readonly events = new EventEmitter();
  private pending: { link: GrokDeviceLink; deviceCode: string; expiresAtMs: number; intervalMs: number } | null =
    null;
  private lastError: string | null = null;

  constructor(private readonly opts: GrokDeviceLinkOptions) {}

  status(): GrokDeviceLinkStatus {
    return {
      state: this.pending ? "linking" : "idle",
      link: this.pending?.link ?? null,
      lastError: this.lastError
    };
  }

  /** Start a link. Nothing here waits on the user: a background poll watches
   *  for the verdict. */
  async start(): Promise<GrokLinkStartResult> {
    if (this.pending) return { ok: false, code: "conflict", error: "a Grok link is already in progress" };
    const res = await this.deviceAuth().start();
    if (!res.ok) return { ok: false, code: "upstream", error: res.error, ...(res.status ? { status: res.status } : {}) };
    // A start that raced another one lost: the first stays the pending link.
    if (this.pending) return { ok: false, code: "conflict", error: "a Grok link is already in progress" };
    const expiresAtMs = this.now() + res.value.expiresIn * 1000;
    const link: GrokDeviceLink = {
      url: res.value.url,
      userCode: res.value.userCode,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
    this.pending = {
      link,
      deviceCode: res.value.deviceCode,
      expiresAtMs,
      intervalMs: Math.max(res.value.intervalSec * 1000, POLL_INTERVAL_MS)
    };
    // A fresh attempt supersedes the previous verdict.
    this.lastError = null;
    this.changed();
    void this.poll(res.value.deviceCode, res.value.expiresIn);
    return { ok: true, link };
  }

  /** Abandon a pending link. Purely local: the device code expires on its own.
   *  Idempotent — nothing pending is a no-op. */
  cancel(): GrokDeviceLinkStatus {
    if (this.pending) {
      this.pending = null;
      this.changed();
    }
    return this.status();
  }

  /**
   * Watch a device-code grant to its verdict. Bounded by both the code's expiry
   * and an attempt cap, so neither a frozen clock (tests) nor an endpoint stuck
   * on `authorization_pending` can spin forever. Honors RFC 8628 `slow_down` by
   * widening the interval.
   */
  private async poll(deviceCode: string, expiresIn: number): Promise<void> {
    let intervalMs = this.pending?.intervalMs ?? POLL_INTERVAL_MS;
    const maxAttempts = Math.ceil((expiresIn * 1000) / intervalMs) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.sleep(intervalMs);
      // Cancelled or superseded — this poll is stale.
      if (this.pending?.deviceCode !== deviceCode) return;
      if (this.now() >= this.pending.expiresAtMs) break;
      const res = await this.deviceAuth().poll(deviceCode);
      if (res.status === "wait") {
        if (res.slowDown) intervalMs += 5000; // RFC 8628 §3.5
        continue;
      }
      if (res.status === "ok") {
        await this.complete(deviceCode, res.tokens);
        return;
      }
      this.end(deviceCode, res.error || "authorization failed");
      return;
    }
    this.end(deviceCode, "device authorization expired");
  }

  private async complete(deviceCode: string, tokens: GrokDeviceTokens): Promise<void> {
    if (this.pending?.deviceCode !== deviceCode) return;
    this.pending = null;
    try {
      await this.opts.importAccount(JSON.stringify(grokAuthJsonFromDeviceTokens(tokens, this.now())));
      this.lastError = null;
    } catch (error) {
      console.error("grok device link: importing the linked account failed", error);
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  private end(deviceCode: string, reason: string): void {
    if (this.pending?.deviceCode !== deviceCode) return;
    this.pending = null;
    this.lastError = reason;
    this.changed();
  }

  private changed(): void {
    this.events.emit("changed", this.status());
  }

  private deviceAuth(): GrokDeviceAuth {
    return this.opts.deviceAuth ?? httpGrokDeviceAuth;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
