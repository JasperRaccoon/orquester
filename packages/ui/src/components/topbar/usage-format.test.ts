import test from "node:test";
import assert from "node:assert/strict";

import type { ProviderUsageWindow } from "@orquester/api";

import { mergeProviderUsageWindows, providerWindowsToNormalized } from "./usage-format.ts";

const win = (over: Partial<ProviderUsageWindow> & { id: string }): ProviderUsageWindow => ({
  kind: "session",
  label: "5h",
  usedPercent: 10,
  ...over
});

test("a sparse update replaces only the windows it names", () => {
  const previous = [win({ id: "5h", usedPercent: 10 }), win({ id: "week", usedPercent: 80 })];
  const merged = mergeProviderUsageWindows(previous, [win({ id: "5h", usedPercent: 55 })]);
  assert.deepEqual(
    merged.map((w) => [w.id, w.usedPercent]),
    [
      ["5h", 55],
      // Omitted means unchanged, NEVER cleared — a provider that reports only
      // its 5h pool on one turn must not erase the weekly bar.
      ["week", 80]
    ]
  );
});

test("an empty update is a no-op, not a reset", () => {
  const previous = [win({ id: "a" })];
  assert.deepEqual(mergeProviderUsageWindows(previous, []), previous);
});

test("a window the daemon's own poll already covers is dropped, not printed twice", () => {
  const rows = providerWindowsToNormalized("claude", [win({ id: "session" }), win({ id: "other" })], [
    "session",
    "weekly"
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["provider:other"]
  );
});
