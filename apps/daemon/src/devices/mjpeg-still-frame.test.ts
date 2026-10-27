import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { MjpegPartTracker, repeatStillFrame } from "./mjpeg-still-frame.ts";

const part = (body: string) => Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n${body}\r\n`);

test("the tracker keeps the last complete part, across chunk splits, and stops on unknown framing", () => {
  const tracker = new MjpegPartTracker();
  const whole = Buffer.concat([part("one"), part("second")]);
  // Fed byte by byte: a part is still only at a boundary.
  for (let i = 0; i < part("one").length - 1; i += 1) {
    tracker.feed(whole.subarray(i, i + 1));
    assert.equal(tracker.still, null);
  }
  tracker.feed(whole.subarray(part("one").length - 1, part("one").length));
  assert.deepEqual(Buffer.concat(tracker.still!), part("one"));
  tracker.feed(whole.subarray(part("one").length));
  assert.deepEqual(Buffer.concat(tracker.still!), part("second"));

  const other = new MjpegPartTracker();
  other.feed(Buffer.from("HTTP garbage without a boundary\r\n\r\nxx"));
  assert.equal(other.still, null);
  other.feed(part("late"));
  assert.equal(other.still, null);
});

test("a quiet stream re-sends its last part once; a new part cancels the repeat", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = repeatStillFrame(20);
  const out: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => out.push(chunk));
  const firstFrame = once(stream, "data");
  stream.write(part("a"));
  await firstFrame;
  t.mock.timers.tick(10);
  stream.write(part("b"));
  t.mock.timers.tick(19);
  assert.deepEqual(Buffer.concat(out), Buffer.concat([part("a"), part("b")]));
  t.mock.timers.tick(1);
  assert.deepEqual(Buffer.concat(out), Buffer.concat([part("a"), part("b"), part("b")]));
  t.mock.timers.tick(80);
  stream.end();
  await new Promise((resolve) => stream.once("end", resolve));
  assert.deepEqual(Buffer.concat(out), Buffer.concat([part("a"), part("b"), part("b")]));
});
