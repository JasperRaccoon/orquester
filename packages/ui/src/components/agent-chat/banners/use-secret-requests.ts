/**
 * The pending `request_secret` cards of one chat session, kept current
 * (`lib/agent-chat/secret-requests.ts`): loaded when the view mounts and each
 * time the connection comes back (a reconnect may have missed events), then
 * moved by the bus events the app store routes there.
 */

import React from "react";
import type { SecretRequestSummary } from "@orquester/api/agent-chat";

import { useApi } from "../../../context/orquester-context";
import {
  loadSecretRequests,
  secretRequestsFor,
  secretRequestsStore
} from "../../../lib/agent-chat/secret-requests";
import { useAppStore } from "../../../store/app";

const getSnapshot = () => secretRequestsStore.getState();

export function useSecretRequests(sessionId: string, enabled = true): readonly SecretRequestSummary[] {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const state = React.useSyncExternalStore(secretRequestsStore.subscribe, getSnapshot, getSnapshot);
  React.useEffect(() => {
    if (!enabled || !connected) return;
    const controller = new AbortController();
    void loadSecretRequests(api, sessionId, controller.signal);
    return () => controller.abort();
  }, [api, connected, enabled, sessionId]);
  return secretRequestsFor(state, sessionId);
}
