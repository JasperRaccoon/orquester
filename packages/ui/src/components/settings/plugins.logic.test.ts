import test from "node:test";
import assert from "node:assert/strict";

import type { PluginInfo } from "@orquester/api";
import { BOX_KIND_LABELS, type BoxSummary } from "@orquester/api";

import {
  FIRST_ENABLE_MESSAGE,
  filterPlugins,
  pluginControls,
  pluginEngineChange,
  pluginEngineLabel,
  pluginEngineOptions,
  pluginBoxIssues,
  pluginErrorText,
  pluginJobLabel,
  pluginSourceHref,
  pluginToggleDecision,
  secretVaultRows,
  selectedPlugin
} from "./plugins.logic.ts";

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "ts-rust",
    name: "Better TS Typecheck",
    description: "Runs tsc-rs instead of tsc.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community",
    scope: "global",
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

test("turning tsc-rs on asks first; turning it off, or another plugin on, goes ahead", () => {
  assert.equal(pluginToggleDecision(plugin(), true), "confirm");
  assert.equal(pluginToggleDecision(plugin({ enabled: true }), false), "apply");
  assert.equal(pluginToggleDecision(plugin({ platform: "unsupported" }), true), "blocked");
  // On where there is no build (a carried-over plugins.json): it can still be turned off.
  assert.equal(pluginToggleDecision(plugin({ platform: "unsupported", enabled: true }), false), "apply");
});

test("a bundled plugin: no confirmation, no version actions", () => {
  const whiteboard = plugin({ id: "excalidraw", updates: false, enabled: true });
  assert.equal(pluginToggleDecision({ ...whiteboard, enabled: false }, true), "apply");
  assert.equal(pluginToggleDecision(whiteboard, false), "apply");
  assert.deepEqual(pluginControls(whiteboard, false), {
    toggle: true,
    checkForUpdates: false,
    showRollback: false,
    rollback: false,
    removeDownloads: false
  });
  assert.equal(pluginControls(whiteboard, true).toggle, false);
});

test("the first-enable confirmation says what the owner approved", () => {
  assert.equal(
    FIRST_ENABLE_MESSAGE,
    "Both engines, tsrs and tsc-rs, run TypeScript 7. Projects whose tsconfig or code isn't TS 7-ready will fail their typecheck while this is on. Tabs, chats and workflow runs already open keep the normal tsc until reopened."
  );
});

test("an idle, installed, unused plugin allows every action", () => {
  assert.deepEqual(pluginControls(plugin({ current: installed, previous: older }), false), {
    toggle: true,
    checkForUpdates: true,
    showRollback: true,
    rollback: true,
    removeDownloads: true
  });
});

test("roll back is shown only with a previous version", () => {
  const controls = pluginControls(plugin({ current: installed }), false);
  assert.equal(controls.showRollback, false);
  assert.equal(controls.rollback, false);
});

test("remove downloads needs a download and the plugin off", () => {
  assert.equal(pluginControls(plugin(), false).removeDownloads, false);
  assert.equal(pluginControls(plugin({ current: installed, enabled: true }), false).removeDownloads, false);
  assert.equal(pluginControls(plugin({ current: installed }), false).removeDownloads, true);
});

