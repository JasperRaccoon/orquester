/**
 * The storage map in a DOM (jsdom has no canvas, so nothing is painted — the
 * map must still lay out and answer the pointer): clicking a folder's block
 * opens it, clicking a file only selects it, right-click asks for the menu of
 * the block under the pointer.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM, VirtualConsole } from "jsdom";
import type { StorageNode, StorageNodeKind } from "@orquester/api";

import { layoutTreemap, type TreemapTile } from "./storage-treemap.logic";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let StorageTreemap: typeof import("./StorageTreemap").StorageTreemap;

const WIDTH = 800;
const HEIGHT = 500;

/** Reports a fixed content box, as the browser would for the shell's fixed-height slot. */
class FixedResizeObserver {
  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {}
  observe() {
    this.callback([{ contentRect: { width: WIDTH, height: HEIGHT } }]);
  }
  disconnect() {}
  unobserve() {}
}

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "MouseEvent", "Event", "ResizeObserver"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  // A silent console: jsdom reports every `getContext` as "not implemented".
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const values: Record<string, unknown> = { ...(dom.window as unknown as Record<string, unknown>), ResizeObserver: FixedResizeObserver };
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: values[name] ?? (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ StorageTreemap } = await import("./StorageTreemap"));
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

function node(name: string, kind: StorageNodeKind, sizeBytes: number, children?: StorageNode[]): StorageNode {
  return {
    name,
    path: `/${name}`,
    kind,
    sizeBytes,
    apparentBytes: sizeBytes,
    items: 1,
    hasChildren: kind === "dir",
    ...(children ? { children } : {})
  };
}

const tree = node("/", "dir", 1000, [
  node("var", "dir", 500, [node("log", "dir", 300), node("kern.log", "file", 200)]),
  node("swap.img", "file", 300),
  node("Unaccounted", "unaccounted", 200)
]);

/** Where the map draws `name` (jsdom's client rect is at the origin, so map = client coordinates). */
function centerOf(name: string): { clientX: number; clientY: number } {
  const tile = layoutTreemap(tree, WIDTH, HEIGHT, "dark").tiles.find((t: TreemapTile) => t.node.name === name);
  assert.ok(tile, `${name} is laid out`);
  return { clientX: (tile.x0 + tile.x1) / 2, clientY: (tile.y0 + tile.y1) / 2 };
}

describe("StorageTreemap", () => {
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
        createElement(StorageTreemap, {
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

  const map = () => {
    const img = mount.querySelector('[role="img"]');
    assert.ok(img, "the map is exposed as an image");
    return img;
  };

  it("opens the innermost folder under a click", () => {
    act(() => {
      map().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ...centerOf("log") }));
    });
    assert.deepEqual(
      opened.map((n) => n.path),
      ["/log"]
    );
  });

  it("measures the pointer inside the map's border", () => {
    // A 1px border, as the Storage view gives the map: the map starts 1px in from the box's edge.
    const box = map().parentElement!;
    Object.defineProperty(box, "clientLeft", { value: 1, configurable: true });
    Object.defineProperty(box, "clientTop", { value: 1, configurable: true });
    const log = layoutTreemap(tree, WIDTH, HEIGHT, "dark").tiles.find((t: TreemapTile) => t.node.name === "log")!;
    // Just inside log's right edge on the map, which is 1px further right on screen.
    const clientX = log.x1 - 0.25 + 1;
    const clientY = (log.y0 + log.y1) / 2 + 1;
    act(() => {
      map().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX, clientY }));
    });
    assert.deepEqual(
      opened.map((n) => n.path),
      ["/log"]
    );
  });

  it("does not open a file or a synthetic block", () => {
    act(() => {
      map().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ...centerOf("swap.img") }));
      map().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ...centerOf("kern.log") }));
      map().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ...centerOf("Unaccounted") }));
    });
    assert.deepEqual(opened, []);
  });

  it("asks for the menu of the block under a right-click, at the pointer", () => {
    const at = centerOf("swap.img");
    const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at });
    act(() => {
      map().dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, true);
    assert.equal(menus.length, 1);
    assert.equal(menus[0]!.node.name, "swap.img");
    assert.deepEqual(menus[0]!.at, { x: at.clientX, y: at.clientY });
  });
});
