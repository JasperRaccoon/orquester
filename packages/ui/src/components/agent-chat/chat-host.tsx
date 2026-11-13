import React from "react";

import type { ColorScheme, ResolvedMode } from "../../lib/theme";
import type { VisualFrameUrl } from "../../lib/agent-chat/visual-frame";

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
 * load full output, read a full plan, open a file…). Those stay props, so a
 * host that owns the thread (the app's thread store, the embed's own reducer)
 * wires them where it mounts the timeline.
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

  // ── Images, visuals and banner-card affordances (app-only, optional) ──────
  // (added by the images/visuals/banners decoupling; keep this section's fields together)
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
