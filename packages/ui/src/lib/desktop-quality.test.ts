import test from "node:test";
import assert from "node:assert/strict";

import { initialDesktopQuality, nextDesktopQuality, type DesktopQualityState } from "./desktop-quality.ts";

function feed(state: DesktopQualityState, samples: number[]): DesktopQualityState {
  return samples.reduce(nextDesktopQuality, state);
}

test("starts at quality 6", () => {
  assert.equal(initialDesktopQuality().level, 6);
});

test("3 consecutive slow samples step down one level", () => {
  const s = initialDesktopQuality();
  assert.equal(feed(s, [200, 200]).level, 6);
  assert.equal(feed(s, [200, 200, 200]).level, 4);
});

test("steps 6 → 4 → 2 and stops at 2", () => {
  const slow = Array<number>(3).fill(400);
  let s = initialDesktopQuality();
  s = feed(s, slow);
  assert.equal(s.level, 4);
  s = feed(s, slow);
  assert.equal(s.level, 2);
  s = feed(s, [...slow, ...slow]);
  assert.equal(s.level, 2);
});

test("the thresholds are strict: exactly 150 ms is not slow, exactly 50 ms is not fast", () => {
  const s = initialDesktopQuality();
  assert.equal(feed(s, [150, 150, 150]).level, 6);
  const low: DesktopQualityState = { level: 2, highStreak: 0, lowStreak: 0 };
  assert.equal(feed(low, [50, 50, 50, 50, 50]).level, 2);
});

test("a sample in between breaks the streak", () => {
  const s = initialDesktopQuality();
  assert.equal(feed(s, [200, 200, 100, 200, 200]).level, 6);
  const low: DesktopQualityState = { level: 2, highStreak: 0, lowStreak: 0 };
  assert.equal(feed(low, [10, 10, 10, 10, 80, 10]).level, 2);
});

test("5 consecutive fast samples step up one level, up to 6", () => {
  let s: DesktopQualityState = { level: 2, highStreak: 0, lowStreak: 0 };
  s = feed(s, [10, 10, 10, 10]);
  assert.equal(s.level, 2);
  s = feed(s, [10]);
  assert.equal(s.level, 4);
  s = feed(s, Array<number>(5).fill(10));
  assert.equal(s.level, 6);
  s = feed(s, Array<number>(10).fill(10));
  assert.equal(s.level, 6);
});

test("a slow sample resets the fast streak and vice versa", () => {
  const s: DesktopQualityState = { level: 4, highStreak: 0, lowStreak: 0 };
  assert.equal(feed(s, [10, 10, 10, 10, 300, 10]).level, 4);
  assert.equal(feed(s, [300, 300, 10, 300]).level, 4);
});
