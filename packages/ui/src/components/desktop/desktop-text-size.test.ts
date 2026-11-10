import test from "node:test";
import assert from "node:assert/strict";

import { textSizeDisplaySize } from "./desktop-text-size.ts";

test("presets scale the view's CSS size by 1, (1 + dpr) / 2 and dpr, rounded down to even", () => {
  const view = { width: 393, height: 701 };
  assert.deepEqual(textSizeDisplaySize("large", view, 3), { width: 392, height: 700 });
  assert.deepEqual(textSizeDisplaySize("medium", view, 3), { width: 786, height: 1402 });
  assert.deepEqual(textSizeDisplaySize("more", view, 3), { width: 1178, height: 2102 });
  assert.deepEqual(textSizeDisplaySize("medium", { width: 1024, height: 700 }, 1.5), { width: 1280, height: 874 });
});

test("presets stay inside the desktop size limits; fit and an empty view ask for nothing", () => {
  assert.deepEqual(textSizeDisplaySize("large", { width: 200, height: 100 }, 2), { width: 320, height: 240 });
  assert.deepEqual(textSizeDisplaySize("more", { width: 3000, height: 2000 }, 4), { width: 7680, height: 4320 });
  assert.equal(textSizeDisplaySize("fit", { width: 400, height: 800 }, 2), null);
  assert.equal(textSizeDisplaySize("more", { width: 0, height: 800 }, 2), null);
});
