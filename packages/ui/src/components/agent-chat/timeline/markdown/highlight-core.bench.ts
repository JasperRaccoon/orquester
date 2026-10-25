/**
 * Stream a 250-line JavaScript block through the real highlighter and the
 * same memoised, per-line React shape as CodeBlock. Run from packages/ui:
 * TSX_DISABLE_CACHE=1 node --import tsx src/components/agent-chat/timeline/markdown/highlight-core.bench.ts
 * Pass a git revision as the final argument to benchmark its highlighter.
 * The baseline is loaded through a temporary sibling file, then removed.
 * Measured baseline: 7feff9eb1f8aa6623afda260a8495f9877299856.
 *
 * Render counts are deterministic; elapsed time includes parsing and React
 * reconciliation in jsdom, not browser layout or paint.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import React from "react";
import { JSDOM } from "jsdom";

import { createIncrementalTreeHighlighter as currentHighlighter, type HighlightedLine } from "./highlight-core";
import { loadLanguageParser } from "./languages";

const revision = process.argv[2];
let createIncrementalTreeHighlighter = currentHighlighter;
if (revision !== undefined) {
  const baselineFile = new URL(`.highlight-core-baseline-${process.pid}.ts`, import.meta.url);
  writeFileSync(baselineFile, execFileSync("git", ["show", `${revision}:packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.ts`]));
  try {
    createIncrementalTreeHighlighter = (await import(baselineFile.href)).createIncrementalTreeHighlighter as typeof currentHighlighter;
  } finally {
    unlinkSync(baselineFile);
  }
}

const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const parser = await loadLanguageParser("javascript");
assert.ok(parser);

let lineRenders = 0;
const Line = React.memo(function Line({ line }: { line: HighlightedLine }) {
  lineRenders += 1;
  return React.createElement("span", { className: "block" },
    line.map((token, index) => React.createElement("span", { key: index, className: token.cls ?? undefined }, token.text))
  );
});
const prefix = Array.from({ length: 250 }, (_, index) => `const value${index} = compute(${index}, "value");`).join("\n");
const root = createRoot(dom.window.document.getElementById("root")!);
const durations: number[] = [];
const renderCounts: number[] = [];
const updates = 40;

for (let round = 0; round < 6; round += 1) {
  const highlight = createIncrementalTreeHighlighter(parser);
  let code = `${prefix}\nconst tail = "`;
  const render = async (): Promise<void> => {
    const lines = highlight(code);
    await React.act(async () => {
      root.render(React.createElement("pre", null,
        lines.map((line, index) => React.createElement(Line, { key: index, line }))
      ));
    });
  };
  await render();
  lineRenders = 0;
  const started = performance.now();
  for (let index = 0; index < updates; index += 1) {
    code += "a";
    await render();
  }
  const elapsed = performance.now() - started;
  assert.equal(dom.window.document.querySelector("pre")!.textContent, code.replaceAll("\n", ""));
  if (round > 0) {
    durations.push(elapsed);
    renderCounts.push(lineRenders);
  }
}
await React.act(async () => root.unmount());
dom.window.close();
durations.sort((left, right) => left - right);
console.log(JSON.stringify({
  revision: revision ?? "working-tree",
  lines: 251,
  updates,
  lineRenders: renderCounts,
  medianMs: Number(durations[Math.floor(durations.length / 2)]!.toFixed(2)),
  samplesMs: durations.map((value) => Number(value.toFixed(2)))
}));
