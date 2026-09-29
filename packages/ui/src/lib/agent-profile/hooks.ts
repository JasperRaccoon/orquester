/**
 * Agent profile — the React side of `store.ts`: one agent's snapshot and the
 * overview, loaded while connected and refreshed after a reconnect or a change
 * event (either marks them stale).
 *
 * Not imported by the app store (which imports `store.ts` directly), so this
 * module may read the app store without an import cycle.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { AgentProfileAgentId, AgentProfileAgentSummary } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import {
  agentProfileStore,
  EMPTY_AGENT_PROFILE_ENTRY,
  loadAgentProfile,
  loadAgentProfileOverview,
  markAgentProfileStale,
  type AgentProfileEntry,
  type AgentProfileNotice
} from "./store";

interface AgentProfileView {
  entry: AgentProfileEntry;
  /** The overview's agents (installed, version, counts), or `null` before it loaded. */
  overview: readonly AgentProfileAgentSummary[] | null;
  overviewStatus: AgentProfileEntry["status"];
  notice: AgentProfileNotice | null;
  /** Items of any agent with a change in flight (`agentProfileItemKey`). */
  pending: ReadonlySet<string>;
}

let watchingConnection = false;

/**
 * Mark every loaded snapshot stale whenever the connection comes back: the
 * `/events` stream has no replay, so a change made while it was down is only
 * seen by asking again. Installed once, on the first panel mount.
 */
function watchConnection(): void {
  if (watchingConnection) return;
  watchingConnection = true;
  let previous = useAppStore.getState().connectionStatus;
  useAppStore.subscribe((state) => {
    const status = state.connectionStatus;
    if (status === previous) return;
    const was = previous;
    previous = status;
    if (status === "connected" && was !== "connected") markAgentProfileStale();
  });
}

const getSnapshot = () => agentProfileStore.getState();

/** `agent`'s profile and the overview, loading both while connected. */
export function useAgentProfile(agent: AgentProfileAgentId): AgentProfileView {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = useSyncExternalStore(agentProfileStore.subscribe, getSnapshot, getSnapshot);
  const entry = state.agents[agent] ?? EMPTY_AGENT_PROFILE_ENTRY;
  const overviewStale = state.overview.stale;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected) return;
    void loadAgentProfileOverview(api);
  }, [api, connected, overviewStale]);

  useEffect(() => {
    if (!connected) return;
    void loadAgentProfile(api, agent);
    // `stale` re-runs it after a reconnect or a change event marked it out of date.
  }, [api, connected, agent, entry.stale]);

  return useMemo(
    () => ({
      entry,
      overview: state.overview.agents,
      overviewStatus: state.overview.status,
      notice: state.notice,
      pending: state.pending
    }),
    [entry, state.overview.agents, state.overview.status, state.notice, state.pending]
  );
}
