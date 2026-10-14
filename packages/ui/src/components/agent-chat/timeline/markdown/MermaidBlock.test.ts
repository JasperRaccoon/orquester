import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
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
    assert.ok(html.includes('aria-label="Expand diagram"'));
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

  it("routes a mermaid fence to the diagram block, which streams as source", () => {
    const html = render("Here:\n\n```mermaid\ngraph TD\nA-->B\n```\n", true);
    assert.ok(html.includes('data-language="mermaid"'), html);
    assert.ok(html.includes("graph"), html);
  });

  it("leaves other fences on the plain code block", () => {
    const html = render("```ts\nconst x = 1;\n```\n");
    assert.ok(html.includes('data-language="ts"') || html.includes("const"), html);
    assert.ok(!html.includes("Expand diagram"));
  });

  it("renders math and leaves currency alone in a real message", () => {
    const html = render("It costs $5 or $10, and $E=mc^2$ holds.\n\n$$\\sum_i x_i$$");
    assert.ok(html.includes("It costs $5 or $10, and "), html);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 2, html);
    assert.ok(html.includes("katex-display"));
  });

  it("still refuses raw HTML", () => {
    const html = render("<script>alert(1)</script> <b>x</b> $a$");
    assert.ok(!html.includes("<script"), html);
    assert.ok(!html.includes("<b>"), html);
  });
});
