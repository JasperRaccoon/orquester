import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { repeatStillFrame } from "./mjpeg-still-frame.ts";

const part = (body: string) => Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n${body}\r\n`);

test("MJPEG repeats only complete parts across byte splits and leaves unknown framing untouched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = repeatStillFrame();
  const out: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => out.push(chunk));
  const whole = Buffer.concat([part("one"), part("second")]);
  for (let i = 0; i < whole.length - 1; i += 1) stream.write(whole.subarray(i, i + 1));
  t.mock.timers.runAll();
  assert.deepEqual(Buffer.concat(out), whole.subarray(0, -1), "an incomplete final part is never replayed");
  stream.write(whole.subarray(-1));
  t.mock.timers.runAll();
  assert.deepEqual(Buffer.concat(out), Buffer.concat([whole, part("second")]));
  stream.end();
  await once(stream, "end");

  const unknown = repeatStillFrame();
  const untouched: Buffer[] = [];
  unknown.on("data", (chunk: Buffer) => untouched.push(chunk));
  const input = Buffer.concat([Buffer.from("HTTP garbage without a boundary\r\n\r\nxx"), part("late")]);
  unknown.write(input);
  t.mock.timers.runAll();
  unknown.end();
  await once(unknown, "end");
  assert.deepEqual(Buffer.concat(untouched), input);
});

test("a quiet stream re-sends its last part once; a new part cancels the repeat", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = repeatStillFrame();
  const out: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => out.push(chunk));
  stream.write(part("a"));
  stream.write(part("b"));
  t.mock.timers.runAll();
  assert.deepEqual(Buffer.concat(out), Buffer.concat([part("a"), part("b"), part("b")]));
  t.mock.timers.runAll();
  stream.end();
  await new Promise((resolve) => stream.once("end", resolve));
  assert.deepEqual(Buffer.concat(out), Buffer.concat([part("a"), part("b"), part("b")]));
});
