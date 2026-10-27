// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/phoneInteraction.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createPhoneInteraction, phoneWheelNavigation } from "./phoneInteraction.ts";

type Point = { x: number; y: number };
type Phase = "begin" | "move" | "end";

it("keeps a captured screen gesture separate from orbit and ends it once on cancellation", () => {
  const touch = mock.fn((_phase: Phase, _point: Point) => {});
  const orbit = mock.fn((_x: number, _y: number) => {});
  const returns: (Point | undefined)[] = [
    { x: 0.2, y: 0.3 },
    { x: 1, y: 0.6 },
  ];
  const screenPoint = mock.fn((_point: Point, _captured: boolean) => returns.shift() ?? null);
  const input = createPhoneInteraction({ screenPoint, touch, orbit, zoomBy: mock.fn() });
  assert.equal(input.begin(1, { x: 0.4, y: 0.3 }), true);
  assert.equal(input.begin(2, { x: 0.2, y: 0.2 }), false);
  input.move(2, { x: 0.8, y: 0.8 });
  input.move(1, { x: 1.3, y: 0.6 });
  input.end(2);
  input.end();
  input.end(1);
  assert.deepEqual(
    touch.mock.calls.map((call) => call.arguments),
    [
      ["begin", { x: 0.2, y: 0.3 }],
      ["move", { x: 1, y: 0.6 }],
      ["end", { x: 1, y: 0.6 }],
    ],
  );
  assert.equal(orbit.mock.callCount(), 0);
  assert.equal(screenPoint.mock.calls[1]?.arguments[1], true);
});

it("blocks navigation during either captured gesture, then resumes without sending device touches", () => {
  const touch = mock.fn((_phase: Phase, _point: Point) => {});
  const orbit = mock.fn((_x: number, _y: number) => {});
  const zoomBy = mock.fn((_delta: number) => {});
  const input = createPhoneInteraction({
    screenPoint: () => ({ x: 0.5, y: 0.5 }),
    touch,
    orbit,
    zoomBy,
  });
  input.begin(1, { x: 0.5, y: 0.5 });
  assert.equal(input.navigate({ type: "zoom", delta: 0.2 }), false);
  assert.equal(input.navigate({ type: "orbit", x: 0.1, y: 0.2 }), false);
  input.end();
  input.begin(2, { x: 0.5, y: 0.5 }, true);
  assert.equal(input.navigate({ type: "zoom", delta: 0.2 }), false);
  input.end();
  assert.equal(input.navigate({ type: "zoom", delta: 0.2 }), true);
  assert.equal(input.navigate({ type: "orbit", x: 0.1, y: 0.2 }), true);
  assert.deepEqual(
    zoomBy.mock.calls.map((call) => call.arguments),
    [[0.2]],
  );
  assert.deepEqual(
    orbit.mock.calls.map((call) => call.arguments),
    [[0.1, 0.2]],
  );
  assert.deepEqual(
    touch.mock.calls.map((call) => call.arguments[0]),
    ["begin", "end"],
  );
});

it("ends wheel orbit without ending a captured screen touch", () => {
  const onInteractionActive = mock.fn((_active: boolean, _mode: "touch" | "orbit") => {});
  const input = createPhoneInteraction({
    screenPoint: () => ({ x: 0.5, y: 0.5 }),
    touch: mock.fn(),
    orbit: mock.fn(),
    zoomBy: mock.fn(),
    onInteractionActive,
  });
  const calledWith = (...args: unknown[]) =>
    onInteractionActive.mock.calls.some((call) => {
      try {
        assert.deepEqual(call.arguments, args);
        return true;
      } catch {
        return false;
      }
    });
  input.endWheel();
  assert.ok(calledWith(false, "orbit"));
  input.begin(1, { x: 0.5, y: 0.5 });
  onInteractionActive.mock.resetCalls();
  input.endWheel();
  assert.equal(onInteractionActive.mock.callCount(), 0);
  input.end(1);
  assert.ok(calledWith(false, "touch"));
});

it("normalizes wheel units, distinguishes pinch, and bounds jumps from coarse scroll wheels", () => {
  const wheel = { width: 400, height: 800, deltaX: 16, deltaY: 32, deltaMode: 0, ctrlKey: false };
  assert.deepEqual(phoneWheelNavigation(wheel), { type: "orbit", x: -0.04, y: -0.04 });
  assert.deepEqual(
    phoneWheelNavigation({ ...wheel, deltaX: 1, deltaY: 2, deltaMode: 1 }),
    phoneWheelNavigation(wheel),
  );
  assert.deepEqual(phoneWheelNavigation({ ...wheel, deltaX: 1, deltaY: 1, deltaMode: 2 }), {
    type: "orbit",
    x: -0.25,
    y: -0.25,
  });
  assert.deepEqual(phoneWheelNavigation({ ...wheel, ctrlKey: true }), {
    type: "zoom",
    delta: -0.32,
  });
  assert.deepEqual(phoneWheelNavigation({ ...wheel, deltaY: -10000, ctrlKey: true }), {
    type: "zoom",
    delta: 1,
  });
  assert.equal(phoneWheelNavigation({ ...wheel, width: 0 }), null);
  assert.equal(phoneWheelNavigation({ ...wheel, deltaY: NaN }), null);
  assert.equal(phoneWheelNavigation({ ...wheel, deltaMode: 9 }), null);
});
