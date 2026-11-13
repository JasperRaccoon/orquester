/**
 * An agent's published page with no app around it (the embeddable chat): its
 * URL comes from the chat's host, and the theme it is handed is the one
 * painted where the chat renders, not the embedding page's.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { HtmlRenderTheme } from "@orquester/api/agent-chat";

import type { ChatHost } from "../chat-host";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let chatHost: typeof import("../chat-host");
let VisualFrame: typeof import("./VisualFrame").VisualFrame;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "getComputedStyle"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = (dom.window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, {
      value: typeof value === "function" && name === "getComputedStyle" ? value.bind(dom.window) : value,
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  chatHost = await import("../chat-host");
  ({ VisualFrame } = await import("./VisualFrame"));
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
  dom.window.document.body.replaceChildren();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function themeOf(src: string): HtmlRenderTheme {
  const fragment = src.slice(src.indexOf("#") + 1);
  return JSON.parse(decodeURIComponent(fragment.slice(fragment.indexOf("=") + 1))) as HtmlRenderTheme;
}

describe("VisualFrame without the app", () => {
  it("loads the page from the host's URL, themed by the element the chat renders in", async () => {
    const document = dom.window.document;
    // The embedding page paints its own colours on its root; the chat's wrapper has its own.
    document.documentElement.style.setProperty("--n-950", "250 250 250");
    const wrapper = document.createElement("div");
    wrapper.dataset.mode = "dark";
    wrapper.dataset.scheme = "mono";
    wrapper.style.setProperty("--n-950", "1 2 3");
    const mount = document.createElement("div");
    wrapper.append(mount);
    document.body.append(wrapper);

    const asked: string[] = [];
    const host: ChatHost = {
      ...chatHost.STANDALONE_CHAT_HOST,
      visualPageUrl: async (sessionId, attachmentId) => {
        asked.push(`${sessionId}/${attachmentId}`);
        return { src: "https://visuals.example/page/abc", expiresAt: Number.MAX_SAFE_INTEGER };
      }
    };
    root = createRoot(mount);
    await act(async () => {
      root!.render(
        createElement(chatHost.ChatHostProvider, {
          host,
          children: createElement(VisualFrame, {
            sessionId: "s1",
            htmlRender: { attachmentId: "s1-report-html", title: "Report", height: 300 }
          })
        })
      );
      await settle();
    });

    assert.deepEqual(asked, ["s1/s1-report-html"]);
    const frame = document.querySelector("iframe");
    assert.ok(frame, "the page is framed");
    const src = frame.getAttribute("src") ?? "";
    assert.ok(src.startsWith("https://visuals.example/page/abc#"), src);
    assert.equal(themeOf(src).variables["--background"], "#010203");
  });
});
