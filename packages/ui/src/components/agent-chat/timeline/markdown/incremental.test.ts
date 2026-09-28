import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createIncrementalMarkdownPlugin } from "./incremental";

function stream() {
  const plugin = createIncrementalMarkdownPlugin();
  return (source: string) => renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, plugin as unknown as typeof remarkGfm],
    children: source
  }));
}

const FENCE = "```text\ncode\n```\n\n";

test("a reference in the prefix resolves when its definition arrives later", () => {
  const render = stream();
  const prefix = `[guide][ref]\n\n${FENCE}`;
  render(`${prefix}tail`);
  const result = render(`${prefix}tail\n\n[ref]: https://example.com/guide`);
  assert.ok(result.includes('href="https://example.com/guide"'));
  assert.ok(result.includes(">guide</a>"));
});

test("a streamed reference resolves a definition before the cached fence", () => {
  const render = stream();
  const prefix = `[ref]: https://example.com/guide\n\n${FENCE}`;
  render(prefix);
  const result = render(`${prefix}[guide][ref]`);
  assert.ok(result.includes('href="https://example.com/guide"'));
  assert.ok(result.includes(">guide</a>"));
});

test("a streamed CR becoming CRLF preserves text and one line break", () => {
  const render = stream();
  render(`${FENCE}before`);
  render(`${FENCE}before\r`);
  const result = render(`${FENCE}before\r\nafter`);
  assert.ok(result.includes("before\r\nafter"));
  assert.ok(!result.includes("before\n\nafter"));
});

test("a BOM inside streamed text remains an interior character", () => {
  const render = stream();
  render(`${FENCE}tail`);
  const result = render(`${FENCE}\uFEFFtail`);
  assert.ok(result.includes("\uFEFFtail"));
});
