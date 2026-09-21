import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CHAT_PREFS,
  RUNTIME_MODE_LABELS,
  runtimeModeForAgent,
  sanitizeChatPrefs
} from "./chat-prefs.ts";

test("a missing or non-object blob falls back whole", () => {
  assert.deepEqual(sanitizeChatPrefs(undefined), DEFAULT_CHAT_PREFS);
  assert.deepEqual(sanitizeChatPrefs(null), DEFAULT_CHAT_PREFS);
  assert.deepEqual(sanitizeChatPrefs("steer"), DEFAULT_CHAT_PREFS);
  assert.deepEqual(sanitizeChatPrefs([1, 2]), DEFAULT_CHAT_PREFS);
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
  assert.deepEqual(prefs, DEFAULT_CHAT_PREFS);
});

test("only known permission modes survive the per-agent map", () => {
  const prefs = sanitizeChatPrefs({
    runtimeModeByAgent: { claude: "full-access", codex: "yolo", "": "auto", grok: 3 }
  });
  assert.deepEqual(prefs.runtimeModeByAgent, { claude: "full-access" });
});

test("an agent with no remembered mode gets the supervised default", () => {
  const prefs = sanitizeChatPrefs({ runtimeModeByAgent: { claude: "auto" } });
  assert.equal(runtimeModeForAgent(prefs, "claude"), "auto");
  assert.equal(runtimeModeForAgent(prefs, "codex"), "approval-required");
});

test("every permission mode has a chip label", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
    assert.equal(typeof RUNTIME_MODE_LABELS[mode], "string");
    assert.ok(RUNTIME_MODE_LABELS[mode].length > 0);
  }
});
