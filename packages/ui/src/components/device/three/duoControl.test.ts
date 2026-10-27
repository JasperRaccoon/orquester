// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/duoControl.test.ts
import assert from "node:assert/strict";
import { it, mock, type Mock } from "node:test";
import {
  createDuoControl,
  createDuoPinch,
  duoFoldState,
  duoHoldOrientation,
  type DuoCommand,
  type DuoControlState,
} from "./duoControl.ts";

const lastArgs = (fn: Mock<(...args: any[]) => unknown>) => fn.mock.calls.at(-1)?.arguments;

it("keeps a failed send visible, including a disconnect while draining queued motion", () => {
  let next = false;
  const send = mock.fn((_request: { requestId: number; command: DuoCommand }) => {
    const result = next;
    next = false;
    return result;
  });
  const onChange = mock.fn((_state: DuoControlState) => {});
  const queue = createDuoControl({ send, onChange });
  queue.enqueue({ control: "angle", value: 40 });
  assert.deepEqual(lastArgs(onChange), [
    { pending: false, requested: null, error: "Device is disconnected." },
  ]);
  next = true;
  queue.enqueue({ control: "pose", value: "book" });
  queue.enqueue({ control: "angle", value: 60 });
  queue.receive({ requestId: 2, ok: true });
  assert.deepEqual(lastArgs(onChange), [
    { pending: false, requested: null, error: "Device is disconnected." },
  ]);
});

it("coalesces hinge edits behind acknowledgements and lets a preset replace queued edits", () => {
  const send = mock.fn((_request: { requestId: number; command: DuoCommand }) => true);
  const onChange = mock.fn((_state: DuoControlState) => {});
  const queue = createDuoControl({ send, onChange });
  queue.enqueue({ control: "angle", value: 40 });
  queue.enqueue({ control: "angle", value: 50 });
  queue.enqueue({ control: "angle", value: 60 });
  assert.equal(send.mock.callCount(), 1);
  queue.receive({ requestId: 1, ok: true });
  assert.deepEqual(send.mock.calls[1]?.arguments[0], {
    requestId: 2,
    command: { control: "angle", value: 60 },
  });
  queue.enqueue({ control: "angle", value: 100 });
  queue.enqueue({ control: "pose", value: "tent" });
  queue.receive({ requestId: 2, ok: true });
  assert.deepEqual(send.mock.calls[2]?.arguments[0], {
    requestId: 3,
    command: { control: "pose", value: "tent" },
  });
  queue.receive({ requestId: 3, ok: true });
  assert.deepEqual(lastArgs(onChange), [{ pending: false, requested: null, error: null }]);
  queue.clear();
});

it("pinches only a hit device, accumulates independently of native readback, clamps and cancels", () => {
  let confirmed = 90;
  const change = mock.fn((_angle: number | null) => {});
  const pinch = createDuoPinch({
    angle: () => confirmed,
    contains: (x, y) => x > 0.2 && y > 0.2,
    change,
  });
  assert.equal(pinch.begin(0.1, 0.5), false);
  pinch.move(1);
  assert.equal(change.mock.callCount(), 0);
  assert.equal(pinch.begin(0.5, 0.5), true);
  pinch.move(0.25);
  assert.deepEqual(lastArgs(change), [120]);
  confirmed = 100;
  pinch.move(0.25);
  assert.deepEqual(lastArgs(change), [150]);
  pinch.move(2);
  assert.deepEqual(lastArgs(change), [180]);
  pinch.move(-3);
  assert.deepEqual(lastArgs(change), [0]);
  pinch.move(NaN);
  pinch.end();
  assert.deepEqual(lastArgs(change), [null]);
  const count = change.mock.callCount();
  pinch.move(1);
  pinch.end();
  assert.equal(change.mock.callCount(), count);
  assert.equal(pinch.active, false);
});

// regression: #16630 fold controls follow the phone's orientation on each screen
for (const [name, screen, fold, phoneVertical] of [
  [
    "vertical phone, closed",
    { screenId: 1, orientation: "portrait", hingeAngle: 0 },
    "closed",
    true,
  ],
  [
    "horizontal phone, closed",
    { screenId: 1, orientation: "landscape_right", hingeAngle: 0 },
    "closed",
    false,
  ],
  [
    "vertical phone opened as a book",
    { screenId: 3, orientation: "landscape_left", hingeAngle: 180 },
    "open",
    true,
  ],
  [
    "horizontal phone opened as a laptop",
    { screenId: 3, orientation: "portrait_upside_down", hingeAngle: 180 },
    "open",
    false,
  ],
  ["half-open book", { screenId: 3, orientation: "landscape_left", hingeAngle: 90 }, "half", true],
] as const) {
  it(`reads a ${name}`, () => {
    assert.deepEqual(duoFoldState(screen), { fold, stand: false, phoneVertical, settled: true });
  });
}

it("marks a display handoff unsettled while the cover reports the inner display's orientation", () => {
  const handoff = [
    { screenId: 1, orientation: "portrait", hingeAngle: 90 },
    { screenId: 1, orientation: "landscape_left", hingeAngle: 90 },
    { screenId: 3, orientation: "landscape_left", hingeAngle: 90 },
  ] as const;
  assert.deepEqual(
    handoff.map((screen) => duoFoldState(screen).settled),
    [false, false, true],
  );
  assert.equal(
    duoFoldState({ screenId: 3, orientation: "landscape_left", hingeAngle: 0 }).settled,
    false,
  );
});

it("marks native stands so the fold group does not also claim them", () => {
  assert.deepEqual(
    duoFoldState({ screenId: 3, orientation: "portrait", hingeAngle: 90, hingePose: "laptop" }),
    { fold: "half", stand: true, phoneVertical: false, settled: true },
  );
});

it("falls back like the 3D view when hinge fields are missing", () => {
  const closed = duoFoldState({ screenId: 1, orientation: "portrait" });
  assert.deepEqual(
    { fold: closed.fold, phoneVertical: closed.phoneVertical },
    { fold: "closed", phoneVertical: true },
  );
  const open = duoFoldState({ orientation: "landscape_left" });
  assert.deepEqual(
    { fold: open.fold, phoneVertical: open.phoneVertical },
    { fold: "open", phoneVertical: true },
  );
});

it("rotates a stand back to how the phone was held, in the frame of the display receiving it", () => {
  // Recorded from the iPhone Duo simulator: Tent can rest on either display.
  // Rotating the inner display to landscape_left, or the cover to portrait,
  // leaves a phone that opens and closes vertical.
  assert.equal(duoHoldOrientation(true, 3), "landscape_left");
  assert.equal(duoHoldOrientation(true, 1), "portrait");
  assert.equal(duoHoldOrientation(false, 1), "landscape_left");
  assert.equal(duoHoldOrientation(false, 3), "portrait_upside_down");
  for (const screenId of [1, 3])
    for (const vertical of [true, false])
      assert.equal(
        duoFoldState({ screenId, orientation: duoHoldOrientation(vertical, screenId) })
          .phoneVertical,
        vertical,
      );
});
