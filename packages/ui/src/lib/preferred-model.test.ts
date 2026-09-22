import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  launchModelSelection,
  loadPreferredModelSelections,
  savePreferredModelSelections
} from "./preferred-model.ts";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key)
};

describe("preferred model selections (persisted-shape rule)", () => {
  it("round-trips model and options, and drops what it cannot type", () => {
    savePreferredModelSelections({
      claude: { model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }, { id: "thinking", value: true }] }
    });
    const raw = JSON.parse(store.get("orquester:preferred-model-selection-by-agent")!) as Record<string, unknown>;
    raw.codex = { model: 42 }; // an older bundle's garbage
    raw.grok = { model: "grok-4", options: [{ id: "", value: "x" }, { id: "effort", value: { nested: 1 } }, 7] };
    store.set("orquester:preferred-model-selection-by-agent", JSON.stringify(raw));
    const loaded = loadPreferredModelSelections();
    assert.deepEqual(loaded.claude, {
      model: "claude-fable-5-1",
      options: [{ id: "effort", value: "high" }, { id: "thinking", value: true }]
    });
    assert.equal(loaded.codex, undefined, "a non-string model is not a selection");
    assert.deepEqual(loaded.grok, { model: "grok-4" }, "malformed options are dropped, the model kept");
  });

  it("launch carries the remembered options only for the remembered model", () => {
    const preferred = { model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }] };
    assert.deepEqual(launchModelSelection("claude-fable-5-1", preferred), preferred);
    assert.deepEqual(launchModelSelection("haiku", preferred), { model: "haiku" });
    assert.deepEqual(launchModelSelection("haiku", undefined), { model: "haiku" });
  });

  it("garbage storage loads as empty rather than throwing", () => {
    store.set("orquester:preferred-model-selection-by-agent", "{not json");
    assert.deepEqual(loadPreferredModelSelections(), {});
    store.set("orquester:preferred-model-selection-by-agent", "[1,2]");
    assert.deepEqual(loadPreferredModelSelections(), {});
  });
});
