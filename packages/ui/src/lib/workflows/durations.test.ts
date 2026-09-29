import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalDuration,
  convertDuration,
  displayUnitFor,
  formatDurationIn,
  formatMinutes,
  formatSeconds,
  formatUnitCount
} from "./durations.ts";

describe("formatMinutes / formatSeconds", () => {
  it("reads whole units plainly", () => {
    assert.equal(formatMinutes(240), "4 h");
    assert.equal(formatMinutes(30), "30 min");
    assert.equal(formatMinutes(1440), "1 day");
    assert.equal(formatMinutes(10080), "7 days");
    assert.equal(formatSeconds(30), "30 s");
    assert.equal(formatSeconds(300), "5 min");
  });

  it("keeps every non-zero part", () => {
    assert.equal(formatMinutes(150), "2 h 30 min");
    assert.equal(formatMinutes(1500), "1 day 1 h");
    assert.equal(formatMinutes(10079), "6 days 23 h 59 min");
    assert.equal(formatSeconds(90), "1 min 30 s");
    assert.equal(formatMinutes(0.1), "6 s");
  });

  it("reads zero in its own unit and refuses nonsense", () => {
    assert.equal(formatMinutes(0), "0 min");
    assert.equal(formatSeconds(0), "0 s");
    assert.equal(formatMinutes(-1), "");
    assert.equal(formatMinutes(Number.NaN), "");
  });

  it("formats a count in one unit", () => {
    assert.equal(formatUnitCount(1.5, "hours"), "1.5 h");
    assert.equal(formatUnitCount(1, "days"), "1 day");
    assert.equal(formatUnitCount(2, "days"), "2 days");
    assert.equal(formatDurationIn(2, "hours"), "2 h");
  });
});

describe("convertDuration", () => {
  it("converts between units without float noise", () => {
    assert.equal(convertDuration(4, "hours", "minutes"), 240);
    assert.equal(convertDuration(0.1, "hours", "minutes"), 6);
    assert.equal(convertDuration(90, "minutes", "hours"), 1.5);
    assert.equal(convertDuration(7, "days", "minutes"), 10080);
    assert.equal(convertDuration(5, "minutes", "seconds"), 300);
  });
});

describe("displayUnitFor", () => {
  const MIN_H_DAYS = ["minutes", "hours", "days"] as const;

  it("picks the largest offered unit that holds the value whole", () => {
    assert.equal(displayUnitFor(240, "minutes", MIN_H_DAYS), "hours");
    assert.equal(displayUnitFor(90, "minutes", MIN_H_DAYS), "minutes");
    assert.equal(displayUnitFor(2880, "minutes", MIN_H_DAYS), "days");
    assert.equal(displayUnitFor(2880, "minutes", ["minutes", "hours"]), "hours");
    assert.equal(displayUnitFor(300, "seconds", ["seconds", "minutes"]), "minutes");
  });

  it("falls back to the canonical unit, else the smallest offered", () => {
    assert.equal(displayUnitFor(undefined, "minutes", MIN_H_DAYS), "minutes");
    assert.equal(displayUnitFor(0, "minutes", MIN_H_DAYS), "minutes");
    assert.equal(displayUnitFor(0.1, "minutes", MIN_H_DAYS), "minutes");
    assert.equal(displayUnitFor(undefined, "minutes", ["hours", "days"]), "hours");
    assert.equal(displayUnitFor(90, "minutes", ["hours", "days"]), "hours");
  });
});

describe("canonicalDuration", () => {
  it("converts typed values to the canonical unit without float noise", () => {
    assert.equal(canonicalDuration(0.5, "hours", "minutes"), 30);
    assert.equal(canonicalDuration(0.1, "hours", "minutes"), 6);
    assert.equal(canonicalDuration(1 / 3, "hours", "minutes"), 20);
    assert.equal(canonicalDuration(1.5, "minutes", "seconds"), 90);
  });

  it("clamps in the canonical unit, never at a converted bound", () => {
    // 0 h with a 1 min floor stores 1 min exactly (the converted floor would be 0.016667 h → 1.00002 min).
    assert.equal(canonicalDuration(0, "hours", "minutes", 1, 1440), 1);
    assert.equal(canonicalDuration(30, "hours", "minutes", 1, 1440), 1440);
    assert.equal(canonicalDuration(2, "days", "minutes", 1, 10080), 2880);
    assert.equal(canonicalDuration(-4, "seconds", "seconds", 0, 3600), 0);
  });
});
