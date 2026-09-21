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

test("the first update seeds the list", () => {
  const merged = mergeProviderUsageWindows(undefined, [win({ id: "5h" }), win({ id: "week" })]);
  assert.deepEqual(
    merged.map((w) => w.id),
    ["5h", "week"]
  );
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

test("a known window keeps its slot and a new one lands at the end", () => {
  const previous = [win({ id: "a" }), win({ id: "b" }), win({ id: "c" })];
  const merged = mergeProviderUsageWindows(previous, [win({ id: "c", usedPercent: 1 }), win({ id: "z" })]);
  assert.deepEqual(
    merged.map((w) => w.id),
    ["a", "b", "c", "z"]
  );
});

test("an empty update is a no-op, not a reset", () => {
  const previous = [win({ id: "a" })];
  assert.deepEqual(mergeProviderUsageWindows(previous, []), previous);
});

test("provider windows project into presentation rows with a namespaced id", () => {
  const rows = providerWindowsToNormalized("claude", [
    win({ id: "5h", label: "5h", usedPercent: 33.4 }),
    win({ id: "week", kind: "weekly", label: "Week", usedPercent: 71, resetsAt: "2026-09-28T00:00:00Z" })
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.period, r.percent, r.resetsAt]),
    [
      ["provider:5h", "rolling", 33.4, undefined],
      ["provider:week", "weekly", 71, "2026-09-28T00:00:00Z"]
    ]
  );
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

test("an out-of-range percentage is clamped rather than blowing the bar out", () => {
  const rows = providerWindowsToNormalized("grok", [
    win({ id: "a", usedPercent: 140 }),
    win({ id: "b", usedPercent: -5 })
  ]);
  assert.deepEqual(
    rows.map((r) => r.percent),
    [100, 0]
  );
});

test("a monthly window reads as a period bar; an unknown kind falls back to rolling", () => {
  const rows = providerWindowsToNormalized("codex", [
    win({ id: "m", kind: "monthly" }),
    win({ id: "o", kind: "other" })
  ]);
  assert.deepEqual(
    rows.map((r) => r.period),
    ["weekly", "rolling"]
  );
});
