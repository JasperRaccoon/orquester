/**
 * The gone notice covers its chat: focus that was in the chat (the composer)
 * moves to its way out, so keys no longer go to a composer under the overlay;
 * focus elsewhere in the app stays where it is.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { ThreadGoneNotice } from "./ThreadGoneNotice";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(() => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let elsewhere: HTMLInputElement;
let root: Root;

beforeEach(() => {
  const document = dom.window.document;
  const mount = document.createElement("div");
  elsewhere = document.createElement("input");
  document.body.replaceChildren(mount, elsewhere);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

/** The chat's box with its composer, and the notice over it once the thread is gone — as AgentChatView places it. */
const chat = (gone: boolean) =>
  createElement(
    "div",
    { "data-chat": "" },
    createElement("textarea"),
    gone ? createElement(ThreadGoneNotice, { onClose: () => {}, onRetry: () => {} }) : null
  );

const show = async () => {
  await act(async () => {
    root.render(chat(true));
  });
};

describe("the gone notice", () => {
  it("takes focus from the chat it covers", async () => {
    await act(async () => {
      root.render(chat(false));
    });
    dom.window.document.querySelector("textarea")!.focus();
    await show();
    assert.equal(dom.window.document.activeElement?.textContent, "Close tab");
  });

  it("takes focus when nothing had it", async () => {
    await show();
    assert.equal(dom.window.document.activeElement?.textContent, "Close tab");
  });

  it("leaves focus that is elsewhere in the app", async () => {
    elsewhere.focus();
    await show();
    assert.ok(dom.window.document.activeElement === elsewhere, "focus stays in the other pane");
  });
});
