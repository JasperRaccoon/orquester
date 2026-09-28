import test from "node:test";
import assert from "node:assert/strict";

import { runtimeModeForAgent, sanitizeChatPrefs } from "./chat-prefs.ts";

test("a missing or non-object blob falls back whole", () => {
  assert.deepEqual(sanitizeChatPrefs(undefined), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
  assert.deepEqual(sanitizeChatPrefs(null), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
  assert.deepEqual(sanitizeChatPrefs("steer"), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
  assert.deepEqual(sanitizeChatPrefs([1, 2]), { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
});

test("a blob from an older bundle keeps the fields it does have", () => {
  const prefs = sanitizeChatPrefs({ followUpBehavior: "queue" });
  assert.equal(prefs.followUpBehavior, "queue");
  assert.equal(prefs.showSkillsInSlashMenu, true);
  assert.deepEqual(prefs.runtimeModeByAgent, {});
});

test("wrong-typed fields are dropped, not coerced", () => {
  const prefs = sanitizeChatPrefs({
    followUpBehavior: "yolo",
    showSkillsInSlashMenu: "yes",
    runtimeModeByAgent: "all"
  });
  assert.deepEqual(prefs, { followUpBehavior: "steer", showSkillsInSlashMenu: true, runtimeModeByAgent: {} });
});

test("only known permission modes survive the per-agent map", () => {
  const prefs = sanitizeChatPrefs({
    runtimeModeByAgent: { claude: "full-access", codex: "yolo", "": "auto", grok: 3 }
  });
  assert.deepEqual(prefs.runtimeModeByAgent, { claude: "full-access" });
});

test("an agent with no remembered mode gets the full-access default", () => {
  const prefs = sanitizeChatPrefs({ runtimeModeByAgent: { claude: "auto" } });
  assert.equal(runtimeModeForAgent(prefs, "claude"), "auto");
  assert.equal(runtimeModeForAgent(prefs, "codex"), "full-access");
});
