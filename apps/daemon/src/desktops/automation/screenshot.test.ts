import assert from "node:assert/strict";
import { test } from "node:test";

import { deviceImages } from "../../devices/image-pool.ts";
import { encodeDesktopScreenshot } from "./screenshot.ts";

test("a capture is fitted in the image workers: PNG at the long-edge bound, with the scale back to display pixels", async (t) => {
  t.after(() => deviceImages.close());
  const rgb = Buffer.alloc(64 * 32 * 3);
  // Left half red, right half blue.
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) rgb.set(x < 32 ? [255, 0, 0] : [0, 0, 255], (y * 64 + x) * 3);
  const shot = await encodeDesktopScreenshot({ width: 64, height: 32, rgb }, 32);
  assert.equal(shot.mimeType, "image/png");
  assert.deepEqual([shot.width, shot.height, shot.scale], [32, 16, 2]);
  assert.deepEqual(shot.data.subarray(1, 4).toString("latin1"), "PNG");

  const full = await encodeDesktopScreenshot({ width: 64, height: 32, rgb });
  assert.deepEqual([full.width, full.height, full.scale], [64, 32, 1], "never scaled up");
  await assert.rejects(encodeDesktopScreenshot({ width: 64, height: 32, rgb }, 0), RangeError);
});
