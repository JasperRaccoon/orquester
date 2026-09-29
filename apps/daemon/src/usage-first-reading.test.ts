import assert from "node:assert/strict";
import test from "node:test";

import { UsageService } from "./usage.ts";

test("whenFirstReading waits for the first reading after start, and is bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = new UsageService({
    fetchClaude: async () => {
      await gate;
      return { id: "claude", available: true, stale: false, session: { percent: 7 }, weekly: null };
    },
    readCodex: async () => null,
    getPrefs: async () => ({ enabled: true, agents: {}, chip: "busiest" }),
    now: () => 0
  });
  const bounded = service.whenFirstReading(5);
  t.mock.timers.tick(5);
  await bounded;
  t.after(() => service.stop());
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
