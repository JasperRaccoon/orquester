/**
 * `<orquester-agent-chat>`, mounted in jsdom the way a host page uses it:
 * frames pushed in, events listened for, loaders set (design
 * `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md` §5.10).
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { JSDOM } from "jsdom";

import type {
  PendingUserInput,
  ThreadHistoryPage,
  ThreadItem,
  ThreadItemOutputResponse,
  ThreadSnapshotPayload,
  Turn
} from "@orquester/api/agent-chat";

import { activity, head, message, snapshot } from "../../../../packages/ui/src/lib/agent-chat/test-helpers";

import { EMBED_PRELOAD_ERROR_EVENT } from "./contract";
import type { EmbedCommandDetail, EmbedLoaders, EmbedPendingDetail, EmbedResyncDetail } from "./types";

type EmbedElement = HTMLElement & {
  pushFrames(frames: unknown): void;
  reset(): void;
  loaders: EmbedLoaders;
  respondFailed(commandId: string, message?: string): void;
  readonly sessionId: string | null;
};

let act: typeof import("react").act;
let define: typeof import("./index").define;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "ShadowRoot",
  "customElements",
  "CustomEvent",
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

/** A phone-sized viewport: no `min-width` query matches. Read when an element mounts. */
let narrow = false;

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const window = dom.window as unknown as Record<string, unknown>;
  window.matchMedia = (query: string) => ({
    // Every query matches — a wide viewport — unless a test narrows it.
    matches: !(narrow && query.includes("min-width")),
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
  ({ define } = await import("./index"));
  define();
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

// ---------------------------------------------------------------------------
// Fixtures: the wire shapes the daemon's stream sends
// ---------------------------------------------------------------------------

const SESSION = "chat-embed-1";
const at = (second: number): string => `2026-11-13T10:00:${String(second).padStart(2, "0")}.000Z`;

function settledTurn(turnId: string, userMessageId: string, second: number): Turn {
  return {
    turnId,
    state: "completed",
    turnCount: null,
    requestedAt: at(second),
    startedAt: at(second),
    completedAt: at(second + 5),
    assistantMessageId: null,
    userMessageId
  };
}

function thread(items: ThreadItem[], overrides: Partial<ThreadSnapshotPayload> = {}): ThreadSnapshotPayload {
  return snapshot({
    head: head({ id: SESSION, title: "Audit" }),
    items,
    turns: [settledTurn("t1", "u1", 0)],
    seq: 10,
    ...overrides
  });
}

const conversation = (): ThreadItem[] => [
  message("user", "Review the server config", { id: "u1", turnId: "t1", createdAt: at(0) }),
  message("assistant", "The config looks sound.", { id: "a1", turnId: "t1", createdAt: at(2) })
];

/** A running turn, so its rows render unfolded. */
function running(items: ThreadItem[]): ThreadSnapshotPayload {
  return thread(items, {
    head: head({ id: SESSION, session: { status: "running", activeTurnId: "t1" } }),
    turns: [{ ...settledTurn("t1", "u1", 0), state: "running", completedAt: null }]
  });
}

/** A completed Orquester session-tool call, as the slimmed wire carries it. */
function sessionToolCall(name: string, references: Record<string, unknown>): ThreadItem[] {
  const data = { sessionTool: { name, references } };
  return [
    activity("tool.started", { itemType: "mcp_tool_call", toolUseId: `call-${name}`, status: "inProgress", data }, { turnId: "t1", createdAt: at(1) }),
    activity("tool.completed", { itemType: "mcp_tool_call", toolUseId: `call-${name}`, status: "completed", data }, {
      turnId: "t1",
      createdAt: at(1),
      status: "completed"
    })
  ];
}

const question: PendingUserInput = {
  requestId: "req-1",
  createdAt: at(3),
  dismissible: false,
  questions: [
    {
      id: "Which host?",
      header: "Host",
      question: "Which host?",
      options: [
        { label: "Alpha", description: "the first" },
        { label: "Beta", description: "the second" }
      ]
    }
  ]
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let element: EmbedElement;

beforeEach(async () => {
  element = dom.window.document.createElement("orquester-agent-chat") as unknown as EmbedElement;
  await act(async () => {
    dom.window.document.body.replaceChildren(element);
  });
});

afterEach(async () => {
  await act(async () => {
    element.remove();
  });
  narrow = false;
});

const shadow = (): ShadowRoot => element.shadowRoot!;
const text = (): string => shadow().textContent ?? "";
const all = <T extends Element>(selector: string): T[] => Array.from(shadow().querySelectorAll<T>(selector));

function push(frames: unknown): void {
  act(() => element.pushFrames(frames));
}

/** The next `type` event the element fires. */
function next<T>(type: string): Promise<T> {
  return new Promise((resolve) => element.addEventListener(type, (event) => resolve((event as CustomEvent<T>).detail), { once: true }));
}

/** A function that resolves `called` with its first call's arguments, and answers with `answer`. */
function spy<A extends unknown[], R>(answer: (...args: A) => R): { fn: (...args: A) => R; called: Promise<A> } {
  let resolve!: (args: A) => void;
  const called = new Promise<A>((done) => (resolve = done));
  return {
    fn: (...args: A) => {
      resolve(args);
      return answer(...args);
    },
    called
  };
}

/** Wait for `promise` inside act, so the renders it causes are flushed. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let value!: T;
  await act(async () => {
    value = await promise;
  });
  return value;
}

function type(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function click(target: Element): void {
  act(() => {
    (target as HTMLElement).click();
  });
}

// ---------------------------------------------------------------------------

describe("orquester-agent-chat — frames", () => {
  it("renders the messages of the frames it is handed, and reset() empties it", () => {
    push([{ kind: "snapshot", thread: thread(conversation()) }, { kind: "synchronized", hostInstanceId: "h1" }]);
    assert.equal(element.sessionId, SESSION);
    assert.ok(text().includes("Review the server config"));
    assert.ok(text().includes("The config looks sound."));
    const wrapper = shadow().querySelector<HTMLElement>(".orq-embed-root");
    assert.equal(wrapper?.dataset.mode, "dark");
    assert.equal(wrapper?.dataset.scheme, "mono");

    act(() => element.reset());
    assert.equal(element.sessionId, null);
    assert.ok(!text().includes("Review the server config"));
    assert.ok(!text().includes("The config looks sound."));
  });

  it("ignores a frame kind it does not know, with a warning, and the thread stays as it was", () => {
    push({ kind: "snapshot", thread: thread(conversation()) });
    const before = text();
    const warn = mock.method(console, "warn", () => {});
    let pendingEvents = 0;
    element.addEventListener("orquester-pending", () => (pendingEvents += 1));
    try {
      push([{ kind: "error", error: { code: "THREAD_NOT_FOUND" } }, { kind: "thread-v9", payload: {} }]);
      assert.equal(warn.mock.callCount(), 2);
    } finally {
      warn.mock.restore();
    }
    assert.equal(text(), before);
    assert.equal(element.sessionId, SESSION);
    assert.equal(pendingEvents, 0);
  });

  it("asks for a resync when a synchronized frame names a new host instance", async () => {
    let resyncs = 0;
    element.addEventListener("orquester-resync", () => (resyncs += 1));
    push([{ kind: "snapshot", thread: thread(conversation()) }, { kind: "synchronized", hostInstanceId: "h1" }]);
    push({ kind: "synchronized", hostInstanceId: "h1" });
    assert.equal(resyncs, 0, "the same host is a resume");
    const resync = next<EmbedResyncDetail>("orquester-resync");
    push({ kind: "synchronized", hostInstanceId: "h2" });
    assert.deepEqual(await resync, { sessionId: SESSION });
  });

  it("says orquester-stale for its own chunk failures only, never for the page's vite:preloadError", () => {
    let stale = 0;
    element.addEventListener("orquester-stale", () => (stale += 1));
    dom.window.dispatchEvent(new dom.window.Event("vite:preloadError"));
    assert.equal(stale, 0, "the host page's own chunk failure");
    dom.window.dispatchEvent(new dom.window.Event(EMBED_PRELOAD_ERROR_EVENT));
    assert.equal(stale, 1, "the embed's chunk failure");
  });
});

describe("orquester-agent-chat — what it cannot open", () => {
  it("shows changed files and workspace links as plain text, with no turn diff, and keeps web links", () => {
    push({
      kind: "snapshot",
      thread: thread(
        [
          message("user", "Fix the port", { id: "u1", turnId: "t1", createdAt: at(0) }),
          message("assistant", "Edited [the server](src/server.ts), per [the docs](https://docs.example/ports).", {
            id: "a1",
            turnId: "t1",
            createdAt: at(2)
          })
        ],
        {
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
          ]
        }
      )
    });
    assert.ok(text().includes("1 changed file"), "the changed-files card");
    assert.ok(text().includes("server.ts"));
    assert.ok(text().includes("the server"));
    const buttons = all<HTMLButtonElement>("button");
    assert.ok(!buttons.some((button) => button.getAttribute("aria-label") === "Open the full diff for this turn"), "no turn diff");
    assert.ok(!buttons.some((button) => /server\.ts|the server/.test(button.textContent ?? "")), "no file opens");
    assert.equal(all('a[href="src/server.ts"]').length, 0, "a workspace path navigates nowhere");
    const [web] = all<HTMLAnchorElement>('a[href="https://docs.example/ports"]');
    assert.equal(web?.target, "_blank", "a web link stays a link");
  });

  it("lists a delegated child as its call recorded it, never as a closed tab", () => {
    push({
      kind: "snapshot",
      thread: running([
        message("user", "Split the audit", { id: "u1", turnId: "t1", createdAt: at(0) }),
        ...sessionToolCall("create_session", { threadRef: { threadId: "child-1", title: "Audit the database", relation: "delegate" } })
      ])
    });
    const [toggle] = all<HTMLButtonElement>("[data-delegate-group] button[aria-expanded]");
    assert.ok(toggle, "the subagent strip");
    click(toggle);
    assert.ok(text().includes("Audit the database"));
    assert.doesNotMatch(text(), /closed/i);
  });
});

describe("orquester-agent-chat — questions", () => {
  it("fires orquester-pending only when the set of open requests changes", () => {
    const events: EmbedPendingDetail[] = [];
    element.addEventListener("orquester-pending", (event) => events.push((event as CustomEvent<EmbedPendingDetail>).detail));
    push([{ kind: "snapshot", thread: thread(conversation()) }, { kind: "synchronized", hostInstanceId: "h1" }]);
    act(() => element.reset());
    assert.equal(events.length, 0, "a session with nothing open, and its reset, announce nothing");

    push({ kind: "snapshot", thread: thread(conversation(), { pending: { approvals: [], userInputs: [question] } }) });
    push({ kind: "synchronized", hostInstanceId: "h1" });
    act(() => element.reset());
    assert.deepEqual(events, [
      { sessionId: SESSION, pending: [{ requestId: "req-1", kind: "question" }] },
      { sessionId: null, pending: [] }
    ]);
  });

  it("fires orquester-pending for an open question, and an answer as an AnswerCommandBody until respondFailed", async () => {
    const pending = next<EmbedPendingDetail>("orquester-pending");
    push({ kind: "snapshot", thread: thread(conversation(), { pending: { approvals: [], userInputs: [question] } }) });
    assert.deepEqual(await pending, { sessionId: SESSION, pending: [{ requestId: "req-1", kind: "question" }] });

    const textarea = shadow().querySelector<HTMLTextAreaElement>('textarea[aria-label="Custom answer"]');
    assert.ok(textarea, "the question card is up");
    const command = next<EmbedCommandDetail>("orquester-command");
    type(textarea, "Gamma");
    act(() => {
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const detail = await command;
    assert.equal(detail.sessionId, SESSION);
    assert.equal(detail.command, "answer");
    assert.equal(typeof detail.body.commandId, "string");
    assert.ok(detail.body.commandId.length > 0);
    assert.deepEqual(
      { requestId: detail.body.requestId, answers: (detail.body as { answers: unknown }).answers },
      { requestId: "req-1", answers: { "Which host?": "Gamma" } }
    );

    const options = (): HTMLButtonElement[] => all<HTMLButtonElement>("[data-question-option]");
    assert.ok(options().length > 0 && options().every((option) => option.disabled), "the card is responding");
    act(() => element.respondFailed(detail.body.commandId, "The server could not be reached."));
    assert.ok(options().every((option) => !option.disabled), "the card takes input again");
    assert.ok(text().includes("The server could not be reached."));
  });
});

describe("orquester-agent-chat — loaders", () => {
  it("'load older' asks the history loader, and shows nothing without one", async () => {
    push({
      kind: "snapshot",
      thread: thread(conversation(), {
        history: { indexed: true, hasOlder: true, beforeCursor: "cursor-1", oldestRetainedOrdinal: 2, totalTurns: 2 }
      })
    });
    assert.equal(all("[data-timeline-load-older-button]").length, 0, "no loader, no row");

    const page: ThreadHistoryPage = {
      threadId: SESSION,
      turns: [
        { turnId: "t0", ordinal: 1, userMessageId: "u0", requestedAt: at(0), startedAt: at(0), completedAt: at(0), rewindable: false }
      ],
      items: [message("user", "An older request", { id: "u0", turnId: "t0", createdAt: "2026-11-13T09:00:00.000Z" })],
      checkpoints: [],
      page: { beforeCursor: null },
      seq: 10
    } as ThreadHistoryPage;
    const history = spy((_request: Parameters<NonNullable<EmbedLoaders["history"]>>[0], _signal?: AbortSignal) => Promise.resolve(page));
    act(() => {
      element.loaders = { history: history.fn };
    });
    const [button] = all<HTMLButtonElement>("[data-timeline-load-older-button]");
    assert.ok(button, "the load row is offered");
    click(button);
    const [request] = await settle(history.called);
    assert.deepEqual(request, { sessionId: SESSION, before: "cursor-1", turns: 20 });
    await settle(Promise.resolve());
    assert.ok(text().includes("An older request"));
  });

  describe("'load full output'", () => {
    type ItemRequest = Parameters<NonNullable<EmbedLoaders["item"]>>[0];
    type ItemOutputRequest = Parameters<NonNullable<EmbedLoaders["itemOutput"]>>[0];

    /** A command whose result the wire cut: its row offers the item read. */
    const cutCommand = (payload: Record<string, unknown> = {}): ThreadItem =>
      activity(
        "tool.completed",
        {
          itemType: "command_execution",
          toolUseId: "call-ls",
          command: "ls -la /etc",
          status: "completed",
          truncated: true,
          data: { output: "a\nb" },
          ...payload
        },
        { id: "cmd-1", turnId: "t1", createdAt: at(1), status: "completed" }
      );

    function pushCommand(): void {
      push({
        kind: "snapshot",
        thread: running([
          message("user", "list it", { id: "u1", turnId: "t1", createdAt: at(0) }),
          cutCommand(),
          message("assistant", "Listed.", { id: "a1", turnId: "t1", createdAt: at(2) })
        ])
      });
      const [row] = all<HTMLElement>('[data-activity-id="cmd-1"][role="button"]');
      assert.ok(row, "the command's row");
      click(row);
      assert.ok(text().includes("ls -la /etc"), "the row is open");
    }

    const button = (label: string): HTMLButtonElement | undefined =>
      all<HTMLButtonElement>("button").find((candidate) => candidate.textContent === label);
    const viewerText = (): string => shadow().querySelector('[role="dialog"]')?.textContent ?? "";

    it("is offered only with both the item and the itemOutput loaders", () => {
      pushCommand();
      assert.equal(button("Load full output"), undefined, "no loaders");
      act(() => {
        element.loaders = { itemOutput: () => Promise.resolve(null) };
      });
      assert.equal(button("Load full output"), undefined, "itemOutput alone");
      act(() => {
        element.loaders = { item: () => Promise.reject(new Error("unused")) };
      });
      assert.equal(button("Load full output"), undefined, "item alone");
      act(() => {
        element.loaders = { item: () => Promise.reject(new Error("unused")), itemOutput: () => Promise.resolve(null) };
      });
      assert.ok(button("Load full output"), "both");
    });

    it("reads a cut tool result that never streamed through the item loader", async () => {
      const whole = cutCommand({ truncated: false, data: { item: { aggregatedOutput: "every line of the listing" } } });
      const item = spy((_request: ItemRequest, _signal?: AbortSignal) => Promise.resolve({ item: whole }));
      let outputReads = 0;
      act(() => {
        element.loaders = {
          item: item.fn,
          itemOutput: (_request: ItemOutputRequest) => {
            outputReads += 1;
            return Promise.resolve(null);
          }
        };
      });
      pushCommand();
      click(button("Load full output")!);
      const [request] = await settle(item.called);
      assert.deepEqual(request, { sessionId: SESSION, itemId: "cmd-1" });
      await settle(Promise.resolve());
      assert.ok(viewerText().includes("every line of the listing"), "the viewer shows the item's output");
      assert.equal(outputReads, 0, "an item that holds its output whole needs no streamed read");
    });

    it("reads a command's streamed output through itemOutput when its item is stored cut", async () => {
      const output: ThreadItemOutputResponse = { toolUseId: "call-ls", output: "every line of it", complete: true, truncated: false };
      const itemOutput = spy((_request: ItemOutputRequest, _signal?: AbortSignal) => Promise.resolve(output));
      act(() => {
        element.loaders = { item: () => Promise.resolve({ item: cutCommand() }), itemOutput: itemOutput.fn };
      });
      pushCommand();
      click(button("Load full output")!);
      const [request] = await settle(itemOutput.called);
      assert.equal(request.sessionId, SESSION);
      assert.equal(request.itemId, "cmd-1");
      assert.equal(request.offset, 0);
      await settle(Promise.resolve());
      assert.ok(viewerText().includes("every line of it"));
    });

    it("opens and closes its viewer on a phone-sized page without touching the page's history", async () => {
      narrow = true;
      // A new element, so it mounts with the narrow viewport.
      await act(async () => {
        element.remove();
      });
      element = dom.window.document.createElement("orquester-agent-chat") as unknown as EmbedElement;
      await act(async () => {
        dom.window.document.body.replaceChildren(element);
      });
      const history = dom.window.history;
      const pushState = mock.method(history, "pushState");
      const go = mock.method(history, "go");
      const listen = mock.method(dom.window, "addEventListener");
      try {
        act(() => {
          element.loaders = {
            item: () => Promise.resolve({ item: cutCommand({ truncated: false, data: { item: { aggregatedOutput: "all of it" } } }) }),
            itemOutput: () => Promise.resolve(null)
          };
        });
        pushCommand();
        click(button("Load full output")!);
        await settle(Promise.resolve());
        assert.ok(viewerText().includes("all of it"), "the viewer is open");
        click(shadow().querySelector('[role="dialog"] [aria-label="Close"]')!);
        await settle(Promise.resolve());
        assert.equal(shadow().querySelector('[role="dialog"]') === null, true, "the viewer closed");
        assert.equal(pushState.mock.callCount(), 0, "no history entry pushed");
        assert.equal(go.mock.callCount(), 0, "history never moved");
        assert.equal(listen.mock.calls.filter((call) => call.arguments[0] === "popstate").length, 0, "no popstate listener");
      } finally {
        pushState.mock.restore();
        go.mock.restore();
        listen.mock.restore();
      }
    });

    it("reads a cut compaction summary through the item loader", async () => {
      const compaction = (summary: string, truncated: boolean): ThreadItem =>
        activity(
          "context-compaction",
          { state: "compacted", beforeTokens: 100, afterTokens: 20, summary, ...(truncated ? { truncated: true } : {}) },
          { id: "cmp-1", turnId: "t1", createdAt: at(1), tone: "info", summary: "Context compacted" }
        );
      const item = spy((_request: ItemRequest, _signal?: AbortSignal) =>
        Promise.resolve({ item: compaction("The whole summary of the dropped turns", false) })
      );
      act(() => {
        element.loaders = { item: item.fn, itemOutput: () => Promise.resolve(null) };
      });
      push({
        kind: "snapshot",
        thread: thread([
          message("user", "Keep going", { id: "u1", turnId: "t1", createdAt: at(0) }),
          compaction("The whole summ", true),
          message("assistant", "Continuing.", { id: "a1", turnId: "t1", createdAt: at(2) })
        ])
      });
      click(button("Show summary")!);
      click(button("Load the full summary")!);
      const [request] = await settle(item.called);
      assert.deepEqual(request, { sessionId: SESSION, itemId: "cmp-1" });
      await settle(Promise.resolve());
      assert.ok(viewerText().includes("The whole summary of the dropped turns"));
    });
  });
  it("a show_image row reads its image through the attachment loader", async () => {
    const attachmentId = "t1-0f8fad5b-d9cb-469f-a165-70867728950e-png";
    const attachment = spy((_request: Parameters<NonNullable<EmbedLoaders["attachment"]>>[0], _signal?: AbortSignal) =>
      Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }))
    );
    act(() => {
      element.loaders = { attachment: attachment.fn };
    });
    push({
      kind: "snapshot",
      thread: running([
        message("user", "show me", { id: "u1", turnId: "t1", createdAt: at(0) }),
        ...sessionToolCall("show_image", { imageRef: { title: "Screens", images: [{ attachmentId, mimeType: "image/png", caption: "Home" }] } })
      ])
    });
    const [request] = await settle(attachment.called);
    assert.deepEqual(request, { sessionId: SESSION, attachmentId });
  });

  it("an html_render row loads its page through the visualUrl loader", async () => {
    const attachmentId = "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
    const visualUrl = spy((_request: Parameters<NonNullable<EmbedLoaders["visualUrl"]>>[0]) =>
      Promise.resolve("https://host.example/visuals/page.html")
    );
    act(() => {
      element.loaders = { visualUrl: visualUrl.fn };
    });
    push({
      kind: "snapshot",
      thread: running([
        message("user", "chart it", { id: "u1", turnId: "t1", createdAt: at(0) }),
        ...sessionToolCall("html_render", { htmlRender: { attachmentId, title: "Revenue", height: 360 } })
      ])
    });
    const [request] = await settle(visualUrl.called);
    assert.deepEqual(request, { sessionId: SESSION, attachmentId });
  });
});
