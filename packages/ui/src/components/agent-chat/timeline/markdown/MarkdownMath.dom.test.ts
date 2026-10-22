/**
 * Math in a DOM: KaTeX is loaded only when a message has a formula (and once),
 * a formula shows its source until then, and copying a selection that touches
 * a formula yields its TeX — through the selection and through the Copy TeX
 * button.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { MathEngine } from "./math-typeset";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ChatMarkdown: typeof import("./ChatMarkdown").ChatMarkdown;
let setMathEngineLoader: typeof import("./math-typeset").setMathEngineLoader;
let mathClipboardPayload: typeof import("./math-clipboard").mathClipboardPayload;
let copyMathSelection: typeof import("./math-clipboard").copyMathSelection;
let katex: MathEngine;

let dom: JSDOM;
const globals = [
  "window", "document", "HTMLElement", "Element", "Node", "Text", "navigator", "MouseEvent", "Event",
  "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const copied: string[] = [];

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: (value: string) => (copied.push(value), Promise.resolve()) },
    configurable: true
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
  ({ ChatMarkdown } = await import("./ChatMarkdown"));
  ({ setMathEngineLoader } = await import("./math-typeset"));
  ({ mathClipboardPayload, copyMathSelection } = await import("./math-clipboard"));
  katex = (await import("katex")).default as unknown as MathEngine;
});

after(() => {
  setMathEngineLoader(null);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  copied.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
});

/** A loader that records its calls and resolves (or fails) when told to. */
function deferredLoader(): {
  calls: number;
  load: () => Promise<MathEngine>;
  finish: (engine: MathEngine) => Promise<void>;
  fail: () => Promise<void>;
} {
  let resolve!: (engine: MathEngine) => void;
  let reject!: (error: Error) => void;
  const state = {
    calls: 0,
    load: () => {
      state.calls += 1;
      return new Promise<MathEngine>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    finish: async (engine: MathEngine) => {
      await act(async () => resolve(engine));
    },
    fail: async () => {
      await act(async () => reject(new Error("chunk failed")));
    }
  };
  return state;
}

const show = async (text: string): Promise<void> => {
  await act(async () => {
    root.render(createElement(ChatMarkdown, { text }));
  });
};

describe("lazy KaTeX", () => {
  it("is not loaded for a message without math", async () => {
    const loader = deferredLoader();
    setMathEngineLoader(loader.load);
    await show("Plain (parens), [brackets], `$code$` and a price of $5.");
    assert.equal(loader.calls, 0);
    assert.equal(container.querySelector("[data-markdown-math]"), null);
  });

  it("is loaded once the first formula mounts, which shows its source meanwhile", async () => {
    const loader = deferredLoader();
    setMathEngineLoader(loader.load);
    await show("Energy \\(E=mc^2\\) and $x$.");
    assert.equal(loader.calls, 1, "one load for every formula");
    assert.equal(container.querySelector(".katex"), null);
    assert.ok(container.textContent?.includes("\\(E=mc^2\\)"), container.textContent ?? "");
    await loader.finish(katex);
    assert.equal(container.querySelectorAll(".katex").length, 2, container.innerHTML);
    await show("Then \\[y\\] too.");
    assert.equal(loader.calls, 1, "loaded once");
    assert.equal(container.querySelectorAll(".katex").length, 1);
  });

  it("keeps the source after a failed load and retries on the next mount", async () => {
    const loader = deferredLoader();
    setMathEngineLoader(loader.load);
    await show("$x$");
    await loader.fail();
    assert.equal(container.querySelector(".katex"), null);
    assert.ok(container.textContent?.includes("\\(x\\)"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await show("$x$");
    assert.equal(loader.calls, 2);
    await loader.finish(katex);
    assert.equal(container.querySelectorAll(".katex").length, 1);
  });

  it("typesets a formula once, however often it mounts", async () => {
    let renders = 0;
    const counting: MathEngine = {
      renderToString(tex, options) {
        renders += 1;
        return katex.renderToString(tex, options);
      }
    };
    setMathEngineLoader(() => Promise.resolve(counting));
    await show("$x$");
    await act(async () => Promise.resolve());
    const first = renders;
    assert.ok(first >= 1);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => root.unmount());
      root = createRoot(container);
      await show("$x$ again");
    }
    assert.equal(renders, first, "the cache answered every remount");
    assert.equal(container.querySelectorAll(".katex").length, 1);
  });

  it("is imported by the engine module alone, and only through import()", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
      });
    const src = join(here, "../../../..");
    const importers = sources(src).filter((path) => /from "katex|import "katex/.test(readFileSync(path, "utf8")));
    assert.deepEqual(
      importers.map((path) => path.slice(src.length + 1)),
      ["components/agent-chat/timeline/markdown/katex-engine.ts"]
    );
    const dynamic = sources(src).filter((path) => readFileSync(path, "utf8").includes('import("./katex-engine")'));
    assert.deepEqual(
      dynamic.map((path) => path.slice(src.length + 1)),
      ["components/agent-chat/timeline/markdown/math-typeset.ts"]
    );
    for (const path of sources(src)) {
      assert.ok(!/from "\.\/katex-engine"/.test(readFileSync(path, "utf8")), `${path} imports the engine statically`);
    }
    const css = readFileSync(join(src, "styles/globals.css"), "utf8");
    assert.ok(!css.includes('@import "katex'), "KaTeX's stylesheet is not in the global CSS");
  });
});

