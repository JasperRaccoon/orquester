/**
 * React hooks over the agent-tools store (`store.ts`): Settings › Agent tools and a chat's Tools
 * chip. Each loads when it mounts and each time the connection comes back (a reconnect may have
 * missed events), and watches what it shows so `agentTools.changed` re-reads it.
 *
 * The client comes from the app store (`state.api`), not the React context, so a view rendered
 * without the app shell (a render check) simply loads nothing.
 */

import React from "react";

import { useAppStore } from "../../store/app";
import {
  agentToolsStore,
  loadAgentToolsSettings,
  loadThreadAgentTools,
  watchAgentToolsSettings,
  watchThreadAgentTools,
  type AgentToolsState,
  type ThreadToolsEntry
} from "./store";

const getSnapshot = (): AgentToolsState => agentToolsStore.getState();

/** The whole agent-tools state, kept current. */
export function useAgentToolsState(): AgentToolsState {
  return React.useSyncExternalStore(agentToolsStore.subscribe, getSnapshot, getSnapshot);
}

/** Settings › Agent tools: loads and watches the settings while mounted. */
export function useAgentToolsSettings(): Pick<AgentToolsState, "settings" | "settingsLoading" | "settingsError" | "settingsUnsupported"> {
  const api = useAppStore((state) => state.api);
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = useAgentToolsState();
  React.useEffect(() => watchAgentToolsSettings(), []);
  React.useEffect(() => {
    if (!api || !connected) return;
    const controller = new AbortController();
    void loadAgentToolsSettings(api, controller.signal);
    return () => controller.abort();
  }, [api, connected]);
  return state;
}

const NO_THREAD: ThreadToolsEntry = { data: null, error: null, unsupported: false };

/** A chat's toolsets and grants (the Tools chip): loads and watches the chat while mounted. */
export function useThreadAgentTools(threadId: string, enabled = true): ThreadToolsEntry {
  const api = useAppStore((state) => state.api);
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const entry = React.useSyncExternalStore(
    agentToolsStore.subscribe,
    () => agentToolsStore.getState().threads[threadId] ?? NO_THREAD,
    () => agentToolsStore.getState().threads[threadId] ?? NO_THREAD
  );
  React.useEffect(() => (enabled ? watchThreadAgentTools(threadId) : undefined), [enabled, threadId]);
  React.useEffect(() => {
    if (!enabled || !api || !connected) return;
    const controller = new AbortController();
    void loadThreadAgentTools(api, threadId, controller.signal);
    return () => controller.abort();
  }, [api, connected, enabled, threadId]);
  return entry;
}
