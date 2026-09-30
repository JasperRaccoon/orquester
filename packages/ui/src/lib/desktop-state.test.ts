import test from "node:test";
import assert from "node:assert/strict";

import type { DesktopAppSummary, DesktopSummary } from "@orquester/api";

import {
  applyDesktopWindows,
  desktopAppLabel,
  desktopCloseMessage,
  desktopTabTitle,
  parseDesktopList,
  parseDesktopSummary,
  parseDesktopWindowsPayload,
  runningDesktopApps,
  upsertDesktopApp,
  upsertDesktopIn
} from "./desktop-state.ts";

function desktop(overrides: Partial<DesktopSummary> & { id: string }): DesktopSummary {
  return {
    projectPath: "/w/acme/app",
    title: `Desktop ${overrides.id}`,
    order: 0,
    createdAt: "2026-09-30T10:00:00.000Z",
    display: 10,
    size: { width: 1280, height: 800 },
    renderThreads: 4,
    status: "running",
    audio: "available",
    apps: [],
    windows: [],
    activeWindowId: null,
    ...overrides
  };
}

function app(id: string, command: string, status: DesktopAppSummary["status"]): DesktopAppSummary {
  return {
    id,
    desktopId: "d1",
    command,
    cwd: "/w/acme/app",
    env: {},
    status,
    exitCode: null,
    startedAt: "2026-09-30T10:00:00.000Z",
    exitedAt: null
  };
}

const win = (id: string, title: string) => ({ id, title, appId: null, wmClass: "XTerm", maximized: false });

test("a well-formed summary parses; unknown fields ride along", () => {
  const parsed = parseDesktopSummary({ ...desktop({ id: "d1" }), future: 1 });
  assert.equal(parsed?.id, "d1");
  assert.equal((parsed as unknown as { future: number }).future, 1);
});

test("malformed summaries are refused", () => {
  assert.equal(parseDesktopSummary(null), null);
  assert.equal(parseDesktopSummary({ ...desktop({ id: "d1" }), status: "exploded" }), null);
  assert.equal(parseDesktopSummary({ ...desktop({ id: "d1" }), windows: [{ id: 3 }] }), null);
  assert.equal(parseDesktopSummary({ ...desktop({ id: "d1" }), apps: "none" }), null);
  assert.equal(parseDesktopSummary({ ...desktop({ id: "" }) }), null);
  assert.deepEqual(
    parseDesktopList([desktop({ id: "a" }), { id: "b" }]).map((d) => d.id),
    ["a"]
  );
  assert.deepEqual(parseDesktopList({ nope: true }), []);
});

test("a windows payload is checked and patches only its desktop", () => {
  const list = [desktop({ id: "d1" }), desktop({ id: "d2" })];
  const payload = parseDesktopWindowsPayload({
    desktopId: "d2",
    windows: [win("0x1", "xterm"), win("0x2", "Editor")],
    activeWindowId: "0x2"
  });
  assert.ok(payload);
  const next = applyDesktopWindows(list, payload);
  assert.equal(next[0], list[0], "the other desktop keeps its identity");
  assert.equal(next[1]?.windows.length, 2);
  assert.equal(next[1]?.activeWindowId, "0x2");
  assert.equal(applyDesktopWindows(list, { ...payload, desktopId: "gone" }), list, "unknown desktop: same array");

  assert.equal(parseDesktopWindowsPayload({ desktopId: "d1", windows: [{ id: "0x1" }], activeWindowId: null }), null);
  assert.equal(parseDesktopWindowsPayload({ desktopId: 1, windows: [], activeWindowId: null }), null);
  assert.deepEqual(parseDesktopWindowsPayload({ desktopId: "d1", windows: [] }), {
    desktopId: "d1",
    windows: [],
    activeWindowId: null
  });
});

test("upserts replace by id or append", () => {
  const list = [desktop({ id: "d1" })];
  assert.equal(upsertDesktopIn(list, desktop({ id: "d2" })).length, 2);
  const replaced = upsertDesktopIn(list, desktop({ id: "d1", title: "Renamed" }));
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.title, "Renamed");

  const withApp = upsertDesktopApp(list, "d1", app("a1", "xterm", "starting"));
  assert.equal(withApp[0]?.apps.length, 1);
  const updated = upsertDesktopApp(withApp, "d1", app("a1", "xterm", "running"));
  assert.equal(updated[0]?.apps.length, 1);
  assert.equal(updated[0]?.apps[0]?.status, "running");
  assert.equal(upsertDesktopApp(list, "gone", app("a1", "xterm", "running")), list);
});

test("tab title adds the active window's title", () => {
  assert.equal(desktopTabTitle(desktop({ id: "d1", title: "Main" })), "Main");
  assert.equal(
    desktopTabTitle(
      desktop({ id: "d1", title: "Main", windows: [win("0x1", "xterm"), win("0x2", "Editor")], activeWindowId: "0x2" })
    ),
    "Main · Editor"
  );
  assert.equal(desktopTabTitle(desktop({ id: "d1", title: "", activeWindowId: "0x9" })), "Desktop");
});

test("the close message names the running apps", () => {
  const d = desktop({
    id: "d1",
    title: "Main",
    apps: [
      app("a1", "./build/bin/jasperengine-editor --project x", "running"),
      app("a2", "DISPLAY_SCALE=2 xterm", "starting"),
      app("a3", "mousepad", "exited")
    ]
  });
  assert.deepEqual(runningDesktopApps(d).map((a) => a.id), ["a1", "a2"]);
  assert.equal(
    desktopCloseMessage(d),
    "Stop desktop “Main”? 2 apps are running: jasperengine-editor, xterm. They will be terminated."
  );
  assert.match(desktopCloseMessage({ ...d, apps: [d.apps[0]!] }), /1 app is running: jasperengine-editor\./);
  assert.equal(desktopAppLabel({ command: "  " }), "app");
});
