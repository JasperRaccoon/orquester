/**
 * The `/api/fs/*` GET routes take their target path from the query string in
 * one of two spellings:
 *
 *   ?path=<url-encoded path>   the plain form (curl, scripts, older bundles)
 *   ?p=<base64url(path)>       what the shipped clients send
 *
 * The encoded form exists because browser ad blockers (uBlock, ABP, Brave
 * Shields…) filter on the raw request URL, query included. A file under a
 * `banners/` directory or named `*_300x250.jpg` matches EasyList's generic
 * rules and the fetch dies in the browser with ERR_BLOCKED_BY_CLIENT before
 * it reaches the daemon — the preview just says "failed to load". base64url
 * hides the file name from those filters; it is NOT a security measure, and
 * the decoded path goes through exactly the same `assertInsideFsRoot` check.
 *
 * Encoding is strict: a malformed `p` decodes to `undefined` (never to a
 * partially-decoded path, and never falling through to `path` — the client
 * chose one spelling, and silently reading the other would hide a broken
 * encoder). Callers treat `undefined` as "path required" (400).
 */

/** Query parameter name carrying the base64url-encoded path. */
export const FS_PATH_PARAM = "p";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Strict base64url → UTF-8 decode, or `undefined` for anything malformed. */
export function decodeFsPathParam(value: string): string | undefined {
  if (!value || !BASE64URL.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64url");
  // Buffer's decoder silently drops trailing bits; only accept an input that
  // round-trips exactly, so a truncated/garbled value can't resolve to a path.
  if (bytes.toString("base64url") !== value) {
    return undefined;
  }
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return path || undefined;
}

/**
 * Resolve the target path of an `/api/fs/*` request: `p` (base64url) when
 * present — malformed ⇒ `undefined` — otherwise the plain `path`.
 */
export function fsPathFromQuery(query: { path?: string; p?: string }): string | undefined {
  if (query.p !== undefined) {
    return decodeFsPathParam(query.p);
  }
  return query.path || undefined;
}
