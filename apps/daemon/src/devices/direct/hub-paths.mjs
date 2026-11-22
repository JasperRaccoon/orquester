// Allowlists adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/server/src/device/DeviceHubProxy.ts
/**
 * The hub paths a viewer may reach, and the headers that may pass, in ONE place: the daemon's hub
 * proxy (`../hub-proxy.ts`) and the stream gate on the owner's machines (`gate.mjs`, which uploads
 * this file beside itself) both read them. Plain JavaScript with no imports, so the gate runs it on
 * the machine unchanged (types in `hub-paths.d.mts`).
 *
 * Only the paths the Device panel uses: the device list, serve-sim helper streams, input socket and
 * screenshot, serve-emu socket, screenshot and fold. serve-sim's grid start is the box host's own
 * call, never a client's; shell or exec routes are never here.
 */

const READ = ["GET", "HEAD"];

/**
 * One allowed HTTP path: `device` says where the device is named (the `device` query parameter, the
 * pattern's first group, or nowhere); `stream` marks a long-lived video response (a viewer while
 * open); `input` a POST that changes the device (the user's input).
 */
export const HUB_HTTP_ROUTES = Object.freeze([
  { pattern: /^\/api\/devices$/, methods: READ, device: "none" },
  { pattern: /^\/vendor\/serve-sim\/helper\/([^/]+)\/(?:stream\.mjpeg|stream\.avcc)$/, methods: READ, device: "path", stream: true },
  // serve-sim screenshots the first booted simulator when `device` is missing: always name a leased one.
  { pattern: /^\/vendor\/serve-sim\/api\/screenshot$/, methods: ["POST"], device: "query" },
  // serve-emu answers its screenshot to POST only (the panel's poll for browsers without WebCodecs).
  { pattern: /^\/vendor\/serve-emu\/api\/screenshot$/, methods: [...READ, "POST"], device: "query" },
  { pattern: /^\/vendor\/serve-emu\/api\/fold$/, methods: [...READ, "POST"], device: "query", input: true }
]);

/** One allowed WebSocket path: every client message is input, except serve-emu's `reset-video` (`control`). */
export const HUB_WS_ROUTES = Object.freeze([
  { pattern: /^\/vendor\/serve-sim\/helper\/ws$/ },
  { pattern: /^\/vendor\/serve-emu\/ws$/, control: "reset-video" }
]);

/** Request headers that may go upstream (everything else — cookies, credentials, forwarding — stays). */
export const FORWARDED_REQUEST_HEADERS = Object.freeze(["accept", "accept-language", "content-type", "content-length", "range", "if-none-match", "if-modified-since", "user-agent"]);
/** Response headers that may come back. */
export const FORWARDED_RESPONSE_HEADERS = Object.freeze(["content-type", "content-length", "content-encoding", "content-range", "accept-ranges", "etag", "last-modified", "content-disposition"]);
/** Subprotocols the hub reads as its token (`serve-sim.token.<t>`, `serve-emu.token.<t>`): a client's never pass. */
export const TOKEN_SUBPROTOCOL = /^serve-(?:sim|emu)\.token\./;

/** The HTTP route and its match for a hub path, or null when the path is not allowed. */
export function matchHubHttpRoute(path) {
  for (const route of HUB_HTTP_ROUTES) {
    const match = route.pattern.exec(path);
    if (match) return { route, match };
  }
  return null;
}

/** The WebSocket route for a hub path, or null. */
export function matchHubWsRoute(path) {
  return HUB_WS_ROUTES.find((route) => route.pattern.test(path)) ?? null;
}

/** The device a request names, from its query or its path; null when it names none (or names it unreadably). */
export function hubDeviceOf(match, where, search) {
  if (where === "path") {
    try {
      return decodeURIComponent(match[1] ?? "");
    } catch {
      return null;
    }
  }
  if (where === "none") return null;
  const device = new URLSearchParams(search).get("device");
  return device === null || device === "" ? null : device;
}

/** serve-emu's `{"type":"reset-video"}`: a viewer's request for a key frame, not input. */
export function isResetVideoText(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && value.type === "reset-video";
  } catch {
    return false;
  }
}
