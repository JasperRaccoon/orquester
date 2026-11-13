/**
 * The timeline with no app around it (embeddable chat design §5.6): a thread
 * folded from its events and projected the way the app projects it (fold →
 * entries → rows) renders in `ChatTimeline` with no provider of any kind — no
 * `OrquesterProvider`, no chat host, no thread store — and shows its messages.
 * Given the app's callbacks, its rows offer what they open and read.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { foldThread, type DomainEvent } from "@orquester/api/agent-chat";

import { activity, ev, message, resetBuilders } from "../../../lib/agent-chat/test-helpers";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ChatTimeline: typeof import("./ChatTimeline").ChatTimeline;
let deriveTimelineEntriesFromItems: typeof import("../../../lib/agent-chat/entries.logic").deriveTimelineEntriesFromItems;
let deriveTimelineRowsWithState: typeof import("../../../lib/agent-chat/rows.logic").deriveTimelineRowsWithState;

let dom: JSDOM;
const globals = [
  "window", "document", "HTMLElement", "Element", "Node", "Text", "navigator", "KeyboardEvent",
  "MouseEvent", "FocusEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "ResizeObserver", "IntersectionObserver", "MutationObserver", "CSS"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  // What jsdom lacks and a browser has: layout observers, media queries, scrolling.
  const window = dom.window as unknown as Record<string, unknown>;
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {}
  });
  window.ResizeObserver = InertObserver;
  window.IntersectionObserver = InertObserver;
  window.CSS = { escape: (value: string) => value.replace(/["\\]/g, "\\$&") };
  (dom.window.HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
  (dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = window[name];
    Object.defineProperty(globalThis, name, {
      value:
        typeof value === "function" && (name === "getComputedStyle" || name.endsWith("AnimationFrame"))
          ? (value as (...args: unknown[]) => unknown).bind(dom.window)
          : value,
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatTimeline } = await import("./ChatTimeline"));
  ({ deriveTimelineEntriesFromItems } = await import("../../../lib/agent-chat/entries.logic"));
  ({ deriveTimelineRowsWithState } = await import("../../../lib/agent-chat/rows.logic"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** A settled one-turn thread, as its host's log holds it. */
function threadLog(): DomainEvent[] {
  resetBuilders();
  return [
    ev("thread.created", {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "Fix the build",
      adapter: "claude",
      refId: "claude",
      accountId: "acc-1",
      home: "account",
      modelSelection: { model: "sonnet" },
      runtimeMode: "approval-required"
    }),
    ev("thread.message-sent", { messageId: "u1", role: "user", text: "Why does the build fail?", streaming: false, turnId: null }),
    ev("thread.session-set", { session: { status: "running", activeTurnId: "t1" } }),
    ev("thread.message-sent", {
      messageId: "a1",
      role: "assistant",
      text: "The **lockfile** is stale; see [Lockfiles](orquester-knowledge:entry/ke_aaaaaaaaaaaa).",
      streaming: false,
      turnId: "t1"
    }),
    ev("thread.session-set", { session: { status: "ready", activeTurnId: null } })
  ] as DomainEvent[];
}

it("renders a folded thread's messages with no app, host or store around it", async () => {
  const fold = foldThread(threadLog());
  const { entries } = deriveTimelineEntriesFromItems(fold.items);
  const { rows } = deriveTimelineRowsWithState({
    timelineEntries: entries,
    turns: fold.turns,
    isWorking: false,
    activeTurnStartedAt: null,
    supportsConversationRollback: false
  });
  const noop = (): void => {};
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(
      createElement(ChatTimeline, {
        sessionId: "s1",
        rows,
        follow: true,
        onFollowChange: noop,
        disclosures: { expandedTurnIds: [], expandedGroupIds: [], expandedAgentIds: [], expandedReasoningIds: [], toolOutputOffsets: {} },
        onDisclosureChange: noop,
        bottomInset: 0,
        canRevert: false,
        onRevert: noop,
        onOpenTurnDiff: noop,
        onOpenFile: noop,
        onLoadFullOutput: noop,
        onOpenAgent: noop,
        onSendQueuedNow: noop,
        onReturnQueuedToComposer: noop,
        errorBanner: null,
        onDismissErrorBanner: noop,
        threadReady: true
      })
    );
  });

  const text = mount.textContent ?? "";
  assert.match(text, /Why does the build fail\?/);
  assert.match(text, /The lockfile is stale; see Lockfiles\./);
  assert.equal(mount.querySelector("strong")?.textContent, "lockfile", "the reply renders as markdown");
  // No host to open knowledge entries: the citation is its link's plain text.
  assert.equal(mount.querySelector("[data-knowledge-citation]"), null);
  assert.ok(mount.querySelector('[data-knowledge-citation-text="ke_aaaaaaaaaaaa"]'));
});

