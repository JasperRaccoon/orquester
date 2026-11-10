import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopActionEntry } from "@orquester/api";

import { canvasShowsWholeDisplay, desktopOverlayMark, mapDisplayPoint, unionRect, type MapDisplayPoint } from "./overlay.logic.ts";

const display = { width: 1920, height: 1080 };
const container = { left: 100, top: 50, width: 960, height: 700 };

describe("display → view mapping", () => {
  it("scales into the surface, letterboxed and centred, relative to the overlay box", () => {
    // A 960×700 surface shows 1920×1080 at 0.5, 540 px tall, centred: 80 px bars above and below.
    const surface = { ...container };
    assert.deepEqual(mapDisplayPoint({ x: 0, y: 0 }, display, surface, container), { x: 0, y: 80 });
    assert.deepEqual(mapDisplayPoint({ x: 1920, y: 1080 }, display, surface, container), { x: 960, y: 620 });
    assert.deepEqual(mapDisplayPoint({ x: 412, y: 300 }, display, surface, container), { x: 206, y: 230 });
  });

  it("follows a zoomed or panned surface, and places nothing outside the overlay", () => {
    // Zoomed 2× (the surface is twice the box) and panned 300 px left.
    const zoomed = { left: -200, top: 50, width: 1920, height: 1080 };
    const box = { left: 100, top: 50, width: 960, height: 1080 };
    assert.deepEqual(mapDisplayPoint({ x: 600, y: 10 }, display, zoomed, box), { x: 300, y: 10 });
    assert.equal(mapDisplayPoint({ x: 100, y: 10 }, display, zoomed, box), null);
  });

  it("cannot place points without a size, or on a canvas that clips the display", () => {
    assert.equal(mapDisplayPoint({ x: 1, y: 1 }, { width: 0, height: 0 }, container, container), null);
    assert.equal(mapDisplayPoint({ x: 1, y: 1 }, display, { ...container, width: 0 }, container), null);
    assert.equal(canvasShowsWholeDisplay(display, display), true);
    assert.equal(canvasShowsWholeDisplay({ width: 960, height: 700 }, display), false);
  });

  it("treats a striped video as one surface", () => {
    const stripes = [
      { left: 0, top: 0, width: 800, height: 300 },
      { left: 0, top: 300, width: 800, height: 300 },
      { left: 0, top: 0, width: 0, height: 0 }
    ];
    assert.deepEqual(unionRect(stripes), { left: 0, top: 0, width: 800, height: 600 });
    assert.equal(unionRect([]), null);
  });
});

describe("overlay marks", () => {
  const identity: MapDisplayPoint = (x, y) => ({ x, y });
  const nowhere: MapDisplayPoint = () => null;
  const entry = (overrides: Partial<DesktopActionEntry>): DesktopActionEntry => ({
    id: "a1",
    at: "2026-11-10T10:00:00.000Z",
    actor: { kind: "chat", threadId: "t1", label: "Claude" },
    kind: "click",
    summary: "Clicked at 412, 300",
    point: { x: 412, y: 300 },
    ok: true,
    ...overrides
  });

  it("tells a right click and a double click apart, at the mapped point", () => {
    const right = desktopOverlayMark(entry({ button: "right" }), identity);
    assert.equal(right?.kind, "click");
    assert.equal(right?.kind === "click" && right.button, "right");
    const double = desktopOverlayMark(entry({ count: 2 }), identity);
    assert.equal(double?.kind === "click" && double.count, 2);
  });

  it("draws a drag between both points, and falls back to the summary when a point cannot be placed", () => {
    const drag = desktopOverlayMark(entry({ kind: "drag", to: { x: 800, y: 600 } }), identity);
    assert.deepEqual(drag?.kind === "drag" && [drag.from, drag.to], [{ x: 412, y: 300 }, { x: 800, y: 600 }]);
    assert.deepEqual(desktopOverlayMark(entry({}), nowhere), { kind: "label", id: "a1", label: "Clicked at 412, 300", failed: false });
  });

  it("bounds typed text, formats key combos, and draws nothing for reads", () => {
    const typed = desktopOverlayMark(entry({ kind: "type", point: undefined, text: "y".repeat(60) + "z" }), identity);
    assert.ok(typed?.kind === "text" && typed.text.length <= 60 && typed.at === null);
    const key = desktopOverlayMark(entry({ kind: "key", point: undefined, keys: "ctrl+shift+t" }), identity);
    assert.equal(key?.kind === "key" && key.label, "Ctrl+Shift+T");
    for (const kind of ["screenshot", "wait", "clipboard_get", "clipboard_set"] as const) {
      assert.equal(desktopOverlayMark(entry({ kind }), identity), null);
    }
  });
});
