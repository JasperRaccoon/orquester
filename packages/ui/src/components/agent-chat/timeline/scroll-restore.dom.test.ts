/**
 * The timeline's restore of a remembered reading position whose row is gone:
 * a cold open mounts with no rows, so the restore waits for them, and a turn
 * the window does not show — none of it, or only rows kept out of it without
 * its prompt — is paged back in (`revealTurn`) instead of landing at a pixel
 * offset in another turn.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { AgentChatStreamFrame, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import type { AgentChatTransport } from "../../../lib/agent-chat/transport";
import { activity, head, message, snapshot } from "../../../lib/agent-chat/test-helpers";
import type { TimelineScrollPosition } from "../contracts";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ChatTimeline: typeof import("./ChatTimeline").ChatTimeline;
let OrquesterProvider: typeof import("../../../context/orquester-context").OrquesterProvider;
let ensureThreadStore: typeof import("../../../lib/agent-chat/store").ensureThreadStore;
let releaseThreadStore: typeof import("../../../lib/agent-chat/store").releaseThreadStore;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "Event",
  "getComputedStyle",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "ResizeObserver",
  "IntersectionObserver",
  "MutationObserver",
  "CSS"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
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
  ({ OrquesterProvider } = await import("../../../context/orquester-context"));
  ({ ensureThreadStore, releaseThreadStore } = await import("../../../lib/agent-chat/store"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/** A transport whose stream the test drives; every other call stays unanswered. */
function scriptedTransport(): { transport: AgentChatTransport; push: (frame: AgentChatStreamFrame) => void } {
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  const never = () => new Promise<never>(() => {});
  const transport = new Proxy(
    {
      stream(_sessionId: string, _options: unknown, handlers: { onFrame: (frame: AgentChatStreamFrame) => void }) {
        onFrame = handlers.onFrame;
        return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, retry: () => {}, close: () => {} };
      },
      async providers() {
        return { providers: [], hostInstanceId: "h1" };
      }
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : never) }
  ) as unknown as AgentChatTransport;
  return { transport, push: (frame) => onFrame?.(frame) };
}

const AT = (second: number) => `2026-10-24T00:00:${String(second).padStart(2, "0")}.000Z`;
const turn = (n: number): Turn => ({
  turnId: `t${n}`,
  state: "completed",
  turnCount: null,
  requestedAt: AT(n * 10),
  startedAt: AT(n * 10),
  completedAt: AT(n * 10 + 5),
  assistantMessageId: `a${n}`,
  userMessageId: `u${n}`
});

/** A bounded window: turn 3 whole, and of turn 2 only its plan row, kept out of it. */
function boundedThread(sessionId: string): ThreadSnapshotPayload {
  return snapshot({
    head: head({ id: sessionId }),
    items: [
      activity("turn.plan.updated", { plan: [{ step: "two", status: "completed" }] }, { id: "plan-2", turnId: "t2", createdAt: AT(22) }),
      message("user", "third", { id: "u3", createdAt: AT(30) }),
      message("assistant", "three", { id: "a3", turnId: "t3", createdAt: AT(31) })
    ],
    turns: [turn(1), turn(2), turn(3)],
    seq: 10,
    history: { indexed: true, hasOlder: true, beforeCursor: "cut", oldestRetainedOrdinal: 3, totalTurns: 3, windowCut: "cut" }
  });
}

describe("restoring a remembered position whose row is gone", () => {
  let root: Root | null = null;
  let sessionCount = 0;
  afterEach(async () => {
    if (root !== null) await act(async () => root!.unmount());
    root = null;
  });

  async function setUp() {
    sessionCount += 1;
    const sessionId = `restore-${sessionCount}`;
    const scripted = scriptedTransport();
    const store = ensureThreadStore(sessionId, { transport: scripted.transport });
    // The store opens its stream once it has looked for a device copy (there is none here).
    await new Promise((resolve) => setImmediate(resolve));
    scripted.push({ kind: "snapshot", thread: boundedThread(sessionId) });
    scripted.push({ kind: "synchronized", hostInstanceId: "h1" });
    assert.ok(store.getState().rows.length > 0, "the bounded window is painted");
    const revealed: string[] = [];
    store.getState().actions.revealTurn = async (turnId: string) => {
      revealed.push(turnId);
      return true;
    };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    const render = async (rows: AgentChatTimelineRow[], scroll: TimelineScrollPosition) => {
      const noop = () => {};
      await act(async () => {
        root!.render(
          createElement(OrquesterProvider, {
            runtime: "web",
            api: new Proxy({ agentChat: scripted.transport } as Record<string, unknown>, {
              get: (target, key) => (key in target ? target[key as string] : () => new Promise(() => {}))
            }) as never,
            useTitlebar: false,
            children: createElement(ChatTimeline, {
              sessionId,
              rows,
              follow: false,
              onFollowChange: noop,
              disclosures: store.getState().slice.disclosures,
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
              scroll
            })
          })
        );
      });
    };
    return { sessionId, store, revealed, render, release: () => releaseThreadStore(sessionId) };
  }

  const remembered = (turnId: string): TimelineScrollPosition => ({
    rowId: `gone-of-${turnId}`,
    turnId,
    offsetWithinRow: 0,
    scrollOffset: 40,
    atEnd: false
  });

  it("a cold open waits for its rows, then pages in a turn the window does not hold", async () => {
    const { store, revealed, render, release } = await setUp();
    await render([], remembered("t1"));
    assert.deepEqual(revealed, [], "nothing to judge before the rows land");
    await render(store.getState().rows, remembered("t1"));
    assert.deepEqual(revealed, ["t1"]);
    // Once per mount: a later rows change does not restore again.
    await render([...store.getState().rows], remembered("t1"));
    assert.deepEqual(revealed, ["t1"]);
    release();
  });

  it("pages in a turn shown only by a row kept out of it, without its prompt", async () => {
    const { store, revealed, render, release } = await setUp();
    await render(store.getState().rows, remembered("t2"));
    assert.deepEqual(revealed, ["t2"]);
    release();
  });

  it("keeps the pixel offset for a turn the window shows with its prompt", async () => {
    const { store, revealed, render, release } = await setUp();
    await render(store.getState().rows, remembered("t3"));
    assert.deepEqual(revealed, []);
    assert.equal(document.querySelector<HTMLElement>("[data-agent-chat-timeline]")?.scrollTop, remembered("t3").scrollOffset);
    release();
  });
});
