/**
 * `useBackClose` in a DOM (jsdom: no media queries, so a phone): an open
 * overlay holds a history entry, Back closes it, a close through the UI gives
 * the entry back, and an overlay that refuses the close holds a fresh one.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { useBackClose } from "./use-back-close";

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
  dom.window.close();
});

/** The next `popstate` (jsdom traverses history asynchronously, like a browser). */
const popped = (): Promise<void> =>
  new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

const depth = (): number => {
  const state = window.history.state as { orqBackClose?: number } | null;
  return state?.orqBackClose ?? 0;
};

/** Let the stack's microtask run, then whatever React scheduled. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** The user presses Back: the traversal lands and React settles, all inside `act`. */
const pressBack = async (): Promise<void> => {
  const landed = popped();
  await act(async () => {
    window.history.back();
    await landed;
  });
  await settle();
};

let api: { setOpen: (open: boolean) => void; refuse: boolean; closes: number } = { setOpen: () => undefined, refuse: false, closes: 0 };

const Overlay = (): null => {
  const [open, setOpen] = useState(true);
  api.setOpen = setOpen;
  useBackClose(open, () => {
    api.closes += 1;
    if (!api.refuse) setOpen(false);
  });
  return null;
};

describe("useBackClose", () => {
  it("Back closes the overlay; a refused close holds a fresh entry; a UI close gives it back", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    api = { setOpen: () => undefined, refuse: true, closes: 0 };
    act(() => root.render(createElement(Overlay)));
    await settle();
    assert.equal(depth(), 1, "the open overlay holds an entry");

    // Refused: still open, and Back is armed again.
    await pressBack();
    assert.equal(api.closes, 1);
    assert.equal(depth(), 1, "re-armed");

    // Accepted.
    api.refuse = false;
    await pressBack();
    assert.equal(api.closes, 2);
    assert.equal(depth(), 0);

    // Open again, then close through the UI: the entry goes away with it.
    act(() => api.setOpen(true));
    await settle();
    assert.equal(depth(), 1);
    const landed = popped();
    act(() => api.setOpen(false));
    await settle();
    await landed; // our own traversal: it sets no state
    assert.equal(depth(), 0);
    assert.equal(api.closes, 2, "a UI close is not a Back");

    act(() => root.unmount());
  });
});
