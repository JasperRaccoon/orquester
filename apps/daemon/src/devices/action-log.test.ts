import assert from "node:assert/strict";
import test from "node:test";

import { DeviceActionLog } from "./action-log.ts";

test("the action log keeps the last N rows per lease, stamped, summaries on one short line", () => {
  let n = 0;
  const log = new DeviceActionLog({ limit: 3, now: () => new Date("2026-10-27T10:00:00.000Z"), id: () => `a${(n += 1)}` });
  for (let i = 0; i < 5; i += 1) log.append("l1", { actor: "agent", kind: "tap", summary: `Tap\n${i}`, ok: true, point: { x: i, y: i } });
  log.append("l2", { actor: "user", kind: "type", summary: "x".repeat(500), ok: false, error: "nope" });
  assert.deepEqual(log.list("l1").map((entry) => [entry.id, entry.summary, entry.point?.x]), [
    ["a3", "Tap 2", 2],
    ["a4", "Tap 3", 3],
    ["a5", "Tap 4", 4]
  ]);
  const [row] = log.list("l2");
  assert.equal(row!.leaseId, "l2");
  assert.equal(row!.at, "2026-10-27T10:00:00.000Z");
  assert.equal(row!.summary.length, 200);
  log.forget("l1");
  assert.deepEqual(log.list("l1"), []);
  // A copy: callers cannot change the log.
  log.list("l2").pop();
  assert.equal(log.list("l2").length, 1);
});
