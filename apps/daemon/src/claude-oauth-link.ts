import { EventEmitter } from "node:events";
import type { AgentAccount, ClaudeOAuthLink, ClaudeOAuthLinkStatus } from "@orquester/api";
import {
  claudeAuthorizeUrl,
  claudeCredentialsFromTokens,
  createClaudeOAuthPkce,
  exchangeClaudeAuthorizationCode,
  fetchClaudeProfile,
  parseClaudeAuthorizationCode,
  type ClaudeOAuthPkce
} from "./claude-oauth.ts";

/** How long a started sign-in waits for its pasted code. */
const LINK_TTL_MS = 15 * 60_000;

type ClaudeLinkStartResult = { ok: true; link: ClaudeOAuthLink } | { ok: false; code: "conflict"; error: string };

type ClaudeLinkSubmitResult =
  | { ok: true; account: AgentAccount }
  | { ok: false; code: "idle" | "conflict" | "invalid" | "upstream"; error: string };

interface ClaudeOAuthLinkOptions {
  /** Import a Claude-CLI-shaped `.credentials.json` blob as a managed account. */
  importAccount(content: string, identity: { email: string | null }): Promise<AgentAccount>;
}

interface PendingLink {
  link: ClaudeOAuthLink;
  pkce: ClaudeOAuthPkce;
  timer: NodeJS.Timeout;
  exchanging: boolean;
}

/**
 * The Claude account's sign-in link (Settings → Accounts). Start hands out the
 * Claude.ai authorize URL; the user signs in there and pastes the `code#state`
 * the callback page shows back into Orquester, and the daemon exchanges it —
 * with the PKCE verifier that never leaves the daemon — for a managed account.
 * The pending sign-in is in-memory by design and lapses after `LINK_TTL_MS`.
 * A rejected code keeps it pending: reopening the same URL yields a new code.
 * Emits `changed` with the new status on every move.
 */
export class ClaudeOAuthLinkService {
  readonly events = new EventEmitter();
  private pending: PendingLink | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: ClaudeOAuthLinkOptions) {}

  status(): ClaudeOAuthLinkStatus {
    return {
      state: this.pending ? "linking" : "idle",
      link: this.pending?.link ?? null,
      lastError: this.lastError
    };
  }

  start(): ClaudeLinkStartResult {
    if (this.pending) return { ok: false, code: "conflict", error: "a Claude sign-in is already in progress" };
    const pkce = createClaudeOAuthPkce();
    const link: ClaudeOAuthLink = {
      url: claudeAuthorizeUrl(pkce),
      expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString()
    };
    const pending: PendingLink = {
      link,
      pkce,
      timer: setTimeout(() => this.end(pending, "sign-in expired before a code was entered"), LINK_TTL_MS),
      exchanging: false
    };
    pending.timer.unref?.();
    this.pending = pending;
    // A fresh attempt supersedes the previous verdict.
    this.lastError = null;
    this.changed();
    return { ok: true, link };
  }

  /** Exchange the pasted code for a managed account. */
  async submit(input: string): Promise<ClaudeLinkSubmitResult> {
    const attempt = this.pending;
    if (!attempt) return { ok: false, code: "idle", error: "No Claude sign-in is in progress — start one first." };
    if (attempt.exchanging) return { ok: false, code: "conflict", error: "That sign-in is already being completed." };
    const parsed = parseClaudeAuthorizationCode(input);
    if (!parsed) {
      return { ok: false, code: "invalid", error: "That doesn't look like a sign-in code. Copy the whole code from the Claude page." };
    }
    if (parsed.state !== attempt.pkce.state) {
      return { ok: false, code: "invalid", error: "That code belongs to a different sign-in. Open the link shown here and copy its code." };
    }
    attempt.exchanging = true;
    try {
      const res = await exchangeClaudeAuthorizationCode(parsed.code, attempt.pkce);
      if (!res.ok) return { ok: false, code: res.invalidCode ? "invalid" : "upstream", error: res.error };
      const profile = await fetchClaudeProfile(res.tokens.access_token);
      const credential = claudeCredentialsFromTokens(res.tokens, profile, Date.now());
      // Cancelled meanwhile: the user abandoned it, so nothing is imported.
      if (this.pending !== attempt) return { ok: false, code: "idle", error: "The sign-in was cancelled." };
      this.clear(attempt);
      try {
        const account = await this.opts.importAccount(JSON.stringify(credential), { email: res.tokens.email ?? null });
        this.lastError = null;
        this.changed();
        return { ok: true, account };
      } catch (error) {
        console.error("claude oauth link: importing the linked account failed", error);
        this.lastError = error instanceof Error ? error.message : String(error);
        this.changed();
        return { ok: false, code: "upstream", error: this.lastError };
      }
    } finally {
      attempt.exchanging = false;
      // The expiry passed during a failed exchange.
      if (Date.now() >= Date.parse(attempt.link.expiresAt)) this.end(attempt, "sign-in expired before a code was entered");
    }
  }

  /** Abandon a pending sign-in. Idempotent — nothing pending is a no-op. */
  cancel(): ClaudeOAuthLinkStatus {
    if (this.pending) {
      this.clear(this.pending);
      this.changed();
    }
    return this.status();
  }

  private end(attempt: PendingLink, reason: string): void {
    // A code being exchanged right now gets to finish.
    if (this.pending !== attempt || attempt.exchanging) return;
    this.clear(attempt);
    this.lastError = reason;
    this.changed();
  }

  private clear(attempt: PendingLink): void {
    clearTimeout(attempt.timer);
    if (this.pending === attempt) this.pending = null;
  }

  private changed(): void {
    this.events.emit("changed", this.status());
  }
}
