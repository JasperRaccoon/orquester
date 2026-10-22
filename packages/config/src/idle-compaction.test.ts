import assert from "node:assert/strict";
import test from "node:test";

import { agentPrefsSchema, IDLE_COMPACTION_MODES, parseAppConfig, resolveIdleCompaction } from "./index.ts";

test("idle compaction defaults to T3 Code's 'when you return', also for an app.json without it", () => {
  assert.equal(agentPrefsSchema.parse({}).claudeIdleCompaction, "onReturn");
  assert.deepEqual(agentPrefsSchema.parse({}).claudeIdleCompactionByAccount, {});
  const config = parseAppConfig({ agents: { autoResumeLimitedChats: false } });
  assert.equal(config.agents.claudeIdleCompaction, "onReturn");
  assert.deepEqual(
    IDLE_COMPACTION_MODES.map((mode) => [mode.value, mode.label]),
    [
      ["onReturn", "When you return"],
      ["beforeCacheExpires", "Before the cache expires (beta)"],
      ["off", "Never"]
    ]
  );
});

test("a mode another version wrote reads as the default instead of failing the whole file", () => {
  const config = parseAppConfig({
    agents: {
      claudeIdleCompaction: "whenever",
      claudeTimeoutMinutes: 12,
      claudeIdleCompactionByAccount: { acc1: "off", acc2: "sometimes", acc3: 4, system: "beforeCacheExpires" }
    }
  });
  assert.equal(config.agents.claudeIdleCompaction, "onReturn");
  // The other settings survive.
  assert.equal(config.agents.claudeTimeoutMinutes, 12);
  // Only the readable overrides are kept.
  assert.deepEqual(config.agents.claudeIdleCompactionByAccount, { acc1: "off", system: "beforeCacheExpires" });
  assert.deepEqual(parseAppConfig({ agents: { claudeIdleCompactionByAccount: "nope" } }).agents.claudeIdleCompactionByAccount, {});
});

test("an account's override wins over the default; an account without one follows it", () => {
  const prefs = agentPrefsSchema.parse({
    claudeIdleCompaction: "beforeCacheExpires",
    claudeIdleCompactionByAccount: { acc1: "off", system: "onReturn" }
  });
  assert.equal(resolveIdleCompaction(prefs, "acc1"), "off");
  assert.equal(resolveIdleCompaction(prefs, "system"), "onReturn");
  assert.equal(resolveIdleCompaction(prefs, "acc2"), "beforeCacheExpires");
  // Never an inherited key.
  assert.equal(resolveIdleCompaction(prefs, "toString"), "beforeCacheExpires");
});
