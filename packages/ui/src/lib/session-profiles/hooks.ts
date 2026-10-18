/**
 * Agent Profiles — the React side of `store.ts`: the list and one profile's
 * detail, loaded while connected and refreshed after a reconnect or a change
 * event (either marks them stale).
 *
 * Not imported by the app store (which imports `store.ts` directly), so this
 * module may read the app store without an import cycle.
 */

import { useEffect, useSyncExternalStore } from "react";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import {
  EMPTY_DETAIL_ENTRY,
  loadSessionProfile,
  loadSessionProfiles,
  markSessionProfilesStale,
  sessionProfilesStore,
  type SessionProfileDetailEntry,
  type SessionProfileListEntry
} from "./store";

let watchingConnection = false;

/**
 * Mark what is loaded stale whenever the connection comes back: `/events` has
 * no replay, so a change made while it was down is only seen by asking again.
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
    if (status === "connected" && was !== "connected") markSessionProfilesStale();
  });
}

const getSnapshot = () => sessionProfilesStore.getState();

export function useSessionProfilesState() {
  return useSyncExternalStore(sessionProfilesStore.subscribe, getSnapshot, getSnapshot);
}

/** The library: every profile's summary, loaded while connected. */
export function useSessionProfileList(): SessionProfileListEntry {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const list = useSessionProfilesState().list;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected) return;
    void loadSessionProfiles(api);
    // `stale` re-runs it after a reconnect or a change event.
  }, [api, connected, list.stale]);

  return list;
}

/** One profile's detail (the editor), loaded while connected; `null` id loads nothing. */
export function useSessionProfileDetail(profileId: string | null): SessionProfileDetailEntry {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const entry = useSessionProfilesState().details[profileId ?? ""] ?? EMPTY_DETAIL_ENTRY;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected || profileId === null) return;
    void loadSessionProfile(api, profileId);
  }, [api, connected, profileId, entry.stale]);

  return entry;
}
