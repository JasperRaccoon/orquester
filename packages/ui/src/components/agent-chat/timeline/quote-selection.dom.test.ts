/**
 * Quoting a selection of an agent's reply, in a DOM: which selections are
 * quotable (one agent body, trimmed to what is really selected), the markdown
 * a selection is written back as (a code block stays code), where the toolbar
 * goes, and the toolbar itself — shown on a settled selection, Quote handing
 * the markdown to the composer, Escape and a collapse taking it away.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";


let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let resolveQuoteSelection: typeof import("./quote-selection").resolveQuoteSelection;
let selectionMarkdown: typeof import("./quote-selection").selectionMarkdown;
let QuoteSelectionToolbar: typeof import("./QuoteSelectionToolbar").QuoteSelectionToolbar;
let registerComposerHandle: typeof import("../composer/composer-bridge").registerComposerHandle;
let isAnyLayerOpen: typeof import("../../../lib/open-layers").isAnyLayerOpen;

let dom: JSDOM;
const globals = [
  "window", "document", "HTMLElement", "Element", "Node", "Text", "navigator", "KeyboardEvent",
  "MouseEvent", "Event", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  // The toolbar measures after a frame; here the frame is now.
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => undefined;
  // JSDOM lays nothing out: every selection line sits at one place on screen.
  (dom.window.Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
    { left: 40, top: 200, right: 300, bottom: 220, width: 260, height: 20 } as DOMRect
  ];
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
  ({ resolveQuoteSelection, selectionMarkdown } = await import("./quote-selection"));
  ({ QuoteSelectionToolbar } = await import("./QuoteSelectionToolbar"));
  ({ registerComposerHandle } = await import("../composer/composer-bridge"));
  ({ isAnyLayerOpen } = await import("../../../lib/open-layers"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/**
 * A timeline as the rows render it: a user bubble, an agent reply (prose, a
 * list, the chat's code block with its unselectable header and one span per
 * line, a table, math), a tool row and a second reply.
 */
const TIMELINE = `
  <div data-timeline-row-id="u1"><div><p id="user">what the user asked</p></div></div>
  <div data-timeline-row-id="a1">
    <h3 class="sr-only">Agent</h3>
    <div data-quote-source="m1">
      <div class="ac-stream">
        <p id="p1">First <strong>bold</strong> and <code>inline()</code> with <a href="https://example.com/a(b)">a link</a>.</p>
        <h2 id="h">A heading</h2>
        <ul><li>one</li><li>two <em>em</em></li></ul>
        <div data-language="ts">
          <div class="select-none"><span id="label">ts</span><span role="toolbar"><button>Copy code</button></span></div>
          <pre><code class="block"><span class="block" id="l1">const a = 1;</span><span class="block"></span><span class="block" id="l3">const b = \`x\`;</span></code></pre>
        </div>
        <blockquote><p>quoted by the agent</p></blockquote>
        <table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr></tbody></table>
        <p id="math">Energy <span data-markdown-math="inline" data-markdown-copy="\\(E=mc^2\\)" role="group"><span class="katex"><span class="katex-mathml"><math><semantics><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span></span> holds.</p>
        <p id="p2">After code.</p>
      </div>
    </div>
  </div>
  <div data-timeline-row-id="t1" id="tool-row"><div id="tool">tool output</div></div>
  <div data-timeline-row-id="a2"><div data-quote-source="m2"><p id="other">Second reply.</p></div></div>
`;

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  assert.ok(element, `#${id}`);
  return element;
}

function text(id: string): Text {
  const node = byId(id).firstChild;
  assert.ok(node && node.nodeType === 3, `#${id} text`);
  return node as Text;
}

