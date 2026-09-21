import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COMPOSER_PREFERENCES,
  parseComposerPreferences
} from "./composer-prefs.ts";

test("a complete payload round-trips", () => {
  assert.deepEqual(
    parseComposerPreferences({
      sendShortcut: "mod-enter",
      followUpBehavior: "steer",
      showSkillsInSlashMenu: false
    }),
    { sendShortcut: "mod-enter", followUpBehavior: "steer", showSkillsInSlashMenu: false }
  );
});

test("one bad field never loses the others", () => {
  assert.deepEqual(
    parseComposerPreferences({ sendShortcut: 7, followUpBehavior: "steer" }),
    {
      sendShortcut: DEFAULT_COMPOSER_PREFERENCES.sendShortcut,
      followUpBehavior: "steer",
      showSkillsInSlashMenu: DEFAULT_COMPOSER_PREFERENCES.showSkillsInSlashMenu
    }
  );
});

test("a payload of the wrong shape falls back whole", () => {
  for (const raw of [null, undefined, 3, "queue", []]) {
    const parsed = parseComposerPreferences(raw);
    assert.equal(parsed.followUpBehavior, DEFAULT_COMPOSER_PREFERENCES.followUpBehavior);
    assert.equal(parsed.showSkillsInSlashMenu, true);
  }
});

test("the fallback is a copy, so a caller cannot mutate the shared default", () => {
  const parsed = parseComposerPreferences(null);
  parsed.followUpBehavior = "steer";
  assert.equal(DEFAULT_COMPOSER_PREFERENCES.followUpBehavior, "queue");
});
