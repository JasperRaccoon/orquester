/**
 * Which way the viewer streams a device (tailnet machines spec §4.5): straight from the owner's
 * machine over the tailnet or the LAN, or through the daemon. Pure: the hook
 * (`useStreamRoute.ts`) feeds events and the clock in and runs the probes this asks for.
 *
 * - {@link usableRoutes}: what this client may use of the daemon's ordered routes (an HTTPS page
 *   never loads plain `http`/`ws`; `lan` routes are the desktop app's).
 * - {@link probeRoute}: the identity check before a ticket goes anywhere — the route's public
 *   identity endpoint must name the expected host and machine (an address now held by another
 *   device never receives a ticket).
 * - {@link stepRoute}: the roaming state machine. Every evaluation probes the direct routes; the
 *   best one that passes (the daemon always does) wins. A route that fails (its probe, or its stream
 *   once connected) is left at once; a better one is taken only {@link ROUTE_SWITCH_COOLDOWN_MS}
 *   after the last switch, so a flaky path cannot flap. Evaluations run on new routes, on a network
 *   change, on resume, and every {@link ROUTE_REEVALUATE_MS} while on a slower route.
 */

import { DEVICE_HOST_IDENTITY_PATH, type DeviceStreamRoute } from "@orquester/api";

export type { DeviceStreamRoute };

/** While on a slower route, how often a better one is tried again. */
export const ROUTE_REEVALUATE_MS = 60_000;
/** After a switch, how long before a better route is taken (a failing one is left at once). */
export const ROUTE_SWITCH_COOLDOWN_MS = 30_000;
/** How long a probe may take: a LAN answers fast or not at all; a tailnet path may relay through DERP. */
export const ROUTE_PROBE_TIMEOUT_MS: Readonly<Record<"lan" | "tailnet", number>> = { lan: 1_500, tailnet: 6_000 };

/** The client the routes are for. */
export interface RouteClient {
  /** The desktop app (its pages may load plain `http`/`ws` from a LAN address). */
  desktop: boolean;
  /** The page is served over HTTPS (a browser blocks `http`/`ws` from it as mixed content). */
  secure: boolean;
}

