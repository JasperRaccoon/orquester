import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadRightRailState, parseRightRailState, resetRightRailWidth, rightRailState, saveRightRailState, serializeRightRailState, setRightRailOpen, setRightRailWidth, subscribeRightRail, toggleRightRailPanel } from "./right-rail-state.ts";

const key = "orquester:right-rail";
const defaults = { open: null, width: 320 };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => stored.set(name, value)
    }
  });
  setRightRailOpen(null);
  resetRightRailWidth();
  stored.clear();
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const denyStorage = () => Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  get() { throw new Error("SecurityError"); }
});

test("nothing stored, or garbage stored, loads the defaults", () => {
  for (const raw of [null, undefined, "", "not json", "{", "null", "[]", "42", '"prompts"', "true"]) {
    assert.deepEqual(parseRightRailState(raw), defaults, `raw ${String(raw)}`);
  }
});

test("a well-formed payload round-trips", () => {
  assert.deepEqual(JSON.parse(serializeRightRailState({ open: "history", width: 412 })), {
    v: 1, open: "history", width: 412
  });
  assert.deepEqual(parseRightRailState('{"v":1,"open":"history","width":412}'), {
    open: "history", width: 412
  });
});

test("each field is validated on its own: one bad field never costs the others", () => {
  assert.deepEqual(parseRightRailState('{"v":1,"open":"files","width":400}'), { open: null, width: 400 });
  assert.deepEqual(parseRightRailState('{"v":1,"open":"prompts","width":"wide"}'), { open: "prompts", width: 320 });
  assert.deepEqual(parseRightRailState('{"width":300}'), { open: null, width: 300 });
  assert.deepEqual(parseRightRailState('{"open":null}'), defaults);
  assert.deepEqual(parseRightRailState('{"v":1,"open":"history","width":400,"sheet":"history"}'), { open: "history", width: 400 });
  for (const open of ["true", "1", '"History"', '"Workflows"', '{"id":"prompts"}', '["prompts"]']) {
    assert.equal(parseRightRailState(`{"open":${open}}`).open, null);
  }
});

test("the workflows panel is a panel like the others", () => {
  assert.deepEqual(parseRightRailState('{"v":1,"open":"workflows","width":360}'), { open: "workflows", width: 360 });
  assert.deepEqual(JSON.parse(serializeRightRailState({ open: "workflows", width: 360 })), { v: 1, open: "workflows", width: 360 });
});

test("the agent profile panel is a panel like the others", () => {
  assert.deepEqual(parseRightRailState('{"v":1,"open":"profile","width":420}'), { open: "profile", width: 420 });
  assert.deepEqual(JSON.parse(serializeRightRailState({ open: "profile", width: 420 })), { v: 1, open: "profile", width: 420 });
  assert.equal(parseRightRailState('{"open":"Profile"}').open, null);
});

test("malformed stored widths fall back without losing the panel", () => {
  for (const bad of ["0", "-40", "null", '"400"', "true", "[400]", "{}", "1e999"]) {
    assert.deepEqual(parseRightRailState(`{"open":"history","width":${bad}}`), { open: "history", width: 320 });
  }
});

test("a payload written by another version is still read field by field", () => {
  assert.deepEqual(parseRightRailState('{"v":2,"open":"history","width":480,"extra":{"a":1}}'), { open: "history", width: 480 });
  assert.equal(parseRightRailState('{"v":"one","open":"prompts"}').open, "prompts");
});

test("load and save swallow storage errors and missing storage", () => {
  stored.set(key, '{"v":1,"open":"prompts","width":350}');
  assert.deepEqual(loadRightRailState(), { open: "prompts", width: 350 });
  denyStorage();
  assert.deepEqual(loadRightRailState(), defaults);
  assert.doesNotThrow(() => saveRightRailState(defaults));
  Reflect.deleteProperty(globalThis, "localStorage");
  assert.deepEqual(loadRightRailState(), defaults);
  assert.doesNotThrow(() => saveRightRailState(defaults));
});

test("toggling opens, switches and closes the dock — and persists every change", () => {
  for (const [panel, expected] of [["prompts", "prompts"], ["history", "history"], ["history", null]] as const) {
    toggleRightRailPanel(panel);
    assert.equal(rightRailState().open, expected);
    assert.equal(JSON.parse(stored.get(key)!).open, expected);
  }
  setRightRailOpen("prompts");
  assert.equal(JSON.parse(stored.get(key)!).open, "prompts");
});

test("a live drag updates the state only; the release persists it", () => {
  setRightRailWidth(400, { persist: false });
  setRightRailWidth(420, { persist: false });
  assert.equal(rightRailState().width, 420);
  assert.equal(stored.has(key), false);
  setRightRailWidth(420, { persist: true });
  assert.equal(JSON.parse(stored.get(key)!).width, 420);
  resetRightRailWidth();
  assert.equal(JSON.parse(stored.get(key)!).width, 320);
});

test("subscribers hear real changes only, and can unsubscribe", () => {
  const seen: unknown[] = [];
  const unsubscribe = subscribeRightRail(() => seen.push(rightRailState()));
  try {
    toggleRightRailPanel("prompts");
    const snapshot = rightRailState();
    setRightRailOpen("prompts");
    assert.equal(rightRailState(), snapshot, "useSyncExternalStore requires a stable unchanged snapshot");
    assert.deepEqual(seen, [{ open: "prompts", width: 320 }]);
  } finally {
    unsubscribe();
  }
  toggleRightRailPanel("prompts");
  assert.equal(seen.length, 1);
});

test("a storage that throws never breaks the store", () => {
  denyStorage();
  toggleRightRailPanel("history");
  setRightRailWidth(480, { persist: true });
  assert.deepEqual(rightRailState(), { open: "history", width: 480 });
});
