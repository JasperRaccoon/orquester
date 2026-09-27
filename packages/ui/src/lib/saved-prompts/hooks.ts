/**
 * Saved prompts — the React side of `store.ts`: what the panel lists for the
 * open project, loaded while connected and refreshed after a reconnect.
 *
 * Not imported by the app store (which imports `store.ts` directly), so this
 * module may read the app store without an import cycle.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { SavedPrompt } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { promptsForProject } from "./list.logic";
import {
  loadSavedPrompts,
  markSavedPromptsStale,
  savedPromptsLoadKey,
  savedPromptsStore,
  withPinOverride
} from "./store";

export interface SavedPromptsView {
  /** Every global prompt and the open project's own, pending pin flips applied. Unordered. */
  prompts: readonly SavedPrompt[];
  /** This project's load. Not asked yet (not connected) reads as `loading`. */
  status: "loading" | "loaded" | "error";
  /** The first load's failure (`status: "error"`), or a refresh's over rows still shown. */
  error: string | null;
  refreshing: boolean;
  /** The last failed change made from the panel, until dismissed. */
  notice: string | null;
}

let watchingConnection = false;

/**
 * Mark every loaded scope stale whenever the connection comes back: the
 * `/events` stream has no replay, so a change made while it was down is only
 * seen by asking again. Installed once, on the first panel mount — before
 * that nothing is loaded that could be stale.
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
    if (status === "connected" && was !== "connected") markSavedPromptsStale();
  });
}

const getSnapshot = () => savedPromptsStore.getState();

/**
 * The prompts the panel can list for `projectPath` ("" = no project: global
 * ones only), loading them while connected — on mount, on a project change,
 * after a reconnect.
 */
export function useSavedPrompts(projectPath: string): SavedPromptsView {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = useSyncExternalStore(savedPromptsStore.subscribe, getSnapshot, getSnapshot);
  const key = savedPromptsLoadKey(projectPath || null);
  const load = state.loads[key];
  const stale = load?.stale ?? false;

  useEffect(() => {
    watchConnection();
  }, []);

  useEffect(() => {
    if (!connected) return;
    void loadSavedPrompts(api, projectPath || null);
    // `key` stands for `projectPath` (a trailing slash is the same project);
    // `stale` re-runs it after a reconnect marked the rows out of date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connected, key, stale]);

  const prompts = useMemo(
    () =>
      promptsForProject(state.prompts.values(), projectPath).map((prompt) =>
        withPinOverride(prompt, state.pinOverrides)
      ),
    [state.prompts, state.pinOverrides, projectPath]
  );

  const status = load?.status ?? "loading";
  const error = load?.error ?? null;
  const refreshing = load?.refreshing ?? false;
  return useMemo(
    () => ({ prompts, status, error, refreshing, notice: state.notice }),
    [prompts, status, error, refreshing, state.notice]
  );
}
