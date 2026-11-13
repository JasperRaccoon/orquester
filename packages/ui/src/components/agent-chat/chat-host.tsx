import React from "react";

import type { AgentAccount, DeviceToolReference, SessionProfileSummary } from "@orquester/api";
import type { McpAppReference, Turn } from "@orquester/api/agent-chat";

import type { ColorScheme, ResolvedMode } from "../../lib/theme";
import type { VisualFrameUrl } from "../../lib/agent-chat/visual-frame";
import type { AgentChatActions } from "../../lib/agent-chat/contracts";
import type { DelegateChildRef, DelegateChildView } from "../../lib/agent-chat/delegates.logic";
import type { DesktopRowLink } from "../../lib/desktops/chat-rows.logic";

/**
 * The agent chat's host: everything app-specific the chat's render path
 * (timeline, rows, markdown, images, visuals, question and approval cards)
 * needs, injected instead of imported.
 *
 * Why: the render path must run with no app around it — the embeddable chat
 * (`apps/web/src/embed/`, design `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md`)
 * mounts it in a host page's shadow root with no `store/app`, no API client,
 * no thread store and no composer. So no module on that path may import
 * `store/app`, `context/orquester-context`, `lib/agent-chat/store`,
 * `lib/session-profiles/store`, `lib/agent-tools/store` or `composer/`; the
 * embed build fails when one ends up in its bundle.
 *
 * The app provides {@link ChatHostProvider} once, at its root
 * (`chat-host-app.tsx`), filled from its stores and API client, so the app
 * behaves exactly as before. The embed provides its own. With no provider
 * (a unit test, a story) the render path gets {@link STANDALONE_CHAT_HOST}:
 * dark/mono, nothing loads, every app-only affordance absent.
 *
 * Not here: what the timeline already takes as props or actions (load older,
 * load full output, open a file…). Those stay props, so a host that owns the
 * thread (the app's thread store, the embed's own reducer) wires them where
 * it mounts the timeline.
 *
 * Rules for fields:
 * - A value that must re-render its reader when it changes is a HOOK
 *   (`useX`), called unconditionally like any hook. A host's hooks must keep
 *   their identity for the host's life (rules of hooks).
 * - Every app-only affordance is OPTIONAL (`?:`). Absent means the control is
 *   not rendered, or the element renders inert (plain text instead of a link).
 * - Nothing here may import an app module; types only.
 */
