import { isIPv4, isIPv6 } from "node:net";
import { REPO_FAVICON_DOMAIN_MAX, REPO_ICON_MAX_BYTES, type RepoIconStoredType } from "@orquester/api";
import { sniffRepoIcon } from "./image-sniff";
import { checkRequestUrl, guardedGet, hostnameProblem, SafeFetchError, type GuardedGetOptions, type LookupAll } from "./safe-fetch";

/**
 * Fetching a website's favicon for a repo icon (spec 2026-10-18 §3b): the homepage over HTTPS,
 * a tolerant `<link>` scan, then up to four candidate fetches — every hop behind the SSRF guard
 * in `safe-fetch.ts`, every image capped and sniffed like an upload.
 */

export type FaviconErrorCode = "FAVICON_BAD_DOMAIN" | "FAVICON_BLOCKED" | "FAVICON_UNREACHABLE" | "FAVICON_NOT_FOUND";

/** A refusal whose `message` is user-facing: it names the domain and never carries a response body. */
export class FaviconError extends Error {
  constructor(
    public readonly code: FaviconErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FaviconError";
  }
}

export interface FetchedFavicon {
  /** The normalized hostname, e.g. `matssmile.com`. */
  domain: string;
  /** Sniffed, never declared. */
  contentType: RepoIconStoredType;
  /** At most `REPO_ICON_MAX_BYTES`. */
  bytes: Uint8Array;
}

/** The whole operation — homepage, redirects and every candidate. */
export const FAVICON_TIMEOUT_MS = 8_000;
export const FAVICON_HTML_MAX_BYTES = 1024 * 1024;
export const FAVICON_MAX_REDIRECTS = 3;
export const FAVICON_MAX_FETCHES = 4;
const USER_AGENT = "Orquester-favicon/1 (+https://github.com/JasperRaccoon/orquester)";
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const IMAGE_ACCEPT = "image/svg+xml,image/png,image/webp,image/jpeg,image/x-icon,image/*;q=0.8,*/*;q=0.5";

/**
 * `matssmile.com` / `https://www.matssmile.com/x` → its hostname (punycode, lowercased, no
 * trailing dot). Throws `FAVICON_BAD_DOMAIN` for IP literals, ports, credentials, `localhost`,
 * `.local`/`.internal` names, metadata hosts, single-label names, non-http(s) schemes and
 * anything over 253 chars.
 */
export function normalizeFaviconDomain(input: string): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  const refuse = (why: string): never => {
    const shown = trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
    throw new FaviconError("FAVICON_BAD_DOMAIN", shown ? `Can't use "${shown}": ${why}.` : `Enter a website domain, like example.com.`);
  };
  if (trimmed.length === 0) return refuse("enter a website domain, like example.com");
  if (trimmed.length > REPO_FAVICON_DOMAIN_MAX) return refuse(`a domain is at most ${REPO_FAVICON_DOMAIN_MAX} characters`);

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1])) return refuse("only http and https websites are supported");
  const withScheme = scheme ? trimmed : `https://${trimmed}`;
  // The raw authority, before URL normalizes away a default port or an empty userinfo.
  const authority = withScheme.slice(withScheme.indexOf("//") + 2).split(/[/\\?#]/, 1)[0];
  if (authority.includes("@")) return refuse("a domain may not carry a username or password");
  if (authority.startsWith("[")) return refuse("IP addresses aren't supported, enter a domain name");
  if (authority.includes(":")) return refuse("a domain may not carry a port");

  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return refuse("that isn't a website domain");
  }
  // URL has already turned `0x7f.1`, `2130706433` and friends into dotted IPv4.
  if (isIPv4(hostname) || isIPv6(hostname.replace(/^\[|\]$/g, ""))) {
    return refuse("IP addresses aren't supported, enter a domain name");
  }
  hostname = hostname.replace(/\.$/, "");
  const problem = hostnameProblem(hostname);
  if (problem === "local") return refuse("local and single-word names aren't supported, enter a public domain");
  if (problem === "malformed") return refuse("that isn't a website domain");
  return hostname;
}

export interface FetchFaviconOptions {
  /** Aborts the fetch (reported as `FAVICON_UNREACHABLE`). */
  signal?: AbortSignal;
  /** DNS resolution; defaults to `dns.lookup(host, { all: true })`. */
  lookup?: LookupAll;
  /** Replaces the built-in {@link FAVICON_TIMEOUT_MS} deadline (tests drive it by hand). */
  deadline?: AbortSignal;
  /** TEST ONLY — see `GuardedGetOptions.unsafeTestServer`. The routes never pass it. */
  unsafeTestServer?: { port: number };
}

