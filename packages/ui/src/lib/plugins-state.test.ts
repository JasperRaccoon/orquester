import test from "node:test";
import assert from "node:assert/strict";

import type { PluginInfo } from "@orquester/api";

import {
  isGlobalPluginEnabled,
  parsePluginActionResult,
  parsePluginInfo,
  parsePluginsResponse,
  upsertPluginIn
} from "./plugins-state.ts";

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "ts-rust",
    name: "Better TS Typecheck",
    description: "Runs tsc-rs instead of tsc.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community",
    scope: "workspace",
    updates: true,
    platform: "supported",
    enabled: true,
    enabledWorkspaces: ["acme"],
    current: { version: "0.7.0", integrity: "sha512-a", installedAt: "2026-10-14T10:00:00.000Z" },
    previous: null,
    skippedVersion: null,
    lastCheckAt: "2026-10-14T10:00:00.000Z",
    lastError: null,
    job: "idle",
    ...overrides
  };
}

test("a well-formed plugin parses to the same value", () => {
  const value = plugin({
    previous: { version: "0.6.0", integrity: "sha512-b", installedAt: "2026-10-01T10:00:00.000Z" },
    skippedVersion: "0.7.1",
    lastError: { at: "2026-10-14T11:00:00.000Z", step: "download", message: "ETIMEDOUT" },
    job: "installing"
  });
  assert.deepEqual(parsePluginInfo(value), value);
});

test("absent nullable fields read as null and unknown fields are dropped", () => {
  const sent: Record<string, unknown> = { ...plugin(), extra: 1 };
  for (const key of ["current", "previous", "skippedVersion", "lastCheckAt", "lastError"]) {
    delete sent[key];
  }
  assert.deepEqual(parsePluginInfo(sent), {
    ...plugin(),
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null
  });
});

test("a daemon from before global plugins: a workspace plugin with updates, enabled while on anywhere", () => {
  const sent: Record<string, unknown> = { ...plugin() };
  delete sent.scope;
  delete sent.updates;
  delete sent.enabled;
  assert.deepEqual(parsePluginInfo(sent), plugin());
  assert.equal(parsePluginInfo({ ...sent, enabledWorkspaces: [] })?.enabled, false);
});

test("a global plugin parses, and reads as enabled only when it is on", () => {
  const global = plugin({
    id: "excalidraw",
    name: "Excalidraw Whiteboard",
    scope: "global",
    updates: false,
    enabled: true,
    enabledWorkspaces: [],
    current: null,
    lastCheckAt: null
  });
  assert.deepEqual(parsePluginInfo(global), global);
  assert.equal(isGlobalPluginEnabled([plugin(), global], "excalidraw"), true);
  assert.equal(isGlobalPluginEnabled([plugin(), { ...global, enabled: false }], "excalidraw"), false);
  assert.equal(isGlobalPluginEnabled([plugin()], "ts-rust"), false, "a workspace plugin is not global");
  assert.equal(isGlobalPluginEnabled(null, "excalidraw"), false);
});

test("a plugin with a malformed field is rejected", () => {
  const bad: unknown[] = [
    null,
    [],
    { ...plugin(), id: 1 },
    { ...plugin(), name: undefined },
    { ...plugin(), source: "pingdotgg/ts-rust" },
    { ...plugin(), source: { label: "x" } },
    { ...plugin(), platform: "maybe" },
    { ...plugin(), enabledWorkspaces: "acme" },
    { ...plugin(), enabledWorkspaces: ["acme", 2] },
    { ...plugin(), current: { version: "0.7.0" } },
    { ...plugin(), current: { version: "", integrity: "x", installedAt: "y" } },
    { ...plugin(), previous: "0.6.0" },
    { ...plugin(), skippedVersion: 7 },
    { ...plugin(), lastCheckAt: false },
    { ...plugin(), lastError: { at: "x", step: "download" } },
    { ...plugin(), job: "running" },
    { ...plugin(), scope: "project" },
    { ...plugin(), updates: "yes" },
    { ...plugin(), enabled: 1 }
  ];
  for (const value of bad) {
    assert.equal(parsePluginInfo(value), null, JSON.stringify(value));
  }
});

test("a plugins response parses, leaving out plugin ids this client does not know", () => {
  const known = plugin();
  const parsed = parsePluginsResponse({
    plugins: [known, { id: "future-plugin", name: "Something newer" }]
  });
  assert.deepEqual(parsed, { plugins: [known] });
  assert.deepEqual(parsePluginsResponse({ plugins: [] }), { plugins: [] });
});

test("a plugins response with a malformed known plugin, or not a list, is rejected", () => {
  assert.equal(parsePluginsResponse({ plugins: [{ ...plugin(), job: 3 }] }), null);
  assert.equal(parsePluginsResponse({ plugins: [null] }), null);
  assert.equal(parsePluginsResponse({ plugins: "ts-rust" }), null);
  assert.equal(parsePluginsResponse([plugin()]), null);
  assert.equal(parsePluginsResponse(undefined), null);
});

test("a route's answer yields the plugin whether it is the plugin or the whole list", () => {
  const value = plugin({ enabledWorkspaces: [] });
  assert.deepEqual(parsePluginActionResult(value, "ts-rust"), value);
  assert.deepEqual(parsePluginActionResult({ plugins: [value] }, "ts-rust"), value);
  assert.equal(parsePluginActionResult(undefined, "ts-rust"), null);
  assert.equal(parsePluginActionResult({ ok: true }, "ts-rust"), null);
  assert.equal(parsePluginActionResult({ plugins: [{ ...value, job: "?" }] }, "ts-rust"), null);
});

test("upserting replaces a plugin by id or appends it", () => {
  const before = plugin();
  const after = plugin({ enabledWorkspaces: [] });
  assert.deepEqual(upsertPluginIn([before], after), [after]);
  assert.deepEqual(upsertPluginIn([], after), [after]);
  assert.deepEqual(upsertPluginIn(null, after), [after]);
});
