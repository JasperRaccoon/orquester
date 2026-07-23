/**
 * Helpers for the embedded-DevTools proxy: the daemon reverse-proxies the
 * Chromium debug endpoint (frontend assets + per-tab CDP WebSocket) so the
 * real, version-matched DevTools frontend can attach to a browser tab. Pure
 * functions only — the routes live in index.ts, the port ownership in
 * browsers.ts.
 */

/** Extract the loopback debug port from puppeteer's browser.wsEndpoint()
 *  (`ws://127.0.0.1:<port>/devtools/browser/<id>`). Null when unparseable. */
export function parseDebugPort(wsEndpoint: string): number | null {
  try {
    const port = Number(new URL(wsEndpoint).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Validate the wildcard tail of /devtools-frontend/:browserId/* before it is
 * appended to the upstream /devtools/ path. Rejects traversal (raw or
 * percent-encoded), backslashes, empty segments and absurd lengths — the
 * upstream also serves /json/* (page URLs/titles), which must stay unreachable
 * through this proxy.
 */
export function sanitizeDevtoolsPath(rest: string): string | null {
  if (typeof rest !== "string" || rest.length === 0 || rest.length > 2048) return null;
  if (rest.includes("\\") || rest.includes("\0")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  for (const candidate of [rest, decoded]) {
    if (candidate.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  }
  return rest;
}

/**
 * Redact credentials from a request URL before it reaches the logs: the plain
 * `?token=` form (WS auth + /api/fs/download) AND its percent-encoded form
 * `token%3D`, which appears inside the DevTools iframe's nested `?wss=` value
 * on /devtools-frontend inspector.html requests — the plain-form regex alone
 * would log the credential there.
 */
export function redactUrlTokens(url: string): string {
  return url
    .replace(/([?&]token=)[^&]*/gi, "$1[redacted]")
    .replace(/(token%3D)[^&]*/gi, "$1[redacted]");
}
