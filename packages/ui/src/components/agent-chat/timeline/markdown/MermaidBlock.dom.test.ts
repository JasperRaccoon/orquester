import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM, VirtualConsole } from "jsdom";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { loadPele, setPeleLoader, type PeleEngine } from "./mermaid-engine.ts";

/**
 * Client rendering in jsdom, with the real `pele`: effects, the mount and the
 * error boundary only run here, not under `renderToStaticMarkup`.
 */

const FLOWCHART = 'flowchart LR\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n  click A "https://evil.example/"';

let dom: JSDOM;
let container: HTMLElement;
let root: Root;
const savedConsoleError = console.error;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "DOMParser", "XMLSerializer", "getComputedStyle"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(() => {
  // Pele probes for a canvas to measure text and falls back without one; jsdom
  // reports the missing canvas as an error, which is noise here.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!/HTMLCanvasElement\.prototype\.getContext/.test(error.message)) savedConsoleError(error);
  });
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", virtualConsole });
  // Pele waits for its host to have a width; jsdom lays nothing out.
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 640 });
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
  setPeleLoader(null);
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  console.error = savedConsoleError;
});

beforeEach(() => {
  setPeleLoader(null);
  container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Unmount while the DOM globals still exist, then let the zero-delay timers the cleanups queue
  // run (the Modal hands focus back a tick after it closes). Left pending, the last test's would
  // fire after `after()` removed `document` and fail the file as asynchronous activity after the
  // test ended. Equal-delay timers run in the order they were set, so this one runs after theirs.
  await act(async () => {
    root.unmount();
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

/** Renders the block and lets every load and mount settle. */
const show = async (props: { code?: string; mode?: "light" | "dark"; streaming?: boolean } = {}): Promise<void> => {
  await act(async () => {
    root.render(createElement(MermaidBlock, { code: FLOWCHART, streaming: false, mode: "dark", ...props }));
  });
  // The renderer and the diagram's type chunk load over several ticks.
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await loadPele().catch(() => undefined);
    });
  }
};

const diagram = (): SVGSVGElement | null => container.querySelector('[role="img"] svg');

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent === label);
  assert.ok(found, label);
  return found;
};

const click = async (target: Element): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
};

describe("MermaidBlock in the DOM", () => {
  it("draws readable diagram labels without active links", async () => {
    await show();
    const svg = diagram();
    assert.ok(svg, container.innerHTML);
    assert.ok(svg.textContent?.includes("Is it?"), "label text");
    assert.ok(!/href|evil\.example|<a[\s>]/.test(svg.outerHTML), "a click link never survives");
  });

  it("shows pele's parse error above the source, with no Retry", async () => {
    await show({ code: "flowchart TD\n  A-->" });
    assert.ok(container.textContent?.includes("Unable to render diagram: Parse error"), container.textContent ?? "");
    assert.ok(container.querySelector('[data-language="mermaid"]')?.textContent?.includes("A-->"));
    assert.equal(diagram(), null);
    assert.ok(![...container.querySelectorAll("button")].some((b) => b.textContent === "Retry"));
  });

  it("offers Retry when the renderer fails to load, and draws once it loads", async () => {
    setPeleLoader(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    await show();
    assert.ok(container.textContent?.includes("The diagram renderer failed to load."), container.textContent ?? "");
    assert.equal(diagram(), null);
    setPeleLoader(null);
    await click(button("Retry"));
    await show();
    assert.ok(diagram(), container.innerHTML.slice(0, 300));
  });

  it("toggles between the diagram and its source", async () => {
    await show();
    await click(button("Show code"));
    assert.equal(diagram(), null);
    assert.ok(container.querySelector('[data-language="mermaid"]')?.textContent?.includes("flowchart LR"));
    await click(button("Show diagram"));
    await show();
    assert.ok(diagram());
  });

  it("falls back to the source when drawing throws", async () => {
    const throwing: PeleEngine = {
      detectType: () => "flowchart",
      registered: () => true,
      load: () => Promise.resolve(true),
      mount: () => {
        throw new Error("boom");
      }
    };
    setPeleLoader(() => Promise.resolve(throwing));
    // React logs the caught error; that is the behaviour under test.
    console.error = () => {};
    await show();
    console.error = savedConsoleError;
    assert.ok(container.querySelector('[data-language="mermaid"]')?.textContent?.includes("flowchart LR"));
    assert.equal(container.querySelector('[aria-label="Expand diagram"]'), null, "no diagram controls");
  });

  it("typesets $$ labels with the chat's KaTeX, as MathML without the TeX annotation", async () => {
    // jsdom measures everything as 0×0, and pele draws a label it cannot size as text.
    const prototype = dom.window.Element.prototype;
    const realRect = prototype.getBoundingClientRect;
    prototype.getBoundingClientRect = function (this: Element) {
      return this.localName === "math" ? ({ width: 24, height: 18 } as DOMRect) : realRect.call(this);
    };
    try {
      await show({ code: 'flowchart LR\n  A["$$x^2$$"] --> B' });
    } finally {
      prototype.getBoundingClientRect = realRect;
    }
    const svg = diagram();
    assert.ok(svg, container.textContent ?? "");
    const math = svg.querySelector("foreignObject math");
    assert.ok(math, svg.outerHTML);
    assert.ok(math.querySelector("msup"), math.outerHTML);
    assert.equal(svg.querySelector("annotation"), null);
  });

  it("expands into the modal as a blob image, and revokes it on close", async () => {
    const revoked: string[] = [];
    const realRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    try {
      await show();
      await click(button("Expand diagram"));
      const image = dom.window.document.querySelector<HTMLImageElement>('[role="dialog"] img');
      assert.ok(image, "the expanded image");
      assert.ok(image.src.startsWith("blob:"), image.outerHTML);
      const url = image.src;
      const close = dom.window.document.querySelector<HTMLElement>('[role="dialog"] [aria-label="Close"]');
      assert.ok(close);
      await click(close);
      assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
      assert.deepEqual(revoked, [url]);
    } finally {
      URL.revokeObjectURL = realRevoke;
    }
  });
});
