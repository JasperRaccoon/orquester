import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  keepKnownPreferredProfiles,
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
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear()
};

const KEY = "orquester:preferred-profile-by-connection";

describe("preferred profile per agent (persisted-shape rule)", () => {
  it("round-trips per daemon connection, and drops what is not a profile id", () => {
    store.clear();
    savePreferredProfiles("local", { claude: "p-dev" });
    savePreferredProfiles("remote-1", { codex: "p-ed" });
    assert.deepEqual(loadPreferredProfiles("local"), { claude: "p-dev" });
    assert.deepEqual(loadPreferredProfiles("remote-1"), { codex: "p-ed" }, "another daemon has its own picks");
    assert.deepEqual(loadPreferredProfiles("remote-2"), {});
    assert.deepEqual(loadPreferredProfiles(null), {}, "no connection: every agent Global");

    const raw = JSON.parse(store.get(KEY)!) as Record<string, Record<string, unknown>>;
    raw.local!.codex = 42;
    raw.local!.grok = "";
    raw.local!.opencode = "x".repeat(500);
    raw.local![""] = "p-x";
    (raw as Record<string, unknown>).broken = "not a map";
    store.set(KEY, JSON.stringify(raw));
    assert.deepEqual(loadPreferredProfiles("local"), { claude: "p-dev" });
    assert.deepEqual(loadPreferredProfiles("broken"), {});

    savePreferredProfiles("local", {});
    assert.deepEqual(Object.keys(JSON.parse(store.get(KEY)!)).sort(), ["broken", "remote-1"], "an empty map is not kept");
  });

  it("garbage loads as every agent Global", () => {
    store.set(KEY, "{not json");
    assert.deepEqual(loadPreferredProfiles("local"), {});
    store.set(KEY, "[1,2]");
    assert.deepEqual(loadPreferredProfiles("local"), {});
    assert.deepEqual(parsePreferredProfiles(null), {});
  });

  it("null forgets the agent's pick (Global); a deleted profile is forgotten everywhere", () => {
    const map = withPreferredProfile({}, "claude", "p-dev");
    assert.deepEqual(map, { claude: "p-dev" });
    assert.deepEqual(withPreferredProfile(map, "claude", null), {});
    assert.deepEqual(withoutPreferredProfile({ claude: "p-dev", codex: "p-dev", grok: "p-ed" }, "p-dev"), { grok: "p-ed" });
  });

  it("keeps only the picks the daemon's profile list knows", () => {
    const map = { claude: "p-dev", codex: "p-gone", grok: "p-broken" };
    assert.deepEqual(keepKnownPreferredProfiles(map, new Set(["p-dev", "p-broken"])), { claude: "p-dev", grok: "p-broken" });
  });
});
