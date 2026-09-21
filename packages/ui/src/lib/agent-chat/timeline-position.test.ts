import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TIMELINE_POSITION_LRU_LIMIT, type RememberedTimelinePosition } from "./contracts";
import {
  disclosureSets,
  EMPTY_DISCLOSURE_STATE,
  parseDisclosureState,
  parseRememberedPosition,
  parseTimelinePositions,
  resolveTimelineIsAtEnd,
  setToolOutputOffset,
  TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
  TimelinePositionStore,
  toggleDisclosure
} from "./timeline-position";

const position = (overrides: Partial<RememberedTimelinePosition> = {}): RememberedTimelinePosition => ({
  rowId: "r1",
  offsetWithinRow: 0,
  scrollOffset: 10,
  atEnd: true,
  disclosures: EMPTY_DISCLOSURE_STATE,
  interactionMode: "default",
  ...overrides
});

describe("the LRU", () => {
  it("evicts the oldest past the limit", () => {
    const store = new TimelinePositionStore({ persist: () => {} });
    for (let index = 0; index < TIMELINE_POSITION_LRU_LIMIT + 5; index += 1) {
      store.remember(`s${index}`, position());
    }
    assert.equal(store.size, TIMELINE_POSITION_LRU_LIMIT);
    assert.equal(store.read("s0"), undefined);
    assert.ok(store.read(`s${TIMELINE_POSITION_LRU_LIMIT + 4}`));
  });

  it("delete-then-set moves an entry to the end so it survives eviction", () => {
    const store = new TimelinePositionStore({ persist: () => {} });
    store.remember("keep", position());
    for (let index = 0; index < TIMELINE_POSITION_LRU_LIMIT - 1; index += 1) {
      store.remember(`s${index}`, position());
    }
    // Touch it again: it moves to the end of the insertion order.
    store.remember("keep", position({ scrollOffset: 99 }));
    store.remember("one-more", position());
    assert.equal(store.read("keep")?.scrollOffset, 99);
    assert.equal(store.read("s0"), undefined, "the oldest went instead");
  });

  it("persists as an ordered array, and replaying it rebuilds the same order", () => {
    let serialized = "";
    const store = new TimelinePositionStore({ persist: (value) => (serialized = value) });
    store.remember("a", position());
    store.remember("b", position());
    const restored = parseTimelinePositions(serialized);
    assert.deepEqual([...restored.keys()], ["a", "b"]);
  });

  it("forgets a thread", () => {
    const store = new TimelinePositionStore({ persist: () => {} });
    store.remember("a", position());
    store.forget("a");
    assert.equal(store.read("a"), undefined);
  });
});

describe("persisted-state validation", () => {
  it("degrades to nothing remembered on garbage, never a crash", () => {
    assert.equal(parseTimelinePositions(null).size, 0);
    assert.equal(parseTimelinePositions("not json").size, 0);
    assert.equal(parseTimelinePositions(JSON.stringify({ a: 1 })).size, 0);
    assert.equal(parseTimelinePositions(JSON.stringify([["a"], 7, [1, {}]])).size, 0);
  });

  it("keeps the valid rows of a partly-malformed payload", () => {
    const restored = parseTimelinePositions(
      JSON.stringify([
        ["good", position()],
        ["bad", "string"]
      ])
    );
    assert.deepEqual([...restored.keys()], ["good"]);
  });

  it("repairs a row an older bundle wrote with missing fields", () => {
    const parsed = parseRememberedPosition({ scrollOffset: "nope", interactionMode: "weird" });
    assert.equal(parsed?.rowId, null);
    assert.equal(parsed?.scrollOffset, 0);
    assert.equal(parsed?.atEnd, true);
    assert.equal(parsed?.interactionMode, "default");
    assert.deepEqual(parsed?.disclosures, EMPTY_DISCLOSURE_STATE);
  });

  it("drops non-string ids and non-numeric offsets from the disclosure set", () => {
    const parsed = parseDisclosureState({
      expandedTurnIds: ["t1", 7],
      toolOutputOffsets: { a: 10, b: "nope" }
    });
    assert.deepEqual(parsed.expandedTurnIds, ["t1"]);
    assert.deepEqual(parsed.toolOutputOffsets, { a: 10 });
  });

  it("caps a persisted payload that is already over the limit", () => {
    const rows = Array.from({ length: TIMELINE_POSITION_LRU_LIMIT + 10 }, (_, index) => [
      `s${index}`,
      position()
    ]);
    assert.equal(parseTimelinePositions(JSON.stringify(rows)).size, TIMELINE_POSITION_LRU_LIMIT);
  });
});

describe("disclosure helpers", () => {
  it("toggles a list entry", () => {
    const open = toggleDisclosure(EMPTY_DISCLOSURE_STATE, "expandedTurnIds", "t1");
    assert.deepEqual(open.expandedTurnIds, ["t1"]);
    assert.deepEqual(toggleDisclosure(open, "expandedTurnIds", "t1").expandedTurnIds, []);
  });

  it("keeps identity when an offset did not move", () => {
    const withOffset = setToolOutputOffset(EMPTY_DISCLOSURE_STATE, "r1", 12);
    assert.equal(setToolOutputOffset(withOffset, "r1", 12), withOffset);
  });

  it("projects the sets the row derivation reads", () => {
    const sets = disclosureSets({ ...EMPTY_DISCLOSURE_STATE, expandedGroupIds: ["g1"] });
    assert.ok(sets.expandedGroupIds.has("g1"));
  });
});

describe("live-follow re-arm band", () => {
  it("re-arms only inside the 40 px band", () => {
    const at = (gap: number) =>
      resolveTimelineIsAtEnd({ contentLength: 1000, scrollLength: 500, scroll: 500 - gap });
    assert.equal(at(0), true);
    assert.equal(at(TIMELINE_FOLLOW_REARM_THRESHOLD_PX), true);
    assert.equal(at(TIMELINE_FOLLOW_REARM_THRESHOLD_PX + 1), false);
  });

  it("falls back to the reported flag when a measurement is missing", () => {
    assert.equal(resolveTimelineIsAtEnd({ isAtEnd: true }), true);
    assert.equal(resolveTimelineIsAtEnd({}), undefined);
  });
});
