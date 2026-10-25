import test from "node:test";
import assert from "node:assert/strict";

import { exitPoint } from "./desktop-pointer.ts";

const rect = { left: 100, top: 50, right: 900, bottom: 650 };

test("a mouse leaving over an edge parks the pointer on that edge's last pixel", () => {
  assert.deepEqual(exitPoint(rect, 400, 20), { x: 400, y: 50 }); // up, onto the toolbar
  assert.deepEqual(exitPoint(rect, 40, 300), { x: 100, y: 300 }); // left
  assert.deepEqual(exitPoint(rect, 950, 700), { x: 899, y: 649 }); // past the bottom-right corner
});

test("a point already inside stays put", () => {
  assert.deepEqual(exitPoint(rect, 500, 400), { x: 500, y: 400 });
});
