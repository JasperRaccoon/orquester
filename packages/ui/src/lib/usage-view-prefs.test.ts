import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { readUsageViewPrefs, writeUsageViewPrefs } from "./usage-view-prefs.ts";

class MemoryStorage {
  map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const g = globalThis as Record<string, unknown>;

function install(): MemoryStorage {
  const storage = new MemoryStorage();
  g.localStorage = storage;
  return storage;
}

afterEach(() => {
  delete g.localStorage;
});

const DEFAULTS = { tab: "cost", range: "30d", hiddenAgents: [], breakdown: "model" };

describe("usage view prefs", () => {
  it("defaults to cost over 30 days, every agent shown, by model", () => {
    install();
    assert.deepEqual(readUsageViewPrefs(), DEFAULTS);
    delete g.localStorage;
    assert.deepEqual(readUsageViewPrefs(), DEFAULTS, "no storage at all");
  });

  it("round-trips a saved choice", () => {
    install();
    const prefs = { tab: "limits" as const, range: "24h" as const, hiddenAgents: ["grok", "opencode"], breakdown: "project" as const };
    writeUsageViewPrefs(prefs);
    assert.deepEqual(readUsageViewPrefs(), prefs);
  });

  it("drops only the invalid fields of a stored record", () => {
    const storage = install();
    storage.setItem("orquester:usage-view", JSON.stringify({ tab: "tokens", range: "365d", hiddenAgents: ["codex", 7, "", "codex"], breakdown: null, extra: 1 }));
    assert.deepEqual(readUsageViewPrefs(), { tab: "tokens", range: "30d", hiddenAgents: ["codex"], breakdown: "model" });
  });

  it("reads corrupt JSON or a non-object as the defaults", () => {
    const storage = install();
    storage.setItem("orquester:usage-view", "{not json");
    assert.deepEqual(readUsageViewPrefs(), DEFAULTS);
    storage.setItem("orquester:usage-view", JSON.stringify(["cost"]));
    assert.deepEqual(readUsageViewPrefs(), DEFAULTS);
  });

  it("a failing write does not throw", () => {
    const storage = install();
    storage.failWrites = true;
    assert.doesNotThrow(() => writeUsageViewPrefs({ ...DEFAULTS, tab: "tokens" } as never));
  });
});
