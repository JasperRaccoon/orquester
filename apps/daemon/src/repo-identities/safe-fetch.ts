import { promises as dnsPromises, type LookupAddress } from "node:dns";
import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import { Agent, buildConnector, request } from "undici";

/**
 * An SSRF guard for fetching from user-named websites (spec 2026-10-18 §3b).
 *
 * Every request hop resolves its host once, refuses it when ANY answer is a
 * non-public address, and pins the TCP connection to the vetted answers (an
 * undici `Agent` whose `connect.lookup` returns them), so a second DNS answer
 * can't swap in a private address. TLS still verifies the real hostname.
 * Redirects are followed by hand, each hop re-validated the same way.
 */

export type SafeFetchErrorKind =
  /** The URL itself is unusable: wrong scheme, a port, credentials, a public IP literal. */
  | "invalid-url"
  /** The host is (or resolves to, or redirects to) a non-public address or a local-only name. */
  | "blocked"
  | "too-many-redirects"
  /** DNS, connect, TLS or HTTP protocol failure. */
  | "network"
  /** The caller's signal (the overall deadline) fired. */
  | "aborted"
  /** The body ran past `maxBytes` in `"reject"` mode. */
  | "too-large";

/** Its message is for logs only and never holds a response body. */
export class SafeFetchError extends Error {
  constructor(
    public readonly kind: SafeFetchErrorKind,
    message: string
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/** Resolves a hostname to every address it has (like `dns.lookup(host, { all: true })`). */
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

export const defaultLookupAll: LookupAll = (hostname) => dnsPromises.lookup(hostname, { all: true, verbatim: true });

export interface GuardedGetOptions {
  /** The overall deadline; also aborts DNS waits and body reads. */
  signal: AbortSignal;
  /** Body cap in bytes. */
  maxBytes: number;
  /** `"truncate"`: keep the first `maxBytes` and stop reading. `"reject"`: throw `too-large`. */
  overflow: "truncate" | "reject";
  maxRedirects: number;
  headers: Record<string, string>;
  lookup?: LookupAll;
  /**
   * TEST ONLY — never set by the routes. Speak plain HTTP instead of HTTPS and connect every
   * vetted request to `127.0.0.1:port`, so tests can serve fake hostnames from a local server
   * while DNS vetting, redirects and caps run exactly as in production.
   */
  unsafeTestServer?: { port: number };
}

export interface GuardedResponse {
  /** The URL that answered, after redirects. */
  url: URL;
  status: number;
  /** Lowercased names; the first value of repeated headers. */
  headers: Record<string, string>;
  /** Empty unless the status is 2xx. */
  body: Uint8Array;
  /** True when `"truncate"` cut the body at `maxBytes`. */
  truncated: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET `url` behind the guard, following at most `maxRedirects` redirects by hand. Throws
 * {@link SafeFetchError}. A non-2xx final status is returned (with an empty body), not thrown.
 */
export async function guardedGet(url: string | URL, options: GuardedGetOptions): Promise<GuardedResponse> {
  let current = checkRequestUrl(url, options);
  for (let redirects = 0; ; redirects += 1) {
    const response = await guardedHop(current, options);
    if (!("location" in response)) return response;
    if (redirects >= options.maxRedirects) {
      throw new SafeFetchError("too-many-redirects", `More than ${options.maxRedirects} redirects from ${url}`);
    }
    let next: URL;
    try {
      next = new URL(response.location, current);
    } catch {
      throw new SafeFetchError("invalid-url", "A redirect pointed to an unparsable URL");
    }
    current = checkRequestUrl(next, options);
  }
}

/**
 * The URL as a request target: the required scheme (https, or http under `unsafeTestServer`),
 * no credentials, no port, a hostname that passes {@link hostnameProblem}. Throws {@link SafeFetchError}.
 */
export function checkRequestUrl(input: string | URL, options: Pick<GuardedGetOptions, "unsafeTestServer">): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeFetchError("invalid-url", "Unparsable URL");
  }
  const scheme = options.unsafeTestServer ? "http:" : "https:";
  if (url.protocol !== scheme) throw new SafeFetchError("invalid-url", `Only ${scheme} URLs are fetched`);
  if (url.username || url.password) throw new SafeFetchError("invalid-url", "URLs with credentials are not fetched");
  if (url.port) throw new SafeFetchError("invalid-url", "URLs with a port are not fetched");
  const literal = ipLiteral(url.hostname);
  if (literal) {
    throw new SafeFetchError(isBlockedAddress(literal) ? "blocked" : "invalid-url", "IP-literal hosts are not fetched");
  }
  const problem = hostnameProblem(url.hostname.replace(/\.$/, ""));
  if (problem) throw new SafeFetchError(problem === "local" ? "blocked" : "invalid-url", `Host refused (${problem})`);
  url.hash = "";
  return url;
}

/** The address inside an IP-literal URL hostname (`1.2.3.4`, `[::1]`), or null for a name. */
export function ipLiteral(hostname: string): string | null {
  if (isIPv4(hostname)) return hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return isIPv6(hostname) ? hostname : null;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "metadata.tencentyun.com"]);
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Why a lowercased, punycoded hostname (no trailing dot) may not be fetched, or null when it may:
 * `"local"` for names that only mean something on this host or network (localhost, `.local`,
 * `.internal`, single labels that resolve through search domains, metadata hosts) and
 * `"malformed"` for anything that is not a plausible DNS name.
 */
