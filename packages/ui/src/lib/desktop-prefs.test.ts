import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  clearDesktopPrefs,
  readDesktopPrefs,
  sanitizeDesktopPrefs,
  writeDesktopPrefs
} from "./desktop-prefs.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const g = globalThis as Record<string, unknown>;

function install(coarse: boolean): MemoryStorage {
  const storage = new MemoryStorage();
  g.localStorage = storage;
  g.matchMedia = (query: string) => ({ matches: query === "(pointer: coarse)" && coarse });
  return storage;
}

afterEach(() => {
  delete g.localStorage;
  delete g.matchMedia;
});

test("non-touch default is fit, unmuted, full volume", () => {
  install(false);
  assert.deepEqual(readDesktopPrefs("d1"), { muted: false, volume: 1, view: "fit" });
});

test("touch default is fixed 1280×800, scaled", () => {
  install(true);
  assert.deepEqual(readDesktopPrefs("d1"), {
    muted: false,
    volume: 1,
    view: "fixed",
    fixedSize: { width: 1280, height: 800 },
    fixedMode: "scale"
  });
});

test("write then read round-trips under orq.desktop.prefs.<id>", () => {
  const storage = install(false);
  const prefs = { muted: true, volume: 0.25, view: "fixed" as const, fixedSize: { width: 1600, height: 900 }, fixedMode: "pan" as const };
  writeDesktopPrefs("abc", prefs);
  assert.ok(storage.getItem("orq.desktop.prefs.abc"));
  assert.deepEqual(readDesktopPrefs("abc"), prefs);
  assert.deepEqual(readDesktopPrefs("other"), { muted: false, volume: 1, view: "fit" });
});

test("clear removes the key", () => {
  const storage = install(false);
  writeDesktopPrefs("abc", { muted: true, volume: 0.5, view: "fit" });
  clearDesktopPrefs("abc");
  assert.equal(storage.getItem("orq.desktop.prefs.abc"), null);
});

test("corrupt JSON falls back to the device default", () => {
  const storage = install(true);
  storage.setItem("orq.desktop.prefs.x", "{nope");
  assert.equal(readDesktopPrefs("x").view, "fixed");
});

test("invalid fields fall back one by one", () => {
  assert.deepEqual(sanitizeDesktopPrefs({ muted: "yes", volume: 3, view: "zoom" }, false), {
    muted: false,
    volume: 1,
    view: "fit"
  });
  assert.deepEqual(sanitizeDesktopPrefs({ muted: true, volume: -0.1, view: "fit" }, false), {
    muted: true,
    volume: 1,
    view: "fit"
  });
  assert.equal(sanitizeDesktopPrefs({ volume: Number.NaN }, false).volume, 1);
  assert.deepEqual(sanitizeDesktopPrefs([1, 2], false), { muted: false, volume: 1, view: "fit" });
  assert.deepEqual(sanitizeDesktopPrefs(null, true).fixedSize, { width: 1280, height: 800 });
});

test("a fixed view always gets a valid size and mode", () => {
  assert.deepEqual(sanitizeDesktopPrefs({ view: "fixed", fixedSize: { width: 99999, height: 800 }, fixedMode: "zoom" }, false), {
    muted: false,
    volume: 1,
    view: "fixed",
    fixedSize: { width: 1280, height: 800 },
    fixedMode: "scale"
  });
  assert.deepEqual(sanitizeDesktopPrefs({ view: "fixed", fixedSize: { width: 1280.5, height: 800 } }, false).fixedSize, {
    width: 1280,
    height: 800
  });
});

test("fit keeps a remembered fixed choice for switching back", () => {
  const prefs = sanitizeDesktopPrefs({ view: "fit", fixedSize: { width: 1920, height: 1080 }, fixedMode: "pan" }, false);
  assert.deepEqual(prefs, { muted: false, volume: 1, view: "fit", fixedSize: { width: 1920, height: 1080 }, fixedMode: "pan" });
});

test("works with no localStorage at all", () => {
  assert.deepEqual(readDesktopPrefs("d"), { muted: false, volume: 1, view: "fit" });
  writeDesktopPrefs("d", { muted: true, volume: 1, view: "fit" });
  clearDesktopPrefs("d");
});
