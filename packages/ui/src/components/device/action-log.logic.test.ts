import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceActionEntry } from "@orquester/api";

import { actionLogRows } from "./action-log.logic.ts";

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
      [row("a", "2026-10-27T10:00:02.000Z"), row("b", "2026-10-27T10:00:05.000Z", { ok: false, error: "DEVICE_CONTROLLED_BY_USER" }), row("a", "2026-10-27T10:00:02.000Z")],
      [{ id: "u1", leaseId: "l1", at: "2026-10-27T10:00:03.000Z", summary: "Pressed Home", ok: true }],
      "Claude"
    );
    assert.deepEqual(rows.map(({ who, text, failed }) => ({ who, text, failed })), [
      { who: "Claude", text: "Tapped a", failed: false },
      { who: "You", text: "Pressed Home", failed: false },
      { who: "Claude", text: "Tapped b", failed: true }
    ]);
    assert.equal(rows[2]!.error, "DEVICE_CONTROLLED_BY_USER");
  });
});
