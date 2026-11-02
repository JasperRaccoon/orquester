import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveUsageShortcut, type UsageShortcutContext, type UsageShortcutEvent } from "./usage-shortcuts.ts";

const key = (over: Partial<UsageShortcutEvent>): UsageShortcutEvent => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: null,
  ...over
});

const on = (over: Partial<UsageShortcutContext> = {}): UsageShortcutContext => ({ tab: "cost", layerOpen: false, ...over });

/** A DOM-ish target: `closest` answers for the selectors the element sits inside. */
const target = (tagName: string, opts: { editable?: boolean; inDialog?: boolean } = {}) => ({
  tagName,
  isContentEditable: opts.editable ?? false,
  closest: (selector: string) => (opts.inDialog && selector.includes('[role="dialog"]') ? {} : null)
});

describe("resolveUsageShortcut", () => {
  it("c, t and l pick the tab", () => {
    assert.deepEqual(resolveUsageShortcut(key({ key: "c" }), on({ tab: "limits" })), { kind: "tab", tab: "cost" });
    assert.deepEqual(resolveUsageShortcut(key({ key: "t" }), on()), { kind: "tab", tab: "tokens" });
    assert.deepEqual(resolveUsageShortcut(key({ key: "l" }), on()), { kind: "tab", tab: "limits" });
    assert.equal(resolveUsageShortcut(key({ key: "c", ctrlKey: true }), on()), null, "Ctrl+C is copy");
    assert.equal(resolveUsageShortcut(key({ key: "x" }), on()), null);
  });

  it("plain 1–4 pick the range; with a modifier (⌘⇧3 / ⌘⇧4 are macOS screenshots) they do nothing", () => {
    assert.deepEqual(resolveUsageShortcut(key({ key: "1" }), on()), { kind: "range", range: "24h" });
    assert.deepEqual(resolveUsageShortcut(key({ key: "4" }), on()), { kind: "range", range: "90d" });
    assert.equal(resolveUsageShortcut(key({ key: "5" }), on()), null);
    for (const mod of [{ metaKey: true, shiftKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true }, { altKey: true }]) {
      assert.equal(resolveUsageShortcut(key({ key: "3", ...mod }), on()), null, JSON.stringify(mod));
    }
  });

  it("ranges do nothing on Limits", () => {
    assert.equal(resolveUsageShortcut(key({ key: "2" }), on({ tab: "limits" })), null);
  });

  it("stands down while typing, inside a dialog, with a layer open, or on a repeat", () => {
    for (const t of [target("INPUT"), target("TEXTAREA"), target("SELECT"), target("DIV", { editable: true }), target("BUTTON", { inDialog: true })]) {
      assert.equal(resolveUsageShortcut(key({ key: "t", target: t as never }), on()), null, t.tagName);
    }
    assert.deepEqual(resolveUsageShortcut(key({ key: "t", target: target("BUTTON") as never }), on()), { kind: "tab", tab: "tokens" });
    assert.equal(resolveUsageShortcut(key({ key: "t" }), on({ layerOpen: true })), null);
    assert.equal(resolveUsageShortcut(key({ key: "t", repeat: true }), on()), null);
    assert.equal(resolveUsageShortcut(key({ key: "t", isComposing: true }), on()), null);
    assert.equal(resolveUsageShortcut(key({ key: "t", defaultPrevented: true }), on()), null);
  });
});
