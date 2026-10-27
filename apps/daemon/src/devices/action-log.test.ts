import assert from "node:assert/strict";
import test from "node:test";

import { DeviceActionLog } from "./action-log.ts";

test("the action log keeps the last N rows per lease, stamped, summaries on one short line", () => {
  const log = new DeviceActionLog({ now: () => new Date("2026-10-27T10:00:00.000Z") });
  for (let i = 0; i < 202; i += 1) log.append("l1", { actor: "agent", kind: "tap", summary: `Tap\n${i}`, ok: true, point: { x: i, y: i } });
  log.append("l2", { actor: "user", kind: "type", summary: "x".repeat(500), ok: false, error: "nope" });
  const kept = log.list("l1");
  assert.equal(kept.length, 200);
  assert.deepEqual([kept[0]!.summary, kept[0]!.point?.x, kept.at(-1)!.summary, kept.at(-1)!.point?.x], ["Tap 2", 2, "Tap 201", 201]);
  assert.equal(new Set(kept.map((row) => row.id)).size, 200);
  const [row] = log.list("l2");
  assert.equal(row!.leaseId, "l2");
  assert.equal(row!.at, "2026-10-27T10:00:00.000Z");
  assert.ok(row!.summary.length < 500);
  log.forget("l1");
  assert.deepEqual(log.list("l1"), []);
  // A copy: callers cannot change the log.
  log.list("l2").pop();
  assert.equal(log.list("l2").length, 1);
});
