/**
 * The storage list in a DOM: biggest first, one tab stop with arrow keys
 * between rows, Enter opens a folder, the context-menu key / Shift+F10 and
 * right-click ask for a row's menu.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { StorageNode, StorageNodeKind } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let StorageList: typeof import("./StorageList").StorageList;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "MouseEvent", "KeyboardEvent", "FocusEvent", "Event"] as const;
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
  ({ StorageList } = await import("./StorageList"));
});

after(() => {
  dom.window.close();
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function node(name: string, kind: StorageNodeKind, sizeBytes: number): StorageNode {
  return { name, path: `/${name}`, kind, sizeBytes, apparentBytes: sizeBytes, items: 3, hasChildren: kind === "dir" };
}

// Deliberately out of order: the list sorts biggest first.
const tree: StorageNode = {
  ...node("/", "dir", 1000),
  children: [node("swap.img", "file", 300), node("var", "dir", 500), node("Unaccounted", "unaccounted", 200)]
};

describe("StorageList", () => {
  let root: Root;
  let mount: HTMLElement;
  let opened: StorageNode[];
  let menus: Array<{ node: StorageNode; at: { x: number; y: number } }>;

  beforeEach(() => {
    mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    opened = [];
    menus = [];
    act(() => {
      root.render(
        createElement(StorageList, {
          root: tree,
          onOpen: (n: StorageNode) => opened.push(n),
          onContextMenu: (n: StorageNode, at: { x: number; y: number }) => menus.push({ node: n, at })
        })
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const rows = () => [...mount.querySelectorAll<HTMLElement>('[role="option"]')];
  const key = (target: Element, init: KeyboardEventInit) => {
    const event = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const focused = () => dom.window.document.activeElement;

  it("lists entries biggest first with a single tab stop", () => {
    assert.deepEqual(
      rows().map((r) => r.textContent?.match(/^(var|swap\.img|Unaccounted)/)?.[0]),
      ["var", "swap.img", "Unaccounted"]
    );
    assert.deepEqual(
      rows().map((r) => r.tabIndex),
      [0, -1, -1]
    );
  });

  it("moves focus with the arrow keys, Home and End", () => {
    const [first, second, third] = rows();
    act(() => first!.focus());
    key(first!, { key: "ArrowDown" });
    assert.equal(focused(), second);
    key(second!, { key: "End" });
    assert.equal(focused(), third);
    key(third!, { key: "ArrowDown" });
    assert.equal(focused(), third, "stays on the last row");
    key(third!, { key: "Home" });
    assert.equal(focused(), first);
    assert.deepEqual(
      rows().map((r) => r.tabIndex),
      [0, -1, -1]
    );
  });

  it("opens a folder on Enter, and nothing else", () => {
    const [folder, file, unaccounted] = rows();
    key(file!, { key: "Enter" });
    key(unaccounted!, { key: "Enter" });
    assert.equal(opened.length, 0);
    key(folder!, { key: "Enter" });
    assert.deepEqual(
      opened.map((n) => n.name),
      ["var"]
    );
  });

  it("asks for a row's menu on Shift+F10 or the context-menu key, once", () => {
    const [, file, unaccounted] = rows();
    const shiftF10 = key(file!, { key: "F10", shiftKey: true });
    assert.equal(shiftF10.defaultPrevented, true);
    // The browser's own contextmenu that follows the key must not open a second menu.
    act(() => {
      file!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    key(unaccounted!, { key: "ContextMenu" });
    assert.deepEqual(
      menus.map((m) => m.node.name),
      ["swap.img", "Unaccounted"]
    );
    assert.equal(key(file!, { key: "F10" }).defaultPrevented, false, "plain F10 is left alone");
    assert.equal(menus.length, 2);
  });

  it("asks for a row's menu on right-click, at the pointer", () => {
    const [folder] = rows();
    const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 70 });
    act(() => {
      folder!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
      folder!.dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(menus, [{ node: tree.children![1], at: { x: 40, y: 70 } }]);
  });
});
