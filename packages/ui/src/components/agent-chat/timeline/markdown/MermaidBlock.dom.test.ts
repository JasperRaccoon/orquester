import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { createMermaidRenderer, type MermaidRenderer, type MermaidRenderResult } from "./mermaid-render.ts";

/**
 * Client rendering in jsdom: error boundaries and Suspense only run here, not
 * under `renderToStaticMarkup`.
 */

const SVG = '<svg viewBox="0 0 10 10"><text>Hello diagram</text></svg>';
const CODE = "graph TD\nA-->B";

let dom: JSDOM;
let container: HTMLElement;
let root: Root;
const savedConsoleError = console.error;
const globals = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "navigator",
  "DOMParser",
  "XMLSerializer",
  "getComputedStyle"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(() => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value:
        name === "getComputedStyle"
          ? dom.window.getComputedStyle.bind(dom.window)
          : (dom.window as unknown as Record<string, unknown>)[name],
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
  console.error = savedConsoleError;
});

beforeEach(() => {
  container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  root = createRoot(container);
});

function table(answer: MermaidRenderResult | "throw"): MermaidRenderer {
  return {
    size: 0,
    start: () => Promise.resolve({ status: "rendered", svg: "" }),
    invalidate() {},
    read() {
      if (answer === "throw") throw new Error("boom");
      return answer;
    }
  };
}

const show = async (props: { code?: string; renderer: MermaidRenderer }): Promise<void> => {
  await act(async () => {
    root.render(createElement(MermaidBlock, { code: CODE, streaming: false, mode: "dark", ...props }));
  });
};

describe("MermaidBlock in the DOM", () => {
  it("falls back to the highlighted source when rendering the diagram throws", async () => {
    // React logs the caught render error; that is the behaviour under test.
    console.error = () => {};
    await show({ renderer: table("throw") });
    console.error = savedConsoleError;
    const block = container.querySelector('[data-language="mermaid"]');
    assert.ok(block, "the code block is shown");
    assert.ok(block.textContent?.includes("graph TD"), block.textContent ?? "");
    assert.equal(container.querySelector('[aria-label="Expand diagram"]'), null, "no diagram controls");
    assert.equal(container.querySelector('[role="img"]'), null, "no diagram body");
    assert.equal(container.textContent?.includes("Hello diagram"), false);
  });

  it("tries the diagram again once the source changes after a failure", async () => {
    console.error = () => {};
    await show({ renderer: table("throw") });
    console.error = savedConsoleError;
    assert.equal(container.querySelector('[aria-label="Expand diagram"]'), null);
    await show({ code: "graph LR\nX-->Y", renderer: table({ status: "rendered", svg: SVG }) });
    assert.ok(container.textContent?.includes("Hello diagram"), container.innerHTML);
    assert.ok(container.querySelector('[aria-label="Expand diagram"]'));
  });

  it("suspends on a pending render, then shows the diagram when it settles", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const renderer = createMermaidRenderer({
      loadMermaid: () =>
        Promise.resolve({
          initialize() {},
          render: async () => {
            await gate;
            return { svg: SVG };
          }
        }),
      sanitize: (svg) => svg,
      fontFamily: () => ""
    });
    await show({ renderer });
    assert.ok(container.textContent?.includes("Rendering diagram"), container.innerHTML);
    await act(async () => {
      finish();
      await gate;
    });
    assert.ok(container.textContent?.includes("Hello diagram"), container.innerHTML);
    assert.equal(container.textContent?.includes("Rendering diagram"), false);
  });

  it("shows the parser message above the source for an invalid diagram", async () => {
    await show({ renderer: table({ status: "error", message: "Parse error on line 2", retryable: false }) });
    assert.ok(container.textContent?.includes("Unable to render diagram: Parse error on line 2"));
    assert.ok(container.querySelector('[data-language="mermaid"]')?.textContent?.includes("graph TD"));
  });

  const expand = async (): Promise<void> => {
    const button = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Expand diagram");
    assert.ok(button, "the header's Expand control");
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  it("expands into the modal as a blob image, and revokes it on close", async () => {
    const revoked: string[] = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    try {
      await show({ renderer: table({ status: "rendered", svg: SVG }) });
      await expand();
      const image = dom.window.document.querySelector<HTMLImageElement>('[role="dialog"] img');
      assert.ok(image, "the expanded image");
      assert.ok(image.src.startsWith("blob:"), image.outerHTML);
      const url = image.src;
      const close = dom.window.document.querySelector<HTMLElement>('[role="dialog"] [aria-label="Close"]');
      await act(async () => {
        close?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
      assert.deepEqual(revoked, [url]);
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });

  it("shows an error in the modal when the diagram cannot be turned into an image", async () => {
    await show({ renderer: table({ status: "rendered", svg: "<p>not an svg</p>" }) });
    await expand();
    const dialog = dom.window.document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the modal");
    assert.ok(dialog.textContent?.includes("could not be prepared"), dialog.textContent ?? "");
    assert.equal(dialog.querySelector("img"), null);
  });
});
