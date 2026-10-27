import assert from "node:assert/strict";
import test from "node:test";

import { ANIMATIONS_OFF_SCRIPT, GUEST_SETTINGS_SCRIPT, waitForSettle } from "./golden.ts";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("settle: two quiet windows in a row, after the first-boot burst", async () => {
  const c = clock();
  const samples = [350, 280, 40, 120, 30, 20, 10];
  const seen: number[] = [];
  const settled = await waitForSettle(
    async () => {
      c.advance(10_000);
      return samples.shift() ?? 5;
    },
    { maxMs: 300_000, threshold: 60, now: c.now, onSample: (p) => seen.push(p) }
  );
  assert.equal(settled, true);
  assert.deepEqual(seen, [350, 280, 40, 120, 30, 20]);
});

test("settle: gives up after the limit (the snapshot is taken anyway); an exit fails it", async () => {
  const c = clock();
  assert.equal(await waitForSettle(async () => (c.advance(10_000), 300), { maxMs: 60_000, threshold: 60, now: c.now }), false);
  await assert.rejects(waitForSettle(async () => null, { maxMs: 60_000, threshold: 60 }), /exited/);
});

test("guest settings: animations off, screen never off, error dialogs hidden, stay awake", () => {
  for (const part of ["window_animation_scale 0", "transition_animation_scale 0", "animator_duration_scale 0", "screen_off_timeout 2147483647", "hide_error_dialogs 1", "svc power stayon true"]) {
    assert.ok(GUEST_SETTINGS_SCRIPT.includes(part), part);
  }
  assert.ok(ANIMATIONS_OFF_SCRIPT.includes("animator_duration_scale 0") && !ANIMATIONS_OFF_SCRIPT.includes("stayon"));
});
