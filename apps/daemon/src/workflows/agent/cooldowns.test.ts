import assert from "node:assert/strict";
import test from "node:test";
import type { AccountCooldown } from "@orquester/config";
import { WorkflowStateStore } from "../state-store.ts";
import { buildCooldown, cooldownUntil, createCooldownStore } from "./cooldowns.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

function memoryStore(): { store: WorkflowStateStore; writes: string[] } {
  const writes: string[] = [];
  const store = new WorkflowStateStore({ path: "/nowhere/workflow-state.json", write: async (_path, content) => void writes.push(content) });
  return { store, writes };
}

const cd = (untilMs: number, reason: AccountCooldown["reason"] = "usage_limit"): AccountCooldown => ({ until: at(untilMs), reason, setAt: at(0) });

test("the cooldown store keys <family>:<accountId>, serves only active ones and prunes expired on write", async () => {
  let now = NOW;
  const { store, writes } = memoryStore();
  const cooldowns = createCooldownStore(store, { now: () => now });
  await cooldowns.set("claude", "a1", cd(HOUR));
  await cooldowns.set("codex", "system", cd(3 * HOUR, "auth"));
  assert.deepEqual(Object.keys(store.get().cooldowns).sort(), ["claude:a1", "codex:system"]);
  assert.deepEqual(cooldowns.get("claude", "a1"), cd(HOUR));
  assert.equal(cooldowns.get("claude", "a2"), null);
  assert.equal(cooldowns.get("codex", "a1"), null, "keyed per family");

  now = new Date(NOW.getTime() + 2 * HOUR);
  assert.equal(cooldowns.get("claude", "a1"), null, "expired");
  assert.deepEqual(Object.keys(cooldowns.list()), ["codex:system"]);
  assert.ok(store.get().cooldowns["claude:a1"], "still on file until the next write");

  await cooldowns.set("grok", "g1", cd(5 * HOUR));
  assert.deepEqual(Object.keys(store.get().cooldowns).sort(), ["codex:system", "grok:g1"]);
  assert.equal(writes.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(writes.at(-1)!).cooldowns).sort(), ["codex:system", "grok:g1"]);
});

test("cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour", () => {
  const base = { now: NOW, reason: "usage_limit" as const };
  assert.equal(cooldownUntil({ ...base, resetsAt: at(3 * HOUR), usageResetAt: at(DAY) }).toISOString(), at(3 * HOUR));
  assert.equal(cooldownUntil({ ...base, resetsAt: at(-HOUR), usageResetAt: at(DAY) }).toISOString(), at(DAY), "a past resetsAt");
  assert.equal(cooldownUntil({ ...base, resetsAt: at(9 * DAY), usageResetAt: at(DAY) }).toISOString(), at(DAY), "beyond 8 days");
  assert.equal(cooldownUntil({ ...base, resetsAt: "garbage", usageResetAt: at(8 * DAY) }).toISOString(), at(8 * DAY), "8 days is allowed");
  assert.equal(cooldownUntil({ ...base, usageResetAt: at(9 * DAY) }).toISOString(), at(HOUR));
  assert.equal(cooldownUntil(base).toISOString(), at(HOUR));
  assert.equal(cooldownUntil({ now: NOW, reason: "auth", resetsAt: at(3 * HOUR) }).toISOString(), at(HOUR));
});

test("buildCooldown makes the persisted record", () => {
  assert.deepEqual(buildCooldown({ now: NOW, reason: "usage_limit", resetsAt: at(2 * HOUR), detail: "Claude usage limit reached." }), {
    until: at(2 * HOUR),
    reason: "usage_limit",
    setAt: at(0),
    detail: "Claude usage limit reached."
  });
  assert.deepEqual(buildCooldown({ now: NOW, reason: "auth" }), { until: at(HOUR), reason: "auth", setAt: at(0) });
});

test("cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does", () => {
  const base = { now: NOW, reason: "usage_limit" as const };
  assert.equal(cooldownUntil({ ...base, strikes: 0 }).toISOString(), at(HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 1 }).toISOString(), at(2 * HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 2 }).toISOString(), at(4 * HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 9 }).toISOString(), at(4 * HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 5, resetsAt: at(30 * 60_000) }).toISOString(), at(30 * 60_000));
  assert.equal(cooldownUntil({ now: NOW, reason: "auth", strikes: 5 }).toISOString(), at(HOUR), "auth stays an hour");
});
