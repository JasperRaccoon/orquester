import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { ImagePoolBusyError, ImageWorkerPool } from "./image-pool.ts";
import { DEVICE_SCREENSHOT_MAX_BASE64_CHARS, fitScreenshot, thumbnailJpeg } from "./screenshot-image.ts";
import { solidPng } from "./testing.ts";

/** A screen-like RGB PNG: gradients with noise (compresses like a real frame, unlike a solid fill). */
function screenPng(width: number, height: number, seed = 1): Buffer {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const band = Math.floor(y / 80) % 2 === 0 ? 30 : 0;
      raw[o] = Math.min(255, Math.floor((x / width) * 200) + band + Math.floor(random() * 24));
      raw[o + 1] = Math.min(255, Math.floor((y / height) * 200) + Math.floor(random() * 24));
      raw[o + 2] = Math.min(255, 120 + band + Math.floor(random() * 24));
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
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

test("the worker (a .ts entry under the daemon's tsx) encodes thumbnails and fits screenshots like the in-thread code", async (t) => {
  const pool = new ImageWorkerPool({ size: 2 });
  t.after(() => pool.close());
  const png = screenPng(360, 640);
  assert.deepEqual(await pool.thumbnail("l1", png, 120), thumbnailJpeg(png, 120));
  const fitted = await pool.fit(png, 50_000);
  assert.deepEqual(fitted, fitScreenshot(png, 50_000));
  assert.equal(fitted.mimeType, "image/jpeg");
  const small = solidPng(10, 10);
  assert.deepEqual(await pool.fit(small, DEVICE_SCREENSHOT_MAX_BASE64_CHARS), { mimeType: "image/png", data: small, width: 10, height: 10 });
  // A JPEG passes through without a worker; a bad image fails its job only.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(await pool.thumbnail("l1", jpeg, 120), jpeg);
  await assert.rejects(pool.thumbnail("l1", Buffer.from("nope"), 120), /not a PNG/);
  assert.equal(jpegWidth(await pool.thumbnail("l1", png, 120)), 120);
  assert.ok(pool.stats().workers >= 1 && pool.stats().workers <= 2);
});

test("a newer frame of the same lease replaces its queued one (both callers get it); screenshots go first; the queue is capped", async (t) => {
  const pool = new ImageWorkerPool({ size: 1, queueCap: 2 });
  t.after(() => pool.close());
  const big = screenPng(720, 1280);
  const png = screenPng(200, 200, 7);
  const order: string[] = [];
  // The one worker is busy with this frame while the others queue.
  const busy = pool.thumbnail("busy", big, 320).then(() => order.push("busy"));
  const stale = pool.thumbnail("lease", png, 100).then((jpeg) => (order.push("stale"), jpeg));
  const fresh = pool.thumbnail("lease", png, 50).then((jpeg) => (order.push("fresh"), jpeg));
  const shot = pool.fit(png, 10_000).then((fitted) => (order.push("shot"), fitted));
  assert.equal(pool.stats().queued, 2, "the stale frame was folded into the newer one");
  await assert.rejects(pool.thumbnail("other", png, 100), ImagePoolBusyError);
  const [a, b] = await Promise.all([stale, fresh, shot, busy]);
  assert.equal(jpegWidth(a), 50, "the stale caller gets the newer frame");
  assert.deepEqual(a, b);
  assert.deepEqual(order, ["busy", "shot", "stale", "fresh"]);
});

test("a job past its deadline ends its worker and fails; the next job gets a fresh worker", async (t) => {
  const pool = new ImageWorkerPool({ size: 1, jobTimeoutMs: 1 });
  t.after(() => pool.close());
  await assert.rejects(pool.thumbnail("l1", screenPng(720, 1280), 320), /longer than/);
  const relaxed = new ImageWorkerPool({ size: 1 });
  t.after(() => relaxed.close());
  assert.equal(jpegWidth(await relaxed.thumbnail("l1", screenPng(64, 64), 32)), 32);
  assert.equal(pool.stats().workers, 0);
});

test("event-loop blocking: a 720×1280 frame in-thread vs through the workers", async (t) => {
  const frame = screenPng(720, 1280);
  const pool = new ImageWorkerPool({ size: 2 });
  t.after(() => pool.close());
  // Warm both paths (JIT, the worker's start-up).
  thumbnailJpeg(frame, 320);
  await pool.thumbnail("warm", frame, 320);

  const measure = async (work: () => Promise<unknown>): Promise<{ maxMs: number; wallMs: number }> => {
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    const started = performance.now();
    await work();
    const wallMs = performance.now() - started;
    // Let the monitor sample once after the work.
    await new Promise((resolve) => setTimeout(resolve, 20));
    histogram.disable();
    return { maxMs: histogram.max / 1e6, wallMs };
  };
  const frames = 4;
  const inThread = await measure(async () => {
    for (let index = 0; index < frames; index += 1) {
      thumbnailJpeg(frame, 320);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  const offThread = await measure(() => Promise.all(Array.from({ length: frames }, (_, index) => pool.thumbnail(`l${index}`, frame, 320))));
  t.diagnostic(`in-thread: ${frames} frames, max event-loop delay ${inThread.maxMs.toFixed(1)} ms, wall ${inThread.wallMs.toFixed(0)} ms`);
  t.diagnostic(`workers:   ${frames} frames, max event-loop delay ${offThread.maxMs.toFixed(1)} ms, wall ${offThread.wallMs.toFixed(0)} ms`);
  assert.ok(offThread.maxMs < inThread.maxMs / 2, `the workers keep the loop free (${offThread.maxMs.toFixed(1)} ms vs ${inThread.maxMs.toFixed(1)} ms)`);
});
