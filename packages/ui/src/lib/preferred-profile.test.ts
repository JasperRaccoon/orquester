import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loadPreferredProfiles,
  parsePreferredProfiles,
  savePreferredProfiles,
  withPreferredProfile,
  withoutPreferredProfile
} from "./preferred-profile.ts";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key)
};

const KEY = "orquester:preferred-profile-by-agent";

describe("preferred profile per agent (persisted-shape rule)", () => {
  it("round-trips, and drops what is not a profile id", () => {
    savePreferredProfiles({ claude: "p-dev" });
    const raw = JSON.parse(store.get(KEY)!) as Record<string, unknown>;
    raw.codex = 42;
    raw.grok = "";
    raw.opencode = "x".repeat(500);
    raw[""] = "p-x";
    store.set(KEY, JSON.stringify(raw));
    assert.deepEqual(loadPreferredProfiles(), { claude: "p-dev" });
  });

  it("garbage loads as every agent Global", () => {
    store.set(KEY, "{not json");
    assert.deepEqual(loadPreferredProfiles(), {});
    store.set(KEY, "[1,2]");
    assert.deepEqual(loadPreferredProfiles(), {});
    assert.deepEqual(parsePreferredProfiles(null), {});
  });

  it("null forgets the agent's pick (Global); a deleted profile is forgotten everywhere", () => {
    const map = withPreferredProfile({}, "claude", "p-dev");
    assert.deepEqual(map, { claude: "p-dev" });
    assert.equal(withPreferredProfile(map, "claude", "p-dev"), map, "unchanged keeps identity");
    assert.deepEqual(withPreferredProfile(map, "claude", null), {});
    assert.deepEqual(withoutPreferredProfile({ claude: "p-dev", codex: "p-dev", grok: "p-ed" }, "p-dev"), { grok: "p-ed" });
  });
});
