import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { loadMathEngine } from "./math-typeset.ts";
import { isMermaidFence, loadPele, setPeleLoader, type PeleEngine } from "./mermaid-engine.ts";

/**
 * Server rendering: what a block shows before any effect runs. The diagram
 * itself is mounted by pele in a layout effect, so here a ready block is its
 * chrome and an empty host; `MermaidBlock.dom.test.ts` draws it.
 */

const CODE = "graph TD\nA-->B";

const block = (props: { code?: string; streaming?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(MermaidBlock, { code: CODE, streaming: false, mode: "dark", ...props }));

/** Loads the real renderer and the types the tests draw, so readiness is known synchronously. */
async function preload(): Promise<PeleEngine> {
  setPeleLoader(null);
  const pele = await loadPele();
  await pele.load("flowchart");
  return pele;
}

describe("MermaidBlock", () => {
  before(async () => {
    await preload();
  });

  it("shows the source, without a toggle, while the message streams", () => {
    const html = block({ streaming: true });
    assert.ok(html.includes("graph TD"), html);
    assert.ok(html.includes('data-language="mermaid"'), html);
    assert.ok(!html.includes("Show diagram") && !html.includes("Show code"), "no toggle mid-stream");
    assert.ok(!html.includes('role="img"'), html);
  });

  it("shows the diagram's chrome once settled: expand, toggle and a copy button for the source", () => {
    const html = block();
    // One Expand control for the keyboard and assistive tech (the header's);
    // the diagram itself is a mouse shortcut, hidden from both.
    assert.equal((html.match(/aria-label="Expand diagram"/g) ?? []).length, 1, html);
    assert.ok(html.includes('role="img" aria-label="Mermaid diagram"'), html);
    assert.ok(html.includes("ac-mermaid"), "the palette's --pele-* variables apply");
    assert.match(html, /<button[^>]*tabindex="-1"[^>]*aria-hidden="true"/);
    assert.ok(html.includes('aria-label="Show code"'));
    assert.ok(html.includes('aria-label="Copy code"'));
    assert.ok(!html.includes("Wrap lines"), "nothing to wrap in a diagram");
  });

  it("names a diagram type pele does not know above its source, with no Retry", () => {
    for (const code of ["zenuml\n  Alice->John: Hello", "notADiagram\n  foo"]) {
      const html = block({ code });
      assert.ok(html.includes("Unable to render diagram: This diagram type is not supported."), html);
      assert.ok(html.includes('data-language="mermaid"'), html);
      assert.ok(!html.includes("Retry"), html);
      assert.ok(!html.includes('role="img"'), html);
    }
  });

  it("does not render an empty fence", () => {
    const html = block({ code: "  \n" });
    assert.ok(!html.includes('role="img"'), html);
    assert.ok(!html.includes("Rendering diagram"), html);
  });

  describe("before the renderer has loaded", () => {
    afterEach(async () => {
      await preload();
    });

    it("shows a placeholder", () => {
      setPeleLoader(() => new Promise<PeleEngine>(() => {}));
      assert.ok(block().includes("Rendering diagram"));
    });

    it("shows a placeholder until the diagram's type has loaded too", async () => {
      const pele = await preload();
      assert.equal(pele.registered("sequence"), false, "precondition: sequence diagrams not loaded yet");
      assert.ok(block({ code: "sequenceDiagram\n  A->>B: hi" }).includes("Rendering diagram"));
    });
  });
});

describe("ChatMarkdown wiring", () => {
  before(async () => {
    await preload();
  });

  const render = (text: string, streaming = false): string =>
    renderToStaticMarkup(createElement(ChatMarkdown, { text, streaming }));
  const MERMAID = "Here:\n\n```mermaid\ngraph TD\nA-->B\n```\n";

  it("hands a settled mermaid fence to the diagram block", () => {
    const html = render(MERMAID);
    assert.ok(html.includes('role="img" aria-label="Mermaid diagram"'), html);
    assert.ok(html.includes('aria-label="Show code"'), html);
  });

  it("keeps a mermaid fence as source while the message streams", () => {
    const html = render(MERMAID, true);
    assert.ok(html.includes('data-language="mermaid"'), html);
    assert.ok(!html.includes('role="img"'), html);
  });

  it("recognises the fence language case-insensitively", () => {
    assert.equal(isMermaidFence("Mermaid"), true);
    assert.equal(isMermaidFence("mermaidjs"), false);
    assert.ok(render("```Mermaid\ngraph TD\nA-->B\n```\n").includes('aria-label="Mermaid diagram"'));
  });

  it("leaves other fences on the plain code block", () => {
    const html = render("```ts\nconst x = 1;\n```\n");
    assert.ok(html.includes('data-language="ts"'), html);
    assert.ok(html.includes("const"), html);
    assert.ok(!html.includes("Expand diagram") && !html.includes("Show code"), html);
  });

  it("renders math and leaves currency alone in a real message", async () => {
    await loadMathEngine();
    const html = render("It costs $5 or $10, and $E=mc^2$ holds.\n\n$$\\sum_i x_i$$\n\n$$\n\\sum_i x_i\n$$");
    assert.ok(html.includes("It costs $5 or $10, and "), html);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 3, html);
    assert.equal((html.match(/katex-display/g) ?? []).length, 2);
  });

  it("still refuses raw HTML", () => {
    const html = render("<script>alert(1)</script> <b>x</b> $a$");
    assert.ok(!html.includes("<script"), html);
    assert.ok(!html.includes("<b>"), html);
  });
});
