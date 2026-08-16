import { useCallback, useEffect, useRef, useState } from "react";
import type { SystemPortsResponse, SystemProcessesResponse, SystemResourcesResponse } from "@orquester/api";
import { usePollWhileActive } from "../../hooks";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";

/**
 * Poll interval for every System surface. The daemon serves `/api/system/*` from
 * a ~2–2.5 s cache, so anything faster only burns wakeups; anything slower makes
 * the top-bar chip feel frozen. `usePollWhileActive` already skips ticks while
 * the document is hidden, and `active` is false whenever the surface is closed —
 * there is no background poller.
 */
export const SYSTEM_POLL_MS = 3000;

export interface SystemPoll<T> {
  /** Last good payload; kept across a failed tick so the panel doesn't flicker. */
  data: T | null;
  /** Message for the most recent failed read, cleared by the next good one. */
  error: string | null;
  /** True until the first read settles. */
  loading: boolean;
  /** The daemon has no such route (older build) — polling has stopped for good. */
  unavailable: boolean;
  refresh: () => void;
}

function errorMessage(error: unknown): string {
  const message = (error as { serverMessage?: string | null } | null)?.serverMessage;
  if (typeof message === "string" && message) {
    return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * One visibility-gated poller. `load` is read through a ref so callers may pass
 * an inline lambda; an in-flight read suppresses the next tick, so a slow host
 * can never queue requests behind itself. `stopWhen` retires the timer for good
 * on a terminal answer — an off-Linux daemon answers `supported: false` forever,
 * and re-asking it every 3 s buys nothing.
 */
function usePolledResource<T>(
  active: boolean,
  load: (signal: AbortSignal) => Promise<T>,
  stopWhen: (value: T) => boolean,
  intervalMs = SYSTEM_POLL_MS
): SystemPoll<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [stopped, setStopped] = useState(false);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const stopWhenRef = useRef(stopWhen);
  stopWhenRef.current = stopWhen;

  const run = useCallback(() => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    const ctl = new AbortController();
    controller.current = ctl;
    setLoading(true);
    loadRef.current(ctl.signal)
      .then((next) => {
        if (ctl.signal.aborted) {
          return;
        }
        setData(next);
        setError(null);
        if (stopWhenRef.current(next)) {
          setStopped(true);
        }
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) {
          return;
        }
        // A 404 means this daemon predates the route: stop polling rather than
        // hammer it every 3 s for something it will never serve.
        if (statusOf(err) === 404) {
          setUnavailable(true);
        }
        setError(errorMessage(err));
      })
      .finally(() => {
        inFlight.current = false;
        // Unconditional: an abort that lands between the read settling and this
        // callback must not leave the spinner running forever.
        setLoading(false);
      });
  }, []);

  const polling = active && !unavailable && !stopped;

  useEffect(() => {
    if (!polling) {
      return;
    }
    run();
    return () => {
      // Leaving the surface drops the in-flight read too — its result would only
      // land in state nobody is looking at.
      controller.current?.abort();
      controller.current = null;
      inFlight.current = false;
    };
  }, [polling, run]);

  usePollWhileActive(polling, run, intervalMs);

  return { data, error, loading, unavailable, refresh: run };
}

/** True while the active daemon is reachable — nothing polls a dead transport. */
export function useSystemPollEnabled(surfaceVisible: boolean): boolean {
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  return surfaceVisible && connected;
}

/** Host gating is permanent for the life of a daemon: stop asking once refused. */
const unsupported = (value: { supported: boolean }): boolean => !value.supported;

export function useSystemResources(active: boolean): SystemPoll<SystemResourcesResponse> {
  const api = useApi();
  return usePolledResource(active, (signal) => api.systemResources(signal), unsupported);
}

export function useSystemProcesses(active: boolean): SystemPoll<SystemProcessesResponse> {
  const api = useApi();
  return usePolledResource(active, (signal) => api.systemProcesses(signal), unsupported);
}

export function useSystemPorts(active: boolean): SystemPoll<SystemPortsResponse> {
  const api = useApi();
  return usePolledResource(active, (signal) => api.systemPorts(signal), unsupported);
}
