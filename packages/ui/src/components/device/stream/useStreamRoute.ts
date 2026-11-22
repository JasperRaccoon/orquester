/**
 * `useStreamRoute` picks, and keeps re-picking, the way one device streams while `enabled`
 * (tailnet machines spec §4.5): it asks the daemon for the routes and a ticket
 * (`deviceRoutes.streamTicket`), checks a direct route's identity before using it, renews the
 * ticket before it expires (without reconnecting: the stream reads {@link StreamRouteHandle.ticket}
 * at each connect), and feeds the roaming state machine (`routes.ts`) with network changes,
 * resume, a periodic tick and stream failures. The daemon's proxy is the answer whenever nothing
 * better works, including a daemon that does not offer tickets.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DeviceStreamTicketRequest } from "@orquester/api";

import {
  INITIAL_ROUTE_STATE,
  probeRoute,
  readTicketResponse,
  stepRoute,
  usableRoutes,
  type DeviceStreamRoute,
  type ExpectedIdentity,
  type RouteClient,
  type StreamRouteEvent,
  type StreamRouteStep
} from "./routes.ts";

/** What the hook needs from `ApiClient`. */
export interface StreamTicketApi {
  deviceStreamTicket(hostId: string, req: DeviceStreamTicketRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface UseStreamRouteOptions {
  api: StreamTicketApi | null;
  hostId: string;
  /** The hub's `device` parameter; null while the lease has no stream. */
  deviceParam: string | null;
  enabled: boolean;
}

export interface StreamRouteHandle {
  /** The route in use; null while the first choice is made. */
  route: DeviceStreamRoute | null;
  /** The current ticket (direct routes; read at each connect). */
  ticket(): string;
  /** The stream on the active route failed: leave it if it is a direct one. */
  reportFailure(): void;
}

/** Renew this long before the ticket expires. */
const RENEW_BEFORE_MS = 30_000;
/** A failed ticket request is asked again after this. */
const TICKET_RETRY_MS = 30_000;
/** How often the roaming clock ticks (it re-evaluates only every `ROUTE_REEVALUATE_MS`). */
const TICK_MS = 15_000;

/** This client: the desktop app (its preload bridge), and whether the page is HTTPS. */
export function currentRouteClient(): RouteClient {
  if (typeof window === "undefined") return { desktop: false, secure: true };
  const desktop = (window as unknown as { orquesterDesktop?: unknown }).orquesterDesktop !== undefined;
  return { desktop, secure: window.location?.protocol === "https:" };
}

interface NetworkInformationLike {
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

const sameRoute = (a: DeviceStreamRoute | null, b: DeviceStreamRoute | null): boolean => a === b || (a !== null && b !== null && a.kind === b.kind && a.url === b.url);

export function useStreamRoute(options: UseStreamRouteOptions): StreamRouteHandle {
  const { api, hostId, deviceParam, enabled } = options;
  const [route, setRoute] = useState<DeviceStreamRoute | null>(null);
  const ticketRef = useRef("");
  const failRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled || !api || !deviceParam) {
      setRoute(null);
      return;
    }
    let alive = true;
    let state = INITIAL_ROUTE_STATE;
    let expected: ExpectedIdentity | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = new AbortController();
    const client = currentRouteClient();

    const apply = (step: StreamRouteStep) => {
      state = step.state;
      const next = state.active;
      setRoute((prev) => (sameRoute(prev, next) ? prev : next));
      if (step.probe) probe(step.probe);
    };
    const dispatch = (event: StreamRouteEvent) => {
      if (alive) apply(stepRoute(state, event));
    };
    const probe = (routes: DeviceStreamRoute[]) => {
      const identity = expected;
      void Promise.all(routes.map(async (entry) => [entry.url, identity ? await probeRoute(entry, identity, { signal: abort.signal }) : false] as const)).then((entries) =>
        dispatch({ type: "probed", results: Object.fromEntries(entries), now: Date.now() })
      );
    };
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void ask(), Math.max(5_000, ms));
    };
    const ask = async () => {
      try {
        const answer = readTicketResponse(await api.deviceStreamTicket(hostId, { deviceId: deviceParam, client: client.desktop ? "desktop" : "browser" }, abort.signal));
        if (!alive) return;
        if (!answer) throw new Error("unreadable stream ticket");
        ticketRef.current = answer.ticket;
        expected = answer.machineId ? { hostId, machineId: answer.machineId } : null;
        // Without the machine to check against, no direct route is tried.
        const routes = usableRoutes(expected ? answer.routes : answer.routes.filter((entry) => entry.kind === "daemon"), client);
        dispatch({ type: "routes", routes, now: Date.now() });
        schedule(answer.expiresAt - Date.now() - RENEW_BEFORE_MS);
      } catch {
        if (!alive) return;
        // An older daemon, or the request failed: the daemon's proxy until a later answer offers more.
        if (!state.active) dispatch({ type: "routes", routes: usableRoutes([], client), now: Date.now() });
        schedule(TICKET_RETRY_MS);
      }
    };
    void ask();

    const onNetwork = () => dispatch({ type: "network", now: Date.now() });
    const onVisible = () => {
      if (document.visibilityState === "visible") dispatch({ type: "resume", now: Date.now() });
    };
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    window.addEventListener("online", onNetwork);
    window.addEventListener("offline", onNetwork);
    connection?.addEventListener("change", onNetwork);
    document.addEventListener("visibilitychange", onVisible);
    const tick = setInterval(() => dispatch({ type: "tick", now: Date.now() }), TICK_MS);
    failRef.current = () => dispatch({ type: "stream-failed", now: Date.now() });

    return () => {
      alive = false;
      abort.abort();
      if (timer) clearTimeout(timer);
      clearInterval(tick);
      window.removeEventListener("online", onNetwork);
      window.removeEventListener("offline", onNetwork);
      connection?.removeEventListener("change", onNetwork);
      document.removeEventListener("visibilitychange", onVisible);
      failRef.current = () => undefined;
      ticketRef.current = "";
      setRoute(null);
    };
  }, [enabled, api, hostId, deviceParam]);

  const ticket = useCallback(() => ticketRef.current, []);
  const reportFailure = useCallback(() => failRef.current(), []);
  return { route, ticket, reportFailure };
}
