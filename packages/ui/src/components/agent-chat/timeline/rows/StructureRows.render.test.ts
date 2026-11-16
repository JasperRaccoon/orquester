import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkingRow } from "./StructureRows";

/** The row's visible text, tags dropped and whitespace collapsed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

test("a running turn reads \"Working for <elapsed>\", with one \"for\"", () => {
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  const shown = text(renderToStaticMarkup(createElement(WorkingRow, { row: { kind: "working", id: "w", createdAt: startedAt } })));
  assert.match(shown, /^Working for \d/);
  assert.doesNotMatch(shown, /\bfor for\b/);
});
