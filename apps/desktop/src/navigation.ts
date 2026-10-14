/**
 * The main process's URL decisions, free of Electron so they can be tested:
 * where the window may navigate, what a navigation or `window.open` turns
 * into instead, and which daemon a page-scheme URL names. `main.ts` wires
 * them to the window and the protocol handler.
 */

// --- Agent visuals: the page scheme (spec 2026-10-14 §2.2) ---
//
// `orq-visual://local/api/agent-visuals/…` names a page on the local daemon;
// `orq-visual://remote/<base64url endpoint>/api/agent-visuals/…` names one on
// a remote this process already talks to. The endpoint is the remote's origin
// and, for a daemon served under a sub-path (`https://host/orq`), that path —
// the layout of `packages/ui/src/lib/agent-chat/visual-frame.ts`.
export const VISUAL_SCHEME = "orq-visual";
export const VISUAL_ROUTE_PREFIX = "/api/agent-visuals/";

/** The daemon route a remote's file and folder downloads come from. */
const DOWNLOAD_ROUTE = "/api/fs/download";

/** Where a page URL points: a daemon path over the socket, or a remote URL. Null for anything else. */
export type VisualTarget = { kind: "local"; path: string } | { kind: "remote"; url: string };

/**
 * A remote endpoint decoded from a page URL, as `origin` + optional sub-path —
 * only when its origin is one this process reached, so a page cannot turn the
 * scheme into a fetch of an arbitrary host.
 */
function remoteEndpoint(encoded: string, remoteOrigins: ReadonlySet<string>): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null;
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") return null;
  if (!remoteOrigins.has(endpoint.origin)) return null;
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
}

export function visualTarget(raw: string, remoteOrigins: ReadonlySet<string>): VisualTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${VISUAL_SCHEME}:`) return null;
  if (url.hostname === "local") {
    return url.pathname.startsWith(VISUAL_ROUTE_PREFIX) ? { kind: "local", path: `${url.pathname}${url.search}` } : null;
  }
  if (url.hostname !== "remote") return null;
  const match = /^\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
  if (!match || !match[2]!.startsWith(VISUAL_ROUTE_PREFIX)) return null;
  const endpoint = remoteEndpoint(match[1]!, remoteOrigins);
  return endpoint === null ? null : { kind: "remote", url: `${endpoint}${match[2]}${url.search}` };
}

/** A link this app hands to the system browser: http(s) and mail only. */
export function isExternalUrl(url: string): boolean {
  try {
    const { protocol: scheme } = new URL(url);
    return scheme === "https:" || scheme === "http:" || scheme === "mailto:";
  } catch {
    return false;
  }
}

/**
 * The app's own document, whatever its fragment: the only place the window may
 * navigate. An opaque origin (`data:`, `javascript:`, `about:`) is never the
 * app's, although it compares equal to a `file://` page's "null" origin.
 */
export function isAppUrl(currentUrl: string, url: string): boolean {
  try {
    const target = new URL(url);
    const current = new URL(currentUrl);
    if (target.protocol === "file:") return current.protocol === "file:" && target.pathname === current.pathname;
    return target.origin !== "null" && target.origin === current.origin;
  } catch {
    return false;
  }
}

/**
 * Whether a URL carries a credential in its query: the client puts the
 * connection's password in `?token=` where a request cannot set a header (a
 * download, the DevTools frame). Such a URL never leaves for the system
 * browser — its command line and history would keep the password.
 */
export function carriesCredential(url: string): boolean {
  try {
    const { searchParams } = new URL(url);
    return searchParams.has("token") || searchParams.has("access_token");
  } catch {
    return false;
  }
}

/** A file or folder download from a remote daemon this process talks to (its origin, any sub-path). */
export function isRemoteDownload(url: string, remoteOrigins: ReadonlySet<string>): boolean {
  try {
    const target = new URL(url);
    return (
      (target.protocol === "https:" || target.protocol === "http:") &&
      remoteOrigins.has(target.origin) &&
      target.pathname.endsWith(DOWNLOAD_ROUTE)
    );
  } catch {
    return false;
  }
}

/** What becomes of a navigation of the window, or of a `window.open`. */
export type NavigationAction =
  /** The app's own document: let it happen. */
  | { kind: "allow" }
  /** A remote's download: this process downloads it (`webContents.downloadURL`). */
  | { kind: "download"; url: string }
  /** A link: the system browser opens it. */
  | { kind: "external"; url: string }
  /** Anything else: refused. */
  | { kind: "deny" };

/**
 * A main-frame navigation. A remote's download (`<a download>` to another
 * origin is a navigation from a `file://` page) is downloaded here, so its
 * `?token=` reaches only the daemon that issued it; any other URL with a
 * credential is refused rather than handed to the system browser.
 */
export function navigationAction(
  url: string,
  context: { currentUrl: string; remoteOrigins: ReadonlySet<string> }
): NavigationAction {
  if (isAppUrl(context.currentUrl, url)) return { kind: "allow" };
  return windowOpenAction(url, context);
}

/** A `window.open` (a chat link's `target=_blank`, a page's `ui/open-link`): never a new app window. */
export function windowOpenAction(url: string, context: { remoteOrigins: ReadonlySet<string> }): NavigationAction {
  if (isRemoteDownload(url, context.remoteOrigins)) return { kind: "download", url };
  if (carriesCredential(url)) return { kind: "deny" };
  return isExternalUrl(url) ? { kind: "external", url } : { kind: "deny" };
}
