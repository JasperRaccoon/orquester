import { createHash } from "node:crypto";

/**
 * The body as hashed for dedup and the embedding cache: NFC, trimmed, every whitespace run
 * collapsed to one space. The stored body stays verbatim.
 */
export function normalizeKnowledgeBody(body: string): string {
  return body.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** sha256 hex of {@link normalizeKnowledgeBody}. */
export function knowledgeContentHash(body: string): string {
  return createHash("sha256").update(normalizeKnowledgeBody(body), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "ref_url",
  "si",
  "_hsenc",
  "_hsmi",
  "mkt_tok"
]);
/** X's share links append `?s=20&t=…`; on x.com they never change what is shown. */
const X_SHARE_PARAMS = new Set(["s", "t", "src", "lang"]);
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com"]);

/**
 * The URL as compared for dedup: https, lowercase host without `www.`, `twitter.com` ≡ `x.com`
 * (and an X post's path reduced to its status id), tracking parameters and the fragment dropped,
 * the remaining parameters sorted, no trailing slash. `null` when it is not an http(s) URL.
 */
export function normalizeKnowledgeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  const isX = X_HOSTS.has(host);
  if (isX) host = "x.com";
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (isX) {
    const status = /^\/(?:[^/]+|i\/web|i)\/status(?:es)?\/(\d+)/i.exec(path);
    if (status) path = `/i/status/${status[1]}`;
    else path = path.toLowerCase();
  }
  path = path.replace(/\/+$/, "");
  const params = [...url.searchParams.entries()]
    .filter(([key]) => {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_")) return false;
      if (TRACKING_PARAMS.has(lower)) return false;
      if (isX && X_SHARE_PARAMS.has(lower)) return false;
      return true;
    })
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  return `https://${host}${port}${path}${query}`;
}

// ---------------------------------------------------------------------------
// Near-duplicate text
// ---------------------------------------------------------------------------

/** Near-identical: shingle Jaccard at least this (and so lengths within the same ratio). */
export const NEAR_DUPLICATE_JACCARD = 0.9;
/** MinHash pre-filter: candidates whose estimate reaches this get an exact comparison. */
const MINHASH_CANDIDATE = 0.75;
const MINHASH_SIZE = 64;
const SHINGLE = 3;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** murmur3's finalizer: a cheap, well-mixed 32-bit permutation. */
function mix(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS = Array.from({ length: MINHASH_SIZE }, (_, i) => mix(0x9e3779b9 * (i + 1)));

function words(body: string): string[] {
  return normalizeKnowledgeBody(body).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The body's word 3-shingles, hashed (the words themselves for a body under three words). */
export function knowledgeShingles(body: string): Set<number> {
  const tokens = words(body);
  const out = new Set<number>();
  if (tokens.length < SHINGLE) {
    for (const token of tokens) out.add(fnv1a(token));
    return out;
  }
  for (let i = 0; i + SHINGLE <= tokens.length; i += 1) out.add(fnv1a(tokens.slice(i, i + SHINGLE).join(" ")));
  return out;
}

export function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const value of small) if (large.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** A compact, deterministic fingerprint of a body kept in memory for every entry. */
export interface KnowledgeTextSignature {
  shingleCount: number;
  minhash: Uint32Array;
}

export function knowledgeTextSignature(shingles: ReadonlySet<number>): KnowledgeTextSignature {
  const minhash = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let i = 0; i < MINHASH_SIZE; i += 1) {
      const value = mix(shingle ^ SEEDS[i]!);
      if (value < minhash[i]!) minhash[i] = value;
    }
  }
  return { shingleCount: shingles.size, minhash };
}

/**
 * Whether two signatures may be near-identical: similar sizes (Jaccard ≥ t implies a size ratio
 * ≥ t) and a MinHash estimate high enough to be worth the exact comparison.
 */
export function mayBeNearDuplicate(a: KnowledgeTextSignature, b: KnowledgeTextSignature): boolean {
  const small = Math.min(a.shingleCount, b.shingleCount);
  const large = Math.max(a.shingleCount, b.shingleCount);
  // No words at all (emoji, symbols): nothing to compare, so only an exact hash match is a duplicate.
  if (small === 0) return false;
  if (small / large < NEAR_DUPLICATE_JACCARD) return false;
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i += 1) if (a.minhash[i] === b.minhash[i]) same += 1;
  return same / MINHASH_SIZE >= MINHASH_CANDIDATE;
}
