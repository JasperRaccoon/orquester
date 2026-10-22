import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { loadMathEngine } from "./math-typeset.ts";
import { setSharedMermaidRenderer } from "./mermaid-engine.ts";
import type { MermaidRenderer, MermaidRenderResult } from "./mermaid-render.ts";

const SVG = '<svg viewBox="0 0 10 10"><text>Hello diagram</text></svg>';

/** A renderer that answers from a table, or stays pending. */
function fakeRenderer(answer: MermaidRenderResult | "pending" | "throw"): MermaidRenderer & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    size: 0,
    start: () => Promise.resolve({ status: "rendered", svg: "" }),
    invalidate() {},
    read(source, theme) {
      reads.push(`${theme}:${source}`);
      if (answer === "pending") throw new Promise(() => {});
      if (answer === "throw") throw new Error("boom");
      return answer;
    }
  };
}

const block = (props: { code?: string; streaming?: boolean; renderer: MermaidRenderer }): string =>
  renderToStaticMarkup(
    createElement(MermaidBlock, { code: "graph TD\nA-->B", streaming: false, mode: "dark", ...props })
  );

describe("MermaidBlock", () => {
  it("shows the source and never calls the renderer while the message streams", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    const html = block({ streaming: true, renderer });
    assert.ok(html.includes("graph TD"), html);
    assert.ok(!html.includes("Hello diagram"), html);
    assert.ok(!html.includes("Show diagram") && !html.includes("Show code"), "no toggle mid-stream");
    assert.deepEqual(renderer.reads, []);
  });

  it("shows the diagram once settled, with expand, toggle and a copy button for the source", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    const html = block({ renderer });
    assert.ok(html.includes("Hello diagram"), html);
    // One Expand control for the keyboard and assistive tech (the header's);
    // the diagram itself is a mouse shortcut, hidden from both.
    assert.equal((html.match(/aria-label="Expand diagram"/g) ?? []).length, 1, html);
    assert.ok(html.includes('role="img" aria-label="Mermaid diagram"'), html);
    assert.match(html, /<button[^>]*tabindex="-1"[^>]*aria-hidden="true"/);
    assert.ok(html.includes('aria-label="Show code"'));
    assert.ok(html.includes('aria-label="Copy code"'));
    assert.ok(!html.includes("Wrap lines"), "nothing to wrap in a diagram");
    assert.deepEqual(renderer.reads, ["dark:graph TD\nA-->B"]);
  });

  it("shows a placeholder while the diagram renders", () => {
    const html = block({ renderer: fakeRenderer("pending") });
    assert.ok(html.includes("Rendering diagram"), html);
  });

  it("keeps the highlighted source and the parser message when the diagram is invalid", () => {
    const html = block({
      renderer: fakeRenderer({ status: "error", message: "Parse error on line 2", retryable: false })
    });
    assert.ok(html.includes("Unable to render diagram: Parse error on line 2"), html);
    assert.ok(html.includes("graph TD"), html);
    assert.ok(!html.includes("Retry"), html);
  });

  it("offers Retry when the failure was a lost chunk", () => {
    const html = block({
      renderer: fakeRenderer({ status: "error", message: "Failed to fetch", retryable: true })
    });
    assert.ok(html.includes("Retry"), html);
  });

  it("does not render an empty fence", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    block({ code: "  \n", renderer });
    assert.deepEqual(renderer.reads, []);
  });
});

describe("ChatMarkdown wiring", () => {
  const render = (text: string, streaming = false): string =>
    renderToStaticMarkup(createElement(ChatMarkdown, { text, streaming }));

  afterEach(() => setSharedMermaidRenderer(null));

  const MERMAID = "Here:\n\n```mermaid\ngraph TD\nA-->B\n```\n";

  it("hands a settled mermaid fence to the diagram block (shared renderer, source as written)", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    setSharedMermaidRenderer(renderer);
    const html = render(MERMAID);
    // Only MermaidBlock produces a diagram, its controls and a renderer read.
    assert.ok(html.includes("Hello diagram"), html);
    assert.ok(html.includes('aria-label="Show code"'), html);
    assert.equal(renderer.reads.length, 1);
    assert.ok(renderer.reads[0]?.endsWith(":graph TD\nA-->B"), renderer.reads[0]);
  });

  it("keeps a mermaid fence as source while the message streams", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    setSharedMermaidRenderer(renderer);
    const html = render(MERMAID, true);
    assert.ok(html.includes('data-language="mermaid"'), html);
    assert.ok(!html.includes("Hello diagram"), html);
    assert.deepEqual(renderer.reads, []);
  });

  it("recognises the fence language case-insensitively", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    setSharedMermaidRenderer(renderer);
    assert.ok(render("```Mermaid\ngraph TD\nA-->B\n```\n").includes("Hello diagram"));
  });

  it("leaves other fences on the plain code block and never asks the renderer", () => {
    const renderer = fakeRenderer({ status: "rendered", svg: SVG });
    setSharedMermaidRenderer(renderer);
    const html = render("```ts\nconst x = 1;\n```\n");
    assert.ok(html.includes('data-language="ts"'), html);
    assert.ok(html.includes("const"), html);
    assert.ok(!html.includes("Expand diagram") && !html.includes("Show code"), html);
    assert.deepEqual(renderer.reads, []);
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
