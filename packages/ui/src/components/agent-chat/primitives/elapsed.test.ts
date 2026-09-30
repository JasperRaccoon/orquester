import test from "node:test";
import assert from "node:assert/strict";
import { elapsedBetween } from "./elapsed.ts";

test("elapsedBetween returns empty for missing or unparseable stamps", () => {
  // Reads four agent CLIs' timestamps: a bad one must shrink the row, never
  // print "NaNs" into it.
  assert.equal(elapsedBetween(null, null), "");
  assert.equal(elapsedBetween(undefined, null), "");
  assert.equal(elapsedBetween("not a date", null), "");
  assert.equal(elapsedBetween("2026-09-21T10:00:00.000Z", "also not a date"), "");
});
