/**
 * Another chat's message folded to one line, in a DOM: which messages fold, the header button
 * (caption, first line, `aria-expanded`), opening and closing it, find-in-page opening it
 * (`beforematch` on the `hidden="until-found"` body), and the header staying where it was
 * clicked when the fold opens.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  buildMergeBackMessage,
  buildThreadMessage,
  mergeBackContext,
  threadMessageContext,
  type ComposerContextRecord,
  type ThreadMessageOrigin
} from "@orquester/api/agent-chat";

import type { TimelineRowContextValue } from "./context";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let UserMessageRow: typeof import("./rows/MessageRows").UserMessageRow;
let TimelineRowContext: typeof import("./context").TimelineRowContext;

let dom: JSDOM;
const globals = [
  "window", "document", "HTMLElement", "Element", "Node", "Text", "navigator", "KeyboardEvent",
  "MouseEvent", "Event", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ UserMessageRow } = await import("./rows/MessageRows"));
  ({ TimelineRowContext } = await import("./context"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const CONTEXT = { readOnly: true, canRevert: false, revertBusy: false, startedTurnCount: 1, skills: [], onFork: null } as unknown as TimelineRowContextValue;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function messageRow(text: string, context: ComposerContextRecord[] | undefined) {
  return {
    kind: "message",
    id: "r1",
    createdAt: "2026-10-23T00:00:00.000Z",
    message: { kind: "message", id: "m1", role: "user", text, turnId: "t1", streaming: false, createdAt: "t", updatedAt: "t", ...(context ? { context } : {}) }
  };
}

/** The row inside a stand-in timeline scroller (the element `ChatTimeline` marks). */
function render(row: ReturnType<typeof messageRow>): HTMLElement {
  host = document.createElement("div");
  host.setAttribute("data-agent-chat-timeline", "s1");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(TimelineRowContext.Provider, { value: CONTEXT }, createElement(UserMessageRow, { row: row as never })));
  });
  return host;
}

function sentBy(origin: ThreadMessageOrigin, body = "Audit the auth module.\nThen report back."): ReturnType<typeof messageRow> {
  return messageRow(buildThreadMessage({ origin, fromTitle: "Main", text: body }), [threadMessageContext("main")]);
}

function header(scope: HTMLElement): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>("button[aria-expanded]");
  assert.ok(button, "the fold's header button");
  return button;
}

function body(scope: HTMLElement): HTMLElement {
  const element = scope.querySelector<HTMLElement>("[data-folded-body]");
  assert.ok(element, "the fold's body");
  return element;
}

describe("another chat's message folds to one line", () => {
  for (const origin of ["sent", "reply", "opened", "delegated"] as const) {
    it(`folds a ${origin} message behind a header naming its sender and first line`, () => {
      const scope = render(sentBy(origin, "\n\n  Audit   the\tauth module.  \nThen report back."));
      const button = header(scope);
      assert.equal(button.getAttribute("aria-expanded"), "false");
      assert.equal(button.getAttribute("aria-controls"), body(scope).id);
      assert.match(button.textContent ?? "", /“Main”/);
      assert.match(button.textContent ?? "", /Audit the auth module\./);
      assert.doesNotMatch(button.textContent ?? "", /Then report back/, "one line only");
      assert.equal(body(scope).getAttribute("hidden"), "until-found", "the body stays findable");
      assert.equal(scope.querySelector("[data-from-thread]")?.getAttribute("data-from-thread"), origin);
    });
  }

  it("opens on a click and closes on the next, the body in the bubble", () => {
    const scope = render(sentBy("delegated"));
    const button = header(scope);
    act(() => button.click());
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(body(scope).hasAttribute("hidden"), false);
    assert.match(body(scope).textContent ?? "", /Audit the auth module\.\s*Then report back\./);
    assert.equal(scope.querySelector("[data-folded]"), null);
    act(() => button.click());
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(body(scope).getAttribute("hidden"), "until-found");
    assert.ok(scope.querySelector("[data-folded]"));
  });

  it("opens when find-in-page matches its hidden text", () => {
    const scope = render(sentBy("reply"));
    act(() => {
      body(scope).dispatchEvent(new Event("beforematch"));
    });
    assert.equal(header(scope).getAttribute("aria-expanded"), "true");
    assert.equal(body(scope).hasAttribute("hidden"), false);
  });
});

describe("messages that stay open", () => {
  it("a request for the user's input keeps its caption over the full bubble", () => {
    const scope = render(sentBy("attention"));
    assert.equal(scope.querySelector("button[aria-expanded]"), null);
    assert.equal(scope.querySelector("[data-from-thread]")?.getAttribute("data-from-thread"), "attention");
    assert.match(scope.textContent ?? "", /Then report back\./);
  });

  it("a merged-back result is never folded", () => {
    const text = buildMergeBackMessage({ childTitle: "Try B", relation: "fork", text: "B works." });
    const scope = render(messageRow(text, [mergeBackContext("merge-1")]));
    assert.equal(scope.querySelector("button[aria-expanded]"), null);
    assert.ok(scope.querySelector("[data-merged-back]"));
    assert.match(scope.textContent ?? "", /B works\./);
  });

  it("the user's own message is never folded, even one that types another chat's header", () => {
    const scope = render(messageRow(buildThreadMessage({ origin: "sent", fromTitle: "Main", text: "Do X." }), undefined));
    assert.equal(scope.querySelector("button[aria-expanded]"), null);
    assert.equal(scope.querySelector("[data-from-thread]"), null);
  });
});
