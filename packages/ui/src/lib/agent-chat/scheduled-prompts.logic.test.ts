import assert from "node:assert/strict";
import test from "node:test";

import { nextClockTime, parseDelay } from "./scheduled-prompts.logic.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("a typed delay reads in the forms people write it", () => {
  assert.equal(parseDelay("5m"), 5 * MINUTE);
  assert.equal(parseDelay("1h 24m"), HOUR + 24 * MINUTE);
  assert.equal(parseDelay("1h24m"), HOUR + 24 * MINUTE);
  assert.equal(parseDelay("2 hours and 5 minutes"), 2 * HOUR + 5 * MINUTE);
  assert.equal(parseDelay("1.5h"), 1.5 * HOUR);
  assert.equal(parseDelay("4:20"), 4 * HOUR + 20 * MINUTE);
  assert.equal(parseDelay("90"), 90 * MINUTE, "a bare number is minutes");
});

test("a delay that does not read is refused, never guessed", () => {
  for (const text of ["", "soon", "1h banana", "3 weeks", "0m", "4:75"]) {
    assert.equal(parseDelay(text), null, text);
  }
});

test("a clock time is the next time the clock reads it: later today, else tomorrow", () => {
  const now = new Date(2026, 9, 31, 0, 5);
  assert.deepEqual(nextClockTime("04:30", now), new Date(2026, 9, 31, 4, 30));
  assert.deepEqual(nextClockTime("00:05", now), new Date(2026, 10, 1, 0, 5), "now is already past: tomorrow");
  assert.equal(nextClockTime("25:00", now), null);
});
