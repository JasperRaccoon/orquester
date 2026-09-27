import test from "node:test";
import assert from "node:assert/strict";

import {
  RIGHT_RAIL_BAR_WIDTH,
  RIGHT_RAIL_CONTENT_MIN,
  RIGHT_RAIL_CSS_MAX_WIDTH,
  RIGHT_RAIL_CSS_MIN_WIDTH,
  RIGHT_RAIL_DEFAULT_STATE,
  RIGHT_RAIL_STORAGE_KEY,
  RIGHT_RAIL_WIDTH_DEFAULT,
  RIGHT_RAIL_WIDTH_MAX,
  RIGHT_RAIL_WIDTH_MIN,
  __resetRightRailStoreForTests,
  clampRightRailWidth,
  loadRightRailState,
  parseRightRailState,
  resetRightRailWidth,
  rightRailState,
  rightRailWidthCap,
  saveRightRailState,
  serializeRightRailState,
  setRightRailOpen,
  setRightRailSheetPanel,
  setRightRailWidth,
  subscribeRightRail,
  toggleRightRailPanel,
  type RightRailStorage
} from "./right-rail-state.ts";

/** An in-memory `localStorage` stand-in that counts writes. */
function memoryStorage(initial?: string): RightRailStorage & { value: string | null; writes: number } {
  const store = {
    value: initial ?? null,
    writes: 0,
    getItem(key: string): string | null {
      return key === RIGHT_RAIL_STORAGE_KEY ? store.value : null;
    },
    setItem(key: string, value: string): void {
      assert.equal(key, RIGHT_RAIL_STORAGE_KEY);
      store.value = value;
      store.writes += 1;
    }
  };
  return store;
}

/** A storage that refuses everything, like a locked-down browser profile. */
const hostileStorage: RightRailStorage = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  }
};

// ---------------------------------------------------------------------------
// Parsing: field by field, never a throw
// ---------------------------------------------------------------------------

test("nothing stored, or garbage stored, loads the defaults", () => {
  for (const raw of [null, undefined, "", "not json", "{", "null", "[]", "42", '"prompts"', "true"]) {
    assert.deepEqual(parseRightRailState(raw), RIGHT_RAIL_DEFAULT_STATE, `raw ${String(raw)}`);
  }
  assert.deepEqual(RIGHT_RAIL_DEFAULT_STATE, { open: null, width: RIGHT_RAIL_WIDTH_DEFAULT, sheet: "prompts" });
});

test("a well-formed payload round-trips", () => {
  const state = { open: "history", width: 412, sheet: "history" } as const;
  assert.equal(serializeRightRailState(state), '{"v":1,"open":"history","width":412,"sheet":"history"}');
  assert.deepEqual(parseRightRailState(serializeRightRailState(state)), state);
  assert.deepEqual(parseRightRailState(serializeRightRailState(RIGHT_RAIL_DEFAULT_STATE)), RIGHT_RAIL_DEFAULT_STATE);
});

test("each field is validated on its own: one bad field never costs the others", () => {
  assert.deepEqual(parseRightRailState('{"v":1,"open":"files","width":400,"sheet":"history"}'), {
    open: null,
    width: 400,
    sheet: "history"
  });
  assert.deepEqual(parseRightRailState('{"v":1,"open":"prompts","width":"wide","sheet":7}'), {
    open: "prompts",
    width: RIGHT_RAIL_WIDTH_DEFAULT,
    sheet: "prompts"
  });
  // Missing fields take their defaults; an explicit null `open` is a closed dock.
  assert.deepEqual(parseRightRailState('{"width":300}'), { open: null, width: 300, sheet: "prompts" });
  assert.deepEqual(parseRightRailState('{"open":null,"sheet":"history"}'), {
    open: null,
    width: RIGHT_RAIL_WIDTH_DEFAULT,
    sheet: "history"
  });
  for (const open of ["true", "1", '"History"', '{"id":"prompts"}', '["prompts"]']) {
    assert.equal(parseRightRailState(`{"open":${open}}`).open, null, `open ${open}`);
  }
});

test("a stored width is clamped into range, and a nonsensical one is dropped", () => {
  const width = (value: string): number => parseRightRailState(`{"width":${value}}`).width;
  assert.equal(width("10"), RIGHT_RAIL_WIDTH_MIN, "too narrow → the minimum");
  assert.equal(width("9999"), RIGHT_RAIL_WIDTH_MAX, "too wide → the maximum");
  assert.equal(width("1e308"), RIGHT_RAIL_WIDTH_MAX);
  assert.equal(width("300.6"), 301, "rounded to whole pixels");
  for (const bad of ["0", "-40", "null", '"400"', "true", "[400]", "{}"]) {
    assert.equal(width(bad), RIGHT_RAIL_WIDTH_DEFAULT, `width ${bad}`);
  }
});

