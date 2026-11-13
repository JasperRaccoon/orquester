import React from "react";

import { useApi } from "../../context/orquester-context";
import { visualPageUrl } from "./visual/VisualFrame";
import { useAppStore } from "../../store/app";
import { ChatHostProvider, type ChatHost } from "./chat-host";

/**
 * The app's {@link ChatHost}: the chat render path's app-specific needs,
 * filled from the app's stores and API client. Mounted once at the app root
 * (`OrquesterApp.tsx`, inside `OrquesterProvider`), so every chat timeline in
 * the app behaves exactly as it did when it read these itself.
 *
 * This module may import the app; `chat-host.tsx` may not.
 */
function useAppAppearance(): ReturnType<ChatHost["useAppearance"]> {
  const mode = useAppStore((state) => state.resolvedMode);
  const scheme = useAppStore((state) => state.colorScheme);
  return React.useMemo(() => ({ mode, scheme }), [mode, scheme]);
}

export function AppChatHostProvider(props: { children: React.ReactNode }): React.ReactElement {
  const api = useApi();
  const host = React.useMemo<ChatHost>(
    () => ({
      useAppearance: useAppAppearance,
      fetchAttachment: (sessionId, attachmentId, signal) => api.agentChat.fetchAttachment(sessionId, attachmentId, signal),
      visualPageUrl: (sessionId, attachmentId) => visualPageUrl(api, sessionId, attachmentId),
      readFileBytes: (path, signal) => api.readFileBytes(path, signal),

      // ── Timeline, rows and markdown affordances ──

      // ── Images, visuals and banner-card affordances ──
    }),
    [api]
  );
  return <ChatHostProvider host={host}>{props.children}</ChatHostProvider>;
}
