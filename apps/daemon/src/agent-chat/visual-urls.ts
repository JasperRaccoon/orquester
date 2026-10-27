/**
 * Signed URLs for agent-published pages (spec 2026-10-14 §2.2).
 *
 * A page is framed by an `<iframe>`, which cannot send the bearer every other
 * chat route needs, so the client first mints a short-lived URL over its
 * authenticated transport and the frame loads that. The signature is an
 * HMAC-SHA256 under a key the daemon generates at start and never persists or
 * sends anywhere: it binds the chat session, the attachment and the expiry,
 * so a URL opens exactly one page of one thread until it expires (≤ 15 min),
 * and a daemon restart retires every URL it minted. A frame keeps its first
 * URL for its life; a new mount re-mints when less than five minutes remain
 * (`HTML_RENDER_URL_MIN_REMAINING_MS`, the client's rule).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  HTML_RENDER_CONTENT_SECURITY_POLICY,
  HTML_RENDER_URL_MAX_LIFETIME_MS,
  agentChatRoutes,
  type AgentVisualUrlResponse
} from "@orquester/api/agent-chat";

/**
 * The response headers every served page carries (spec §2.2). The sandbox
 * CSP gives the document an opaque origin whatever embeds it: scripts and
 * forms run, but the app's cookies, storage and API are out of reach.
 * `frame-ancestors` is deliberately not here — the web's Caddy adds
 * `'self'`, and the desktop serves the page through its own scheme, whose
 * parent is a `file://` document no `'self'` would match.
 */
export const VISUAL_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": HTML_RENDER_CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer"
};

export interface VisualUrlSigner {
  /** A signed path for the page, valid for {@link HTML_RENDER_URL_MAX_LIFETIME_MS}. */
  mint(sessionId: string, attachmentId: string): AgentVisualUrlResponse;
  /** Whether `exp`/`sig` (as the query carried them) authorise this page now. */
  verify(sessionId: string, attachmentId: string, exp: unknown, sig: unknown): boolean;
}

function signature(key: Buffer, sessionId: string, attachmentId: string, exp: number): string {
  return createHmac("sha256", key)
    .update(`orq-visual:v1\n${sessionId}\n${attachmentId}\n${exp}`)
    .digest("base64url");
}

/** A signer under a fresh random 32-byte key held only by this daemon. */
export function createVisualUrlSigner(): VisualUrlSigner {
  const key = randomBytes(32);
  return {
    mint(sessionId, attachmentId) {
      const exp = Date.now() + HTML_RENDER_URL_MAX_LIFETIME_MS;
      const query = new URLSearchParams({ exp: String(exp), sig: signature(key, sessionId, attachmentId, exp) });
      return { path: `${agentChatRoutes.visual(sessionId, attachmentId)}?${query.toString()}`, expiresAt: exp };
    },

    verify(sessionId, attachmentId, exp, sig) {
      if (typeof exp !== "string" || !/^\d{1,16}$/.test(exp) || typeof sig !== "string") {
        return false;
      }
      const expiresAt = Number(exp);
      const nowMs = Date.now();
      // Expired, or claiming more life than any minted URL ever has.
      if (!Number.isSafeInteger(expiresAt) || expiresAt < nowMs || expiresAt > nowMs + HTML_RENDER_URL_MAX_LIFETIME_MS) {
        return false;
      }
      const expected = Buffer.from(signature(key, sessionId, attachmentId, expiresAt));
      const given = Buffer.from(sig);
      return given.length === expected.length && timingSafeEqual(given, expected);
    }
  };
}