test("a payload written by another version is still read field by field", () => {
  // A rollback after a newer bundle wrote `v: 2` keeps whatever still validates.
  assert.deepEqual(parseRightRailState('{"v":2,"open":"history","width":480,"extra":{"a":1}}'), {
    open: "history",
    width: 480,
    sheet: "prompts"
  });
  assert.deepEqual(parseRightRailState('{"v":"one","open":"prompts"}').open, "prompts");
});

// ---------------------------------------------------------------------------
// Clamping against the row
// ---------------------------------------------------------------------------

test("the width cap leaves the tab content its floor, even below the dock's minimum", () => {
  const reserve = RIGHT_RAIL_BAR_WIDTH + RIGHT_RAIL_CONTENT_MIN;
  for (const row of [undefined, null, Number.NaN, 0, -100, Number.POSITIVE_INFINITY]) {
    assert.equal(rightRailWidthCap(row), RIGHT_RAIL_WIDTH_MAX, `row ${String(row)}`);
  }
  assert.equal(rightRailWidthCap(2000), RIGHT_RAIL_WIDTH_MAX, "a wide row is capped by the maximum");
  assert.equal(rightRailWidthCap(800), 800 - reserve, "a mid row by the content floor");
  // The 768px breakpoint beside a 256px sidebar: the content keeps its 360px.
  assert.equal(rightRailWidthCap(512), 512 - reserve, "the content's floor wins over the dock's minimum");
  assert.equal(rightRailWidthCap(300), 0, "and a row with no room left gets no dock at all");
  assert.equal(rightRailWidthCap(800.9), 396, "whole pixels, rounded down");
});

test("the CSS bounds are the cap's rule, resolved against the row by the browser", () => {
  const reserve = RIGHT_RAIL_BAR_WIDTH + RIGHT_RAIL_CONTENT_MIN;
  assert.equal(RIGHT_RAIL_CSS_MIN_WIDTH, `max(0px, min(${RIGHT_RAIL_WIDTH_MIN}px, 100% - ${reserve}px))`);
  assert.equal(RIGHT_RAIL_CSS_MAX_WIDTH, `max(0px, min(${RIGHT_RAIL_WIDTH_MAX}px, 100% - ${reserve}px))`);
});

test("clamping rounds, bounds and caps against the row", () => {
  assert.equal(clampRightRailWidth(333.4), 333);
  assert.equal(clampRightRailWidth(100), RIGHT_RAIL_WIDTH_MIN);
  assert.equal(clampRightRailWidth(-5), RIGHT_RAIL_WIDTH_MIN);
  assert.equal(clampRightRailWidth(900), RIGHT_RAIL_WIDTH_MAX);
  assert.equal(clampRightRailWidth(500, 800), 800 - RIGHT_RAIL_BAR_WIDTH - RIGHT_RAIL_CONTENT_MIN);
  assert.equal(clampRightRailWidth(300, 800), 300, "inside the cap it is left alone");
  assert.equal(clampRightRailWidth(300, 512), 108, "a row too narrow for the minimum: the cap alone");
  assert.equal(clampRightRailWidth(Number.NaN), RIGHT_RAIL_WIDTH_DEFAULT);
  assert.equal(clampRightRailWidth(Number.POSITIVE_INFINITY), RIGHT_RAIL_WIDTH_DEFAULT);
  assert.equal(clampRightRailWidth(Number.NaN, 600), 196, "the fallback is capped too");
});

// ---------------------------------------------------------------------------
// Storage: errors are swallowed
// ---------------------------------------------------------------------------