export interface ChatHost {
  /** The resolved light/dark mode and the colour scheme the chat paints with. */
  useAppearance(): { mode: ResolvedMode; scheme: ColorScheme };
  /** A chat attachment's bytes (images: `show_image`, image attachments). Rejects when unavailable. */
  fetchAttachment(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** A URL an agent-published page (`html_render`) loads from, in the sandboxed frame. */
  visualPageUrl(sessionId: string, attachmentId: string): Promise<VisualFrameUrl>;
  /** A workspace file's bytes (markdown images of local paths). Absent: such images are not loaded. */
  readFileBytes?: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;

  // ── Timeline, rows and markdown affordances (app-only, optional) ──────────
  // (added by the timeline decoupling; keep this section's fields together)

  /**
   * The thread a timeline renders, by session id, read at call time and never
   * subscribed (a scroll must not re-render the timeline): the timeline
   * remembers its reading position there, reveals a remembered turn the
   * window paged out, and reads a cut plan back whole. Absent, or `null` for
   * a thread the host does not hold: nothing is remembered or revealed, and a
   * plan reads as `readPlanWithoutStore` answers.
   */
  peekThread?: (sessionId: string) => ChatHostThread | null;
  /**
   * The composer a selected passage of an agent's reply is quoted into (as
   * markdown): `takes` says whether one that takes quotes is mounted for the
   * thread. Absent: the selection toolbar is not shown.
   */
  quoteToComposer?: {
    takes(sessionId: string): boolean;
    quote(sessionId: string, markdown: string): void;
  };
  /** "Rewind to here" on a user message, with its confirm. Absent: not offered. */
  RewindToHere?: React.ComponentType<RewindToHereProps>;
  /** The live agent accounts an identity-change row names. Absent: named as the event recorded it. */
  useAgentAccounts?(): readonly AgentAccount[] | undefined;
  /** The live Agent Profiles a profile-change row names (`null` until loaded). Absent: `null`. */
  useSessionProfiles?(): readonly SessionProfileSummary[] | null;
  /**
   * The app's chat tabs, which thread links name and open: a tab's live
   * title (`undefined` once it is closed), and opening it. Absent: a thread
   * link renders as the title the event recorded, inert, or not at all.
   */
  chatTabs?: {
    useTitle(sessionId: string): string | undefined;
    open(sessionId: string): void;
  };
  /**
   * The live state of delegated child chats (the subagent strip): each
   * child's view from its tab, its agent · model · account line, and opening
   * it (false once its tab is gone). Absent: each child as its call recorded
   * it, with no meta line and no Open.
   */
  delegates?: {
    useChildViews(refs: readonly DelegateChildRef[]): DelegateChildView[];
    useMetaLine(view: Pick<DelegateChildView, "refId" | "model" | "accountId">): string;
    open(sessionId: string): boolean;
  };
  /**
   * A desktop tool row's extras: the desktop's live title, "Show desktop" and
   * a kept screenshot's thumbnail. Absent: the row names the desktop as the
   * call did, with neither control.
   */
  desktopRows?: {
    useTitle(link: DesktopRowLink | undefined): string | undefined;
    ShowButton: React.ComponentType<{ link: DesktopRowLink }>;
    ScreenshotThumb: React.ComponentType<{ link: DesktopRowLink; title: string | undefined }>;
  };
  /** A device tool row's extras, as {@link desktopRows} for a device lease. */
  deviceRows?: {
    useName(link: DeviceToolReference | undefined): string | undefined;
    ShowButton: React.ComponentType<{ link: DeviceToolReference; sessionId: string | undefined }>;
    ScreenshotThumb: React.ComponentType<{ link: DeviceToolReference; name: string | undefined }>;
  };
  /**
   * An Orquester approval card for `tool` is open in the thread, so a pending
   * image says it waits rather than that it is being made. Absent: never.
   */
  useToolApprovalPending?(sessionId: string | undefined, tool: string): boolean;
  /** An MCP App's frame, in place of its tool call. Absent: the app is named, not framed. */
  McpAppFrame?: React.ComponentType<McpAppFrameProps>;
  /**
   * A knowledge citation (`orquester-knowledge:entry/<id>`) as a chip that
   * opens the entry. Absent: the link's plain text.
   */
  KnowledgeCitation?: React.ComponentType<{ entryId: string; children?: React.ReactNode }>;

  // ── Images, visuals and banner-card affordances (app-only, optional) ──────
  // (added by the images/visuals/banners decoupling; keep this section's fields together)
}

/** What {@link ChatHost.peekThread} answers for one thread. */
export interface ChatHostThread {
  /** The thread's turns, so a remembered row that is gone can name its turn's prompt. */
  readonly turns: readonly Turn[];
  readonly actions: Pick<AgentChatActions, "rememberScroll" | "revealTurn" | "readFullPlanMarkdown">;
}

/** {@link ChatHost.RewindToHere}'s props: the user message, and the turns a rewind to it keeps. */
export interface RewindToHereProps {
  messageId: string;
  text: string;
  revertTurnCount: number;
  /** The confirm opened or closed (the row keeps its meta row shown while it is open). */
  onOpenChange: (open: boolean) => void;
}

/** {@link ChatHost.McpAppFrame}'s props. */
export interface McpAppFrameProps {
  sessionId: string;
  /** The call's completed row, which names the app to the daemon. */
  itemId: string;
  app: McpAppReference;
  /** A read-only timeline (a drill-in) sends no messages. */
  readOnly: boolean;
}

const DARK_MONO = { mode: "dark", scheme: "mono" } as const satisfies ReturnType<ChatHost["useAppearance"]>;
const unavailable = (): Promise<never> => Promise.reject(new Error("Not available here."));

/** The host with no app: dark/mono, nothing loads, every optional affordance absent. */
export const STANDALONE_CHAT_HOST: ChatHost = {
  useAppearance: () => DARK_MONO,
  fetchAttachment: unavailable,
  visualPageUrl: unavailable
};

const ChatHostContext = React.createContext<ChatHost>(STANDALONE_CHAT_HOST);

export function ChatHostProvider(props: { host: ChatHost; children: React.ReactNode }): React.ReactElement {
  return <ChatHostContext.Provider value={props.host}>{props.children}</ChatHostContext.Provider>;
}

/** The chat's host: the provided one, else {@link STANDALONE_CHAT_HOST}. */
export function useChatHost(): ChatHost {
  return React.useContext(ChatHostContext);
}
