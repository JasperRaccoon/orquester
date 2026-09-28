import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountCooldown } from "@orquester/config";
import { WorkflowStateStore } from "../state-store.ts";
import { cooldownUntil, createCooldownStore } from "./cooldowns.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

const cd = (untilMs: number, reason: AccountCooldown["reason"] = "usage_limit"): AccountCooldown => ({ until: at(untilMs), reason, setAt: at(0) });

test("the cooldown store keys <family>:<accountId>, serves only active ones and prunes expired on write", async (t) => {
  let now = NOW;
  const root = await mkdtemp(join(tmpdir(), "orq-cooldowns-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  const store = new WorkflowStateStore({ path });
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

  await cooldowns.set("grok", "g1", cd(5 * HOUR));
  assert.deepEqual(Object.keys(store.get().cooldowns).sort(), ["codex:system", "grok:g1"]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8")).cooldowns).sort(), ["codex:system", "grok:g1"]);
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

test("cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does", () => {
  const base = { now: NOW, reason: "usage_limit" as const };
  assert.equal(cooldownUntil({ ...base, strikes: 0 }).toISOString(), at(HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 1 }).toISOString(), at(2 * HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 2 }).toISOString(), at(4 * HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 9 }).toISOString(), at(4 * HOUR));
  assert.equal(cooldownUntil({ ...base, strikes: 5, resetsAt: at(30 * 60_000) }).toISOString(), at(30 * 60_000));
  assert.equal(cooldownUntil({ now: NOW, reason: "auth", strikes: 5 }).toISOString(), at(HOUR), "auth stays an hour");
});
