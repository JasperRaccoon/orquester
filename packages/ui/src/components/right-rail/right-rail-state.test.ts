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
async function persistRail(open: "prompts" | "history", width: number) {
  const rail = await freshRail();
  rail.setRightRailOpen(open);
  rail.setRightRailWidth(width, { persist: true });
  return JSON.parse(stored.get(key)!);
}

test("a well-formed payload round-trips", async () => {
  assert.partialDeepStrictEqual(await persistRail("history", 412), {
    v: 1, open: "history", width: 412
  });
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"history","width":412}'), {
    open: "history", width: 412
  });
});

test("each field is validated on its own: one bad field never costs the others", async () => {
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"files","width":400}'), { open: null, width: 400 });
  const badWidth = await loadStoredRail('{"v":1,"open":"prompts","width":"wide"}');
  assert.equal(badWidth.open, "prompts");
  assert.ok(Number.isFinite(badWidth.width) && badWidth.width > 0);
  assert.partialDeepStrictEqual(await loadStoredRail('{"width":300}'), { open: null, width: 300 });
  assert.equal((await loadStoredRail('{"open":null}')).open, null);
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"history","width":400,"sheet":"history"}'), { open: "history", width: 400 });
  for (const open of ["true", "1", '"History"', '"Workflows"', '{"id":"prompts"}', '["prompts"]']) {
    assert.equal((await loadStoredRail(`{"open":${open}}`)).open, null);
  }
});

test("workflows (now in the left sidebar) and the agent profile (now Settings → Agent config) no longer open the dock", async () => {
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"workflows","width":360}'), { open: null, width: 360 });
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"profile","width":420}'), { open: null, width: 420 });
  assert.partialDeepStrictEqual(await persistRail("prompts", 360), { v: 1, open: "prompts", width: 360 });
});

test("malformed stored widths fall back without losing the panel", async () => {
  for (const bad of ["0", "-40", "null", '"400"', "true", "[400]", "{}", "1e999"]) {
    const parsed = await loadStoredRail(`{"open":"history","width":${bad}}`);
    assert.equal(parsed.open, "history");
    assert.ok(Number.isFinite(parsed.width) && parsed.width > 0);
  }
});

test("a payload written by another version is still read field by field", async () => {
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":2,"open":"history","width":480,"extra":{"a":1}}'), { open: "history", width: 480 });
  assert.equal((await loadStoredRail('{"v":"one","open":"prompts"}')).open, "prompts");
});

test("load and save swallow storage errors and missing storage", async () => {
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"prompts","width":350}'), { open: "prompts", width: 350 });
  denyStorage();
  const denied = await freshRail();
  assert.doesNotThrow(() => denied.rightRailState());
  assert.doesNotThrow(() => denied.setRightRailOpen("history"));
  denied.setRightRailWidth(480, { persist: true });
  assert.partialDeepStrictEqual(denied.rightRailState(), { open: "history", width: 480 });
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

test("the Device panel persists, validates and resets its preference separately", async () => {
  const rail = await freshRail();
  rail.setRightRailWidth(300, { persist: true });
  rail.setRightRailOpen("device");
  rail.setRightRailWidth(700, { persist: true, panel: "device" });
  assert.equal(rail.rightRailWidthOf(rail.rightRailState(), "device"), 700);
  assert.equal(rail.rightRailWidthOf(rail.rightRailState(), "history"), 300);
  assert.deepEqual(JSON.parse(stored.get(key)!), { v: 1, open: "device", width: 300, deviceWidth: 700 });
  // The Device panel's documented configuration range (devices spec §10.1).
  assert.equal(rail.clampRightRailWidth(2000, null, "device"), 900);
  assert.equal(rail.clampRightRailWidth(100, null, "device"), 320);
  assert.partialDeepStrictEqual(await loadStoredRail('{"v":1,"open":"device","width":300,"deviceWidth":5000}'), {
    open: "device", width: 300, deviceWidth: 900
  });
  const malformed = await loadStoredRail('{"open":"device","width":300,"deviceWidth":"wide"}');
  assert.equal(malformed.open, "device");
  assert.equal(malformed.width, 300);
  assert.ok(Number.isFinite(malformed.deviceWidth) && malformed.deviceWidth > 0);
  rail.resetRightRailWidth("device");
  assert.notEqual(rail.rightRailState().deviceWidth, 700, "reset forgets the custom preference");
  assert.equal(rail.rightRailState().width, 300, "reset leaves the other panels alone");
});
