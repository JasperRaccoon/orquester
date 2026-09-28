import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageResponse } from "@orquester/api";
import { usageView } from "./usage-view.ts";

const now = Date.parse("2026-09-22T12:00:00.000Z");

test("usageView preserves scoped percentages, reset instants, freshness and account auth state", () => {
  const res: UsageResponse = { agents: [
    { id: "claude", available: true, stale: false, plan: "Max 20x", session: { percent: 7 }, weekly: { percent: 2 }, asOf: "2026-09-22T11:37:00.000Z",
      accounts: [{ id: "acc-1", label: "jasperclaude", available: true, stale: false, plan: "Max 20x", session: { percent: 7, resetsAt: "2026-09-22T16:44:00.000Z" }, weekly: { percent: 2, resetsAt: "2026-09-24T21:14:00.000Z" }, scopedWindows: [{ label: "Fable", percent: 3, resetsAt: "2026-09-24T21:14:00.000Z" }], asOf: "2026-09-22T11:37:00.000Z" }],
      system: { id: "system", label: "System", available: true, stale: true, session: null, weekly: null },
      aggregate: { strategy: "worst-account", accountCount: 1, staleAccountCount: 0 } },
    { id: "grok", available: true, stale: false, session: null, weekly: { percent: 0, resetsAt: "2026-09-26T13:35:00.000Z" }, plan: "SuperGrok", asOf: "2026-09-22T11:59:00.000Z" }
  ] };
  const accounts = [{ id: "acc-1", agent: "claude" as const, label: "jasperclaude", email: "j@x.io", plan: "max", needsReauth: true, createdAt: "", importedAt: "" }];
  const v = usageView(res, accounts, now);
  assert.equal(v.agents[0].ageMinutes, 23); assert.equal(v.agents[0].plan, "Max 20x");
  const acc = v.agents[0].accounts[0];
  assert.equal(acc.label, "jasperclaude"); assert.equal(acc.needsReauth, true); assert.equal(acc.email, "j@x.io");
  assert.deepEqual(acc.windows.map(({ id, percentUsed, resetsAt }) => ({ id, percentUsed, resetsAt })), [
    { id: "session", percentUsed: 7, resetsAt: "2026-09-22T16:44:00.000Z" },
    { id: "weekly", percentUsed: 2, resetsAt: "2026-09-24T21:14:00.000Z" },
    { id: "scoped:Fable", percentUsed: 3, resetsAt: "2026-09-24T21:14:00.000Z" }
  ]);
  assert.deepEqual(v.agents[0].system, { id: "system", label: "System", available: true, stale: true, windows: [] });
  assert.deepEqual(v.agents[0].aggregate, { strategy: "worst-account", accountCount: 1, staleAccountCount: 0 });
  assert.equal(v.agents[0].windows, undefined);
  assert.deepEqual(v.agents[1].accounts, []);
  assert.deepEqual(v.agents[1].windows?.map(({ id, percentUsed, resetsAt }) => ({ id, percentUsed, resetsAt })), [{ id: "weekly", percentUsed: 0, resetsAt: "2026-09-26T13:35:00.000Z" }]);
});
