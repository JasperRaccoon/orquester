import test from "node:test";
import assert from "node:assert/strict";

import type { PluginInfo } from "@orquester/api";

import {
  FIRST_ENABLE_MESSAGE,
  defaultPluginScope,
  filterPlugins,
  pluginControls,
  pluginEnabledIn,
  pluginErrorText,
  pluginJobLabel,
  pluginSourceHref,
  pluginToggleDecision,
  selectedPlugin
} from "./plugins.logic.ts";

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
    enabled: false,
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle",
    ...overrides
  };
}

const installed = { version: "0.7.0", integrity: "sha512-a", installedAt: "2026-10-14T10:00:00.000Z" };
const older = { version: "0.6.0", integrity: "sha512-b", installedAt: "2026-10-01T10:00:00.000Z" };

test("the scope is the picked workspace, else the active one, else the first", () => {
  const workspaces = ["acme", "jaspersito", "lab"];
  assert.equal(defaultPluginScope(workspaces, "jaspersito", "lab"), "lab");
  assert.equal(defaultPluginScope(workspaces, "jaspersito", null), "jaspersito");
  assert.equal(defaultPluginScope(workspaces, null, null), "acme");
  // A picked or active workspace that no longer exists falls through.
  assert.equal(defaultPluginScope(workspaces, "jaspersito", "deleted"), "jaspersito");
  assert.equal(defaultPluginScope(workspaces, "deleted", null), "acme");
  assert.equal(defaultPluginScope([], "jaspersito", "lab"), null);
});

test("search matches name and description, case-insensitively", () => {
  const ts = plugin();
  assert.deepEqual(filterPlugins([ts], ""), [ts]);
  assert.deepEqual(filterPlugins([ts], "   "), [ts]);
  assert.deepEqual(filterPlugins([ts], "better ts"), [ts]);
  assert.deepEqual(filterPlugins([ts], "TSC-RS"), [ts]);
  assert.deepEqual(filterPlugins([ts], "  typecheck "), [ts]);
  assert.deepEqual(filterPlugins([ts], "eslint"), []);
});

test("the detail panel shows the selected plugin while listed, else the first", () => {
  const ts = plugin();
  assert.equal(selectedPlugin([ts], "ts-rust"), ts);
  assert.equal(selectedPlugin([ts], null), ts);
  assert.equal(selectedPlugin([], "ts-rust"), null);
});

test("a plugin is on for the scope only when the scope is in its enabled workspaces", () => {
  const ts = plugin({ enabledWorkspaces: ["acme"] });
  assert.equal(pluginEnabledIn(ts, "acme"), true);
  assert.equal(pluginEnabledIn(ts, "lab"), false);
  assert.equal(pluginEnabledIn(ts, null), false);
});

test("turning a plugin on where it is on nowhere asks first; other flips go ahead", () => {
  assert.equal(pluginToggleDecision(plugin(), "acme", true), "confirm");
  assert.equal(pluginToggleDecision(plugin({ enabledWorkspaces: ["lab"] }), "acme", true), "apply");
  assert.equal(pluginToggleDecision(plugin({ enabledWorkspaces: ["acme"] }), "acme", false), "apply");
  assert.equal(pluginToggleDecision(plugin(), null, true), "blocked");
  assert.equal(pluginToggleDecision(plugin({ platform: "unsupported" }), "acme", true), "blocked");
  assert.equal(
    pluginToggleDecision(plugin({ platform: "unsupported", enabledWorkspaces: ["acme"] }), "acme", false),
    "blocked"
  );
});

test("a global plugin: its own switch, no scope needed, no confirmation, no version actions", () => {
  const whiteboard = plugin({ id: "excalidraw", scope: "global", updates: false, enabled: true });
  assert.equal(pluginEnabledIn(whiteboard, null), true);
  assert.equal(pluginEnabledIn({ ...whiteboard, enabled: false }, "acme"), false);
  assert.equal(pluginToggleDecision({ ...whiteboard, enabled: false }, null, true), "apply");
  assert.equal(pluginToggleDecision(whiteboard, "acme", false), "apply");
  assert.deepEqual(pluginControls(whiteboard, null, false), {
    toggle: true,
    checkForUpdates: false,
    showRollback: false,
    rollback: false,
    removeDownloads: false
  });
  assert.equal(pluginControls(whiteboard, null, true).toggle, false);
});

test("the first-enable confirmation says what the owner approved", () => {
  assert.equal(
    FIRST_ENABLE_MESSAGE,
    "tsc-rs runs TypeScript 7. Projects whose tsconfig or code isn't TS 7-ready will fail their typecheck while this is on. Tabs, chats and workflow runs already open keep the normal tsc until reopened."
  );
});

test("an idle, installed, unused plugin allows every action", () => {
  assert.deepEqual(pluginControls(plugin({ current: installed, previous: older }), "acme", false), {
    toggle: true,
    checkForUpdates: true,
    showRollback: true,
    rollback: true,
    removeDownloads: true
  });
});

test("roll back is shown only with a previous version", () => {
  const controls = pluginControls(plugin({ current: installed }), "acme", false);
  assert.equal(controls.showRollback, false);
  assert.equal(controls.rollback, false);
});

test("remove downloads needs a download and no enabled workspace", () => {
  assert.equal(pluginControls(plugin(), "acme", false).removeDownloads, false);
  assert.equal(
    pluginControls(plugin({ current: installed, enabledWorkspaces: ["lab"] }), "acme", false).removeDownloads,
    false
  );
  assert.equal(pluginControls(plugin({ current: installed }), "acme", false).removeDownloads, true);
});

test("a running job blocks the version actions but not the toggle", () => {
  for (const job of ["checking", "installing"] as const) {
    const controls = pluginControls(plugin({ current: installed, previous: older, job }), "acme", false);
    assert.deepEqual(controls, {
      toggle: true,
      checkForUpdates: false,
      showRollback: true,
      rollback: false,
      removeDownloads: false
    });
  }
});

test("a request in flight blocks every control", () => {
  assert.deepEqual(pluginControls(plugin({ current: installed, previous: older }), "acme", true), {
    toggle: false,
    checkForUpdates: false,
    showRollback: true,
    rollback: false,
    removeDownloads: false
  });
});

test("an unsupported platform or a missing workspace disables the toggle", () => {
  const unsupported = pluginControls(plugin({ platform: "unsupported" }), "acme", false);
  assert.equal(unsupported.toggle, false);
  assert.equal(unsupported.checkForUpdates, false);
  assert.equal(unsupported.rollback, false);
  assert.equal(pluginControls(plugin(), null, false).toggle, false);
  // The version actions do not depend on a workspace.
  assert.equal(pluginControls(plugin(), null, false).checkForUpdates, true);
});

test("job labels and the last error read as the panel shows them", () => {
  assert.equal(pluginJobLabel("idle"), null);
  assert.equal(pluginJobLabel("checking"), "Checking for updates…");
  assert.equal(pluginJobLabel("installing"), "Installing…");
  assert.equal(
    pluginErrorText({ at: "2026-10-14T10:00:00.000Z", step: "smoke-test", message: "exit 1" }),
    "smoke-test: exit 1"
  );
});

test("the source link renders only for a web address", () => {
  assert.equal(pluginSourceHref("https://github.com/pingdotgg/ts-rust"), "https://github.com/pingdotgg/ts-rust");
  assert.equal(pluginSourceHref("http://example.com/x"), "http://example.com/x");
  assert.equal(pluginSourceHref("javascript:alert(1)"), null);
  assert.equal(pluginSourceHref("file:///etc/passwd"), null);
  assert.equal(pluginSourceHref("not a url"), null);
});