test("load and save swallow storage errors and missing storage", () => {
  assert.deepEqual(loadRightRailState(hostileStorage), RIGHT_RAIL_DEFAULT_STATE);
  assert.deepEqual(loadRightRailState(null), RIGHT_RAIL_DEFAULT_STATE);
  assert.doesNotThrow(() => saveRightRailState(RIGHT_RAIL_DEFAULT_STATE, hostileStorage));
  assert.doesNotThrow(() => saveRightRailState(RIGHT_RAIL_DEFAULT_STATE, null));
  const storage = memoryStorage('{"v":1,"open":"prompts","width":350,"sheet":"history"}');
  assert.deepEqual(loadRightRailState(storage), { open: "prompts", width: 350, sheet: "history" });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("the store loads once from storage, lazily", () => {
  const storage = memoryStorage('{"v":1,"open":"history","width":300,"sheet":"history"}');
  __resetRightRailStoreForTests({ storage });
  assert.deepEqual(rightRailState(), { open: "history", width: 300, sheet: "history" });
  storage.value = '{"v":1,"open":"prompts"}';
  assert.equal(rightRailState().open, "history", "an in-memory state is not re-read");
  assert.equal(storage.writes, 0, "reading never writes");
});

test("toggling opens, switches and closes the dock — and persists every change", () => {
  const storage = memoryStorage();
  __resetRightRailStoreForTests({ storage });
  toggleRightRailPanel("prompts");
  assert.equal(rightRailState().open, "prompts");
  assert.equal(JSON.parse(storage.value!).open, "prompts");
  toggleRightRailPanel("history");
  assert.equal(rightRailState().open, "history", "the other button switches");
  toggleRightRailPanel("history");
  assert.equal(rightRailState().open, null, "the active button closes");
  assert.equal(JSON.parse(storage.value!).open, null);
  assert.equal(storage.writes, 3);
  setRightRailOpen("prompts");
  assert.equal(rightRailState().open, "prompts");
  assert.equal(storage.writes, 4);
});

test("a live drag updates the state only; the release persists it", () => {
  const storage = memoryStorage();
  __resetRightRailStoreForTests({ storage });
  setRightRailWidth(400, { persist: false });
  setRightRailWidth(420, { persist: false });
  assert.equal(rightRailState().width, 420);
  assert.equal(storage.writes, 0, "no write per frame");
  setRightRailWidth(420, { persist: true });
  assert.equal(storage.writes, 1, "the release writes even when the preview already holds the value");
  assert.equal(JSON.parse(storage.value!).width, 420);
  setRightRailWidth(700, { persist: true, rowWidth: 900 });
  assert.equal(rightRailState().width, 900 - RIGHT_RAIL_BAR_WIDTH - RIGHT_RAIL_CONTENT_MIN, "capped by the row");
  // A row too narrow for the minimum draws the dock narrower; it never stores less.
  setRightRailWidth(480, { persist: true, rowWidth: 512 });
  assert.equal(rightRailState().width, RIGHT_RAIL_WIDTH_MIN);
  assert.equal(JSON.parse(storage.value!).width, RIGHT_RAIL_WIDTH_MIN);
  resetRightRailWidth();
  assert.equal(rightRailState().width, RIGHT_RAIL_WIDTH_DEFAULT, "double-click resets");
  assert.equal(JSON.parse(storage.value!).width, RIGHT_RAIL_WIDTH_DEFAULT);
});

test("the mobile sheet remembers its last tab", () => {
  const storage = memoryStorage();
  __resetRightRailStoreForTests({ storage });
  setRightRailSheetPanel("history");
  assert.equal(rightRailState().sheet, "history");
  assert.equal(JSON.parse(storage.value!).sheet, "history");
  assert.equal(rightRailState().open, null, "without opening the desktop dock");
});

test("subscribers hear real changes only, and can unsubscribe", () => {
  __resetRightRailStoreForTests({ storage: memoryStorage() });
  let calls = 0;
  const unsubscribe = subscribeRightRail(() => {
    calls += 1;
  });
  const before = rightRailState();
  toggleRightRailPanel("prompts");
  assert.equal(calls, 1);
  assert.notEqual(rightRailState(), before, "a new snapshot object per change");
  const same = rightRailState();
  setRightRailOpen("prompts");
  setRightRailWidth(RIGHT_RAIL_WIDTH_DEFAULT, { persist: true });
  assert.equal(calls, 1, "a no-op change notifies nobody");
  assert.equal(rightRailState(), same, "and keeps the snapshot identity (useSyncExternalStore)");
  unsubscribe();
  toggleRightRailPanel("prompts");
  assert.equal(calls, 1);
});

test("a storage that throws never breaks the store", () => {
  __resetRightRailStoreForTests({ storage: hostileStorage });
  assert.deepEqual(rightRailState(), RIGHT_RAIL_DEFAULT_STATE);
  assert.doesNotThrow(() => toggleRightRailPanel("history"));
  assert.equal(rightRailState().open, "history", "the change still lands in memory");
  assert.doesNotThrow(() => setRightRailWidth(480, { persist: true }));
  assert.equal(rightRailState().width, 480);
});