function select(start: Node, startOffset: number, end: Node, endOffset: number): Selection {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function lastText(id: string): Text {
  const node = byId(id).lastChild;
  assert.ok(node && node.nodeType === 3);
  return node as Text;
}

function mountTimeline(): HTMLElement {
  const viewport = document.createElement("div");
  viewport.id = "viewport";
  viewport.innerHTML = TIMELINE;
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  document.body.replaceChildren(viewport);
  return viewport;
}

function quoteOf(selection: Selection, viewport: HTMLElement): string {
  const resolved = resolveQuoteSelection(selection, viewport);
  assert.ok(resolved, "quotable");
  return selectionMarkdown(resolved.range, resolved.source);
}

describe("which selection can be quoted", () => {
  let viewport: HTMLElement;
  beforeEach(() => {
    viewport = mountTimeline();
  });

  it("one inside a single agent reply, naming that reply", () => {
    const resolved = resolveQuoteSelection(select(text("p1"), 0, text("p2"), 5), viewport);
    assert.equal(resolved?.source.getAttribute("data-quote-source"), "m1");
  });

  it("not one in a user message, a tool row, or across two replies", () => {
    assert.ok(resolveQuoteSelection(select(text("user"), 0, text("user"), 4), viewport) === null, "the element is absent");
    assert.ok(resolveQuoteSelection(select(text("tool"), 0, text("tool"), 4), viewport) === null, "the element is absent");
    assert.ok(resolveQuoteSelection(select(text("p2"), 0, text("other"), 6), viewport) === null, "the element is absent");
    assert.ok(resolveQuoteSelection(select(text("p2"), 0, text("tool"), 4), viewport) === null, "the element is absent");
  });

  it("a triple click that runs to the start of the next row: trimmed to what it selects", () => {
    const resolved = resolveQuoteSelection(select(text("p2"), 0, byId("tool-row"), 0), viewport);
    assert.ok(resolved);
    assert.equal(resolved.range.toString(), "After code.");
  });

  it("not one of only unselectable chrome, nor a collapsed one", () => {
    assert.ok(resolveQuoteSelection(select(text("label"), 0, text("label"), 2), viewport) === null, "the element is absent");
    assert.ok(resolveQuoteSelection(select(text("p1"), 3, text("p1"), 3), viewport) === null, "the element is absent");
  });

  it("not one outside the timeline it watches", () => {
    const elsewhere = document.createElement("div");
    assert.ok(resolveQuoteSelection(select(text("p1"), 0, text("p1"), 5), elsewhere) === null, "the element is absent");
  });
});

describe("the markdown a selection is quoted as", () => {
  let viewport: HTMLElement;
  beforeEach(() => {
    viewport = mountTimeline();
  });

  it("rebuilds the structure: emphasis, code, links, headings, lists, code blocks, quotes, tables, math", () => {
    const markdown = quoteOf(select(text("p1"), 0, text("p2"), 11), viewport);
    assert.equal(
      markdown,
      [
        "First **bold** and `inline()` with [a link](https://example.com/a%28b%29).",
        "## A heading",
        "- one\n- two *em*",
        "```ts\nconst a = 1;\n\nconst b = `x`;\n```",
        "> quoted by the agent",
        "| Key | Value |\n| --- | --- |\n| a\\|b | 1 |",
        "Energy \\(E=mc^2\\) holds.",
        "After code."
      ].join("\n\n")
    );
  });

  it("keeps the part of a paragraph it selects, no more", () => {
    assert.equal(quoteOf(select(text("p1"), 2, text("p1"), 5), viewport), "rst");
  });

  it("quotes lines of a code block as a fenced block in its language", () => {
    assert.equal(
      quoteOf(select(text("l1"), 6, text("l3"), 7), viewport),
      "```ts\na = 1;\n\nconst b\n```"
    );
  });

  it("quotes a part of one code line as inline code", () => {
    assert.equal(quoteOf(select(text("l1"), 6, text("l1"), 7), viewport), "`a`");
  });

  it("leaves the code block's header out when the selection starts in it", () => {
    const markdown = quoteOf(select(text("label"), 0, text("l1"), 5), viewport);
    assert.equal(markdown, "`const`");
  });

  it("joins a paragraph and the code after it as two blocks", () => {
    const markdown = quoteOf(select(lastText("p1"), 0, text("l1"), 12), viewport);
    assert.equal(markdown, ".\n\n## A heading\n\n- one\n- two *em*\n\n```ts\nconst a = 1;\n```");
  });
});

describe("the selection toolbar", () => {
  let root: Root;
  let viewport: HTMLElement;
  let quoted: string[];
  let unregister: (() => void) | null;

  const toolbar = () => document.querySelector<HTMLElement>("[data-quote-selection-toolbar]");

  function pointer(type: "pointerdown" | "pointerup", target: EventTarget, pointerType = "mouse"): void {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    Object.defineProperty(event, "isPrimary", { value: true });
    target.dispatchEvent(event);
  }

  /**
   * Past every settle window. Twice: JSDOM fires its own `selectionchange`
   * from a timer, which re-arms the toolbar's settle timer inside the first
   * tick — and a timer armed during a tick is the next tick's.
   */
  async function settle(): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
      await act(async () => {
        mock.timers.tick(500);
      });
    }
  }

  async function mouseSelect(start: Node, startOffset: number, end: Node, endOffset: number): Promise<void> {
    await act(async () => {
      pointer("pointerdown", start.parentElement!);
      select(start, startOffset, end, endOffset);
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      pointer("pointerup", window);
    });
    await settle();
  }

  const withComposer = (): void => {
    unregister = registerComposerHandle("s1", {
      insertText: () => {},
      stageAttachment: () => true,
      returnMessage: () => [],
      focusAtEnd: () => {},
      openControl: () => {},
      sendText: () => false,
      submitText: () => ({ ok: false, reason: "refused" }),
      restoreFailedSend: () => false,
      addQuote: (markdown) => {
        quoted.push(markdown);
        return { ok: true };
      }
    });
  };

  beforeEach(async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    quoted = [];
    unregister = null;
    viewport = mountTimeline();
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    root = createRoot(mount);
    await act(async () => {
      root.render(createElement(QuoteSelectionToolbar, { viewport, sessionId: "s1", bottomInset: 0 }));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    unregister?.();
    window.getSelection()?.removeAllRanges();
    mock.timers.reset();
  });

  it("shows over a settled selection in a reply, and Quote hands its markdown to the composer", async () => {
    withComposer();
    await mouseSelect(text("l1"), 0, text("l3"), 14);
    const shown = toolbar();
    assert.ok(shown, "shown on release");
    assert.equal(shown.style.visibility, "visible");
    assert.equal(isAnyLayerOpen(), true, "an open layer, so the chat's Escape stands down");

    const quote = Array.from(shown.querySelectorAll("button")).find((button) => button.textContent === "Quote");
    assert.ok(quote);
    await act(async () => {
      quote.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(quoted, ["```ts\nconst a = 1;\n\nconst b = `x`;\n```"]);
    assert.ok(toolbar() === null, "gone once quoted");
    assert.equal(window.getSelection()?.rangeCount, 0, "and the selection let go");
    assert.equal(isAnyLayerOpen(), false);
  });

  it("goes on Escape, and on a collapse", async () => {
    withComposer();
    await mouseSelect(text("p2"), 0, text("p2"), 5);
    assert.ok(toolbar());
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.ok(toolbar() === null, "the element is absent");

    await mouseSelect(text("p2"), 0, text("p2"), 5);
    assert.ok(toolbar(), "back for a new selection");
    await act(async () => {
      window.getSelection()?.collapseToStart();
      document.dispatchEvent(new dom.window.Event("selectionchange"));
    });
    assert.ok(toolbar() === null, "the element is absent");
  });

  it("goes on a press elsewhere, and on a scroll of the timeline", async () => {
    withComposer();
    await mouseSelect(text("p2"), 0, text("p2"), 5);
    assert.ok(toolbar());
    await act(async () => {
      viewport.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.ok(toolbar() === null, "gone while it scrolls");
    await settle();
    assert.ok(toolbar(), "back once still, the selection still in sight");
    await act(async () => {
      pointer("pointerdown", byId("other"));
    });
    assert.ok(toolbar() === null, "the element is absent");
  });

  it("follows a keyboard selection once it settles", async () => {
    withComposer();
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
      select(text("p2"), 0, text("p2"), 5);
      document.dispatchEvent(new dom.window.Event("selectionchange"));
    });
    assert.ok(toolbar() === null, "not while the keys may still be moving it");
    await settle();
    assert.ok(toolbar());
  });

  it("never shows for a user message, nor where no composer takes quotes", async () => {
    withComposer();
    await mouseSelect(text("user"), 0, text("user"), 4);
    assert.ok(toolbar() === null, "the element is absent");
    unregister?.();
    unregister = null;
    await mouseSelect(text("p2"), 0, text("p2"), 5);
    assert.ok(toolbar() === null, "the element is absent");
  });
});
