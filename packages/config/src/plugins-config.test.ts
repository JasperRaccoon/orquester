import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendNodeRequireOption,
  createDefaultPluginsConfig,
  parsePluginsConfig,
  pluginStateOf,
  pluginsConfigPath,
  tsRustPluginDir,
  tsRustPreloadPath
} from "./index.ts";

test("plugin files live in the daemon dir", () => {
  assert.equal(pluginsConfigPath("/base"), "/base/daemon/plugins.json");
  assert.equal(tsRustPluginDir("/base"), "/base/daemon/plugins/ts-rust");
  assert.equal(tsRustPreloadPath("/base"), "/base/daemon/plugins/ts-rust/preload.cjs");
});

test("an empty plugins.json reads as no plugin state", () => {
  assert.deepEqual(createDefaultPluginsConfig(), { version: 1, plugins: {} });
  assert.deepEqual(parsePluginsConfig({}), { version: 1, plugins: {} });
  assert.deepEqual(pluginStateOf(createDefaultPluginsConfig(), "ts-rust"), { enabledWorkspaces: [] });
});

test("a full plugin record round-trips", () => {
  const record = {
    enabledWorkspaces: ["jaspersito"],
    current: { version: "0.7.0", integrity: "sha512-a", installedAt: "2026-10-14T10:00:00.000Z" },
    previous: { version: "0.6.0", integrity: "sha512-b", installedAt: "2026-10-13T10:00:00.000Z" },
    skippedVersion: "0.6.1",
    lastCheckAt: "2026-10-14T11:00:00.000Z",
    lastError: { at: "2026-10-14T11:00:00.000Z", step: "download", message: "timed out" }
  };
  const parsed = parsePluginsConfig({ version: 1, plugins: { "ts-rust": record } });
  assert.deepEqual(pluginStateOf(parsed, "ts-rust"), record);
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
  assert.deepEqual(pluginStateOf(parsed, "ts-rust"), { enabledWorkspaces: [] });
});

test("a malformed plugins.json is rejected rather than read as empty", () => {
  assert.throws(() => parsePluginsConfig({ version: 2 }));
  assert.throws(() => parsePluginsConfig({ version: 1, plugins: ["ts-rust"] }));
});

test("a known plugin's malformed record is rejected where it is read", () => {
  const wrongType = parsePluginsConfig({ plugins: { "ts-rust": { enabledWorkspaces: "jaspersito" } } });
  assert.throws(() => pluginStateOf(wrongType, "ts-rust"));
  const emptyVersion = parsePluginsConfig({ plugins: { "ts-rust": { current: { version: "" } } } });
  assert.throws(() => pluginStateOf(emptyVersion, "ts-rust"));
  assert.throws(() => pluginStateOf(parsePluginsConfig({ plugins: { "ts-rust": "on" } }), "ts-rust"));
});

test("the preload is appended to NODE_OPTIONS without replacing it", () => {
  assert.equal(appendNodeRequireOption(undefined, "/a/preload.cjs"), '--require "/a/preload.cjs"');
  assert.equal(appendNodeRequireOption("", "/a/preload.cjs"), '--require "/a/preload.cjs"');
  assert.equal(
    appendNodeRequireOption("--max-old-space-size=8192", "/a/preload.cjs"),
    '--max-old-space-size=8192 --require "/a/preload.cjs"'
  );
});

test("appending the preload twice leaves NODE_OPTIONS unchanged", () => {
  const once = appendNodeRequireOption("--enable-source-maps", "/a/preload.cjs");
  assert.equal(appendNodeRequireOption(once, "/a/preload.cjs"), once);
});

test("a preload path with spaces is quoted", () => {
  assert.equal(appendNodeRequireOption(undefined, "/My Apps/preload.cjs"), '--require "/My Apps/preload.cjs"');
});
