/**
 * The Usage view's history data (spec §6.3): one daemon's `GET /api/usage/history`
 * answers, kept on screen while a newer one loads, with which request is current
 * so a late answer (for a range left, or a daemon left) never replaces newer data.
 *
 * The pure part — {@link usageHistoryReducer} and its selectors — is what the
 * tests drive; {@link useUsageHistory} wires it to the API client, the price
 * editor's "prices changed" signal and the 60 s poll.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

import type { UsageHistoryResponse } from "@orquester/api";

import { usePollWhileActive } from "../hooks/use-poll-while-active";
import { ApiError, type ApiClient } from "./api-client";
import { onUsagePricesChanged } from "./usage-prices-events";

/** An answer older than this (or one taken mid-scan) is shown, then refetched with `refresh=1`. */
export const USAGE_HISTORY_STALE_MS = 60_000;

export interface UsageHistoryRequest {
  id: number;
  range: string;
  /** `refresh=1`: the daemon rescans before answering. */
  force: boolean;
}

export interface UsageHistoryState {
  /** The last answer — for any range — kept while a newer one loads, and through errors. */
  data: UsageHistoryResponse | null;
  /** Whether {@link data} answered a forced request (a forced answer is never forced again). */
  dataForced: boolean;
  /** The request whose answer will be shown; any other answer is late and ignored. */
  pending: UsageHistoryRequest | null;
  /** The last request failed: `too-old` when the daemon has no history route (404). */
  error: "too-old" | "failed" | null;
}

export type UsageHistoryAction =
  | { type: "request"; request: UsageHistoryRequest }
  | { type: "answer"; id: number; data: UsageHistoryResponse }
  | { type: "fail"; id: number; status: number | null }
  /** Another daemon: nothing of the previous one's may show. */
  | { type: "reset" };

export const initialUsageHistoryState: UsageHistoryState = { data: null, dataForced: false, pending: null, error: null };

export function usageHistoryReducer(state: UsageHistoryState, action: UsageHistoryAction): UsageHistoryState {
  switch (action.type) {
    case "request":
      return { ...state, pending: action.request };
    case "answer":
      if (state.pending?.id !== action.id) return state;
      return { data: action.data, dataForced: state.pending.force, pending: null, error: null };
    case "fail":
      if (state.pending?.id !== action.id) return state;
      return { ...state, pending: null, error: action.status === 404 ? "too-old" : "failed" };
    case "reset":
      return initialUsageHistoryState;
  }
}

/** The answer was taken mid-scan or is over a minute old. */
export function isUsageHistoryStale(data: UsageHistoryResponse, now: number): boolean {
  if (data.scanning) return true;
  const asOf = Date.parse(data.asOf);
  return Number.isFinite(asOf) && now - asOf > USAGE_HISTORY_STALE_MS;
}

/** Refetch with `refresh=1` now: the shown answer is stale and no forced request has answered it yet. */
export function needsForcedRefetch(state: UsageHistoryState, now: number): boolean {
  return state.data !== null && state.pending === null && !state.dataForced && state.error === null && isUsageHistoryStale(state.data, now);
}

/** Whether the shown figures are out of date for `range` while a request runs (they dim). */
export function usageHistoryLoading(state: UsageHistoryState, range: string): boolean {
  if (state.pending === null || state.data === null) return false;
  return state.pending.force || state.data.range !== range;
}

/** A forced request runs: the "Updating…" indicator and the refresh button's spin. */
export function usageHistoryUpdating(state: UsageHistoryState): boolean {
  return state.pending?.force === true;
}

export interface UsageHistoryHandle {
  state: UsageHistoryState;
  /** Fetch now; `force` awaits the daemon's rescan (the refresh button). */
  refetch: (force: boolean) => void;
}

/**
 * The history of `range` from `api`, cut in `timeZone`. `scope` names the
 * daemon (the active connection): a change drops everything shown. `poll`
 * refetches (unforced) every 60 s while the page is visible.
 */
export function useUsageHistory(
  api: ApiClient | null,
  scope: string | null,
  range: string,
  timeZone: string,
  poll: boolean
): UsageHistoryHandle {
  const [state, dispatch] = useReducer(usageHistoryReducer, initialUsageHistoryState);
  const seq = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const pendingRef = useRef(state.pending);
  pendingRef.current = state.pending;

  const refetch = useCallback(
    (force: boolean) => {
      if (!api) return;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      const id = ++seq.current;
      dispatch({ type: "request", request: { id, range, force } });
      api.getUsageHistory(range, timeZone, force, controller.signal).then(
        (data) => dispatch({ type: "answer", id, data }),
        (error: unknown) => dispatch({ type: "fail", id, status: error instanceof ApiError ? error.status : null })
      );
    },
    [api, range, timeZone]
  );

  // Declared before the fetch below, so a daemon switch drops the old data before asking the new one.
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    dispatch({ type: "reset" });
  }, [scope]);

  useEffect(() => {
    refetch(false);
  }, [refetch, scope]);

  useEffect(() => () => inFlight.current?.abort(), []);

  // The daemon reprices all history when prices change: ask again.
  useEffect(() => onUsagePricesChanged(() => refetch(false)), [refetch]);

  useEffect(() => {
    if (needsForcedRefetch(state, Date.now())) refetch(true);
  }, [state, refetch]);

  usePollWhileActive(
    poll,
    () => {
      if (pendingRef.current === null) refetch(false);
    },
    USAGE_HISTORY_STALE_MS
  );

  return { state, refetch };
}
