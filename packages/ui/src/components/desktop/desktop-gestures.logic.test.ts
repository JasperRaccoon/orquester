import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { DesktopGestureRecognizer, LONG_PRESS_MS } from "./desktop-gestures.logic.ts";
import type { DesktopViewportGeometry } from "./desktop-viewport.logic.ts";
import type { DesktopInputMode } from "../../lib/desktop-prefs.ts";

// A 1000×500 view showing a 2000×1000 display: 2 display px per CSS px, no letterbox.
const GEOMETRY: DesktopViewportGeometry = {
  width: 1000,
  height: 500,
  left: 0,
  top: 0,
  visibleHeight: 500,
  display: { width: 2000, height: 1000 },
  devicePixelRatio: 1,
  sharp: false
};

const SHIFT = 0xffe1;

function setup(mode: DesktopInputMode, modifiers: number[] = []) {
  const calls: string[] = [];
  let haptics = 0;
  let pending = [...modifiers];
  const recognizer = new DesktopGestureRecognizer(
    {
      geometry: () => GEOMETRY,
      sink: {
        pointerMove: (x, y) => calls.push(`move ${x},${y}`),
        pointerButton: (button, down) => calls.push(`${down ? "down" : "up"} ${button}`),
        scroll: (dx, dy) => calls.push(`scroll ${dx},${dy}`),
        key: (keysym, down) => calls.push(`key ${keysym.toString(16)} ${down ? "down" : "up"}`),
        releaseAll: () => calls.push("releaseAll"),
        setClipboard: () => undefined
      },
      takeModifiers: () => {
        const keys = pending;
        pending = [];
        return keys;
      },
      onChange: () => undefined,
      haptic: () => {
        haptics += 1;
      }
    },
    mode
  );
  let t = 0;
  const at = (dt: number) => (t += dt);
  const down = (id: number, x: number, y: number, dt = 0) => recognizer.down({ id, x, y, t: at(dt) });
  const move = (id: number, x: number, y: number, dt = 16) => recognizer.move({ id, x, y, t: at(dt) });
  const up = (id: number, x: number, y: number, dt = 0) => recognizer.up({ id, x, y, t: at(dt) });
  return { recognizer, calls, down, move, up, haptics: () => haptics };
}

const clicks = (calls: string[]) => calls.filter((c) => !c.startsWith("move"));

test("trackpad: a tap left-clicks at the cursor, not under the finger", () => {
  const { calls, down, up } = setup("trackpad");
  down(1, 100, 50);
  up(1, 102, 51, 120);
  assert.deepEqual(calls, ["move 1000,500", "down 1", "up 1"]);
});

test("touch: a tap moves to the finger and left-clicks there", () => {
  const { calls, down, up } = setup("touch");
  down(1, 100, 50);
  up(1, 100, 50, 100);
  assert.deepEqual(calls, ["move 200,100", "down 1", "up 1"]);
});

test("a slow or moved touch is not a tap", () => {
  const { calls, down, up } = setup("touch");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    down(1, 100, 50);
    up(1, 100, 50, 360);
    assert.deepEqual(calls, []);
  } finally {
    mock.timers.reset();
  }
  const trackpad = setup("trackpad");
  trackpad.down(1, 100, 50);
  trackpad.move(1, 130, 50);
  trackpad.up(1, 130, 50);
  assert.deepEqual(clicks(trackpad.calls), []);
});

test("two-finger tap right-clicks: at the cursor (trackpad) or the first finger (touch)", () => {
  const trackpad = setup("trackpad");
  trackpad.down(1, 100, 50);
  trackpad.down(2, 200, 50, 20);
  trackpad.up(1, 100, 50, 80);
  trackpad.up(2, 200, 50, 20);
  assert.deepEqual(trackpad.calls, ["move 1000,500", "down 3", "up 3"]);

  const touch = setup("touch");
  touch.down(1, 100, 50);
  touch.down(2, 200, 50, 20);
  touch.up(2, 200, 50, 80);
  touch.up(1, 100, 50, 20);
  assert.deepEqual(touch.calls, ["move 200,100", "down 3", "up 3"]);
});

test("three-finger tap middle-clicks", () => {
  const { calls, down, up } = setup("trackpad");
  down(1, 100, 50);
  down(2, 200, 50, 10);
  down(3, 300, 50, 10);
  up(1, 100, 50, 60);
  up(2, 200, 50);
  up(3, 300, 50);
  assert.deepEqual(clicks(calls), ["down 2", "up 2"]);
});

test("trackpad: one-finger drag moves the cursor 1.5 × display px per CSS px", () => {
  const { calls, recognizer, down, move, up } = setup("trackpad");
  down(1, 100, 100);
  move(1, 120, 100); // past the slop: the whole 20 px count
  move(1, 120, 90);
  up(1, 120, 90);
  // 20 css px × 1.5 × 2 display px per css px = 60 display px.
  assert.deepEqual(calls, ["move 1060,500", "move 1060,470"]);
  assert.deepEqual(recognizer.state.cursor, { x: 1060, y: 470 });
});

test("trackpad: a long press holds the left button for a drag until the finger lifts", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { calls, down, move, up } = setup("trackpad", [SHIFT]);
    down(1, 100, 100);
    mock.timers.tick(LONG_PRESS_MS);
    assert.deepEqual(calls, ["move 1000,500", `key ${SHIFT.toString(16)} down`, "down 1"]);
    move(1, 140, 100);
    up(1, 140, 100);
    assert.deepEqual(calls.slice(3), ["move 1120,500", "up 1", `key ${SHIFT.toString(16)} up`]);
  } finally {
    mock.timers.reset();
  }
});

