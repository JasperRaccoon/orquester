/**
 * The enlarged chat image in a DOM: ←/→ page through its row's images from wherever focus is in
 * it, a focused action that goes away while the next image loads included.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { ApiClient } from "../../../lib/api-client";
import type { ChatImageItem } from "./chat-image";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let OrquesterProvider: typeof import("../../../context/orquester-context").OrquesterProvider;
let ChatImageLightbox: typeof import("./ChatImageLightbox").ChatImageLightbox;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "Event",
  "MutationObserver"
] as const;
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
  ({ OrquesterProvider } = await import("../../../context/orquester-context"));
  ({ ChatImageLightbox } = await import("./ChatImageLightbox"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
const item = (name: string): ChatImageItem => ({
  key: name,
  source: { kind: "file", path: `/w/ws/app/${name}.png` },
  alt: name
});

describe("ChatImageLightbox", () => {
  it("keeps paging with → after the focused action goes away while the next image loads", async () => {
    // The first image loads; the second never does, so its actions never show.
    const api = {
      readFileBytes: (path: string) => (path.endsWith("one.png") ? Promise.resolve(PNG) : new Promise<never>(() => {}))
    } as unknown as ApiClient;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const steps: number[] = [];
    const items = [item("one"), item("two")];
    const view = (index: number) =>
      createElement(OrquesterProvider, {
        runtime: "web",
        api,
        useTitlebar: false,
        children: createElement(ChatImageLightbox, {
          items,
          index,
          onIndexChange: (next: number) => steps.push(next),
          onClose: () => undefined
        })
      });
    await act(async () => {
      root!.render(view(0));
      await settle();
    });
    const copy = document.querySelector<HTMLElement>('button[aria-label="Copy image"]');
    assert.ok(copy, "the loaded image offers its actions");
    copy.focus();

    const pressRight = () =>
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
      );
    await act(async () => {
      pressRight();
      await settle();
    });
    assert.deepEqual(steps, [1]);
    await act(async () => {
      root!.render(view(1));
      await settle();
    });
    assert.equal(document.querySelector('button[aria-label="Copy image"]'), null, "the actions went with the image");

    await act(async () => {
      pressRight();
      await settle();
    });
    assert.deepEqual(steps, [1, 0]);
  });
});