it("with the app's callbacks, opens files and the turn diff and reads full output", async () => {
  resetBuilders();
  const at = (second: number): string => `2026-11-13T10:00:0${second}.000Z`;
  const items = [
    message("user", "Fix the port", { id: "u1", turnId: "t1", createdAt: at(0) }),
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-ls", command: "ls -la /etc", status: "completed", truncated: true, data: { output: "a" } },
      { id: "cmd-1", turnId: "t1", createdAt: at(1), status: "completed" }
    ),
    message("assistant", "Edited [the server](src/server.ts).", { id: "a1", turnId: "t1", createdAt: at(2) })
  ];
  const { entries } = deriveTimelineEntriesFromItems(items);
  const { rows } = deriveTimelineRowsWithState({
    timelineEntries: entries,
    turns: [
      { turnId: "t1", state: "completed", turnCount: 1, requestedAt: at(0), startedAt: at(0), completedAt: at(5), assistantMessageId: "a1", userMessageId: "u1" }
    ],
    checkpoints: [
      {
        turnId: "t1",
        checkpointTurnCount: 1,
        checkpointRef: "refs/orquester/checkpoints/x/turn/1",
        status: "ready",
        files: [{ path: "src/server.ts", additions: 3, deletions: 1 }],
        assistantMessageId: "a1",
        completedAt: at(5)
      }
    ],
    expandedTurnIds: new Set(["t1"]),
    isWorking: false,
    activeTurnStartedAt: null,
    supportsConversationRollback: false
  });
  const calls: string[] = [];
  const noop = (): void => {};
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(
      createElement(ChatTimeline, {
        sessionId: "s1",
        rows,
        follow: true,
        onFollowChange: noop,
        disclosures: { expandedTurnIds: ["t1"], expandedGroupIds: ["cmd-1"], expandedAgentIds: [], expandedReasoningIds: [], toolOutputOffsets: {} },
        onDisclosureChange: noop,
        bottomInset: 0,
        canRevert: false,
        onRevert: noop,
        onOpenTurnDiff: (turnCount) => void calls.push(`diff:${turnCount}`),
        onOpenFile: (path) => void calls.push(`file:${path}`),
        onLoadFullOutput: (itemId) => void calls.push(`output:${itemId}`),
        onOpenAgent: noop,
        onSendQueuedNow: noop,
        onReturnQueuedToComposer: noop,
        errorBanner: null,
        onDismissErrorBanner: noop,
        threadReady: true
      })
    );
  });

  const buttons = (): HTMLButtonElement[] => Array.from(mount.querySelectorAll("button"));
  const press = async (find: (button: HTMLButtonElement) => boolean, what: string): Promise<void> => {
    const button = buttons().find(find);
    assert.ok(button, what);
    await act(async () => button.click());
  };
  await press((button) => button.getAttribute("aria-label") === "Open the full diff for this turn", "the turn diff");
  await press((button) => button.textContent === "the server", "the workspace link");
  await press((button) => button.textContent?.includes("server.ts") === true, "the changed file");
  await press((button) => button.textContent === "Load full output", "the full output");
  assert.deepEqual(calls, ["diff:1", "file:src/server.ts", "file:src/server.ts", "output:cmd-1"]);
});
