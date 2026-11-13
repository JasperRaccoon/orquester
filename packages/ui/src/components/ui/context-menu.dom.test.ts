/**
 * A `ContextMenu` opened near the viewport's bottom-right corner in a DOM: it
 * moves by the size it actually renders at (wrapped descriptions included), so
 * all of it stays on screen.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { ContextMenu } from "./context-menu";

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

describe("ContextMenu placement", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
  });

  it("keeps a menu whose descriptions wrap inside the viewport", () => {
    // jsdom lays nothing out: report the size a browser renders these wrapped reasons at.
    const rendered = { width: 260, height: 190 };
    const proto = dom.window.HTMLElement.prototype;
    const measure = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute("role") === "menu"
        ? ({ x: 0, y: 0, top: 0, left: 0, right: rendered.width, bottom: rendered.height, ...rendered } as DOMRect)
        : measure.call(this);
    };
    try {
      const host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      const reason = "Refused: this folder holds the daemon's own state and the service's secrets.";
      act(() => {
        root!.render(
          createElement(ContextMenu, {
            x: window.innerWidth - 10,
            y: window.innerHeight - 10,
            onClose: () => {},
            items: [
              { label: "Rename", onClick: () => {}, disabled: true, description: reason },
              { label: "Delete", onClick: () => {}, disabled: true, description: reason }
            ]
          })
        );
      });
      const menu = document.querySelector('[role="menu"]') as HTMLElement;
      assert.ok(parseFloat(menu.style.top) + rendered.height <= window.innerHeight, `top ${menu.style.top}`);
      assert.ok(parseFloat(menu.style.left) + rendered.width <= window.innerWidth, `left ${menu.style.left}`);
    } finally {
      proto.getBoundingClientRect = measure;
    }
  });
});
