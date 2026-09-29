import assert from "node:assert/strict";
import { afterEach,beforeEach,describe,it } from "node:test";

import { type RememberedTimelinePosition } from "./contracts";
import {
EMPTY_DISCLOSURE_STATE,
parseDisclosureState,
parseRememberedPosition,
parseTimelinePositions,
TimelinePositionStore
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

const storageKey = "orquester:agent-chat-timeline-positions";
let saved: Map<string, string>;
let originalStorage: PropertyDescriptor | undefined;
beforeEach(() => {
  saved = new Map();
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) }
  });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the LRU", () => {
  it("evicts the oldest past the limit", () => {
    const store = new TimelinePositionStore();
    for (let index = 0; index < 105; index += 1) {
      store.remember(`s${index}`, position());
    }
    assert.equal(JSON.parse(saved.get(storageKey)!).length, 100);
    assert.equal(store.read("s0"), undefined);
    assert.ok(store.read("s104"));
  });

  it("delete-then-set moves an entry to the end so it survives eviction", () => {
    const store = new TimelinePositionStore();
    store.remember("keep", position());
    for (let index = 0; index < 99; index += 1) {
      store.remember(`s${index}`, position());
    }
    // Touch it again: it moves to the end of the insertion order.
    store.remember("keep", position({ scrollOffset: 99 }));
    store.remember("one-more", position());
    assert.equal(store.read("keep")?.scrollOffset, 99);
    assert.equal(store.read("s0"), undefined, "the oldest went instead");
  });

  it("persists as an ordered array, and replaying it rebuilds the same order", () => {
    const store = new TimelinePositionStore();
    store.remember("a", position());
    store.remember("b", position());
    const restored = parseTimelinePositions(saved.get(storageKey) ?? null);
    assert.deepEqual([...restored.keys()], ["a", "b"]);
  });

  it("forgets a thread", () => {
    const store = new TimelinePositionStore();
    store.remember("a", position());
    store.forget("a");
    assert.equal(store.read("a"), undefined);
    assert.deepEqual(JSON.parse(saved.get(storageKey)!), []);
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
    assert.deepEqual(parsed?.disclosures, {
      expandedTurnIds: [], expandedGroupIds: [], expandedAgentIds: [], expandedReasoningIds: [], toolOutputOffsets: {}
    });
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
    const rows = Array.from({ length: 110 }, (_, index) => [
      `s${index}`,
      position()
    ]);
    assert.equal(parseTimelinePositions(JSON.stringify(rows)).size, 100);
  });
});
