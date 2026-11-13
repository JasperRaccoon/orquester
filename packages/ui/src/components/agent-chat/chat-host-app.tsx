import React from "react";

import { useApi } from "../../context/orquester-context";
import { anotherLayerOwnsTheKeyboard } from "../attention/GlobalShortcutListener";
import { saveImageToProject } from "./images/image-actions";
import { attachImageAsReference } from "./images/image-reference";
import { visualPageUrl } from "./visual/VisualFrame";
import { useAppStore } from "../../store/app";
import { peekThreadStore } from "../../lib/agent-chat/store";
import { toolApprovalsFor, toolApprovalsStore } from "../../lib/agent-tools/store";
import { sessionProfilesStore } from "../../lib/session-profiles/store";
import { DesktopScreenshotThumb, DesktopShowButton, useDesktopLinkTitle } from "../desktop/DesktopRowLink";
import { DeviceScreenshotThumb, DeviceShowButton, useDeviceLinkName } from "../device/DeviceRowLink";
import { KnowledgeCitation } from "../knowledge/KnowledgeCitation";
import { composerTakesQuotes, quoteIntoComposer } from "./composer/composer-bridge";
import { RewindToHereButton } from "./composer/RewindControl";
import { openDelegateTab, useDelegateChildViews, useDelegateMetaLine } from "./delegates/delegate-tabs";
import { McpAppFrame } from "./mcp-app/McpAppFrame";
import { ChatHostProvider, type ChatHost } from "./chat-host";

/**
 * The app's {@link ChatHost}: the chat render path's app-specific needs,
 * filled from the app's stores and API client. Mounted once at the app root
 * (`OrquesterApp.tsx`, inside `OrquesterProvider`), so every chat timeline in
 * the app behaves exactly as it did when it read these itself.
 *
 * This module may import the app; `chat-host.tsx` may not.
 */
function useAppProjectRepoKey(projectPath: string | null): string | null {
  return useAppStore((state) =>
    projectPath ? (state.projects.find((project) => project.path === projectPath)?.repoKey ?? null) : null
  );
}

function useAppAppearance(): ReturnType<ChatHost["useAppearance"]> {
  const mode = useAppStore((state) => state.resolvedMode);
  const scheme = useAppStore((state) => state.colorScheme);
  return React.useMemo(() => ({ mode, scheme }), [mode, scheme]);
}

// ── Timeline, rows and markdown affordances ──
// Module-level, so each keeps its identity for the app's life (hooks above all).

const peekThread: NonNullable<ChatHost["peekThread"]> = (sessionId) => {
  const state = peekThreadStore(sessionId)?.getState();
  return state ? { turns: state.slice.turns, actions: state.actions } : null;
};

const quoteToComposer: NonNullable<ChatHost["quoteToComposer"]> = {
  takes: composerTakesQuotes,
  // A refusal (the draft holds all the quotes it may) is said on the
  // composer's status line, where the quotes are.
  quote: (sessionId, markdown) => {
    quoteIntoComposer(sessionId, markdown);
  }
};

function useAgentAccounts(): ReturnType<NonNullable<ChatHost["useAgentAccounts"]>> {
  return useAppStore((state) => state.agentAccounts?.accounts);
}

const profilesSnapshot = () => sessionProfilesStore.getState().list.profiles;

function useSessionProfiles(): ReturnType<NonNullable<ChatHost["useSessionProfiles"]>> {
  return React.useSyncExternalStore(sessionProfilesStore.subscribe, profilesSnapshot, profilesSnapshot);
}

/** The project's agent-chat tab of that id: its live title, and activating it. */
const chatTabs: NonNullable<ChatHost["chatTabs"]> = {
  useTitle: (sessionId) =>
    useAppStore(
      (state) => state.sessions.find((session) => session.id === sessionId && session.kind === "agent-chat")?.title
    ),
  open: (sessionId) => useAppStore.getState().activateTab(sessionId)
};

const delegates: NonNullable<ChatHost["delegates"]> = {
  useChildViews: useDelegateChildViews,
  useMetaLine: useDelegateMetaLine,
  open: openDelegateTab
};

const desktopRows: NonNullable<ChatHost["desktopRows"]> = {
  useTitle: useDesktopLinkTitle,
  ShowButton: DesktopShowButton,
  ScreenshotThumb: DesktopScreenshotThumb
};

const deviceRows: NonNullable<ChatHost["deviceRows"]> = {
  useName: useDeviceLinkName,
  ShowButton: DeviceShowButton,
  ScreenshotThumb: DeviceScreenshotThumb
};

function useToolApprovalPending(sessionId: string | undefined, tool: string): boolean {
  return React.useSyncExternalStore(toolApprovalsStore.subscribe, () =>
    sessionId === undefined
      ? false
      : toolApprovalsFor(toolApprovalsStore.getState(), sessionId).some((approval) => approval.tool === tool)
  );
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
      peekThread,
      quoteToComposer,
      RewindToHere: RewindToHereButton,
      useAgentAccounts,
      useSessionProfiles,
      chatTabs,
      delegates,
      desktopRows,
      deviceRows,
      useToolApprovalPending,
      McpAppFrame,
      KnowledgeCitation,

      // ── Images, visuals and banner-card affordances ──
      notify: (notice) => useAppStore.getState().setNotice(notice),
      saveImageToProject: (input) => saveImageToProject({ api, ...input }),
      revealInFiles: (path) => useAppStore.getState().revealInFileBrowser(path),
      attachImageToComposer: (input) => attachImageAsReference({ api, ...input }),
      keyboardLayerOpen: anotherLayerOwnsTheKeyboard,
      fetchForgeLinkPreview: async (url, projectPath) => (await api.getGitHubLinkPreview(url, projectPath)).preview,
      useProjectRepoKey: useAppProjectRepoKey
    }),
    [api]
  );
  return <ChatHostProvider host={host}>{props.children}</ChatHostProvider>;
}
