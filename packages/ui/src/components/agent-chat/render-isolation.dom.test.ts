/**
 * Re-render isolation, counted: a streamed reply delta re-renders the
 * streaming row (and the timeline that lays it out) — never the chat view, its
 * composer or the composer's footer; a subagent's progress re-renders the view
 * that shows the roster — never a message row; a keystroke re-renders the composer's
 * field — never the footer chips, the chat view or the timeline. Counted with
 * `lib/render-probe.ts` on the real `AgentChatView`, its real thread store and
 * a scripted transport.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { AgentChatStreamFrame, ThreadSnapshotPayload } from "@orquester/api/agent-chat";

import type { AgentChatTransport } from "../../lib/agent-chat/transport";
import { activity, ev, head, message, snapshot } from "../../lib/agent-chat/test-helpers";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let AgentChatView: typeof import("./AgentChatView").AgentChatView;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let countRenders: typeof import("../../lib/render-probe").countRenders;
let releaseThreadStore: typeof import("../../lib/agent-chat/store").releaseThreadStore;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
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
  "MutationObserver"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const window = dom.window as unknown as Record<string, unknown>;
  window.matchMedia = (query: string) => ({
    matches: query.includes("min-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {}
  });
  window.ResizeObserver = InertObserver;
  window.IntersectionObserver = InertObserver;
  window.HTMLElement = dom.window.HTMLElement;
  (dom.window.HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
  (dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = window[name];
    Object.defineProperty(globalThis, name, {
      value: typeof value === "function" && (name === "getComputedStyle" || name.endsWith("AnimationFrame"))
        ? (value as (...args: unknown[]) => unknown).bind(dom.window)
        : value,
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ AgentChatView } = await import("./AgentChatView"));
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  ({ countRenders } = await import("../../lib/render-probe"));
  ({ releaseThreadStore } = await import("../../lib/agent-chat/store"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/** A transport whose stream this test drives frame by frame; every other call stays unanswered. */
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

/** An API client whose every method waits forever, but for the chat transport. */
function scriptedApi(transport: AgentChatTransport): unknown {
  const never = () => new Promise<never>(() => {});
  return new Proxy({ agentChat: transport } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : typeof key === "string" ? never : undefined)
  });
}

const SESSION_ID = "render-isolation";
const STREAMING_ID = "reply-1";

function runningThread(): ThreadSnapshotPayload {
  return snapshot({
    head: head({
      id: SESSION_ID,
      session: { status: "running", activeTurnId: "t1" }
    }),
    items: [
      message("user", "Explain the change", { id: "prompt-1", turnId: "t1" }),
      message("assistant", "It ", { id: STREAMING_ID, turnId: "t1", streaming: true })
    ],
    turns: [
      {
        turnId: "t1",
        state: "running",
        turnCount: null,
        requestedAt: "2026-10-23T10:00:00.000Z",
        startedAt: "2026-10-23T10:00:00.000Z",
        completedAt: null,
        assistantMessageId: STREAMING_ID,
        userMessageId: "prompt-1"
      }
    ],
    seq: 10
  });
}

describe("re-render isolation", () => {
  let root: Root;
  let push: (frame: AgentChatStreamFrame) => void;
  let seq = 10;

  before(async () => {
    const scripted = scriptedTransport();
    push = scripted.push;
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    await act(async () => {
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: scriptedApi(scripted.transport) as never,
          useTitlebar: false,
          children: createElement(AgentChatView, {
            session: { id: SESSION_ID, refId: "claude", title: "Render isolation", kind: "chat" } as never,
            projectPath: "",
            active: true
          })
        })
      );
    });
    await act(async () => {
      push({ kind: "snapshot", thread: runningThread() } as AgentChatStreamFrame);
    });
  });

  after(async () => {
    await act(async () => root.unmount());
    releaseThreadStore(SESSION_ID);
  });

  it("a streamed reply delta re-renders the streaming row, never the view, the composer or its footer", async () => {
    const probe = countRenders();
    try {
      for (const delta of ["is ", "a ", "small ", "fix."]) {
        seq += 1;
        await act(async () => {
          push({
            kind: "event",
            seq,
            event: ev(
              "thread.message-sent",
              { messageId: STREAMING_ID, role: "assistant", text: delta, streaming: true, turnId: "t1" },
              { seq, threadId: SESSION_ID }
            )
          } as AgentChatStreamFrame);
        });
      }
    } finally {
      probe.stop();
    }
    const rendered = Object.fromEntries(probe.counts);
    console.log("render counts for 4 streamed deltas:", JSON.stringify(rendered));
    assert.equal(rendered.AssistantMessageRow, 4, "the streaming row renders once per delta");
    for (const name of ["AgentChatView", "ChatComposer", "ModelChip", "RuntimeModeChip"]) {
      assert.equal(rendered[name] ?? 0, 0, `${name} re-rendered for a streamed delta`);
    }
    assert.ok(
      dom.window.document.body.textContent?.includes("It is a small fix."),
      "the streamed text reached the screen"
    );
  });

  it("a subagent's progress re-renders no message row", async () => {
    const probe = countRenders();
    try {
      for (const [kind, extra] of [
        ["task.started", {}],
        ["task.progress", { summary: "Reading the auth module" }],
        ["task.progress", { summary: "Reading the session store" }]
      ] as const) {
        seq += 1;
        await act(async () => {
          push({
            kind: "event",
            seq,
            event: ev(
              "thread.activity-appended",
              {
                activity: activity(
                  kind,
                  { taskId: "agent-1", taskType: "subagent", agentKind: "agent", title: "Audit", ...extra },
                  { id: `task-${seq}`, tone: "info", turnId: "t1", agentId: "agent-1" }
                )
              },
              { seq, threadId: SESSION_ID }
            )
          } as AgentChatStreamFrame);
        });
      }
    } finally {
      probe.stop();
    }
    const rendered = Object.fromEntries(probe.counts);
    console.log("render counts for 3 roster ticks:", JSON.stringify(rendered));
    assert.ok((rendered.AgentChatView ?? 0) > 0, "the roster moved, and the view that shows it re-rendered");
    assert.equal(rendered.AssistantMessageRow ?? 0, 0, "a message row re-rendered for a roster tick");
    assert.ok(
      (dom.window.document.body.textContent ?? "").includes("It is a small fix."),
      "the reply is still on screen"
    );
  });

  it("a keystroke re-renders the composer's field, never its footer, the view or the timeline", async () => {
    const textarea = dom.window.document.querySelector("textarea");
    assert.ok(textarea, "the composer is mounted");
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    const probe = countRenders();
    try {
      for (const value of ["h", "he", "hel", "hell", "hello"]) {
        await act(async () => {
          setValue.call(textarea, value);
          textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
      }
    } finally {
      probe.stop();
    }
    const rendered = Object.fromEntries(probe.counts);
    console.log("render counts for 5 keystrokes:", JSON.stringify(rendered));
    assert.equal(textarea.value, "hello");
    for (const name of ["AgentChatView", "ChatTimeline", "AssistantMessageRow", "ModelChip", "RuntimeModeChip"]) {
      assert.equal(rendered[name] ?? 0, 0, `${name} re-rendered for a keystroke`);
    }
  });
});