test("a running job blocks the version actions but not the toggle", () => {
  for (const job of ["checking", "installing"] as const) {
    const controls = pluginControls(plugin({ current: installed, previous: older, job }), false);
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
  assert.deepEqual(pluginControls(plugin({ current: installed, previous: older }), true), {
    toggle: false,
    checkForUpdates: false,
    showRollback: true,
    rollback: false,
    removeDownloads: false
  });
});

test("an unsupported platform disables the toggle unless the plugin is on", () => {
  const unsupported = pluginControls(plugin({ platform: "unsupported" }), false);
  assert.equal(unsupported.toggle, false);
  assert.equal(unsupported.checkForUpdates, false);
  assert.equal(unsupported.rollback, false);
  assert.equal(pluginControls(plugin({ platform: "unsupported", enabled: true }), false).toggle, true);
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

const engines: NonNullable<PluginInfo["engines"]> = [
  {
    id: "tsrs",
    label: "tsrs",
    description: "The fastest.",
    source: { label: "oxc-project/tsrs", url: "https://github.com/oxc-project/tsrs" },
    platform: "supported"
  },
  {
    id: "tsc-rs",
    label: "tsc-rs",
    description: "Also runs on Windows.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    platform: "supported"
  }
];

test("the engine control lists each engine, the active one selected, and switches only to another usable one", () => {
  const ts = plugin({ engine: "tsrs", engines });
  assert.deepEqual(
    pluginEngineOptions(ts, false).map((o) => [o.id, o.selected, o.disabled, o.hint]),
    [
      ["tsrs", true, false, null],
      ["tsc-rs", false, false, null]
    ]
  );
  assert.equal(pluginEngineLabel(ts), "tsrs");
  assert.equal(pluginEngineChange(ts, "tsc-rs", false), true);
  assert.equal(pluginEngineChange(ts, "tsrs", false), false, "the active engine is no change");
  assert.equal(pluginEngineChange(ts, "tsc-rs", true), false, "not while a request is in flight");
  assert.ok(pluginEngineOptions(ts, true).every((o) => o.disabled));
});

test("an engine with no build here is disabled with a hint", () => {
  const intelMac = plugin({
    engine: "tsc-rs",
    engines: [{ ...engines[0]!, platform: "unsupported" }, engines[1]!]
  });
  const [tsrs, tscRs] = pluginEngineOptions(intelMac, false);
  assert.equal(tsrs?.disabled, true);
  assert.match(tsrs?.hint ?? "", /No build for this server/);
  assert.equal(tscRs?.selected, true);
  assert.equal(pluginEngineChange(intelMac, "tsrs", false), false);
});

test("a plugin without engines, or from a daemon before the choice, has no engine control", () => {
  assert.deepEqual(pluginEngineOptions(plugin(), false), []);
  assert.deepEqual(pluginEngineOptions(plugin({ engines }), false), [], "no active engine named");
  assert.equal(pluginEngineLabel(plugin()), null);
  assert.equal(pluginEngineChange(plugin(), "tsrs", false), false);
});

test("secretVaultRows: labels each vault by its custom label or key, ordered by workspace then label", () => {
  const vault = (workspace: string, repoKey: string, clonesNeedingAttention = 0) => ({
    workspace,
    repoKey,
    fileCount: 2,
    clonesNeedingAttention
  });
  const rows = secretVaultRows(
    [
      vault("work", "host.example/o/zeta"),
      vault("home", "host.example/o/repo10", 1),
      vault("home", "host.example/o/repo9"),
      vault("work", "host.example/o/alpha")
    ],
    new Map([["host.example/o/zeta", { label: "Aardvark" }]])
  );
  assert.deepEqual(
    rows.map((r) => [r.workspace, r.label, r.clonesNeedingAttention]),
    [
      ["home", "o/repo9", 0],
      ["home", "o/repo10", 1],
      ["work", "Aardvark", 0],
      ["work", "o/alpha", 0]
    ]
  );
  assert.equal(rows[2].repoKey, "host.example/o/zeta");
  assert.equal(rows[2].fileCount, 2);
  assert.deepEqual(
    secretVaultRows([vault("w", "nohost")], new Map()).map((r) => r.label),
    ["nohost"]
  );
});

// boxes: per-box tooling installs in the Status section.
test("pluginBoxIssues lists the failed and unsupported boxes, labelled from the boxes held", () => {
  const held = {
    id: "b1",
    kind: "linux",
    providerLabel: "Hetzner",
    purpose: "project",
    purposeNote: null,
    project: { workspace: "ws", name: "app", path: "/w/ws/app" }
  } as unknown as BoxSummary;
  const at = "2026-10-20T10:00:00.000Z";
  const issues = pluginBoxIssues(
    plugin({
      boxes: [
        { boxId: "b1", state: "failed", message: "smoke test: tsrs exited 1", updatedAt: at },
        { boxId: "b2", state: "unsupported", message: null, updatedAt: at },
        { boxId: "b3", state: "ready", message: "tsrs 0.16.0", updatedAt: at },
        { boxId: "b4", state: "installing", message: null, updatedAt: at }
      ]
    }),
    [held]
  );
  assert.deepEqual(issues, [
    { boxId: "b1", label: `ws / app · ${BOX_KIND_LABELS.linux} on Hetzner`, state: "failed", message: "smoke test: tsrs exited 1" },
    {
      boxId: "b2",
      label: "Box b2",
      state: "unsupported",
      message: "There is no build of this plugin for the box's operating system and processor."
    }
  ]);
  assert.deepEqual(pluginBoxIssues(plugin(), [held]), [], "a plugin without per-box tooling has none");
});
