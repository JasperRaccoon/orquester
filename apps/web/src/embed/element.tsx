/**
 * `<orquester-agent-chat>`: one agent-chat thread, rendered by Orquester's own
 * chat GUI from the frames a host hands it (design
 * `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md` §5.4).
 *
 * The class is built when `define` runs, never at import, so loading the
 * bundle touches no DOM global. Each element owns an open shadow root, its
 * own React root and its own thread; it never talks to Orquester — images,
 * pages, older history and full output come through the host's `loaders`,
 * and answers leave as `orquester-command` events.
 */

import React from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AgentChatStreamFrame } from "@orquester/api/agent-chat";

import type { ChatHost } from "../../../../packages/ui/src/components/agent-chat/chat-host";

import { EmbedChat, type EmbedCommandRequest } from "./EmbedChat";
import { EmbedSettings, loadersOf, modeOf, schemeOf, type EmbedSettingsState } from "./settings";
import { adoptEmbedStyles } from "./styles";
import { EMBED_ROOT_CLASS } from "./contract";
import { EmbedThread } from "./thread";
import type {
  EmbedCommandDetail,
  EmbedLoaders,
  EmbedPendingDetail,
  EmbedPendingRequest,
  EmbedResyncDetail,
  EmbedStaleDetail
} from "./types";

declare const __ORQUESTER_BUILD__: string | undefined;

/** The Orquester build this bundle was made from (`orquester-stale`'s `detail.build`). */
export const EMBED_BUILD: string =
  typeof __ORQUESTER_BUILD__ === "string" && __ORQUESTER_BUILD__ ? __ORQUESTER_BUILD__ : "unknown";

/** The element's public surface, as a host types it. */
export interface OrquesterAgentChatElement extends HTMLElement {
  pushFrames(frames: AgentChatStreamFrame | readonly AgentChatStreamFrame[]): void;
  reset(): void;
  loaders: EmbedLoaders;
  respondFailed(commandId: string, message?: string): void;
  readonly sessionId: string | null;
}

/**
 * The shadow root's own layout: a block the host sizes, its thread scrolling
 * inside it. Everything else is the embed stylesheet's (`styles.ts`).
 */
const HOST_CSS = `
:host { display: block; position: relative; overflow: hidden; }
:host([hidden]) { display: none; }
.orq-embed-root { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.orq-embed-app { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
`;

const OBSERVED = ["mode", "scheme", "workspace-root"] as const;

