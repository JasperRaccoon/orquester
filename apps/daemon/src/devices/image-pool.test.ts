import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { ImagePoolBusyError, ImageWorkerPool, type ImageWorkerRequest } from "./image-pool.ts";
import { DEVICE_SCREENSHOT_MAX_BASE64_CHARS } from "./screenshot-image.ts";
import { solidPng } from "./testing.ts";

/** An RGB PNG whose noise forces the capped screenshot down the JPEG path. */
function screenPng(width: number, height: number): Buffer {
  let seed = 7;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 1; x <= width * 3; x += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      raw[y * (width * 3 + 1) + x] = seed >>> 16;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function jpegWidth(jpeg: Buffer): number {
  for (let i = 2; i < jpeg.length - 9; i += 1) if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) return jpeg.readUInt16BE(i + 7);
  throw new Error("no SOF0");
}

test("the real worker loads through tsx and returns usable thumbnail and capped screenshot bytes", async (t) => {
  const pool = new ImageWorkerPool();
  t.after(() => pool.close());
  const png = screenPng(128, 96);
  assert.equal(jpegWidth(await pool.thumbnail("l1", png, 32)), 32);
  const fitted = await pool.fit(png, 2_000);
  assert.equal(fitted.mimeType, "image/jpeg");
  assert.ok(fitted.data.toString("base64").length <= 2_000);
  assert.equal(jpegWidth(fitted.data), fitted.width);
  assert.ok(fitted.width < 128 && fitted.width * 96 === fitted.height * 128);
  const small = solidPng(10, 10);
  assert.deepEqual(await pool.fit(small, DEVICE_SCREENSHOT_MAX_BASE64_CHARS), { mimeType: "image/png", data: small, width: 10, height: 10 });
  await assert.rejects(pool.thumbnail("l1", Buffer.from("nope"), 32), /not a PNG/);
  assert.equal(jpegWidth(await pool.thumbnail("l1", png, 32)), 32, "a bad input does not poison the worker");
});

test("a newer frame of the same lease replaces its queued one (both callers get it); screenshots go first; the queue is capped", async (t) => {
  const pool = new ImageWorkerPool();
  t.after(() => pool.close());
  const send = Worker.prototype.postMessage;
  type Delivery = { worker: Worker; message: ImageWorkerRequest };
  const held: Delivery[] = [];
  let onDelivery: ((delivery: Delivery) => void) | undefined;
  let blocked = true;
  t.mock.method(Worker.prototype, "postMessage", function (this: Worker, message: ImageWorkerRequest) {
    if (blocked) {
      const delivery = { worker: this, message };
      held.push(delivery);
      onDelivery?.(delivery);
    } else send.call(this, message);
  });
  const png = solidPng(8, 8);
  const busy = [pool.thumbnail("busy-a", png, 8), pool.thumbnail("busy-b", png, 8)];
  let staleResolved = false;
  const stale = pool.thumbnail("lease", png, 8).then((image) => { staleResolved = true; return image; });
  const fresh = pool.thumbnail("lease", png, 4);
  let shotResolved = false;
  const shot = pool.fit(png, 4_096).then((image) => { shotResolved = true; return image; });
  const fillers = Array.from({ length: 30 }, () => pool.fit(png, 4_096));
  const completion = Promise.all([stale, fresh, shot, ...busy, ...fillers]);
  void completion.catch(() => undefined);
  let refusal: unknown;
  void pool.thumbnail("other", png, 8).catch((error) => { refusal = error; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(refusal instanceof ImagePoolBusyError, "the 33rd waiting job is refused");
  const first = held.shift()!;
  const nextReady = new Promise<Delivery>((resolve) => { onDelivery = resolve; });
  send.call(first.worker, first.message);
  await busy[0];
  const next = await nextReady;
  onDelivery = undefined;
  held.splice(held.indexOf(next), 1);
  const answered = once(next.worker, "message");
  send.call(next.worker, next.message);
  await answered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shotResolved, true, "the screenshot is answered before the waiting thumbnail");
  assert.equal(staleResolved, false);
  blocked = false;
  for (const { worker, message } of held) send.call(worker, message);
  await completion;
  const [a, b] = await Promise.all([stale, fresh]);
  assert.equal(jpegWidth(a), 4, "the stale caller gets the newer frame");
  assert.deepEqual(a, b);
});

test("a job past its 30 s deadline fails, retires its worker, and lets the next job recover", async (t) => {
  const pool = new ImageWorkerPool();
  t.after(() => pool.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let worker!: Worker;
  const gate = t.mock.method(Worker.prototype, "postMessage", function (this: Worker) { worker = this; });
  let settled = false;
  const job = pool.thumbnail("stalled", solidPng(8, 8), 8);
  void job.then(() => { settled = true; }, () => { settled = true; });
  const failed = assert.rejects(job, /30 s/);
  const exited = once(worker, "exit");
  t.mock.timers.tick(29_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a job is allowed the documented deadline");
  t.mock.timers.tick(1);
  await failed;
  await exited;
  gate.mock.restore();
  assert.equal(jpegWidth(await pool.thumbnail("next", solidPng(8, 8), 8)), 8);
});
