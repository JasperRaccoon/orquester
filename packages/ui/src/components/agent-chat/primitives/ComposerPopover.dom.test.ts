/**
 * `ComposerPopover`'s outside press inside a shadow root (the embeddable chat):
 * from the document, a press inside the shadow root targets its host, so the
 * popover must read the press's path to tell its own panel and trigger from
 * the rest of the page — choosing an item works, the trigger toggles it, and a
 * press anywhere else still closes it.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ComposerPopover: typeof import("./ComposerPopover").ComposerPopover;
let ComposerMenuRow: typeof import("./ComposerPopover").ComposerMenuRow;
let PortalContainerProvider: typeof import("../../../lib/portal-container").PortalContainerProvider;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
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
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ComposerPopover, ComposerMenuRow } = await import("./ComposerPopover"));
  ({ PortalContainerProvider } = await import("../../../lib/portal-container"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ComposerPopover inside a shadow root", () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let root: Root;
  let chosen: number;

  beforeEach(() => {
    chosen = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    const app = document.createElement("div");
    const portal = document.createElement("div");
    shadow.append(app, portal);
    root = createRoot(app);
    act(() => {
      root.render(
        createElement(PortalContainerProvider, {
          container: portal,
          children: createElement(ComposerPopover, {
            label: "More",
            renderTrigger: (props) => createElement("button", { type: "button", "data-trigger": "", ...props }, "More"),
            children: (close) =>
              createElement(
                ComposerMenuRow,
                {
                  onClick: () => {
                    chosen += 1;
                    close();
                  }
                },
                "Always allow this session"
              )
          })
        })
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /**
   * A user's press: the mousedown, then — in a task of its own, after what
   * the mousedown did has rendered — the click it ends in.
   */
  const press = (target: Element) => {
    act(() => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    });
    act(() => {
      (target as HTMLElement).click();
    });
  };
  const trigger = () => shadow.querySelector<HTMLButtonElement>("[data-trigger]")!;
  // Whether the panel is up: a boolean, so a failing assertion never prints a DOM node.
  const menu = () => shadow.querySelector('[role="menu"]') !== null;
  const item = () => shadow.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

  it("lets the user choose an item", () => {
    press(trigger());
    assert.ok(menu(), "the popover opens in the shadow root");
    press(item());
    assert.equal(chosen, 1, "the item's action ran");
    assert.equal(menu(), false, "and the popover closed");
  });

  it("closes on a second press of its trigger", () => {
    press(trigger());
    assert.ok(menu());
    press(trigger());
    assert.equal(menu(), false);
  });

  it("still closes on a press outside it, on the page or in the shadow root", () => {
    press(trigger());
    assert.ok(menu());
    press(document.body);
    assert.equal(menu(), false, "a press on the page");

    press(trigger());
    assert.ok(menu());
    const sibling = document.createElement("button");
    shadow.appendChild(sibling);
    press(sibling);
    assert.equal(menu(), false, "a press elsewhere in the shadow root");
    assert.equal(chosen, 0);
  });
});