/** Fetch `domain`'s best icon over HTTPS behind the SSRF guard. Throws {@link FaviconError}. */
export async function fetchFavicon(domain: string, options: FetchFaviconOptions = {}): Promise<FetchedFavicon> {
  const host = normalizeFaviconDomain(domain);
  const deadline = options.deadline ?? AbortSignal.timeout(FAVICON_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const base = {
    signal,
    maxRedirects: FAVICON_MAX_REDIRECTS,
    lookup: options.lookup,
    unsafeTestServer: options.unsafeTestServer
  } satisfies Partial<GuardedGetOptions>;
  const scheme = options.unsafeTestServer ? "http:" : "https:";

  let page;
  try {
    page = await guardedGet(`${scheme}//${host}/`, {
      ...base,
      maxBytes: FAVICON_HTML_MAX_BYTES,
      overflow: "truncate",
      headers: { "user-agent": USER_AGENT, accept: HTML_ACCEPT }
    });
  } catch (error) {
    throw pageError(host, error);
  }
  const pageOk = page.status >= 200 && page.status <= 299;
  const html = pageOk ? new TextDecoder("utf-8").decode(page.body) : "";
  const candidates = rankIconCandidates(scanIconLinks(html, page.url.href), page.url.href);

  let fetches = 0;
  let blocked = false;
  for (const candidate of candidates) {
    if (candidate.startsWith("data:")) {
      const bytes = decodeDataUrl(candidate);
      const contentType = bytes ? sniffRepoIcon(bytes) : null;
      if (bytes && contentType) return { domain: host, contentType, bytes };
      continue;
    }
    try {
      checkRequestUrl(candidate, base);
    } catch (error) {
      if (error instanceof SafeFetchError && error.kind === "blocked") blocked = true;
      continue;
    }
    if (fetches >= FAVICON_MAX_FETCHES) break;
    fetches += 1;
    let response;
    try {
      response = await guardedGet(candidate, {
        ...base,
        maxBytes: REPO_ICON_MAX_BYTES,
        overflow: "reject",
        headers: { "user-agent": USER_AGENT, accept: IMAGE_ACCEPT }
      });
    } catch (error) {
      if (error instanceof SafeFetchError && error.kind === "aborted") throw timedOut(host);
      if (error instanceof SafeFetchError && error.kind === "blocked") blocked = true;
      continue;
    }
    if (response.status < 200 || response.status > 299) continue;
    const contentType = sniffRepoIcon(response.body);
    if (contentType) return { domain: host, contentType, bytes: response.body };
  }

  if (blocked) throw blockedError(host);
  if (!pageOk) throw new FaviconError("FAVICON_UNREACHABLE", `Couldn't reach ${host}: it answered HTTP ${page.status}.`);
  throw new FaviconError("FAVICON_NOT_FOUND", `No icon found on ${host}.`);
}

function pageError(host: string, error: unknown): FaviconError {
  if (!(error instanceof SafeFetchError)) return new FaviconError("FAVICON_UNREACHABLE", `Couldn't reach ${host}.`);
  switch (error.kind) {
    case "blocked":
      return blockedError(host);
    case "aborted":
      return timedOut(host);
    case "too-many-redirects":
      return new FaviconError("FAVICON_UNREACHABLE", `Couldn't reach ${host}: too many redirects.`);
    case "invalid-url":
      return new FaviconError("FAVICON_UNREACHABLE", `Couldn't reach ${host} over HTTPS.`);
    default:
      return new FaviconError("FAVICON_UNREACHABLE", `Couldn't reach ${host}.`);
  }
}

const blockedError = (host: string) => new FaviconError("FAVICON_BLOCKED", `${host} points to a private or local address.`);
const timedOut = (host: string) => new FaviconError("FAVICON_UNREACHABLE", `Couldn't reach ${host}: it took too long to answer.`);

// ---------------------------------------------------------------------------
// The <link> scan and candidate order (pure)
// ---------------------------------------------------------------------------

export interface IconLink {
  /** Absolute: resolved against the page (or its `<base href>`). */
  url: string;
  /** `apple-touch-icon` / `apple-touch-icon-precomposed`, rather than plain `icon`. */
  apple: boolean;
  /** Largest declared `sizes` edge in px; `Infinity` for `any`; null when undeclared. */
  size: number | null;
  /** The declared `type`, lowercased; null when undeclared. */
  type: string | null;
}

/** Declared types worth fetching; anything else declared (e.g. `image/gif`) is skipped. */
const FETCHABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/ico",
  "image/icon"
]);

