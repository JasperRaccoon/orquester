/**
 * The timeline's follow rules (spec §7.3).
 *
 * The re-arm band itself is covered in `diff-tree.test.ts`; this file owns the
 * *motion* half — when a follow step glides and when it snaps — and the named
 * two-frame settle latch that keeps a list-identity change instant.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  armSettleLatch,
  IDLE_SETTLE_LATCH,
  isSettling,
  shouldAnimateFollow,
  tickSettleLatch,
  timelineListIdentity,
  TIMELINE_SETTLE_FRAMES
} from "./follow";

const animate = (over: Partial<Parameters<typeof shouldAnimateFollow>[0]> = {}): boolean =>
  shouldAnimateFollow({
    working: true,
    reducedMotion: false,
    firstPaint: false,
    settling: false,
    ...over
  });

describe("shouldAnimateFollow", () => {
  it("glides only for streamed growth inside an already-open thread", () => {
    assert.equal(animate(), true);
  });

  it("snaps when nothing is streaming", () => {
    assert.equal(animate({ working: false }), false);
  });

  it("snaps when the user prefers reduced motion, even mid-turn", () => {
    assert.equal(animate({ reducedMotion: true }), false);
    assert.equal(animate({ reducedMotion: true, settling: true }), false);
    assert.equal(animate({ reducedMotion: true, firstPaint: true }), false);
  });

  it("snaps before the first paint", () => {
    assert.equal(animate({ firstPaint: true }), false);
  });

  it("snaps while the list is settling — a thread switch never travels", () => {
    assert.equal(animate({ settling: true }), false);
  });
});

describe("the settle latch", () => {
  it("covers exactly two frames", () => {
    assert.equal(TIMELINE_SETTLE_FRAMES, 2);
    const identity = timelineListIdentity("s1");
    let latch = armSettleLatch(identity);
    assert.equal(isSettling(latch, identity), true);

    latch = tickSettleLatch(latch);
    assert.equal(isSettling(latch, identity), true, "still settling after one frame");

    latch = tickSettleLatch(latch);
    assert.equal(isSettling(latch, identity), false, "cleared after the second");
    assert.deepEqual(latch, IDLE_SETTLE_LATCH);
  });

  it("is idle by default and stays idle when ticked", () => {
    assert.equal(isSettling(IDLE_SETTLE_LATCH, timelineListIdentity("s1")), false);
    assert.equal(tickSettleLatch(IDLE_SETTLE_LATCH), IDLE_SETTLE_LATCH);
  });

  it("only settles the identity it was armed for", () => {
    const outgoing = timelineListIdentity("s1");
    const incoming = timelineListIdentity("s2");
    const latch = armSettleLatch(outgoing);
    assert.equal(isSettling(latch, outgoing), true);
    assert.equal(
      isSettling(latch, incoming),
      false,
      "a latch armed for the thread just left never affects the one arrived at"
    );
  });

  it("treats a drill-in as its own list", () => {
    const thread = timelineListIdentity("s1");
    const drillIn = timelineListIdentity("s1", "agent-7");
    assert.notEqual(thread, drillIn);
    assert.equal(isSettling(armSettleLatch(thread), drillIn), false);
    // A null agent id is the thread itself, not a third identity.
    assert.equal(timelineListIdentity("s1", null), thread);
  });

  it("re-arming restarts the two frames", () => {
    const identity = timelineListIdentity("s1");
    const latch = tickSettleLatch(armSettleLatch(identity));
    assert.equal(latch.frames, 1);
    assert.equal(armSettleLatch(identity).frames, TIMELINE_SETTLE_FRAMES);
  });
});