test("touch: a long press right-clicks under the finger with a haptic tick, and nothing follows", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { calls, down, move, up, haptics } = setup("touch");
    down(1, 100, 50);
    mock.timers.tick(LONG_PRESS_MS);
    move(1, 150, 50);
    up(1, 150, 50);
    assert.deepEqual(calls, ["move 200,100", "down 3", "up 3"]);
    assert.equal(haptics(), 1);
  } finally {
    mock.timers.reset();
  }
});

test("touch: a one-finger drag is a left drag from where the finger touched down", () => {
  const { calls, down, move, up } = setup("touch");
  down(1, 100, 50);
  move(1, 120, 50);
  move(1, 150, 60);
  up(1, 150, 60);
  assert.deepEqual(calls, ["move 200,100", "down 1", "move 240,100", "move 300,120", "up 1"]);
});

test("two-finger drag scrolls naturally in display pixels, under the fingers in Touch mode", () => {
  const { calls, down, move, up } = setup("touch");
  down(1, 400, 300);
  down(2, 500, 300);
  move(1, 400, 285); // past the slop: scrolling starts here
  move(2, 500, 285);
  move(1, 400, 270);
  move(2, 500, 270);
  up(1, 400, 270);
  up(2, 500, 270);
  assert.equal(calls[0], "move 900,585", "the pointer goes to the fingers' midpoint first");
  const scrolls = calls.filter((c) => c.startsWith("scroll")).map((c) => c.slice(7).split(",").map(Number));
  // From where scrolling began (midpoint at y 292.5) the midpoint rose 22.5 css px: the content
  // moves up with the fingers (scroll down), 2 display px per css px.
  assert.equal(scrolls.reduce((sum, [, dy]) => sum + dy, 0), 45);
  assert.ok(scrolls.every(([dx]) => Object.is(Math.abs(dx), 0)));
  assert.deepEqual(clicks(calls).filter((c) => !c.startsWith("scroll")), []);
});

test("a pinch zooms only past 15 %, keeps the midpoint, pans while zoomed and snaps back below 1.05×", () => {
  const { recognizer, calls, down, move, up } = setup("trackpad");
  down(1, 400, 250);
  down(2, 500, 250);
  move(1, 395, 250);
  move(2, 505, 250); // 10 %: nothing yet
  assert.equal(recognizer.state.zoom.zoom, 1);
  move(1, 365, 250); // 110 → 140 px: a pinch, measured from here (midpoint 435, 250)
  move(2, 575, 250); // 140 → 210 px: 1.5×, midpoint now 470, 250
  const zoomed = recognizer.state.zoom;
  assert.ok(Math.abs(zoomed.zoom - 1.5) < 1e-9);
  // The stage point that was under the midpoint (435, 250) is under the new midpoint (470, 250).
  assert.ok(Math.abs(zoomed.x - (470 - 1.5 * 435)) < 1e-9 && Math.abs(zoomed.y - (250 - 1.5 * 250)) < 1e-9);
  up(1, 365, 250);
  up(2, 575, 250);
  assert.equal(recognizer.state.zoom.zoom, 1.5, "a real zoom stays after the fingers lift");
  assert.deepEqual(clicks(calls), [], "a pinch neither clicks nor scrolls");

  // Zoomed, a two-finger drag pans instead of scrolling.
  down(3, 400, 250);
  down(4, 500, 250);
  move(3, 400, 270);
  move(4, 500, 270);
  move(3, 400, 280);
  move(4, 500, 280);
  up(3, 400, 280);
  up(4, 500, 280);
  // From where panning began (midpoint at y 260) the midpoint moved 20 css px down.
  assert.ok(Math.abs(recognizer.state.zoom.y - (zoomed.y + 20)) < 1e-9);
  assert.deepEqual(clicks(calls), []);

  // Pinching back down to just above 1× snaps to 1× on release.
  down(5, 300, 250);
  down(6, 500, 250);
  move(5, 340, 250); // 200 → 160 px: a pinch, measured from here at 1.5×
  move(6, 450, 250); // 160 → 110 px: 1.03×
  assert.ok(recognizer.state.zoom.zoom > 1 && recognizer.state.zoom.zoom < 1.05);
  up(5, 340, 250);
  up(6, 450, 250);
  assert.equal(recognizer.state.zoom.zoom, 1);
});

test("a double tap clicks twice on the first tap's point", () => {
  const { calls, down, up } = setup("touch");
  down(1, 100, 50);
  up(1, 100, 50, 80);
  down(2, 110, 58, 150);
  up(2, 110, 58, 80);
  assert.deepEqual(calls, ["move 200,100", "down 1", "up 1", "move 200,100", "down 1", "up 1"]);
});

test("latched modifiers are held around a tap's click (Shift-tap = Shift-click), once", () => {
  const { calls, down, up } = setup("touch", [SHIFT]);
  down(1, 100, 50);
  up(1, 100, 50, 50);
  down(1, 100, 50, 1_000);
  up(1, 100, 50, 50);
  assert.deepEqual(clicks(calls), [`key ${SHIFT.toString(16)} down`, "down 1", "up 1", `key ${SHIFT.toString(16)} up`, "down 1", "up 1"]);
});

test("a pen is a direct pointer: hover moves, the tip clicks where it touches, with latched modifiers", () => {
  const { recognizer, calls } = setup("trackpad", [SHIFT]);
  recognizer.penMove({ x: 100, y: 50 });
  recognizer.penButton(1, true, { x: 100, y: 50 });
  recognizer.penMove({ x: 110, y: 50 });
  recognizer.penButton(1, false, { x: 110, y: 50 });
  assert.deepEqual(calls, [
    "move 200,100",
    "move 200,100",
    `key ${SHIFT.toString(16)} down`,
    "down 1",
    "move 220,100",
    "move 220,100",
    "up 1",
    `key ${SHIFT.toString(16)} up`
  ]);
});