export function hostnameProblem(hostname: string): "local" | "malformed" | null {
  if (hostname.length === 0 || hostname.length > 253) return "malformed";
  if (hostname === "localhost" || METADATA_HOSTS.has(hostname)) return "local";
  if (LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return "local";
  const labels = hostname.split(".");
  if (labels.length < 2) return "local";
  if (!labels.every((label) => LABEL.test(label))) return "malformed";
  return null;
}

// ---------------------------------------------------------------------------
// One hop
// ---------------------------------------------------------------------------

async function guardedHop(
  url: URL,
  options: GuardedGetOptions
): Promise<GuardedResponse | { location: string }> {
  const { signal } = options;
  if (signal.aborted) throw new SafeFetchError("aborted", "Deadline passed");
  const addresses = await vetHost(url.hostname, options.lookup ?? defaultLookupAll, signal);

  const lookup = options.unsafeTestServer
    ? pinnedLookup(url.hostname, [{ address: "127.0.0.1", family: 4 }])
    : pinnedLookup(url.hostname, addresses);
  const testServer = options.unsafeTestServer;
  const testConnector = testServer ? buildConnector({ lookup }) : null;
  const agent = new Agent({
    connect: testConnector
      ? (opts, callback) => testConnector({ ...opts, port: String(testServer!.port) }, callback)
      : { lookup },
    connections: 1
  });

  try {
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, {
        dispatcher: agent,
        method: "GET",
        headers: { ...options.headers, "accept-encoding": "identity" },
        signal,
        maxRedirections: 0
      });
    } catch {
      if (signal.aborted) throw new SafeFetchError("aborted", "Deadline passed");
      throw new SafeFetchError("network", `Request to ${url.host} failed`);
    }

    const headers = flattenHeaders(response.headers);
    const { statusCode, body } = response;
    // Destroying an undici body emits an AbortError; it is expected whenever we stop reading.
    body.on("error", () => undefined);
    if (REDIRECT_STATUSES.has(statusCode) && headers.location) {
      body.destroy();
      return { location: headers.location };
    }
    if (statusCode < 200 || statusCode > 299) {
      body.destroy();
      return { url, status: statusCode, headers, body: new Uint8Array(0), truncated: false };
    }

    const declared = Number(headers["content-length"]);
    if (options.overflow === "reject" && Number.isFinite(declared) && declared > options.maxBytes) {
      body.destroy();
      throw new SafeFetchError("too-large", `Body of ${url.host} over ${options.maxBytes} bytes`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        if (total + chunk.length > options.maxBytes) {
          if (options.overflow === "reject") {
            body.destroy();
            throw new SafeFetchError("too-large", `Body of ${url.host} over ${options.maxBytes} bytes`);
          }
          chunks.push(chunk.subarray(0, options.maxBytes - total));
          total = options.maxBytes;
          truncated = true;
          body.destroy();
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      if (signal.aborted) throw new SafeFetchError("aborted", "Deadline passed");
      throw new SafeFetchError("network", `Reading from ${url.host} failed`);
    }
    return { url, status: statusCode, headers, body: concat(chunks, total), truncated };
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}

/** Resolve once and refuse the host if any answer is not a public address. */
async function vetHost(hostname: string, lookup: LookupAll, signal: AbortSignal): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await untilAborted(lookup(hostname), signal);
  } catch {
    if (signal.aborted) throw new SafeFetchError("aborted", "Deadline passed");
    throw new SafeFetchError("network", `DNS lookup of ${hostname} failed`);
  }
  if (addresses.length === 0) throw new SafeFetchError("network", `DNS lookup of ${hostname} found nothing`);
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new SafeFetchError("blocked", `${hostname} resolves to a non-public address`);
  }
  return addresses;
}

