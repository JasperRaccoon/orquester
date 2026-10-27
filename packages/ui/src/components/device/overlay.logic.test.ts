import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceActionEntry } from "@orquester/api";

import { overlayMarkOf } from "./overlay.logic.ts";

const screen = { width: 400, height: 800 };
const entry = (overrides: Partial<DeviceActionEntry>): DeviceActionEntry => ({
  id: "a1",
  leaseId: "l1",
  at: "2026-10-27T10:00:00.000Z",
  actor: "agent",
  kind: "tap",
  summary: "Tapped @e7 “Search”",
  ok: true,
  ...overrides
});

describe("overlay mapping", () => {
  it("normalizes points in portrait and swaps the sides in landscape", () => {
    const point = (orientation: "portrait" | "landscape_right", x = 100, y = 200) => {
      const mark = overlayMarkOf(entry({ point: { x, y } }), screen, orientation);
      assert.ok(mark?.kind === "tap");
      return mark.at;
    };
    assert.deepEqual(point("portrait"), { x: 0.25, y: 0.25 });
    assert.deepEqual(point("landscape_right"), { x: 0.125, y: 0.5 });
    assert.deepEqual(point("portrait", 900, -5), { x: 1, y: 0 });
    const unknown = overlayMarkOf(entry({ point: { x: 100, y: 200 } }), undefined, "portrait");
    assert.ok(unknown?.kind === "tap" && unknown.at === null);
  });
  it("a tap draws a ripple with the target's label; a long press is marked", () => {
    const mark = overlayMarkOf(entry({ target: "@e7 Search" }), screen, "portrait");
    assert.ok(mark?.kind === "tap" && mark.label === "Search" && !mark.long && !mark.failed);
    const long = overlayMarkOf(entry({ kind: "long_press", ok: false }), screen, "portrait");
    assert.ok(long?.kind === "tap" && long.long && long.failed);
  });
  it("a swipe draws its trail; a direction-only scroll synthesizes one (the finger moves against the scroll)", () => {
    const swipe = overlayMarkOf(entry({ kind: "swipe", from: { x: 200, y: 600 }, to: { x: 200, y: 200 }, summary: "Swiped up" }), screen, "portrait");
    assert.ok(swipe?.kind === "swipe");
    assert.deepEqual([swipe.from, swipe.to], [{ x: 0.5, y: 0.75 }, { x: 0.5, y: 0.25 }]);
    const scroll = overlayMarkOf(entry({ kind: "scroll", summary: "Scrolled down" }), screen, "portrait");
    assert.ok(scroll?.kind === "swipe" && scroll.from.y > scroll.to.y, "scrolling down drags the finger up");
    assert.equal(overlayMarkOf(entry({ kind: "scroll", summary: "Scrolled" }), screen, "portrait"), null);
  });
  it("typing shows its text; a key press its name; reads and the user's input draw nothing", () => {
    const typed = overlayMarkOf(entry({ kind: "type", summary: "Typed “hello world”" }), screen, "portrait");
    assert.deepEqual(typed, { kind: "text", id: "a1", at: null, text: "hello world", failed: false });
    assert.deepEqual(overlayMarkOf(entry({ kind: "press", summary: "Pressed home" }), screen, "portrait"), { kind: "key", id: "a1", label: "Home", failed: false });
    assert.equal(overlayMarkOf(entry({ kind: "screenshot" }), screen, "portrait"), null);
    assert.equal(overlayMarkOf(entry({ actor: "user" }), screen, "portrait"), null);
  });
});
