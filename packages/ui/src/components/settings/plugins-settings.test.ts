import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginInfo, WorkspaceSummary } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { PluginsSettings } from "./PluginsSettings";

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

const workspace = (name: string): WorkspaceSummary => ({ name, path: `/w/${name}`, projectCount: 1 });

/** Server-render the section against a store snapshot (zustand renders its initial state on the server). */
function render(t: test.TestContext, state: Record<string, unknown>): string {
  const initial = useAppStore.getInitialState();
  const previous = { ...initial };
  t.after(() => Object.assign(initial, previous));
  Object.assign(initial, state);
  return renderToStaticMarkup(createElement(PluginsSettings));
}

/** The plugin's two toggles: its list row's and the detail panel's. */
function switches(html: string): string[] {
  const found = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
  assert.equal(found.length, 2);
  return found;
}

test("an installed plugin shows its list row, detail and scoped toggles", (t) => {
  const html = render(t, {
    workspaces: [workspace("acme"), workspace("lab")],
    currentWorkspace: "lab",
    plugins: [
      plugin({
        enabledWorkspaces: ["lab"],
        current: { version: "0.7.0", integrity: "sha512-a", installedAt: "2026-10-14T10:00:00.000Z" },
        previous: { version: "0.6.0", integrity: "sha512-b", installedAt: "2026-10-01T10:00:00.000Z" },
        lastError: { at: "2026-10-14T11:00:00.000Z", step: "download", message: "ETIMEDOUT" }
      })
    ]
  });
  assert.match(html, /Search workspace plugins…/);
  assert.match(html, /Scope:.*lab/);
  assert.match(html, />Installed</);
  assert.match(html, /href="https:\/\/github.com\/pingdotgg\/ts-rust"[^>]*target="_blank"/);
  assert.match(html, /Community/);
  assert.match(html, /v0\.7\.0/);
  assert.match(html, /Roll back to v0\.6\.0/);
  assert.match(html, /download: ETIMEDOUT/);
  assert.match(html, /Enable for this workspace/);
  // The row and the detail toggle both show the scope's state and are usable.
  for (const toggle of switches(html)) {
    assert.match(toggle, /aria-checked="true"/);
    assert.match(toggle, /aria-label="Enable Better TS Typecheck for lab"/);
    assert.doesNotMatch(toggle, / disabled=""/);
  }
  // Removing downloads waits until no workspace has the plugin on.
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Remove downloads/);
  assert.doesNotMatch(html, /Install from file|Enable plugin/);
});

test("without an install, no rollback is offered and the version reads as not installed", (t) => {
  const html = render(t, { workspaces: [workspace("acme")], plugins: [plugin()] });
  assert.match(html, /Not installed/);
  assert.match(html, /Never checked/);
  assert.doesNotMatch(html, /Roll back/);
  assert.doesNotMatch(html, />Installed</);
  for (const toggle of switches(html)) assert.match(toggle, /aria-checked="false"/);
});

test("an unsupported platform shows the plugin as unavailable with its toggles disabled", (t) => {
  const html = render(t, { workspaces: [workspace("acme")], plugins: [plugin({ platform: "unsupported" })] });
  assert.match(html, /Unavailable on this server/);
  for (const toggle of switches(html)) assert.match(toggle, / disabled=""/);
});

test("without workspaces the section explains why nothing can be turned on", (t) => {
  const html = render(t, { workspaces: [], currentWorkspace: null, currentProject: null, plugins: [plugin()] });
  assert.match(html, /No workspaces yet/);
  for (const toggle of switches(html)) assert.match(toggle, / disabled=""/);
});

test("a global plugin has one server-wide switch and no version controls, even without workspaces", (t) => {
  const html = render(t, {
    workspaces: [],
    currentWorkspace: null,
    currentProject: null,
    plugins: [
      plugin({
        id: "excalidraw",
        name: "Excalidraw Whiteboard",
        scope: "global",
        updates: false,
        enabled: true,
        source: { label: "excalidraw/excalidraw", url: "https://github.com/excalidraw/excalidraw" }
      })
    ]
  });
  assert.match(html, />Built in</);
  assert.match(html, /Enable on this server/);
  assert.doesNotMatch(html, /Check for updates|Remove downloads|Not installed|Enable for this workspace/);
  for (const toggle of switches(html)) {
    assert.match(toggle, /aria-checked="true"/);
    assert.match(toggle, /aria-label="Enable Excalidraw Whiteboard"/);
    assert.doesNotMatch(toggle, / disabled=""/);
  }
});

test("before the first load the section shows it is loading", (t) => {
  const html = render(t, { workspaces: [workspace("acme")], plugins: null });
  assert.match(html, /Loading plugins…/);
});
