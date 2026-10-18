/**
 * A `Modal`'s Escape in a DOM: it closes the modal only while the modal is the
 * newest open layer. A menu opened inside it, or a non-modal editor drawn over
 * it (the agent-config editor over Settings), owns that Escape — even when it
 * lets go of its layer while handling the same key.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { isAnyLayerOpen, openTrackedLayer } from "../../lib/open-layers";
import { Modal } from "./modal";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "KeyboardEvent"] as const;
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

describe("Modal's Escape", () => {
  let root: Root;
  let host: HTMLElement;
  let closes: number;

  beforeEach(() => {
    // The modal hands focus back on a timer after it closes: run it here, not after the DOM is gone.
    mock.timers.enable({ apis: ["setTimeout"] });
    closes = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      const onClose = () => {
        closes += 1;
      };
      root.render(createElement(Modal, { open: true, onClose, children: createElement("button", null, "in") }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
    host.remove();
    assert.equal(isAnyLayerOpen(), false, "the modal left its layer open");
  });

  const pressEscape = (target: EventTarget = document.body) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

  it("closes the modal while it is the newest layer", () => {
    pressEscape();
    assert.equal(closes, 1);
  });

  it("leaves the Escape to a newer layer drawn over it", () => {
    const editor = openTrackedLayer();
    pressEscape();
    assert.equal(closes, 0, "the editor over Settings owns this Escape");
    editor.release();
    pressEscape();
    assert.equal(closes, 1, "with the editor gone the modal is the newest again");
  });

  it("stays open when the newer layer lets go of its layer on the same key", () => {
    // A menu inside the modal: its own handler runs before the modal's
    // bubbling listener and releases the menu's layer there and then.
    const menu = openTrackedLayer();
    const item = document.createElement("button");
    document.body.appendChild(item);
    item.addEventListener("keydown", () => menu.release());
    pressEscape(item);
    item.remove();
    assert.equal(closes, 0);
  });
});