describe("copy as TeX", () => {
  beforeEach(async () => {
    setMathEngineLoader(() => Promise.resolve(katex));
    await show("Energy \\(E=mc^2\\) holds.\n\n$$\na+b\n$$\n\nAfter **that**.\n\nNo math here.");
    await act(async () => Promise.resolve());
    assert.equal(container.querySelectorAll(".katex").length, 2, container.innerHTML);
  });

  function select(start: Node, startOffset: number, end: Node, endOffset: number): Selection {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  const paragraph = (text: string): HTMLElement =>
    Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.startsWith(text)) as HTMLElement;

  it("copies a selection across formulas as markdown with their TeX", () => {
    const first = paragraph("Energy").firstChild!;
    const last = paragraph("After").lastChild!;
    const payload = mathClipboardPayload(select(first, 0, last, 1));
    assert.ok(payload);
    assert.equal(payload.text, "Energy \\(E=mc^2\\) holds.\n\n\\[\na+b\n\\]\n\nAfter **that**.");
    assert.ok(payload.html.includes("<code>\\(E=mc^2\\)</code>"), payload.html);
    assert.ok(payload.html.includes("<pre><code>\\[\na+b\n\\]</code></pre>"), payload.html);
    assert.ok(!payload.html.includes("katex"), payload.html);
    assert.ok(!payload.html.includes("<button"), payload.html);
  });

  it("copies a whole formula's TeX from a selection inside its glyphs", () => {
    const glyph = container.querySelector(".katex-html")!;
    const leaf = dom.window.document.createTreeWalker(glyph, 4).nextNode()!;
    const payload = mathClipboardPayload(select(leaf, 0, leaf, 1));
    assert.deepEqual(payload && payload.text, "\\(E=mc^2\\)");
    assert.ok(payload?.html.includes("<code>\\(E=mc^2\\)</code>"));
  });

  it("leaves a selection without a formula to the browser", () => {
    const text = paragraph("No math").firstChild!;
    assert.equal(mathClipboardPayload(select(text, 0, text, 5)), null);
  });

  it("puts both flavours on the clipboard from the copy event", () => {
    const first = paragraph("Energy").firstChild!;
    select(first, 0, paragraph("Energy").lastChild!, 3);
    const data = new Map<string, string>();
    let prevented = false;
    copyMathSelection({
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
      currentTarget: container,
      preventDefault: () => {
        prevented = true;
      }
    } as unknown as Parameters<typeof copyMathSelection>[0]);
    assert.equal(prevented, true);
    assert.equal(data.get("text/plain"), "Energy \\(E=mc^2\\) ho");
    assert.ok(data.get("text/html")?.startsWith('<meta charset="utf-8">'));
  });

  it("gives display math a Copy TeX button that copies the bare TeX", async () => {
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-markdown-math="display"] button');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.getAttribute("aria-label"), "Copy TeX");
    assert.equal(container.querySelectorAll('[data-markdown-math="inline"] button').length, 0);
    await act(async () => {
      buttons[0]!.click();
    });
    assert.deepEqual(copied, ["a+b"]);
  });
});
