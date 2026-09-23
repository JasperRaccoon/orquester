/**
 * Putting a row back where the reader had it (design 2026-09-23 "Client":
 * "the viewport is kept stable across a prepend") — the one piece of the
 * timeline's anchoring that is arithmetic rather than DOM plumbing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrollRowTo } from "./anchor";

/** A scroller whose content starts at viewport y=`top` and is scrolled by `scrollTop`. */
function scroller(top: number, scrollTop: number) {
  return { scrollTop, getBoundingClientRect: () => ({ top }) };
}

/** A row laid out at content y=`contentTop` inside `host`. */
function rowAt(host: { scrollTop: number; getBoundingClientRect(): { top: number } }, contentTop: number) {
  return {
    getBoundingClientRect: () => ({ top: host.getBoundingClientRect().top + contentTop - host.scrollTop })
  };
}

describe("scrollRowTo", () => {
  it("sets the edge `offset` px into the row", () => {
    const host = scroller(50, 100);
    scrollRowTo(host, rowAt(host, 400), 30);
    assert.equal(host.scrollTop, 430, "the edge sits 30 px into a row that starts at 400");
  });

  it("leaves the row that far below the edge for a negative offset", () => {
    const host = scroller(0, 0);
    scrollRowTo(host, rowAt(host, 400), -16);
    assert.equal(host.scrollTop, 384);
  });

  it("absorbs a prepend: the anchored row returns to where it sat", () => {
    // Before: the row starts at 500 and the reader's edge is at 480, so it sat
    // 20 px below the edge (the anchor's signed offset is 480 − 500 = −20).
    const host = scroller(0, 480);
    // A 1 000 px page lands above it; the browser did not move the scroll.
    const row = rowAt(host, 1_500);
    scrollRowTo(host, row, -20);
    assert.equal(row.getBoundingClientRect().top - host.getBoundingClientRect().top, 20);
  });

  it("is idempotent where the browser already anchored natively", () => {
    // Native scroll anchoring already moved the scroll by the page's height.
    const host = scroller(0, 1_480);
    const row = rowAt(host, 1_500);
    scrollRowTo(host, row, -20);
    assert.equal(host.scrollTop, 1_480, "an absolute target never adds the shift twice");
  });
});
