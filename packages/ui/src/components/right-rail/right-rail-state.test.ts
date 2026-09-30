import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { resetRightRailWidth, rightRailState, setRightRailOpen, setRightRailWidth, subscribeRightRail, toggleRightRailPanel } from "./right-rail-state.ts";

const key = "orquester:right-rail";
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

let railInstance = 0;
function freshRail(): Promise<typeof import("./right-rail-state.ts")> {
  return import(`./right-rail-state.ts?storage-case=${railInstance++}`);
}
async function loadStoredRail(raw: string) {
  stored.set(key, raw);
  return (await freshRail()).rightRailState();
}
async function persistRail(open: "history" | "workflows" | "profile", width: number) {
  const rail = await freshRail();
  rail.setRightRailOpen(open);
  rail.setRightRailWidth(width, { persist: true });
  return JSON.parse(stored.get(key)!);
}

test("a well-formed payload round-trips", async () => {
  assert.deepEqual(await persistRail("history", 412), {
    v: 1, open: "history", width: 412
  });
  assert.deepEqual(await loadStoredRail('{"v":1,"open":"history","width":412}'), {
    open: "history", width: 412
  });
});

test("each field is validated on its own: one bad field never costs the others", async () => {
  assert.deepEqual(await loadStoredRail('{"v":1,"open":"files","width":400}'), { open: null, width: 400 });
  const badWidth = await loadStoredRail('{"v":1,"open":"prompts","width":"wide"}');
  assert.equal(badWidth.open, "prompts");
  assert.ok(Number.isFinite(badWidth.width) && badWidth.width > 0);
  assert.deepEqual(await loadStoredRail('{"width":300}'), { open: null, width: 300 });
  assert.equal((await loadStoredRail('{"open":null}')).open, null);
  assert.deepEqual(await loadStoredRail('{"v":1,"open":"history","width":400,"sheet":"history"}'), { open: "history", width: 400 });
  for (const open of ["true", "1", '"History"', '"Workflows"', '{"id":"prompts"}', '["prompts"]']) {
    assert.equal((await loadStoredRail(`{"open":${open}}`)).open, null);
  }
});

test("the workflows panel is a panel like the others", async () => {
  assert.deepEqual(await loadStoredRail('{"v":1,"open":"workflows","width":360}'), { open: "workflows", width: 360 });
  assert.deepEqual(await persistRail("workflows", 360), { v: 1, open: "workflows", width: 360 });
});

test("the agent profile panel is a panel like the others", async () => {
  assert.deepEqual(await loadStoredRail('{"v":1,"open":"profile","width":420}'), { open: "profile", width: 420 });
  assert.deepEqual(await persistRail("profile", 420), { v: 1, open: "profile", width: 420 });
  assert.equal((await loadStoredRail('{"open":"Profile"}')).open, null);
});

test("malformed stored widths fall back without losing the panel", async () => {
  for (const bad of ["0", "-40", "null", '"400"', "true", "[400]", "{}", "1e999"]) {
    const parsed = await loadStoredRail(`{"open":"history","width":${bad}}`);
    assert.equal(parsed.open, "history");
    assert.ok(Number.isFinite(parsed.width) && parsed.width > 0);
  }
});

test("a payload written by another version is still read field by field", async () => {
  assert.deepEqual(await loadStoredRail('{"v":2,"open":"history","width":480,"extra":{"a":1}}'), { open: "history", width: 480 });
  assert.equal((await loadStoredRail('{"v":"one","open":"prompts"}')).open, "prompts");
});

test("load and save swallow storage errors and missing storage", async () => {
  assert.deepEqual(await loadStoredRail('{"v":1,"open":"prompts","width":350}'), { open: "prompts", width: 350 });
  denyStorage();
  const denied = await freshRail();
  assert.doesNotThrow(() => denied.rightRailState());
  assert.doesNotThrow(() => denied.setRightRailOpen("history"));
  Reflect.deleteProperty(globalThis, "localStorage");
  const missing = await freshRail();
  assert.doesNotThrow(() => missing.rightRailState());
  assert.doesNotThrow(() => missing.setRightRailOpen("history"));
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
});

test("subscribers hear real changes only, and can unsubscribe", () => {
  const seen: unknown[] = [];
  const unsubscribe = subscribeRightRail(() => seen.push(rightRailState().open));
  try {
    toggleRightRailPanel("prompts");
    const snapshot = rightRailState();
    setRightRailOpen("prompts");
    assert.equal(rightRailState(), snapshot, "useSyncExternalStore requires a stable unchanged snapshot");
    assert.deepEqual(seen, ["prompts"]);
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
