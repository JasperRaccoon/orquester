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
