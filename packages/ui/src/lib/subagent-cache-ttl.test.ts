import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubagentCacheTtlStatus } from "@orquester/api";
import { describeSubagentCacheTtl } from "./subagent-cache-ttl.ts";

const status = (over: Partial<SubagentCacheTtlStatus>): SubagentCacheTtlStatus => ({
  mode: "auto",
  ttl: "1h",
  lastCheck: { at: "2026-10-11T00:00:00.000Z", outcome: "1h", requests: 600, windowDays: 14, changePct: -9.4 },
  nextCheckAt: "2026-10-18T00:00:00.000Z",
  ...over
});
const check = (over: Partial<NonNullable<SubagentCacheTtlStatus["lastCheck"]>>) =>
  status({ lastCheck: { ...status({}).lastCheck!, ...over } });

test("auto reports the selected TTL and signed 1h cost comparison", () => {
  const cheaper = describeSubagentCacheTtl(status({}));
  assert.match(cheaper, /currently\s+1h/i);
  assert.match(cheaper, /9\.4% less/);
  assert.match(cheaper, /14 days/);
  const dearer = describeSubagentCacheTtl({ ...check({ outcome: "5m", changePct: 7.8 }), ttl: "5m" });
  assert.match(dearer, /currently\s+5m/i);
  assert.match(dearer, /7\.8% more/);
});

test("a held choice explains the comparison, including equal cost", () => {
  const held = describeSubagentCacheTtl(check({ outcome: "hold", changePct: -3.2 }));
  assert.match(held, /3\.2% less/);
  assert.match(held, /too close/);
  assert.match(describeSubagentCacheTtl(check({ outcome: "hold", changePct: 0 })), /the same/);
});

test("insufficient usage reports the request count and observation window", () => {
  const description = describeSubagentCacheTtl(check({ outcome: "insufficient", requests: 120, changePct: null }));
  assert.match(description, /\b120\b/);
  assert.match(description, /14 days/);
});

test("before the first check the selected TTL is still reported", () => {
  assert.match(describeSubagentCacheTtl(status({ ttl: "5m", lastCheck: null, nextCheckAt: null })), /currently\s+5m/i);
});
