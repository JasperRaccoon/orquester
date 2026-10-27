import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceActionEntry } from "@orquester/api";

import { actionLogHeadline, actionLogRows, gestureSummary, visibleRange } from "./action-log.logic.ts";

const row = (id: string, at: string, overrides: Partial<DeviceActionEntry> = {}): DeviceActionEntry => ({
  id,
  leaseId: "l1",
  at,
  actor: "agent",
  kind: "tap",
  summary: `Tapped ${id}`,
  ok: true,
  ...overrides
});

describe("action log reducer", () => {
  it("merges the daemon's log with the panel's own actions, by time, de-duplicated, failures marked", () => {
    const rows = actionLogRows(
      [row("a", "2026-10-27T10:00:02.000Z"), row("b", "2026-10-27T10:00:05.000Z", { ok: false, error: "DEVICE_CONTROLLED_BY_USER\n wait" }), row("a", "2026-10-27T10:00:09.000Z")],
      [{ id: "u1", leaseId: "l1", at: "2026-10-27T10:00:03.000Z", summary: "Pressed Home", ok: true }],
      "Claude"
    );
    assert.deepEqual(rows.map((r) => [r.id, r.who, r.text, r.failed]), [
      ["a", "Claude", "Tapped a", false],
      ["local:u1", "You", "Pressed Home", false],
      ["b", "Claude", "Tapped b", true]
    ]);
    assert.equal(rows[2]!.error, "DEVICE_CONTROLLED_BY_USER wait");
    assert.match(rows[0]!.time, /^\d\d:\d\d:\d\d$/);
  });
  it("drops unreadable times, keeps the newest rows past the limit, and keeps equal times in order", () => {
    const rows = actionLogRows([row("x", "not a time"), row("p", "2026-10-27T10:00:00.000Z"), row("q", "2026-10-27T10:00:00.000Z"), row("r", "2026-10-27T10:00:01.000Z")], [], "Codex", 2);
    assert.deepEqual(rows.map((r) => r.id), ["q", "r"]);
    const failedLocal = actionLogRows([], [{ id: "s", leaseId: "l1", at: "2026-10-27T10:00:00.000Z", summary: "Screenshot", ok: false }], "Codex");
    assert.equal(failedLocal[0]!.error, "Failed");
  });
  it("headline", () => {
    assert.deepEqual(actionLogHeadline([]), { count: "0 actions", last: null });
    const rows = actionLogRows([row("a", "2026-10-27T10:00:00.000Z")], [], "Claude");
    assert.equal(actionLogHeadline(rows).count, "1 action");
  });
  it("gesture summaries", () => {
    assert.equal(gestureSummary({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }, 100), "Tapped the screen");
    assert.equal(gestureSummary({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 800), "Long-pressed the screen");
    assert.equal(gestureSummary({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 200), "Swiped up");
    assert.equal(gestureSummary({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.55 }, 200), "Swiped right");
  });
  it("virtualization window", () => {
    assert.deepEqual(visibleRange(0, 100, 25, 1000, 2), { start: 0, end: 7 });
    assert.deepEqual(visibleRange(2500, 100, 25, 1000, 2), { start: 98, end: 107 });
    assert.deepEqual(visibleRange(1e9, 100, 25, 10, 2), { start: 8, end: 10 });
    assert.deepEqual(visibleRange(0, 100, 25, 0), { start: 0, end: 0 });
  });
});
