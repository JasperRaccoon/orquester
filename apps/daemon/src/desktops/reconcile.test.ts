import { test } from "node:test";
import assert from "node:assert/strict";
import { type DesktopRecord, desktopRecordSchema } from "@orquester/config";
import { type ReconcileInput, reconcile } from "./reconcile.ts";

function record(id: string, apps: Array<{ id: string; status?: "starting" | "running" | "exited"; exitCode?: number | null }> = []): DesktopRecord {
  return desktopRecordSchema.parse({
    id,
    projectPath: "/w/p",
    createdAt: "2026-09-30T00:00:00.000Z",
    apps: apps.map((app) => ({
      id: app.id,
      desktopId: id,
      command: "xterm",
      cwd: "/w/p",
      status: app.status ?? "running",
      exitCode: app.exitCode ?? null,
      startedAt: "2026-09-30T00:00:00.000Z"
    }))
  });
}

function input(overrides: Partial<ReconcileInput>): ReconcileInput {
  return {
    records: [],
    liveSessions: [],
    windowsBySession: new Map(),
    readyFiles: new Map(),
    hostExitFiles: new Set(),
    appExitFiles: new Map(),
    indexLoaded: true,
    ...overrides
  };
}

test("record + live session + ready + no host.exit → running; apps by window / exit file / neither", () => {
  const result = reconcile(
    input({
      records: [record("d1", [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4", status: "exited", exitCode: 0 }])],
      liveSessions: ["orqsvc-desktop-d1"],
      windowsBySession: new Map([["orqsvc-desktop-d1", ["host", "app-a1", "app-a2"]]]),
      readyFiles: new Map([["d1", 3]]),
      appExitFiles: new Map([["d1", new Map([["a2", 3]])]])
    })
  );
  assert.deepEqual(result.reap, []);
  assert.deepEqual(result.desktops, [
    {
      id: "d1",
      status: "running",
      display: 3,
      killSession: false,
      apps: [
        { id: "a1", status: "running", exitCode: null },
        // An exit file wins over a window still closing.
        { id: "a2", status: "exited", exitCode: 3 },
        // Neither a window nor an exit file.
        { id: "a3", status: "exited", exitCode: null },
        // Already exited: keeps its recorded code.
        { id: "a4", status: "exited", exitCode: 0 }
      ]
    }
  ]);
});

test("record without a live session → stopped; apps exited (exit file code or null)", () => {
  const result = reconcile(
    input({
      records: [record("d1", [{ id: "a1" }, { id: "a2" }])],
      readyFiles: new Map([["d1", 3]]),
      appExitFiles: new Map([["d1", new Map([["a1", 137]])]])
    })
  );
  assert.deepEqual(result.desktops, [
    {
      id: "d1",
      status: "stopped",
      display: null,
      killSession: false,
      apps: [
        { id: "a1", status: "exited", exitCode: 137 },
        { id: "a2", status: "exited", exitCode: null }
      ]
    }
  ]);
});

test("live session whose host exited, never became ready, or lost its host window → stopped, session killed", () => {
  const live = ["orqsvc-desktop-d1", "orqsvc-desktop-d2", "orqsvc-desktop-d3"];
  const result = reconcile(
    input({
      records: [record("d1"), record("d2"), record("d3")],
      liveSessions: live,
      windowsBySession: new Map([
        ["orqsvc-desktop-d1", ["host"]],
        ["orqsvc-desktop-d2", ["host"]],
        ["orqsvc-desktop-d3", ["app-x"]]
      ]),
      readyFiles: new Map([
        ["d1", 1],
        ["d3", 3]
      ]),
      hostExitFiles: new Set(["d1"])
    })
  );
  for (const desktop of result.desktops) {
    assert.equal(desktop.status, "stopped", desktop.id);
    assert.equal(desktop.killSession, true, desktop.id);
  }
});

test("live session without a record is reaped only when the index loaded", () => {
  const base = {
    records: [record("d1")],
    liveSessions: ["orqsvc-desktop-d1", "orqsvc-desktop-orphan"],
    windowsBySession: new Map([["orqsvc-desktop-d1", ["host"]]]),
    readyFiles: new Map([["d1", 0]])
  };
  assert.deepEqual(reconcile(input({ ...base, indexLoaded: true })).reap, ["orqsvc-desktop-orphan"]);
  assert.deepEqual(reconcile(input({ ...base, indexLoaded: false })).reap, []);
});

test("a live session whose record this build could not read is never reaped", () => {
  const result = reconcile(
    input({
      liveSessions: ["orqsvc-desktop-future", "orqsvc-desktop-orphan"],
      claimedIds: ["future"]
    })
  );
  assert.deepEqual(result.reap, ["orqsvc-desktop-orphan"]);
});