/** The routes this client may try, best first; the daemon's always last. */
export function usableRoutes(routes: readonly DeviceStreamRoute[], client: RouteClient): DeviceStreamRoute[] {
  const out: DeviceStreamRoute[] = [];
  for (const route of routes) {
    if (route.kind === "daemon") continue;
    if (route.kind === "lan" && !client.desktop) continue;
    const plain = /^http:/i.test(route.url);
    if (plain && client.secure && !client.desktop) continue;
    if (!/^https?:\/\//i.test(route.url)) continue;
    if (!out.some((seen) => seen.url === route.url)) out.push(route);
  }
  const daemon = routes.find((route) => route.kind === "daemon");
  out.push(daemon ?? { kind: "daemon", url: "" });
  return out;
}

/** The identity a direct route must answer. */
export interface ExpectedIdentity {
  hostId: string;
  machineId: string;
}

/**
 * Whether a direct route reaches the expected machine: GET its identity endpoint within the
 * route's probe timeout; true only for exactly `{hostId, machineId}`. Never sends the ticket.
 */
export async function probeRoute(route: DeviceStreamRoute, expected: ExpectedIdentity, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<boolean> {
  if (route.kind === "daemon") return true;
  const timeout = AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS[route.kind]);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await (options.fetch ?? fetch)(`${route.url.replace(/\/+$/, "")}${DEVICE_HOST_IDENTITY_PATH}`, { signal, cache: "no-store", credentials: "omit" });
    if (!response.ok) return false;
    const body = (await response.json()) as { hostId?: unknown; machineId?: unknown } | null;
    return body?.hostId === expected.hostId && body.machineId === expected.machineId;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The roaming state machine
// ---------------------------------------------------------------------------

export interface StreamRouteState {
  /** Usable routes, best first, the daemon's last. */
  routes: DeviceStreamRoute[];
  /** The route in use; null before the first evaluation ends. */
  active: DeviceStreamRoute | null;
  /** Probes are out. */
  evaluating: boolean;
  /** Something changed while probing: evaluate once more when the answers arrive. */
  again: boolean;
  lastEvalAt: number | null;
  lastSwitchAt: number | null;
  /** Routes whose stream failed since the last network change, resume or periodic retry: skipped. */
  failed: string[];
}

export type StreamRouteEvent =
  /** A ticket answer's routes (already {@link usableRoutes}). */
  | { type: "routes"; routes: DeviceStreamRoute[]; now: number }
  /** `online` / `offline` / a `navigator.connection` change. */
  | { type: "network"; now: number }
  /** The app came back (visible again). */
  | { type: "resume"; now: number }
  | { type: "tick"; now: number }
  /** The answers to the last probe request, by route URL. */
  | { type: "probed"; results: Readonly<Record<string, boolean>>; now: number }
  /** The active route's stream failed after connecting. */
  | { type: "stream-failed"; now: number };

export interface StreamRouteStep {
  state: StreamRouteState;
  /** Direct routes to probe now (best first); null: none. */
  probe: DeviceStreamRoute[] | null;
}

export const INITIAL_ROUTE_STATE: StreamRouteState = { routes: [], active: null, evaluating: false, again: false, lastEvalAt: null, lastSwitchAt: null, failed: [] };

const rank = (routes: readonly DeviceStreamRoute[], route: DeviceStreamRoute | null): number => (route ? routes.findIndex((entry) => entry.url === route.url && entry.kind === route.kind) : -1);
const daemonOf = (routes: readonly DeviceStreamRoute[]): DeviceStreamRoute => routes.find((route) => route.kind === "daemon") ?? { kind: "daemon", url: "" };

/** Probe the direct routes (or settle on the daemon when there are none). */
function evaluate(state: StreamRouteState, now: number): StreamRouteStep {
  if (state.evaluating) return { state: { ...state, again: true }, probe: null };
  const direct = state.routes.filter((route) => route.kind !== "daemon");
  if (direct.length === 0) {
    const daemon = daemonOf(state.routes);
    const switched = state.active?.url !== daemon.url || state.active.kind !== "daemon";
    return { state: { ...state, active: daemon, lastEvalAt: now, ...(switched ? { lastSwitchAt: state.active ? now : null } : {}) }, probe: null };
  }
  return { state: { ...state, evaluating: true, again: false, lastEvalAt: now }, probe: direct };
}

function settle(state: StreamRouteState, results: Readonly<Record<string, boolean>>, now: number): StreamRouteState {
  const ok = (route: DeviceStreamRoute) => route.kind === "daemon" || (results[route.url] === true && !state.failed.includes(route.url));
  const best = state.routes.find(ok) ?? daemonOf(state.routes);
  const current = state.active;
  const base = { ...state, evaluating: false };
  if (!current) return { ...base, active: best, lastSwitchAt: null };
  const currentRank = rank(state.routes, current);
  if (currentRank >= 0 && best.url === current.url && best.kind === current.kind) return base;
  // The route in use is gone or failed: leave it at once.
  if (currentRank < 0 || !ok(state.routes[currentRank]!)) return { ...base, active: best, lastSwitchAt: now };
  // A better route: only once the last switch has settled.
  const settled = state.lastSwitchAt === null || now - state.lastSwitchAt >= ROUTE_SWITCH_COOLDOWN_MS;
  return settled ? { ...base, active: best, lastSwitchAt: now } : base;
}

export function stepRoute(state: StreamRouteState, event: StreamRouteEvent): StreamRouteStep {
  switch (event.type) {
    case "routes": {
      const same = event.routes.length === state.routes.length && event.routes.every((route, index) => route.kind === state.routes[index]?.kind && route.url === state.routes[index]?.url);
      if (same && state.active) return { state, probe: null };
      return evaluate({ ...state, routes: event.routes, failed: state.failed.filter((url) => event.routes.some((route) => route.url === url)) }, event.now);
    }
    case "network":
    case "resume":
      return evaluate({ ...state, failed: [] }, event.now);
    case "tick": {
      const slower = state.active !== null && rank(state.routes, state.active) > 0;
      if (!slower || state.evaluating || (state.lastEvalAt !== null && event.now - state.lastEvalAt < ROUTE_REEVALUATE_MS)) return { state, probe: null };
      return evaluate({ ...state, failed: [] }, event.now);
    }
    case "probed": {
      if (!state.evaluating) return { state, probe: null };
      const next = settle(state, event.results, event.now);
      return next.again ? evaluate({ ...next, again: false }, event.now) : { state: next, probe: null };
    }
    case "stream-failed": {
      const active = state.active;
      if (!active || active.kind === "daemon") return { state, probe: null };
      return evaluate({ ...state, failed: [...state.failed.filter((url) => url !== active.url), active.url] }, event.now);
    }
  }
}

/** The panel's quiet note about the route in use. */
export function routeLabel(route: DeviceStreamRoute | null): string | null {
  if (!route) return null;
  if (route.kind === "tailnet") return "Direct · tailnet";
  if (route.kind === "lan") return "Direct · LAN";
  return "Via Orquester";
}

// ---------------------------------------------------------------------------
// Direct URLs
// ---------------------------------------------------------------------------

/** A device's stream on a direct route: the same hub paths at the machine's own base URL (the ticket is added at each connect). */
export function directStreamUrls(route: DeviceStreamRoute, stream: { kind: string; deviceParam: string }): { video: string; input?: string; screenshot?: string } | null {
  const base = route.url.replace(/\/+$/, "");
  const socketBase = base.replace(/^http/i, "ws");
  const device = `device=${encodeURIComponent(stream.deviceParam)}`;
  if (stream.kind === "serve-emu") return { video: `${socketBase}/vendor/serve-emu/ws?${device}`, screenshot: `${base}/vendor/serve-emu/api/screenshot?${device}` };
  if (stream.kind === "serve-sim") {
    return { video: `${base}/vendor/serve-sim/helper/${encodeURIComponent(stream.deviceParam)}/stream.avcc`, input: `${socketBase}/vendor/serve-sim/helper/ws?${device}` };
  }
  return null;
}

/** A stream ticket answer as the client trusts it: well-formed routes only (else null). */
export function readTicketResponse(value: unknown): { routes: DeviceStreamRoute[]; ticket: string; expiresAt: number; machineId: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.routes) || typeof body.ticket !== "string" || typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)) return null;
  const routes: DeviceStreamRoute[] = [];
  for (const entry of body.routes) {
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, url } = entry as Record<string, unknown>;
    if ((kind === "tailnet" || kind === "lan" || kind === "daemon") && typeof url === "string") routes.push({ kind, url });
  }
  return { routes, ticket: body.ticket, expiresAt: body.expiresAt, machineId: typeof body.machineId === "string" && body.machineId !== "" ? body.machineId : null };
}
