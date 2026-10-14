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

/**
 * The daemon base a request URL was made against — the endpoint the user
 * configured, `origin` plus any sub-path — read off the path the client
 * appends to it (`<base>/api/…`, or `<base>/health`). Null for anything that
 * is not a daemon request over http(s). The main process remembers these for
 * every remote it talks to; a page or a download may only name one of them.
 */
export function remoteBaseOf(url: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.username !== "" || target.password !== "") return null;
  const path = target.pathname;
  const api = path.indexOf("/api/");
  const base = api >= 0 ? path.slice(0, api) : path.endsWith("/health") ? path.slice(0, -"/health".length) : null;
  return base === null ? null : `${target.origin}${base}`;
}

/** Where a page URL points: a daemon path over the socket, or a remote URL. Null for anything else. */
export type VisualTarget = { kind: "local"; path: string } | { kind: "remote"; url: string };

/**
 * A remote endpoint decoded from a page URL — only when it is exactly the base
 * of a remote this process reached (origin and configured sub-path), so a
 * page cannot turn the scheme into a fetch of an arbitrary host, or of
 * another path prefix on a remote's origin.
 */
function remoteEndpoint(encoded: string, remoteBases: ReadonlySet<string>): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null;
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") return null;
  const base = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
  return remoteBases.has(base) ? base : null;
}

export function visualTarget(raw: string, remoteBases: ReadonlySet<string>): VisualTarget | null {
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
  const endpoint = remoteEndpoint(match[1]!, remoteBases);
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

/** Query names that carry the connection's password. */
const CREDENTIAL_PARAMS = new Set(["token", "access_token", "password"]);
/** How deep a value nested inside a value is unwrapped; anything deeper is refused. */
const MAX_CREDENTIAL_DEPTH = 4;

/** Whether a query string (or fragment) names a credential, at any nesting. */
function queryCarriesCredential(query: string, depth: number): boolean {
  if (depth > MAX_CREDENTIAL_DEPTH) return true;
  for (const [name, value] of new URLSearchParams(query)) {
    if (CREDENTIAL_PARAMS.has(name.toLowerCase())) return true;
    if (valueCarriesCredential(value, depth + 1)) return true;
  }
  return false;
}

/**
 * Whether a parameter's value hides a credential: a URL or path with its own
 * query (`host/ws-devtools/x?token=…`, the DevTools `wss=` value), or a value
 * still percent-encoded once more, unwrapped a bounded number of times.
 */
function valueCarriesCredential(value: string, depth: number): boolean {
  if (depth > MAX_CREDENTIAL_DEPTH) return true;
  for (const separator of ["?", "#"]) {
    const at = value.indexOf(separator);
    if (at >= 0 && queryCarriesCredential(value.slice(at + 1), depth)) return true;
  }
  if (/%[0-9a-f]{2}/i.test(value)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }
    if (decoded !== value) return valueCarriesCredential(decoded, depth + 1);
  }
  return false;
}

/**
 * Whether a URL carries a credential: the client puts the connection's
 * password in `?token=` where a request cannot set a header — a download's
 * query, or nested inside another parameter's value (the DevTools frame's
 * `wss=<host>/ws-devtools/<id>?token=…`). Such a URL never leaves for the
 * system browser — its command line and history would keep the password.
 * Unparseable URLs count as carrying one.
 */
export function carriesCredential(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return true;
  }
  if (target.password !== "") return true;
  return queryCarriesCredential(target.search.slice(1), 0) || queryCarriesCredential(target.hash.slice(1), 0);
}

/** A file or folder download from a remote daemon this process talks to (at its configured base). */
export function isRemoteDownload(url: string, remoteBases: ReadonlySet<string>): boolean {
  const base = remoteBaseOf(url);
  if (base === null || !remoteBases.has(base)) return false;
  try {
    return new URL(url).pathname === `${new URL(base).pathname.replace(/\/$/, "")}${DOWNLOAD_ROUTE}`;
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
  context: { currentUrl: string; remoteBases: ReadonlySet<string> }
): NavigationAction {
  if (isAppUrl(context.currentUrl, url)) return { kind: "allow" };
  return windowOpenAction(url, context);
}

/** A `window.open` (a chat link's `target=_blank`, a page's `ui/open-link`): never a new app window. */
export function windowOpenAction(url: string, context: { remoteBases: ReadonlySet<string> }): NavigationAction {
  if (isRemoteDownload(url, context.remoteBases)) return { kind: "download", url };
  if (carriesCredential(url)) return { kind: "deny" };
  return isExternalUrl(url) ? { kind: "external", url } : { kind: "deny" };
}
