import test from "node:test";
import assert from "node:assert/strict";
import { elapsedBetween } from "./elapsed.ts";

test("elapsedBetween accepts ISO stamps and epoch millis alike", () => {
  const start = "2026-09-21T10:00:00.000Z";
  assert.equal(elapsedBetween(start, "2026-09-21T10:01:04.000Z"), "1m 04s");
  assert.equal(elapsedBetween(Date.parse(start), Date.parse(start) + 42_000), "42s");
});

test("elapsedBetween measures against `now` when there is no end stamp", (context) => {
  const now = Date.parse("2026-09-21T10:00:30.000Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  assert.equal(elapsedBetween("2026-09-21T10:00:00.000Z", null), "30s");
});

test("elapsedBetween returns empty for missing or unparseable stamps", () => {
  // Reads four agent CLIs' timestamps: a bad one must shrink the row, never
  // print "NaNs" into it.
  assert.equal(elapsedBetween(null, null), "");
  assert.equal(elapsedBetween(undefined, null), "");
  assert.equal(elapsedBetween("not a date", null), "");
  assert.equal(elapsedBetween("2026-09-21T10:00:00.000Z", "also not a date"), "");
});
