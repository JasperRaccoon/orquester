import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultPluginsConfig,
  parsePluginsConfig,
  pluginStateOf,
  pluginsConfigPath,
  storedKnowledgeSettings,
  storedTsCheckerEngine,
  tsRustPluginDir,
  tsRustPreloadPath,
  tsrsEngineDir
} from "./index.ts";

test("plugin files live in the daemon dir", () => {
  assert.equal(pluginsConfigPath("/base"), "/base/daemon/plugins.json");
  assert.equal(tsRustPluginDir("/base"), "/base/daemon/plugins/ts-rust");
  assert.equal(tsRustPreloadPath("/base"), "/base/daemon/plugins/ts-rust/preload.cjs");
  assert.equal(tsrsEngineDir("/base"), "/base/daemon/plugins/ts-rust/tsrs");
});

test("a ts-rust record with an engine and tsrs's versions round-trips; a record without them still reads", () => {
  const record = {
    enabled: true,
    engine: "tsrs",
    current: { version: "0.7.0", integrity: "sha512-a", installedAt: "2026-10-14T10:00:00.000Z" },
    tsrs: {
      current: { version: "0.16.0-ts7.1.0-dev.20260929", integrity: "sha512-c", installedAt: "2026-10-17T10:00:00.000Z" },
      previous: { version: "0.15.0", integrity: "sha512-d", installedAt: "2026-10-16T10:00:00.000Z" },
      skippedVersion: "0.15.1",
      lastCheckAt: "2026-10-17T11:00:00.000Z",
      lastError: { at: "2026-10-17T11:00:00.000Z", step: "registry", message: "ENOTFOUND" },
      newer: true
    }
  };
  const state = pluginStateOf(parsePluginsConfig({ version: 1, plugins: { "ts-rust": record } }), "ts-rust");
  assert.deepEqual(state, record);
  assert.equal(storedTsCheckerEngine(state), "tsrs");
  assert.equal(storedTsCheckerEngine(pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": { engine: "tsc-rs" } } }), "ts-rust")), "tsc-rs");
  assert.equal(storedTsCheckerEngine(pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": { enabled: true } } }), "ts-rust")), undefined);
});

test("an engine this build does not know reads as none and is kept; a malformed tsrs record is rejected", () => {
  for (const engine of ["tsgo", 7, null, { id: "tsrs" }]) {
    const state = pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": { engine } } }), "ts-rust");
    assert.equal(storedTsCheckerEngine(state), undefined, JSON.stringify(engine));
    assert.deepEqual(state.engine, engine);
  }
  assert.throws(() => pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": { tsrs: "x" } } }), "ts-rust"));
  assert.throws(() => pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": { tsrs: { current: { version: "" } } } } }), "ts-rust"));
});

test("an empty plugins.json reads as no plugin state", () => {
  assert.deepEqual(createDefaultPluginsConfig(), { version: 1, plugins: {} });
  assert.deepEqual(parsePluginsConfig({}), { version: 1, plugins: {} });
  assert.deepEqual(pluginStateOf(createDefaultPluginsConfig(), "ts-rust"), {});
});

test("a full plugin record round-trips", () => {
  const record = {
    enabled: true,
    current: { version: "0.7.0", integrity: "sha512-a", installedAt: "2026-10-14T10:00:00.000Z" },
    previous: { version: "0.6.0", integrity: "sha512-b", installedAt: "2026-10-13T10:00:00.000Z" },
    skippedVersion: "0.6.1",
    lastCheckAt: "2026-10-14T11:00:00.000Z",
    lastError: { at: "2026-10-14T11:00:00.000Z", step: "download", message: "timed out" }
  };
  const parsed = parsePluginsConfig({ version: 1, plugins: { "ts-rust": record } });
  assert.deepEqual(pluginStateOf(parsed, "ts-rust"), record);
});

test("an older build's per-workspace list is read as it is, and never defaulted in", () => {
  const legacy = parsePluginsConfig({ version: 1, plugins: { "ts-rust": { enabledWorkspaces: ["jaspersito"] } } });
  assert.deepEqual(pluginStateOf(legacy, "ts-rust"), { enabledWorkspaces: ["jaspersito"] });
  const current = parsePluginsConfig({ version: 1, plugins: { "ts-rust": { enabled: true } } });
  assert.deepEqual(pluginStateOf(current, "ts-rust"), { enabled: true });
});

test("unknown fields and unknown plugin ids written by other versions are kept", () => {
  const parsed = parsePluginsConfig({
    version: 1,
    future: { a: 1 },
    plugins: {
      "ts-rust": { enabledWorkspaces: [], channel: "next", current: { version: "1.0.0", integrity: "x", installedAt: "t", arch: "x64" } },
      "other-plugin": { enabledWorkspaces: ["w"], extra: true }
    }
  });
  const roundTripped = JSON.parse(JSON.stringify(parsed));
  assert.deepEqual(roundTripped.future, { a: 1 });
  assert.equal(roundTripped.plugins["ts-rust"].channel, "next");
  assert.equal(roundTripped.plugins["ts-rust"].current.arch, "x64");
  assert.deepEqual(roundTripped.plugins["other-plugin"], { enabledWorkspaces: ["w"], extra: true });
});

test("an unknown plugin id with any shape does not make the file unreadable, and round-trips verbatim", () => {
  const other = { enabledWorkspaces: "all", nested: [1, { deep: true }] };
  const parsed = parsePluginsConfig({ version: 1, plugins: { "future-plugin": other, "flag-plugin": true } });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)).plugins, { "future-plugin": other, "flag-plugin": true });
  assert.deepEqual(pluginStateOf(parsed, "ts-rust"), {});
});

test("a malformed plugins.json is rejected rather than read as empty", () => {
  assert.throws(() => parsePluginsConfig({ version: 2 }));
  assert.throws(() => parsePluginsConfig({ version: 1, plugins: ["ts-rust"] }));
});

test("a known plugin's malformed record is rejected where it is read", () => {
  const wrongType = parsePluginsConfig({ plugins: { "ts-rust": { enabledWorkspaces: "jaspersito" } } });
  assert.throws(() => pluginStateOf(wrongType, "ts-rust"));
  const wrongFlag = parsePluginsConfig({ plugins: { "ts-rust": { enabled: "yes" } } });
  assert.throws(() => pluginStateOf(wrongFlag, "ts-rust"));
  const emptyVersion = parsePluginsConfig({ plugins: { "ts-rust": { current: { version: "" } } } });
  assert.throws(() => pluginStateOf(emptyVersion, "ts-rust"));
  assert.throws(() => pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": "on" } }), "ts-rust"));
});

test("knowledge-graph settings read field by field; a bad value never makes the record unreadable", () => {
  const read = (settings: unknown) =>
    storedKnowledgeSettings(pluginStateOf(parsePluginsConfig({ plugins: { "knowledge-graph": { settings } } }), "knowledge-graph"));
  assert.deepEqual(read({ accountId: "acc-1", model: "claude-sonnet-4-5", concurrency: 3, future: { x: 1 } }), {
    accountId: "acc-1",
    model: "claude-sonnet-4-5",
    concurrency: 3
  });
  assert.deepEqual(read({ accountId: null, model: null }), { accountId: null, model: null });
  assert.deepEqual(read({ accountId: 7, model: "", concurrency: 2.5 }), {});
  assert.deepEqual(read("on"), {});
  assert.deepEqual(read(undefined), {});
});

test("knowledge-graph settings read the account policy field by field, keeping unknown keys", () => {
  const read = (settings: unknown) =>
    storedKnowledgeSettings(pluginStateOf(parsePluginsConfig({ plugins: { "knowledge-graph": { settings } } }), "knowledge-graph"));
  const defaults = { strategy: "least-used", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" };
  // A full, valid policy reads as stored.
  const full = {
    strategy: "fixed",
    accounts: ["acc-2", "system"],
    includeSystem: true,
    maxSessionPct: 80,
    maxWeeklyPct: 90,
    scoped: [{ label: "Fable", maxPct: 70, onlyForModels: ["opus"] }],
    soonestResetWindow: "session",
    leastUsedMetric: "weekly",
    unknownUsage: "exclude"
  };
  assert.deepEqual(read({ accountId: "acc-2", accountPolicy: full }), { accountId: "acc-2", accountPolicy: full });
  // An empty object is the policy's defaults; no accountPolicy is none (the caller maps accountId).
  assert.deepEqual(read({ accountPolicy: {} }), { accountPolicy: defaults });
  assert.deepEqual(read({ accountId: null }), { accountId: null });
  // Bad fields read as their defaults, bad list items are left out, unknown keys are kept.
  assert.deepEqual(
    read({
      accountPolicy: {
        strategy: "round-robin",
        accounts: ["acc-1", 7, "", "acc-3"],
        includeSystem: "yes",
        maxSessionPct: 140,
        maxWeeklyPct: 50,
        scoped: [{ label: "Fable", maxPct: 60 }, { label: "", maxPct: 10 }, "x"],
        unknownUsage: "skip",
        future: { x: 1 }
      }
    }).accountPolicy,
    { ...defaults, accounts: ["acc-1", "acc-3"], maxWeeklyPct: 50, scoped: [{ label: "Fable", maxPct: 60 }], future: { x: 1 } }
  );
  // A policy that is not an object reads as absent.
  for (const accountPolicy of ["fixed", null, [1], 3]) assert.deepEqual(read({ accountPolicy }), {}, JSON.stringify(accountPolicy));
});

test("a plugin record's settings and their unknown keys survive a parse", () => {
  const config = parsePluginsConfig({
    plugins: { "knowledge-graph": { enabled: true, settings: { concurrency: 2, future: [1, 2] }, other: "kept" } }
  });
  const state = pluginStateOf(config, "knowledge-graph");
  assert.deepEqual(state.settings, { concurrency: 2, future: [1, 2] });
  assert.equal((state as Record<string, unknown>).other, "kept");
});
