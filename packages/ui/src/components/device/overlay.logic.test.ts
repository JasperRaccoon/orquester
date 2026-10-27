import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceActionEntry } from "@orquester/api";

import { newOverlayEntries, normalizePoint, orientedScreen, overlayMarkOf, targetLabel } from "./overlay.logic.ts";

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
    assert.deepEqual(orientedScreen(screen, "portrait"), { width: 400, height: 800 });
    assert.deepEqual(orientedScreen({ width: 800, height: 400 }, "portrait_upside_down"), { width: 400, height: 800 });
    assert.deepEqual(orientedScreen(screen, "landscape_left"), { width: 800, height: 400 });
    assert.deepEqual(normalizePoint({ x: 100, y: 200 }, screen, "portrait"), { x: 0.25, y: 0.25 });
    assert.deepEqual(normalizePoint({ x: 100, y: 200 }, screen, "landscape_right"), { x: 0.125, y: 0.5 });
    assert.deepEqual(normalizePoint({ x: 900, y: -5 }, screen, "portrait"), { x: 1, y: 0 });
    assert.equal(normalizePoint({ x: 1, y: 1 }, undefined, "portrait"), null);
    assert.equal(normalizePoint(undefined, screen, "portrait"), null);
  });
  it("a tap draws a ripple with the target's label; a long press is marked", () => {
    const mark = overlayMarkOf(entry({ point: { x: 200, y: 400 }, target: "@e7 Search" }), screen, "portrait");
    assert.deepEqual(mark, { kind: "tap", id: "a1", at: { x: 0.5, y: 0.5 }, label: "Search", long: false, failed: false });
    const long = overlayMarkOf(entry({ kind: "long_press", ok: false }), screen, "portrait");
    assert.ok(long?.kind === "tap" && long.long && long.failed && long.at === null && long.label === "Tapped @e7 “Search”");
    assert.equal(targetLabel("@e3"), "@e3");
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
  it("only rows that arrive after the overlay looked animate", () => {
    const rows = [entry({ id: "a" }), entry({ id: "b" })];
    assert.deepEqual(newOverlayEntries(rows, new Set(["a"])).map((row) => row.id), ["b"]);
  });
});
