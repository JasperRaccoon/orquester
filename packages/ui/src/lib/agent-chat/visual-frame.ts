/**
 * Agent visuals — the frame's pure rules (spec 2026-10-14 §2.2, §2.4): where
 * a signed page URL is framed from on each runtime, when a cached URL is
 * reused, which app shortcuts a focused page may pass on, and how a link it
 * asks for is opened. No React import.
 */

import {
  AGENT_VISUAL_ROUTE_PREFIX,
  HTML_RENDER_URL_MIN_REMAINING_MS,
  matchesHtmlRenderShortcut,
  type HtmlRenderKeyDown,
  type HtmlRenderShortcut
} from "@orquester/api/agent-chat";

/** What the frame needs to know about the connection a page is fetched over. */
export interface VisualFrameHost {
  /** The transporter's kind: `http` (web, desktop remote) or `unix` (desktop local). */
  kind: string;
  /** The connection's endpoint (`https://host`, or `unix://…`). */
  endpoint: string;
  /**
   * The desktop's page scheme (`orq-visual`), when the desktop bridge offers
   * one: its main process fetches the page and answers it under the sandbox
   * CSP, for the unix socket the renderer cannot frame and for a remote whose
   * Caddy would refuse a `file://` parent.
   */
  desktopScheme?: string;
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The iframe `src` for a minted page path, or null when this connection
 * cannot frame one (a desktop build without the page scheme on the socket).
 * The layout of the desktop URLs is the main process's (`apps/desktop/src/main.ts`).
 */
export function visualFrameSrc(path: string, host: VisualFrameHost): string | null {
  if (!path.startsWith(`${AGENT_VISUAL_ROUTE_PREFIX}/`)) {
    return null;
  }
  if (host.desktopScheme !== undefined) {
    if (host.kind === "unix") {
      return `${host.desktopScheme}://local${path}`;
    }
    if (host.kind === "http") {
      // The endpoint's origin and its sub-path, as the web frames from: a
      // daemon served under `https://host/orq` serves its pages there too.
      try {
        const endpoint = new URL(host.endpoint);
        const base = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
        return `${host.desktopScheme}://remote/${base64Url(base)}${path}`;
      } catch {
        return null;
      }
    }
    return null;
  }
  return host.kind === "http" ? `${host.endpoint.replace(/\/$/, "")}${path}` : null;
}

/** The desktop bridge's page scheme, validated: bridge payloads are untrusted. */
export function desktopVisualScheme(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const scheme = (window as unknown as { orquesterDesktop?: { visualScheme?: unknown } }).orquesterDesktop
    ?.visualScheme;
  return typeof scheme === "string" && /^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) ? scheme : undefined;
}

/** A minted page URL, framed as is. */
export interface VisualFrameUrl {
  src: string;
  /** The daemon's expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * Minted URLs, so a remount (a thread switch, a history page) reuses one with
 * life left and the frame does not re-mint every time. A frame keeps its first
 * URL for its life; a NEW mount re-mints only when less than five minutes
 * remain, since a frame cannot report a failed load.
 */
export class VisualUrlCache {
  private readonly urls = new Map<string, VisualFrameUrl>();

  /** A cached URL with more than five minutes of life left at `now`, else null. */
  usable(key: string, now: number): VisualFrameUrl | null {
    const cached = this.urls.get(key);
    if (cached === undefined) return null;
    if (cached.expiresAt - now > HTML_RENDER_URL_MIN_REMAINING_MS) return cached;
    this.urls.delete(key);
    return null;
  }

  remember(key: string, url: VisualFrameUrl): void {
    this.urls.set(key, url);
    // Bounded: a long session browses many threads.
    if (this.urls.size > 200) {
      const oldest = this.urls.keys().next().value;
      if (oldest !== undefined) this.urls.delete(oldest);
    }
  }
}

const chord = (key: string, modifiers: Partial<Omit<HtmlRenderShortcut, "key">> = {}): HtmlRenderShortcut => ({
  key,
  ...(modifiers.code !== undefined ? { code: modifiers.code } : {}),
  metaKey: modifiers.metaKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
  altKey: modifiers.altKey ?? false
});

/**
 * The app shortcuts a focused page passes on (spec §2.4): only chords that
 * change what the reader sees — never one that changes a thread, since a page
 * script can report any key it likes. The command palette (`mod+K`), the
 * attention cycle (`Ctrl+Shift+A`) and scroll-to-end (`mod+J`).
 */
export const VISUAL_FRAME_SHORTCUTS: readonly HtmlRenderShortcut[] = [
  chord("k", { code: "KeyK", ctrlKey: true }),
  chord("k", { code: "KeyK", metaKey: true }),
  chord("a", { ctrlKey: true, shiftKey: true }),
  chord("j", { code: "KeyJ", ctrlKey: true }),
  chord("j", { code: "KeyJ", metaKey: true })
];

/**
 * In the full-screen viewer: the palette (which opens over a modal) and
 * Escape, which closes the viewer. Not the attention cycle or scroll-to-end:
 * both stand down while a modal is up, so passing them on would do nothing.
 * Escape is never forwarded inline: a bare Escape there is the chat's
 * interrupt, which a page must not be able to send.
 */
export const VISUAL_VIEWER_SHORTCUTS: readonly HtmlRenderShortcut[] = [
  chord("k", { code: "KeyK", ctrlKey: true }),
  chord("k", { code: "KeyK", metaKey: true }),
  chord("escape", { code: "Escape" })
];

/** Whether a key a page reported is one of the chords its frame allowed. */
export function isAllowedVisualKey(key: HtmlRenderKeyDown, shortcuts: readonly HtmlRenderShortcut[]): boolean {
  return !key.repeat && shortcuts.some((shortcut) => matchesHtmlRenderShortcut(key, shortcut));
}

/**
 * Whether a page's request may act now: it came from this frame, the frame
 * has focus, and the reader has just used the app (a page can take focus by
 * script, so this stops opens on load). Escape is not user activation, so a
 * key needs only focus when it is Escape.
 */
export function visualRequestAllowed(input: {
  fromFrame: boolean;
  frameFocused: boolean;
  userActive: boolean | undefined;
  escape?: boolean;
}): boolean {
  return input.fromFrame && input.frameFocused && (input.escape === true || input.userActive !== false);
}

/**
 * Open a page's link as a chat link opens: a new browsing context, with no
 * opener — a new tab on the web, the system browser on the desktop (its
 * window-open handler). Only http(s) ever reaches here.
 */
export function openVisualLink(url: string): void {
  if (typeof window === "undefined" || !/^https?:\/\//i.test(url)) {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** The full-screen viewer's zoom range and step (spec §2.4: 50–200 % in 25 % steps). */
export const VISUAL_VIEWER_MIN_ZOOM = 0.5;
export const VISUAL_VIEWER_MAX_ZOOM = 2;
const VISUAL_VIEWER_ZOOM_STEP = 0.25;

/** The next zoom step in `direction`, snapped to the 25 % grid and kept within range. */
export function stepVisualZoom(zoom: number, direction: 1 | -1): number {
  const next = Math.round((zoom + direction * VISUAL_VIEWER_ZOOM_STEP) / VISUAL_VIEWER_ZOOM_STEP) * VISUAL_VIEWER_ZOOM_STEP;
  return Math.min(VISUAL_VIEWER_MAX_ZOOM, Math.max(VISUAL_VIEWER_MIN_ZOOM, next));
}
