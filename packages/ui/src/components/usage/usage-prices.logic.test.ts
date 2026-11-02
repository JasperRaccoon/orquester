import { test } from "node:test";
import assert from "node:assert/strict";

import type { UsageBuiltinPrice } from "@orquester/api";

import {
  builtinRatesFor,
  draftFromPrices,
  isRateEdit,
  newPriceRow,
  parseRate,
  priceDraftResult,
  ratePlaceholder,
  type PriceRow
} from "./usage-prices.logic.ts";

const saved = {
  overrides: { "gpt-6-astra": { input: 2, output: 8, cacheRead: 0.2 } },
  aliases: { "my-proxy-model": "claude-sonnet-4-5" }
};

function edit(rows: PriceRow[], model: string, change: Partial<PriceRow> | ((row: PriceRow) => PriceRow)): PriceRow[] {
  return rows.map((row) => (row.model !== model ? row : typeof change === "function" ? change(row) : { ...row, ...change }));
}

test("a rate cell takes digits with one decimal separator and parses finite non-negative numbers", () => {
  for (const ok of ["", "4", "4.", "0.075", ".5", "3,5"]) assert.equal(isRateEdit(ok), true, ok);
  for (const bad of ["-1", "1.2.3", "1,2.3", "1e3", "abc", "1 2"]) assert.equal(isRateEdit(bad), false, bad);

  assert.equal(parseRate(" 3,5 "), 3.5);
  assert.equal(parseRate("0"), 0);
  assert.equal(parseRate(".5"), 0.5);
  assert.equal(parseRate("   "), "blank");
  assert.equal(parseRate("-1"), "invalid");
  assert.equal(parseRate("Infinity"), "invalid");
  assert.equal(parseRate("1e400"), "invalid");
});

test("an untouched draft sends nothing, and edits back to the saved value are dropped", () => {
  const rows = draftFromPrices(saved);
  assert.deepEqual(priceDraftResult(rows, saved), { errors: {}, patch: {}, changed: false });

  const same = edit(rows, "gpt-6-astra", (row) => ({ ...row, rates: { ...row.rates, input: "2.00", cacheRead: "0,2" } }));
  assert.equal(priceDraftResult(same, saved).changed, false);
});

test("the patch names only changed models: an edit, a reset row as null, a new mapping", () => {
  let rows = draftFromPrices(saved);
  rows = edit(rows, "gpt-6-astra", (row) => ({ ...row, rates: { ...row.rates, output: "10", cacheRead: "" } }));
  rows = edit(rows, "my-proxy-model", { reset: true });
  rows = [{ ...newPriceRow("o3-mirror"), mapTo: "o3" }, ...rows];

  const result = priceDraftResult(rows, saved);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.patch, {
    overrides: { "gpt-6-astra": { input: 2, output: 10 } },
    aliases: { "my-proxy-model": null, "o3-mirror": "o3" }
  });
});

test("a row asks for an id, a unique model, Input and Output unless mapped, and a real target", () => {
  const blank = newPriceRow();
  const duplicate = { ...newPriceRow(" gpt-6-astra "), rates: { ...newPriceRow().rates, input: "1", output: "1" } };
  const unpriced = newPriceRow("glm-5");
  const self = { ...newPriceRow("kimi-k3"), mapTo: "kimi-k3" };
  const mapped = { ...newPriceRow("kimi-k2"), mapTo: "gpt-6-astra" };

  const { errors } = priceDraftResult([...draftFromPrices(saved), blank, duplicate, unpriced, self, mapped], saved);
  assert.deepEqual(errors[blank.key], { message: "Enter a model ID.", missing: true });
  assert.equal(errors[duplicate.key]?.message, "This model already has a row.");
  assert.equal(errors[unpriced.key]?.missing, true);
  assert.equal(errors[self.key]?.message, "Map to a different model.");
  assert.equal(errors[mapped.key], undefined);
});

test("mappings are checked for a cycle on the graph the daemon would hold after saving", () => {
  // Saved: my-proxy-model → claude-sonnet-4-5. Mapping the target back closes the loop.
  const closing = { ...newPriceRow("claude-sonnet-4-5"), mapTo: "my-proxy-model" };
  const rows = [closing, ...draftFromPrices(saved)];
  assert.equal(priceDraftResult(rows, saved).errors[closing.key]?.message, "Mappings can't form a cycle.");

  // Resetting the saved mapping in the same draft opens the loop again.
  const reopened = edit(rows, "my-proxy-model", { reset: true });
  assert.deepEqual(priceDraftResult(reopened, saved).errors, {});
});

test("built-in rates resolve like the daemon's lookup, which the placeholders show", () => {
  const builtin: UsageBuiltinPrice[] = [
    { model: "claude-opus-4-8", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } },
    { model: "claude-opus-4", rates: { input: 15, output: 75 } },
    { model: "gpt-5", rates: { input: 1.25, output: 10, cacheRead: 0.125 } }
  ];
  assert.equal(builtinRatesFor("Claude-Opus-4-8-20260115[1m]", builtin)?.input, 5);
  assert.equal(builtinRatesFor("claude-opus-4-1", builtin)?.input, 15);
  assert.equal(builtinRatesFor("openai/gpt-5-preview", builtin)?.input, 1.25);
  assert.equal(builtinRatesFor("gpt-50", builtin), null);
  assert.equal(builtinRatesFor("opus", builtin), null);

  const gpt5 = builtinRatesFor("gpt-5", builtin);
  assert.equal(ratePlaceholder("input", gpt5), "1.25");
  assert.equal(ratePlaceholder("cacheWrite5m", gpt5), "= input");
  assert.equal(ratePlaceholder("input", null), "Automatic");
  assert.equal(ratePlaceholder("cacheRead", null), "= input");
});
