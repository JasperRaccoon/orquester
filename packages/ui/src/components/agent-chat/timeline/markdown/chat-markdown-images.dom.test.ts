/**
 * Markdown images of the chat in a DOM (design 2026-11-10 §9.2): a chat image Markdown names
 * without its type is saved under the extension of what its bytes are, and an image inside a link
 * is the link's, never an enlarge button inside it.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";


let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ChatHostProvider: typeof import("../../chat-host").ChatHostProvider;
let STANDALONE_CHAT_HOST: typeof import("../../chat-host").STANDALONE_CHAT_HOST;
let rowContext: typeof import("../context");
let ChatMarkdown: typeof import("./ChatMarkdown").ChatMarkdown;

let dom: JSDOM;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "navigator",
  "KeyboardEvent",
  "MouseEvent",
  "Event",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  });
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
  ({ ChatHostProvider, STANDALONE_CHAT_HOST } = await import("../../chat-host"));
  rowContext = await import("../context");
  ({ ChatMarkdown } = await import("./ChatMarkdown"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).buffer;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
const ATTACHMENT = "s1-0f8fad5b-d9cb-469f-a165-70867728950e-jpg";
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A chat's timeline row: the chat `s1`, in the project `/w/ws/app`. */
function InChat({ children }: { children: ReactNode }) {
  const base = rowContext.useTimelineRowContext();
  return createElement(
    rowContext.TimelineRowContext.Provider,
    { value: { ...base, sessionId: "s1", workspaceRoot: "/w/ws/app", readOnly: false } },
    children
  );
}

describe("Markdown images in a chat", () => {
  let mount: HTMLElement;
  let root: Root;
  const host = {
    fetchAttachment: async () => JPEG,
    readFileBytes: async () => PNG,
    saveImageToProject: async (input: { relativePath: string }) => input.relativePath
  };
  const render = async (text: string) => {
    await act(async () => {
      root.render(
        createElement(ChatHostProvider, {
          host: { ...STANDALONE_CHAT_HOST, ...host },
          children: createElement(InChat, null, createElement(ChatMarkdown, { text }))
        })
      );
      await settle();
    });
    // The bytes are read, then sniffed for their type.
    await act(settle);
  };

  beforeEach(() => {
    mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("saves a chat image named without its type under its bytes' extension", async () => {
    await render(`![a dog](attachment:${ATTACHMENT})`);
    const save = document.querySelector<HTMLElement>('button[aria-label="Save to project…"]');
    assert.ok(save, "the chat image offers Save to project…");
    await act(async () => save.click());
    const path = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    assert.match(path?.value ?? "", /\.jpg$/);
  });

  it("leaves an image inside a link to the link: a click opens no lightbox", async () => {
    await render("[![shot](/w/ws/app/shot.png)](https://example.com/page)");
    const image = mount.querySelector("img");
    assert.ok(image && image.closest("a"), "the image is inside its link");
    // jsdom does not navigate; keep it from trying.
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(async () => image.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="dialog"]') === null, true, "no lightbox opened");
  });
});
