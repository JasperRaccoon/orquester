import assert from "node:assert/strict";
import type { AgentUsage } from "@orquester/api";
import { usagePrefsSchema } from "@orquester/config";
import { missingUsageAgents, normalizeUsageWindows, pickDriver } from "./usage-format";

const claude: AgentUsage = { id: "claude", available: true, stale: false, session: { percent: 10 }, weekly: { percent: 20 } };
const codex: AgentUsage = { id: "codex", available: true, stale: false, session: { percent: 80 }, weekly: { percent: 5 } };
assert.equal(pickDriver([claude, codex], "busiest")?.id, "codex");
assert.equal(pickDriver([claude, codex], "claude")?.id, "claude");
assert.equal(pickDriver([codex], "claude")?.id, "codex");
assert.equal(pickDriver([], "busiest"), null);

const freshPrefs = usagePrefsSchema.parse({});
assert.deepEqual(missingUsageAgents(freshPrefs, []), ["claude", "codex", "grok"]);
assert.deepEqual(missingUsageAgents(freshPrefs, ["claude"]), ["codex", "grok"]);
assert.deepEqual(missingUsageAgents(usagePrefsSchema.parse({ agents: { codex: false } }), []), ["claude", "grok"]);
assert.deepEqual(missingUsageAgents(usagePrefsSchema.parse({ enabled: false }), []), []);

assert.deepEqual(normalizeUsageWindows("claude", { session: null, weekly: null }), []);
const scoped = normalizeUsageWindows("claude", {
  session: { percent: 10 },
  weekly: { percent: 96 },
  scopedWindows: [{ label: "Fable", percent: 100, resetsAt: "2026-08-17T03:00:00Z" }]
});
assert.deepEqual(scoped.map((window) => window.percent), [10, 96, 100]);
assert.equal(scoped[2].resetsAt, "2026-08-17T03:00:00Z");
assert.deepEqual(
  normalizeUsageWindows("claude", { session: null, weekly: null, scopedWindows: [{ label: "Fable", percent: 40 }] }).map((window) => window.percent),
  [40]
);
const capped = normalizeUsageWindows("grok", {
  session: null,
  weekly: { percent: 70, used: 700, limit: 1000, remaining: 300, resetsAt: "2026-07-07T10:00:00Z" }
})[0];
assert.equal(capped.unit, "credits");
assert.equal(capped.used, 700);
assert.equal(capped.limit, 1000);
assert.equal(capped.remaining, 300);
assert.equal(capped.resetsAt, "2026-07-07T10:00:00Z");
console.log("usage-format.check OK");
