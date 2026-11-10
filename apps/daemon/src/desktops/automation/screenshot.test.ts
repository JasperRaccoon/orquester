import assert from "node:assert/strict";
import { test } from "node:test";

import { deviceImages } from "../../devices/image-pool.ts";
import { encodeDesktopScreenshot } from "./screenshot.ts";

const FORMAT = { byteOrder: "lsb", redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff } as const;

/** 64×32 BGRX pixels on an ArrayBuffer of their own, as the engine captures them: left half red, right half blue. */
function capture(): { width: number; height: number; pixels: Buffer; format: typeof FORMAT } {
  const pixels = Buffer.allocUnsafeSlow(64 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) pixels.writeUInt32LE(x < 32 ? 0xff0000 : 0x0000ff, (y * 64 + x) * 4);
  return { width: 64, height: 32, pixels, format: FORMAT };
}

test("a capture's raw pixels are handed to the image workers (not copied) and fitted there: PNG at the long-edge bound, with the scale back to display pixels", async (t) => {
  t.after(() => deviceImages.close());
  const raw = capture();
  const shot = await encodeDesktopScreenshot(raw, 32);
  assert.equal(shot.mimeType, "image/png");
  assert.deepEqual([shot.width, shot.height, shot.scale], [32, 16, 2]);
  assert.deepEqual(shot.data.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(raw.pixels.buffer.byteLength, 0, "transferred to the worker");

  const full = await encodeDesktopScreenshot(capture());
  assert.deepEqual([full.width, full.height, full.scale], [64, 32, 1], "never scaled up");
  await assert.rejects(encodeDesktopScreenshot(capture(), 0), RangeError);
});