/**
 * The icon `<link>`s of an HTML document, in document order: `rel` holding the token `icon`,
 * `apple-touch-icon` or `apple-touch-icon-precomposed` (never `mask-icon`), with an `href` that
 * resolves against `pageUrl` to http(s) or a `data:` URL. A tolerant scan, not a parser:
 * comments, scripts and styles are skipped; unquoted and single-quoted attributes are read.
 */
export function scanIconLinks(html: string, pageUrl: string): IconLink[] {
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  let baseUrl = pageUrl;
  const baseTag = /<base\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text);
  const baseHref = baseTag ? readAttributes(baseTag[1]).get("href") : undefined;
  if (baseHref) {
    try {
      const resolved = new URL(decodeEntities(baseHref).trim(), pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") baseUrl = resolved.href;
    } catch {
      // ignore a broken <base>
    }
  }

  const links: IconLink[] = [];
  for (const match of text.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = readAttributes(match[1]);
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (rel.includes("mask-icon")) continue;
    const apple = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!apple && !rel.includes("icon")) continue;
    const href = decodeEntities(attributes.get("href") ?? "").trim();
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "data:") continue;
    const type = attributes.get("type")?.trim().toLowerCase() || null;
    if (type && !FETCHABLE_TYPES.has(type)) continue;
    links.push({ url: url.href, apple, size: largestSize(attributes.get("sizes")), type });
  }
  return links;
}

/**
 * Candidate URLs to try, best first, de-duplicated: (1) an SVG `icon`; (2) any icon with a
 * declared size of at least 64px (`any` counts), largest first; (3) other apple-touch-icons;
 * (4) other icons; (5) `/favicon.ico` at the page's origin.
 */
export function rankIconCandidates(links: IconLink[], pageUrl: string): string[] {
  const rank = (link: IconLink): number => {
    if (!link.apple && isSvg(link)) return 1;
    if (link.size !== null && link.size >= 64) return 2;
    return link.apple ? 3 : 4;
  };
  const ordered = links
    .map((link, index) => ({ link, index, rank: rank(link) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank === 2 && a.link.size !== b.link.size) return (b.link.size ?? 0) - (a.link.size ?? 0);
      return a.index - b.index;
    })
    .map(({ link }) => link.url);
  ordered.push(new URL("/favicon.ico", pageUrl).href);
  return [...new Set(ordered)];
}

function isSvg(link: IconLink): boolean {
  if (link.type === "image/svg+xml") return true;
  if (link.url.startsWith("data:")) return /^data:image\/svg\+xml[;,]/i.test(link.url);
  try {
    return new URL(link.url).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

function largestSize(sizes: string | undefined): number | null {
  if (!sizes) return null;
  let largest: number | null = null;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    if (token === "any") return Infinity;
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (match) largest = Math.max(largest ?? 0, Number(match[1]), Number(match[2]));
  }
  return largest;
}

function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

// ---------------------------------------------------------------------------
// data: URLs
// ---------------------------------------------------------------------------

/**
 * The bytes of a `data:` URL of a fetchable image type (base64 or percent-encoded), or null
 * when it is another type, malformed, or larger than `REPO_ICON_MAX_BYTES`.
 */
export function decodeDataUrl(url: string): Uint8Array | null {
  const match = /^data:([^,]*),(.*)$/is.exec(url);
  if (!match) return null;
  const params = match[1].split(";").map((part) => part.trim().toLowerCase());
  if (!FETCHABLE_TYPES.has(params[0])) return null;
  const payload = match[2];
  if (params.includes("base64")) {
    const compact = decodeURIComponentSafe(payload)?.replace(/\s+/g, "");
    if (compact === undefined || !/^[a-z0-9+/_-]*={0,2}$/i.test(compact)) return null;
    if (Math.floor((compact.length * 3) / 4) > REPO_ICON_MAX_BYTES + 2) return null;
    const bytes = new Uint8Array(Buffer.from(compact, compact.includes("-") || compact.includes("_") ? "base64url" : "base64"));
    return bytes.length > REPO_ICON_MAX_BYTES ? null : bytes;
  }
  const raw = new TextEncoder().encode(payload);
  const bytes: number[] = [];
  const hex = (byte: number) => (byte >= 0x30 && byte <= 0x39) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x66);
  for (let i = 0; i < raw.length; i += 1) {
    if (bytes.length >= REPO_ICON_MAX_BYTES) return null;
    if (raw[i] === 0x25 && i + 2 < raw.length && hex(raw[i + 1]) && hex(raw[i + 2])) {
      bytes.push(parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16));
      i += 2;
    } else {
      bytes.push(raw[i]);
    }
  }
  return new Uint8Array(bytes);
}

function decodeURIComponentSafe(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