/**
 * A `net.connect` lookup that answers only `hostname`, and only with the already-vetted
 * `addresses` — the socket never asks DNS again.
 */
export function pinnedLookup(hostname: string, addresses: LookupAddress[]): LookupFunction {
  const expected = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (requested, options, callback) => {
    if (requested.replace(/^\[|\]$/g, "").toLowerCase() !== expected || addresses.length === 0) {
      const error: NodeJS.ErrnoException = new Error(`Refusing to resolve ${requested}`);
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const matching = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (matching.length === 0) {
      const error: NodeJS.ErrnoException = new Error(`No IPv${family} address for ${requested}`);
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if (options.all) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SafeFetchError("aborted", "Deadline passed"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function flattenHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) headers[name.toLowerCase()] = first;
  }
  return headers;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** [network, prefix length] over the 32-bit address. */
const BLOCKED_V4: Array<[number, number, number, number, number]> = [
  [0, 0, 0, 0, 8], // "this network", unspecified
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // CGNAT (incl. 100.100.100.200, Alibaba metadata)
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local (incl. 169.254.169.254 metadata)
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 88, 99, 0, 24], // 6to4 relay anycast
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4] // reserved, incl. 255.255.255.255 broadcast
];

/** Explicitly named cloud metadata addresses (each is also inside a blocked range). */
const METADATA_ADDRESSES = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);

/**
 * True when `ip` is anything but a public unicast address: loopback, unspecified, private,
 * link-local, CGNAT, ULA, multicast, reserved, benchmarking, documentation, metadata — and the
 * IPv4-mapped/compatible/translated, NAT64 and 6to4 forms of blocked IPv4 addresses. IPv6 outside
 * global unicast `2000::/3` is refused outright. Anything unparsable counts as blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const address = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (METADATA_ADDRESSES.has(address)) return true;
  if (isIPv4(address)) return isBlockedV4(address.split(".").map(Number));
  if (isIPv6(address)) {
    const bytes = parseIPv6(address);
    return bytes === null || isBlockedV6(bytes);
  }
  return true;
}

function isBlockedV4(octets: number[]): boolean {
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return BLOCKED_V4.some(([a, b, c, d, prefix]) => {
    const network = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === network;
  });
}

function isBlockedV6(b: number[]): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((byte) => byte === 0);
  const tailV4 = () => isBlockedV4(b.slice(12, 16));

  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible form: never a website.
  if (zeros(0, 12)) return true;
  // ::ffff:a.b.c.d — IPv4-mapped.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return tailV4();
  // ::ffff:0:a.b.c.d — IPv4-translated (SIIT).
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return tailV4();
  // 64:ff9b::/96 — NAT64 well-known prefix.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return tailV4();
  // 64:ff9b:1::/48 — local-use NAT64.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) return true;
  // 2002::/16 — 6to4, the IPv4 address in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(b.slice(2, 6));

  // Everything else must be global unicast 2000::/3 (this excludes fc00::/7 ULA, fe80::/10
  // link-local, fec0::/10 site-local, ff00::/8 multicast, 100::/64 discard and the rest).
  if ((b[0] & 0xe0) !== 0x20) return true;
  // 2001::/23 — IETF protocol assignments (Teredo, benchmarking 2001:2::/48, ORCHID).
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return true;
  // 2001:db8::/32 — documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  // 3fff::/20 — documentation.
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return true;
  return false;
}

/** 16 bytes of a textual IPv6 address (already validated by `isIPv6`), incl. a dotted IPv4 tail. */
function parseIPv6(address: string): number[] | null {
  let text = address;
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    if (!isIPv4(v4[1])) return null;
    tail = v4[1].split(".").map(Number);
    text = text.slice(0, -v4[1].length) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}
