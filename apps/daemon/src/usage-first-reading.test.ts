import assert from "node:assert/strict";
import test from "node:test";

import { UsageService } from "./usage.ts";

test("whenFirstReading waits for the first reading after start, and is bounded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = new UsageService({
    fetchClaude: async () => {
      await gate;
      return { id: "claude", available: true, stale: false, session: { percent: 7 }, weekly: null };
    },
    readCodex: async () => null,
    getPrefs: async () => ({ enabled: true, agents: {}, chip: "busiest" })
  });
  // Not started: the bound answers. (Its timer is unref'd, so the test keeps the loop alive.)
  const keepAlive = setInterval(() => undefined, 1_000);
  await service.whenFirstReading(5);
  clearInterval(keepAlive);
  service.start();
  let done = false;
  const waiting = service.whenFirstReading(60_000).then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  release();
  await waiting;
  assert.equal((await service.snapshot()).agents[0]?.session?.percent, 7);
  service.stop();
});
