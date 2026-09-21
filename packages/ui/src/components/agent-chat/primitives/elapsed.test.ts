import test from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, elapsedBetween } from "./elapsed.ts";

test("formatElapsed keeps bare seconds under a minute", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(9.9), "9s");
  assert.equal(formatElapsed(59), "59s");
});

test("formatElapsed pads the seconds once minutes appear, so the width is stable", () => {
  assert.equal(formatElapsed(60), "1m 00s");
  assert.equal(formatElapsed(64), "1m 04s");
  assert.equal(formatElapsed(3599), "59m 59s");
});

test("formatElapsed drops seconds past an hour and pads the minutes", () => {
  assert.equal(formatElapsed(3600), "1h 00m");
  assert.equal(formatElapsed(3600 + 5 * 60 + 59), "1h 05m");
  assert.equal(formatElapsed(36000), "10h 00m");
});

test("formatElapsed clamps a negative duration rather than rendering '-1s'", () => {
  assert.equal(formatElapsed(-5), "0s");
});

test("elapsedBetween accepts ISO stamps and epoch millis alike", () => {
  const start = "2026-09-21T10:00:00.000Z";
  assert.equal(elapsedBetween(start, "2026-09-21T10:01:04.000Z"), "1m 04s");
  assert.equal(elapsedBetween(Date.parse(start), Date.parse(start) + 42_000), "42s");
});

test("elapsedBetween measures against `now` when there is no end stamp", () => {
  const now = Date.parse("2026-09-21T10:00:30.000Z");
  assert.equal(elapsedBetween("2026-09-21T10:00:00.000Z", null, now), "30s");
});

test("elapsedBetween returns empty for missing or unparseable stamps", () => {
  // Reads four agent CLIs' timestamps: a bad one must shrink the row, never
  // print "NaNs" into it.
  assert.equal(elapsedBetween(null, null), "");
  assert.equal(elapsedBetween(undefined, null), "");
  assert.equal(elapsedBetween("not a date", null), "");
  assert.equal(elapsedBetween("2026-09-21T10:00:00.000Z", "also not a date"), "");
});
