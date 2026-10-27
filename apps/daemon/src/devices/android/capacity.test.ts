import assert from "node:assert/strict";
import test from "node:test";

import { localCapacity } from "./capacity.ts";

const GB = 1024 ** 3;

test("capacity: min(setting, running + (MemAvailable − 8 GB) / 3.2 GB); active ≈ threads / 8", () => {
  // The spike host: 61 GB, 16 threads → 8 booted? (55 GB free − 8) / 3.2 = 14, clamped by the setting 6.
  assert.deepEqual(localCapacity({ maxLocalDevices: 6, memAvailableBytes: 55 * GB, running: 0, threads: 16 }), { total: 6, active: 2 });
  assert.deepEqual(localCapacity({ maxLocalDevices: 32, memAvailableBytes: 34 * GB, running: 0, threads: 16 }), { total: 8, active: 2 });
  // Running emulators already took their RAM out of MemAvailable: they still count.
  assert.equal(localCapacity({ maxLocalDevices: 32, memAvailableBytes: 14 * GB, running: 3, threads: 8 }).total, 4);
  assert.equal(localCapacity({ maxLocalDevices: 6, memAvailableBytes: 6 * GB, running: 0, threads: 4 }).total, 0);
  assert.equal(localCapacity({ maxLocalDevices: 6, memAvailableBytes: 6 * GB, running: 0, threads: 4 }).active, 1);
  assert.equal(localCapacity({ maxLocalDevices: 5, memAvailableBytes: null, running: 0, threads: 16 }).total, 5);
});