function newCommandId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `cmd-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** Every connected element of this bundle: who hears that a lazy chunk failed. */
const connected = new Set<HTMLElement>();

function fire<T>(target: EventTarget, type: string, detail: T): void {
  target.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }));
}

let staleListening = false;

/**
 * A lazy chunk that failed to load reaches the page as Vite's
 * `vite:preloadError`: typically the Orquester redeployed under the page.
 * Every connected element says so once per failure (`orquester-stale`); the
 * block that wanted the chunk degrades on its own. A failure naming another
 * bundle's URL (a second version on the page) is not this bundle's.
 */
function listenForStaleChunks(): void {
  if (staleListening || typeof window === "undefined") return;
  staleListening = true;
  // Not `new URL(".", import.meta.url)`: Vite reads that form as an asset reference
  // and would emit the entry's source as a file.
  const base = import.meta.url.slice(0, import.meta.url.lastIndexOf("/") + 1);
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    const message = payload instanceof Error ? payload.message : typeof payload === "string" ? payload : "";
    if (message.includes("://") && !message.includes(base)) return;
    for (const element of connected) fire<EmbedStaleDetail>(element, "orquester-stale", { build: EMBED_BUILD });
  });
}

/** The element class, built against the page's `HTMLElement` at call time. */
export function createEmbedElementClass(): CustomElementConstructor {
  listenForStaleChunks();

  class OrquesterAgentChat extends HTMLElement implements OrquesterAgentChatElement {
    static get observedAttributes(): readonly string[] {
      return OBSERVED;
    }

    readonly #settings = new EmbedSettings();
    readonly #thread = new EmbedThread(() => this.#settings.get().loaders);
    readonly #wrapper: HTMLDivElement;
    readonly #app: HTMLDivElement;
    readonly #portal: HTMLDivElement;
    readonly #host: ChatHost;
    #root: Root | null = null;
    #pending: readonly EmbedPendingRequest[] = [];

    constructor() {
      super();
      const shadow = this.attachShadow({ mode: "open" });
      const layout = document.createElement("style");
      layout.textContent = HOST_CSS;
      shadow.append(layout);
      adoptEmbedStyles(shadow);
      this.#wrapper = document.createElement("div");
      this.#wrapper.className = EMBED_ROOT_CLASS;
      this.#app = document.createElement("div");
      this.#app.className = "orq-embed-app";
      // Portals mount here, inside the wrapper, so they paint with its
      // scheme and the shadow root's styles.
      this.#portal = document.createElement("div");
      this.#portal.className = "orq-embed-portal";
      this.#wrapper.append(this.#app, this.#portal);
      shadow.append(this.#wrapper);
      this.#syncAttributes();

      const settings = this.#settings;
      const useAppearance = (): EmbedSettingsState["appearance"] =>
        React.useSyncExternalStore(settings.subscribe, () => settings.get().appearance);
      this.#host = {
        useAppearance,
        fetchAttachment: async (sessionId, attachmentId, signal) => {
          const loader = settings.get().loaders.attachment;
          if (loader === undefined) throw new Error("Not available here.");
          const blob = await loader({ sessionId, attachmentId }, signal);
          if (typeof (blob as Partial<Blob> | null)?.arrayBuffer !== "function") throw new Error("Expected the image's bytes.");
          return blob.arrayBuffer();
        },
        visualPageUrl: async (sessionId, attachmentId) => {
          const loader = settings.get().loaders.visualUrl;
          if (loader === undefined) throw new Error("Not available here.");
          const src = await loader({ sessionId, attachmentId });
          if (typeof src !== "string" || src.length === 0) throw new Error("Expected the page's URL.");
          // The host's URL carries no expiry the element can know of.
          return { src, expiresAt: Number.MAX_SAFE_INTEGER };
        }
      };

      // `orquester-pending` on every change of the open requests; the view
      // keeps the list's identity while it holds the same requests.
      this.#thread.subscribe(() => {
        const view = this.#thread.getView();
        if (view.pending === this.#pending) return;
        this.#pending = view.pending;
        fire<EmbedPendingDetail>(this, "orquester-pending", {
          sessionId: view.sessionId,
          pending: view.pending.map((entry) => ({ ...entry }))
        });
      });
    }

    connectedCallback(): void {
      connected.add(this);
      if (this.#root !== null) return;
      this.#root = createRoot(this.#app);
      this.#root.render(
        <EmbedChat
          thread={this.#thread}
          settings={this.#settings}
          host={this.#host}
          portal={this.#portal}
          onCommand={this.#command}
        />
      );
    }

    disconnectedCallback(): void {
      connected.delete(this);
      // A move (remove, then insert) keeps the tree; a removal unmounts it.
      // The thread stays, for an element inserted again.
      queueMicrotask(() => {
        if (this.isConnected || this.#root === null) return;
        this.#root.unmount();
        this.#root = null;
      });
    }

    attributeChangedCallback(): void {
      this.#syncAttributes();
    }

    pushFrames(frames: AgentChatStreamFrame | readonly AgentChatStreamFrame[]): void {
      const list: readonly unknown[] = Array.isArray(frames) ? frames : [frames];
      const { resync } = this.#thread.push(list);
      if (resync) {
        fire<EmbedResyncDetail>(this, "orquester-resync", { sessionId: this.#thread.getView().sessionId });
      }
    }

    reset(): void {
      this.#thread.reset();
    }

    get loaders(): EmbedLoaders {
      return this.#settings.get().loaders;
    }

    set loaders(value: EmbedLoaders) {
      this.#settings.setLoaders(loadersOf(value));
    }

    respondFailed(commandId: string, message?: string): void {
      this.#thread.respondFailed(commandId, message);
    }

    get sessionId(): string | null {
      return this.#thread.getView().sessionId;
    }

    #syncAttributes(): void {
      const mode = modeOf(this.getAttribute("mode"));
      const scheme = schemeOf(this.getAttribute("scheme"));
      this.#wrapper.dataset.mode = mode;
      this.#wrapper.dataset.scheme = scheme;
      this.#settings.setAppearance(mode, scheme);
      const root = this.getAttribute("workspace-root");
      this.#settings.setWorkspaceRoot(root !== null && root.length > 0 ? root : undefined);
    }

    readonly #command = (request: EmbedCommandRequest): void => {
      const sessionId = this.#thread.getView().sessionId;
      if (sessionId === null) return;
      const commandId = newCommandId();
      let detail: EmbedCommandDetail;
      switch (request.command) {
        case "answer":
          detail = { sessionId, command: "answer", body: { commandId, requestId: request.requestId, answers: request.answers } };
          break;
        case "dismiss":
          detail = { sessionId, command: "dismiss", body: { commandId, requestId: request.requestId } };
          break;
        case "approval":
          detail = {
            sessionId,
            command: "approval",
            body: { commandId, requestId: request.requestId, decision: request.decision }
          };
          break;
      }
      this.#thread.beginResponding(request.requestId, commandId);
      fire<EmbedCommandDetail>(this, "orquester-command", detail);
    };
  }

  return OrquesterAgentChat;
}
