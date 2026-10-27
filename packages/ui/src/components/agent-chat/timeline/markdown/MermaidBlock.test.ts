import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { loadPele } from "./mermaid-engine.ts";

/**
 * Markdown fence routing and unsupported-source fallback. Mounted controls,
 * renderer loading and drawing are owned by `MermaidBlock.dom.test.ts`.
 */

const CODE = "graph TD\nA-->B";

const block = (props: { code?: string; streaming?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(MermaidBlock, { code: CODE, streaming: false, mode: "dark", ...props }));

before(async () => {
  const pele = await loadPele();
  await pele.load("flowchart");
});

describe("MermaidBlock", () => {
  it("names a diagram type pele does not know above its source, with no Retry", () => {
    for (const code of ["zenuml\n  Alice->John: Hello", "notADiagram\n  foo"]) {
      const html = block({ code });
      assert.ok(html.includes(code.split("\n")[0]!), "unsupported source remains readable");
      assert.ok(html.includes('data-language="mermaid"'), html);
      assert.ok(!html.includes("Retry"), html);
      assert.ok(!html.includes('role="img"'), html);
    }
  });

});

describe("ChatMarkdown wiring", () => {
  const render = (text: string, streaming = false): string =>
    renderToStaticMarkup(createElement(ChatMarkdown, { text, streaming }));
  const MERMAID = "Here:\n\n```mermaid\ngraph TD\nA-->B\n```\n";

  it("hands a settled mermaid fence to the diagram block", () => {
    const html = render(MERMAID);
    assert.ok(html.includes('role="img"'), html);
  });

  it("keeps a mermaid fence as source while the message streams", () => {
    const html = render(MERMAID, true);
    assert.ok(html.includes('data-language="mermaid"'), html);
    assert.ok(!html.includes('role="img"'), html);
  });

  it("recognises the fence language case-insensitively", () => {
    assert.ok(render("```Mermaid\ngraph TD\nA-->B\n```\n").includes('role="img"'));
  });

  it("leaves other fences on the plain code block", () => {
    const html = render("```ts\nconst x = 1;\n```\n");
    assert.ok(html.includes('data-language="ts"'), html);
    assert.ok(html.includes("const"), html);
    assert.ok(!html.includes('role="img"'), html);
  });
});
