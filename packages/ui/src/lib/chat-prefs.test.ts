import test from "node:test";
import assert from "node:assert/strict";

import { loadChatPrefs, runtimeModeForAgent } from "./chat-prefs.ts";

function load(raw: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "orquester.chat-prefs" ? JSON.stringify(raw) ?? null : null
  } });
  try { return loadChatPrefs(); }
  finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("a missing or non-object blob falls back whole", () => {
  assert.deepEqual(load(undefined), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
  assert.deepEqual(load(null), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
  assert.deepEqual(load("steer"), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
  assert.deepEqual(load([1, 2]), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
});

test("a blob from an older bundle keeps the fields it does have", () => {
  const prefs = load({ followUpBehavior: "queue" });
  assert.equal(prefs.followUpBehavior, "queue");
  assert.equal(prefs.showSkillsInSlashMenu, true);
  assert.deepEqual(prefs.runtimeModeByAgent, {});
});

test("wrong-typed fields are dropped, not coerced", () => {
  const prefs = load({
    followUpBehavior: "yolo",
    showSkillsInSlashMenu: "yes",
    runtimeModeByAgent: "all"
  });
  assert.deepEqual(prefs, { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
});

test("only known permission modes survive the per-agent map", () => {
  const prefs = load({
    runtimeModeByAgent: { claude: "full-access", codex: "yolo", "": "auto", grok: 3 }
  });
  assert.deepEqual(prefs.runtimeModeByAgent, { claude: "full-access" });
});

test("an agent with no remembered mode gets the full-access default", () => {
  const prefs = load({ runtimeModeByAgent: { claude: "auto" } });
  assert.equal(runtimeModeForAgent(prefs, "claude"), "auto");
  assert.equal(runtimeModeForAgent(prefs, "codex"), "full-access");
});
