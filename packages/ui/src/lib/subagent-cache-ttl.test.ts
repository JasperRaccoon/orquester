import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubagentCacheTtlStatus } from "@orquester/api";
import { describeSubagentCacheTtl } from "./subagent-cache-ttl.ts";

const day = (iso: string) => iso.slice(5, 10);
const status = (over: Partial<SubagentCacheTtlStatus>): SubagentCacheTtlStatus => ({
  mode: "auto",
  ttl: "1h",
  lastCheck: { at: "2026-10-11T00:00:00.000Z", outcome: "1h", requests: 600, windowDays: 14, changePct: -9.4 },
  nextCheckAt: "2026-10-18T00:00:00.000Z",
  ...over
});
const check = (over: Partial<NonNullable<SubagentCacheTtlStatus["lastCheck"]>>) =>
  status({ lastCheck: { ...status({}).lastCheck!, ...over } });

test("auto on 1h says what the last check found and when the next one is", () => {
  assert.equal(
    describeSubagentCacheTtl(status({}), day),
    "Currently 1h. Last check 10-11: 1h would have cost 9.4% less over 14 days. Next check 10-18."
  );
});

test("auto on 5m says how much more 1h would have cost", () => {
  assert.equal(
    describeSubagentCacheTtl({ ...check({ outcome: "5m", changePct: 7.8 }), ttl: "5m" }, day),
    "Currently 5m. Last check 10-11: 1h would have cost 7.8% more over 14 days. Next check 10-18."
  );
});

test("a check too close to call says the choice stayed", () => {
  assert.equal(
    describeSubagentCacheTtl(check({ outcome: "hold", changePct: -3.2 }), day),
    "Currently 1h. Last check 10-11: 1h would have cost 3.2% less over 14 days, too close to change. Next check 10-18."
  );
  assert.equal(
    describeSubagentCacheTtl(check({ outcome: "hold", changePct: 0 }), day),
    "Currently 1h. Last check 10-11: 1h would have cost the same over 14 days, too close to change. Next check 10-18."
  );
});

test("too little usage says so, with the count", () => {
  assert.equal(
    describeSubagentCacheTtl(
      { ...check({ outcome: "insufficient", requests: 120, changePct: null }), ttl: "5m", nextCheckAt: "2026-10-12T00:00:00.000Z" },
      day
    ),
    "Currently 5m. Last check 10-11: only 120 subagent requests in 14 days, too few to judge. Next check 10-12."
  );
});

test("before the first check it says one is pending", () => {
  assert.equal(
    describeSubagentCacheTtl(status({ ttl: "5m", lastCheck: null, nextCheckAt: null }), day),
    "Currently 5m. The first check runs once recent subagent usage has been read."
  );
});
