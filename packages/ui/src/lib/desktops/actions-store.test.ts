import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { DesktopActionEntry } from "@orquester/api";

import {
  applyDesktopActionEvent,
  desktopActionsStore,
  dropDesktopActions,
  loadDesktopActionLog,
  resetDesktopActions,
  setDesktopActionsViewing
} from "./actions-store.ts";

const entry = (id: string, second: number): DesktopActionEntry => ({
  id,
  at: new Date(Date.UTC(2026, 10, 10, 10, 0, second)).toISOString(),
  actor: { kind: "external", label: "MCP client" },
  kind: "click",
  summary: "Clicked",
  ok: true
});
const ring = (id = "d1") => desktopActionsStore.getState().rings[id];

describe("desktop actions store", () => {
  beforeEach(() => resetDesktopActions());

  it("follows desktop.action events per desktop and badges them until the popover opens", () => {
    applyDesktopActionEvent({ desktopId: "d1", entry: entry("a", 1) });
    applyDesktopActionEvent({ desktopId: "d1", entry: { id: "bad" } });
    applyDesktopActionEvent({ desktopId: "d2", entry: entry("b", 2) });
    assert.deepEqual(ring()?.entries.map((e) => e.id), ["a"]);
    assert.equal(ring()?.unseen, 1);
    setDesktopActionsViewing("d1", true);
    assert.equal(ring()?.unseen, 0);
    applyDesktopActionEvent({ desktopId: "d1", entry: entry("c", 3) });
    assert.equal(ring()?.unseen, 0);
    setDesktopActionsViewing("d1", false);
    applyDesktopActionEvent({ desktopId: "d1", entry: entry("d", 4) });
    assert.equal(ring()?.unseen, 1);
    dropDesktopActions("d1");
    assert.equal(ring(), undefined);
    assert.equal(ring("d2")?.entries.length, 1);
  });

  it("loads the daemon's log once, as history; an older daemon without the route reads as empty", async () => {
    let calls = 0;
    const api = {
      desktopActionLog: async () => {
        calls += 1;
        return { entries: [entry("old", 1), { junk: true }] };
      }
    };
    await loadDesktopActionLog(api as never, "d1");
    await loadDesktopActionLog(api as never, "d1");
    assert.equal(calls, 1);
    assert.deepEqual(ring()?.entries.map((e) => e.id), ["old"]);
    assert.equal(ring()?.unseen, 0);

    const missing = { desktopActionLog: async () => Promise.reject(new Error("404")) };
    await assert.rejects(loadDesktopActionLog(missing as never, "d2"));
    assert.equal(ring("d2")?.loaded, true);
    assert.deepEqual(ring("d2")?.entries, []);
  });

  it("drops an answer that arrives after a connection switch", async () => {
    let answer: (value: { entries: DesktopActionEntry[] }) => void = () => undefined;
    const api = { desktopActionLog: () => new Promise<{ entries: DesktopActionEntry[] }>((resolve) => (answer = resolve)) };
    const pending = loadDesktopActionLog(api as never, "d1");
    resetDesktopActions();
    answer({ entries: [entry("stale", 1)] });
    await pending;
    assert.equal(ring(), undefined);
  });
});
