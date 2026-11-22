/**
 * The tailnet service's decisions as pure functions: what one check of `tailscale serve` should do
 * about the daemon's HTTPS route and about each shared preview (spec 2026-11-22 §4.7.3–4). The
 * service (`service.ts`) gathers the facts, calls these, and runs what they answer.
 *
 * Ownership, the one rule: a route is Orquester's when it proxies to the daemon's live listener, or
 * when it sits on the port and target `tailnet.json` recorded Orquester creating. Any other route is
 * another app's: it is never changed, removed or taken over (`taken`).
 */

import { sameProxyTarget, type ProxyTarget, type ServeRoute } from "../boxes/tailscale/local.ts";

/** What the daemon's own route record says (`StoredTailnetHttps`, targets parsed). */
export interface HttpsRecord {
  enabled: boolean;
  port: number;
  /** The target Orquester created the route with; null when unknown. */
  target: ProxyTarget | null;
}

export interface HttpsCheckInput {
  /** Tailscale runs, is signed in, and `tailscale serve status` could be read. */
  serveKnown: boolean;
  /** The daemon's HTTP listener as a proxy target; null while the HTTP transport does not listen. */
  live: ProxyTarget | null;
  record: HttpsRecord | null;
  /** This machine's serve routes (`parseServeRoutes`). */
  routes: readonly ServeRoute[];
  /**
   * Whether the recorded target still answers. Only read when the route on the recorded port still
   * points at it and that is not the live listener; null when not probed.
   */
  recordTargetAlive: boolean | null;
}

export type HttpsDecision =
  /** Nothing wanted and nothing serving the daemon. */
  | { kind: "off" }
  /** Serve status could not be read: change nothing. */
  | { kind: "unknown" }
  /** Wanted, but the daemon's HTTP transport is not listening: nothing to serve. */
  | { kind: "http-off" }
  /** A route on `port` proxies to the live daemon. `adopt`: record it as Orquester's (it was made outside this service, or moved). */
  | { kind: "serving"; port: number; adopt: boolean }
  /** Wanted and missing, or Orquester's own route left pointing at a dead port: (re)create it on `port`. */
  | { kind: "create"; port: number; reason: "missing" | "stale" }
  /** Wanted, but `port` serves another app (`by`: its target, if it proxies). Nothing is changed. */
  | { kind: "taken"; port: number; by: string | null };

const proxiesTo = (route: ServeRoute, target: ProxyTarget): boolean => route.https && route.target !== null && sameProxyTarget(route.target, target);

/** The daemon's HTTPS route: one check's decision. */
export function decideHttps(input: HttpsCheckInput): HttpsDecision {
  if (!input.serveKnown) return { kind: "unknown" };
  const { live, record } = input;
  if (live) {
    const serving = input.routes.filter((route) => proxiesTo(route, live));
    if (serving.length > 0) {
      const port = (record && serving.find((route) => route.port === record.port)?.port) ?? serving[0]!.port;
      const adopt = !record || !record.enabled || record.port !== port || record.target === null || !sameProxyTarget(record.target, live);
      return { kind: "serving", port, adopt };
    }
  }
  if (!record?.enabled) return { kind: "off" };
  if (!live) return { kind: "http-off" };
  const route = input.routes.find((candidate) => candidate.port === record.port);
  if (!route) return { kind: "create", port: record.port, reason: "missing" };
  const ours = record.target !== null && route.target !== null && sameProxyTarget(route.target, record.target);
  // Our own route, left pointing at a port nothing answers on any more (the daemon moved): repoint it.
  if (ours && input.recordTargetAlive === false) return { kind: "create", port: record.port, reason: "stale" };
  return { kind: "taken", port: record.port, by: route.target?.url ?? null };
}

/**
 * The HTTPS port to set the daemon up on: the recorded one when it is free (or is Orquester's own
 * stale route), else the first candidate no route uses. Null when every candidate is taken.
 */
export function chooseHttpsPort(input: {
  record: HttpsRecord | null;
  routes: readonly ServeRoute[];
  usedPorts: readonly number[];
  candidates: readonly number[];
  /** Ports held by Orquester's shared previews. */
  previewPorts: ReadonlySet<number>;
  recordTargetAlive: boolean | null;
}): number | null {
  const { record } = input;
  if (record) {
    const route = input.routes.find((candidate) => candidate.port === record.port);
    const stale = route !== undefined && record.target !== null && route.target !== null && sameProxyTarget(route.target, record.target) && input.recordTargetAlive === false;
    if ((!route && !input.usedPorts.includes(record.port)) || stale) return record.port;
  }
  return input.candidates.find((port) => !input.usedPorts.includes(port) && !input.previewPorts.has(port)) ?? null;
}

/**
 * The routes Orquester may remove when the owner turns the tailnet address off: those proxying to
 * the live daemon, and the recorded one while it still points at the recorded target.
 */
export function ownHttpsRoutes(input: { live: ProxyTarget | null; record: HttpsRecord | null; routes: readonly ServeRoute[] }): number[] {
  const { live, record } = input;
  return input.routes
    .filter(
      (route) =>
        (live !== null && proxiesTo(route, live)) ||
        (record !== null && route.port === record.port && record.target !== null && route.target !== null && sameProxyTarget(route.target, record.target))
    )
    .map((route) => route.port);
}

/** A shared preview as one check sees it. */
export interface PreviewCheckInput {
  port: number;
  /** The target Orquester created its route with. */
  target: ProxyTarget;
  routes: readonly ServeRoute[];
  /** Something answers on the target now. */
  listening: boolean;
  /** Consecutive earlier checks that found nothing listening. */
  misses: number;
}

/** Checks in a row a preview's port may be silent (a dev server restarting) before its share goes. */
export const PREVIEW_MISSES_BEFORE_REMOVAL = 2;

export type PreviewDecision =
  /** Still served and listening. */
  | { kind: "keep" }
  /** Nothing listened this time; count it. */
  | { kind: "miss"; misses: number }
  /** The port stopped listening: remove Orquester's route and forget the share. */
  | { kind: "remove" }
  /** The route is gone or now another app's: forget the share without touching serve config. */
  | { kind: "forget" };

export function decidePreview(input: PreviewCheckInput): PreviewDecision {
  const route = input.routes.find((candidate) => candidate.port === input.port);
  if (!route || route.target === null || !sameProxyTarget(route.target, input.target)) return { kind: "forget" };
  if (input.listening) return { kind: "keep" };
  const misses = input.misses + 1;
  return misses >= PREVIEW_MISSES_BEFORE_REMOVAL ? { kind: "remove" } : { kind: "miss", misses };
}
