import assert from "node:assert/strict";
import test from "node:test";

import { agentPrefsSchema, applyAppConfigUpdate, IDLE_COMPACTION_MODES, parseAppConfig, resolveIdleCompaction } from "./index.ts";

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

test("an older client's whole `agents` write keeps the idle-compaction settings it does not know", () => {
  const stored = {
    version: 1,
    useTitlebar: false,
    futureTopLevel: { kept: true },
    agents: {
      claudeTimeoutMinutes: 30,
      claudeIdleCompaction: "beforeCacheExpires",
      claudeIdleCompactionByAccount: { acc1: "off" },
      futureAgentField: 7
    }
  };
  // What a client from before the setting sends when the user toggles another agent setting: its
  // own schema dropped the fields it does not know.
  const olderClient = { agents: { claudeTimeoutMinutes: 12, continueThreadsAfterRestart: true } };
  const { config, stored: written } = applyAppConfigUpdate(stored, olderClient);
  assert.equal(config.agents.claudeTimeoutMinutes, 12);
  assert.equal(config.agents.continueThreadsAfterRestart, true);
  assert.equal(config.agents.claudeIdleCompaction, "beforeCacheExpires");
  assert.deepEqual(config.agents.claudeIdleCompactionByAccount, { acc1: "off" });
  // Fields this build does not know survive in the file, at both levels; untouched ones stay.
  assert.equal((written.agents as Record<string, unknown>).futureAgentField, 7);
  assert.deepEqual(written.futureTopLevel, { kept: true });
  assert.equal(written.useTitlebar, false);
  // Read back, the file still parses for this build — and for an older one, which ignores what it
  // does not know.
  assert.equal(parseAppConfig(written).agents.claudeIdleCompaction, "beforeCacheExpires");
  const olderSchema = agentPrefsSchema.pick({ claudeTimeoutMinutes: true, continueThreadsAfterRestart: true });
  assert.deepEqual(olderSchema.parse(written.agents), { claudeTimeoutMinutes: 12, continueThreadsAfterRestart: true });
});

test("a field the body names wins, a record field is replaced whole, and an invalid update throws", () => {
  const stored = { agents: { claudeIdleCompactionByAccount: { acc1: "off", acc2: "onReturn" } } };
  const { config } = applyAppConfigUpdate(stored, { agents: { claudeIdleCompaction: "off", claudeIdleCompactionByAccount: { acc2: "onReturn" } } });
  assert.equal(config.agents.claudeIdleCompaction, "off");
  // Removing an account's override works: the record is the client's whole.
  assert.deepEqual(config.agents.claudeIdleCompactionByAccount, { acc2: "onReturn" });
  assert.throws(() => applyAppConfigUpdate(stored, { agents: { claudeTimeoutMinutes: 99 } }));
  // No file yet: the update over the defaults.
  assert.equal(applyAppConfigUpdate(undefined, { useTitlebar: false }).config.useTitlebar, false);
});
