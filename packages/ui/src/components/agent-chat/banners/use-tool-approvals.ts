/**
 * The pending Orquester approval cards of one chat session (unified MCP §7), kept current
 * (`lib/agent-tools/store.ts`): loaded when the dock mounts and each time the connection comes
 * back (a reconnect may have missed events), then moved by the bus events the app store routes
 * there. Oldest first.
 *
 * The client comes from the app store, so a dock rendered without the app shell (a render check)
 * loads nothing and shows only what the store already holds.
 */

import React from "react";
import type { ParsedToolApprovalSummary } from "@orquester/api/agent-chat";

import { loadToolApprovals, toolApprovalsFor, toolApprovalsStore } from "../../../lib/agent-tools/store";
import { useAppStore } from "../../../store/app";

const getSnapshot = () => toolApprovalsStore.getState();

export function useToolApprovals(sessionId: string, enabled = true): readonly ParsedToolApprovalSummary[] {
  const api = useAppStore((state) => state.api);
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = React.useSyncExternalStore(toolApprovalsStore.subscribe, getSnapshot, getSnapshot);
  React.useEffect(() => {
    if (!enabled || !api || !connected) return;
    const controller = new AbortController();
    void loadToolApprovals(api, sessionId, controller.signal);
    return () => controller.abort();
  }, [api, connected, enabled, sessionId]);
  return enabled ? toolApprovalsFor(state, sessionId) : NONE;
}

const NONE: readonly ParsedToolApprovalSummary[] = [];
