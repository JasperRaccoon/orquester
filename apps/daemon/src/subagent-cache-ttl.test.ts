import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decideSubagentCacheTtl,
  estimateSubagentCacheCosts,
  SubagentCacheTtlController,
  type SubagentRequest
} from "./subagent-cache-ttl.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse("2026-10-11T00:00:00Z");

const req = (sub: string, ts: number, cacheWrite: number, cacheRead: number, cacheWrite1h = 0): SubagentRequest => ({
  sub,
  ts,
  cacheWrite,
  cacheRead,
  cacheWrite1h
});

/** `count` subagents on the 5m cache that each wait `gapMin` between two requests and re-write their prefix. */
const idleAgents = (count: number, gapMin: number): SubagentRequest[] =>
  Array.from({ length: count }, (_, i) => [
    req(`idle-${i}`, NOW - DAY, 100_000, 0),
    req(`idle-${i}`, NOW - DAY + gapMin * MIN, 100_000, 0)
  ]).flat();

/** `count` subagents on the 5m cache whose second request follows within a minute and reads the prefix. */
const busyAgents = (count: number): SubagentRequest[] =>
  Array.from({ length: count }, (_, i) => [
    req(`busy-${i}`, NOW - DAY, 100_000, 0),
    req(`busy-${i}`, NOW - DAY + MIN, 1_000, 100_000)
  ]).flat();

test("a 5m subagent that re-writes its prefix after a 10 minute wait would have read it at 1h", () => {
  const costs = estimateSubagentCacheCosts(idleAgents(1, 10));
  // 5m: two 100k writes at 1.25x. 1h: one 100k write at 2x, then a 100k read at 0.1x.
  assert.deepEqual(costs, { requests: 2, cost5m: 250_000, cost1h: 210_000 });
});

test("a subagent that never waits 5 minutes only pays the dearer 1h write", () => {
  const costs = estimateSubagentCacheCosts(busyAgents(1));
  // writes 101k, reads 100k: 5m = 126,250 + 10,000; 1h = 202,000 + 10,000
  assert.deepEqual(costs, { requests: 2, cost5m: 136_250, cost1h: 212_000 });
});

test("a wait of an hour or more expires both caches, so only the write price differs", () => {
  const costs = estimateSubagentCacheCosts(idleAgents(1, 60));
  assert.deepEqual(costs, { requests: 2, cost5m: 250_000, cost1h: 400_000 });
});

test("a 1h subagent that read its prefix after a wait would have re-written it at 5m", () => {
  const costs = estimateSubagentCacheCosts([
    req("a", NOW, 100_000, 5_000, 100_000),
    req("a", NOW + 10 * MIN, 1_000, 105_000, 1_000)
  ]);
  // 1h is what happened: 2x(101k) + 0.1x(110k) = 213,000.
  // 5m: first request 1.25x100k + 0.1x5k; after the wait only the 5k the agent
  // found warm on its first request is still read, the other 101k is written.
  assert.deepEqual(costs, { requests: 2, cost5m: 125_500 + 126_750, cost1h: 213_000 });
});

test("requests are ordered per subagent, whatever order they arrive in", () => {
  const [first, second] = idleAgents(1, 10);
  assert.deepEqual(estimateSubagentCacheCosts([second!, first!]), estimateSubagentCacheCosts([first!, second!]));
});

test("auto picks 1h when it would have been more than 5% cheaper", () => {
  const decision = decideSubagentCacheTtl(idleAgents(300, 10), "5m");
  assert.equal(decision.outcome, "1h");
  assert.equal(decision.ttl, "1h");
  assert.equal(decision.requests, 600);
  assert.equal(decision.changePct, -16);
});

test("auto picks 5m when 1h would have been more than 5% dearer", () => {
  const decision = decideSubagentCacheTtl(busyAgents(300), "1h");
  assert.equal(decision.outcome, "5m");
  assert.equal(decision.ttl, "5m");
});

test("auto keeps the current choice when the two are within 5%", () => {
  // 250 idle agents save 10.0M, 132 busy ones cost 10.0M more: about even.
  const mixed = [...idleAgents(250, 10), ...busyAgents(132)];
  const on = decideSubagentCacheTtl(mixed, "1h");
  assert.equal(on.outcome, "hold");
  assert.equal(on.ttl, "1h");
  assert.ok(Math.abs(on.changePct!) <= 5, String(on.changePct));
  assert.equal(decideSubagentCacheTtl(mixed, "5m").ttl, "5m");
});

test("auto falls back to 5m when there are too few subagent requests to judge", () => {
  const decision = decideSubagentCacheTtl(idleAgents(100, 10), "1h");
  assert.deepEqual(decision, { outcome: "insufficient", ttl: "5m", requests: 200, changePct: null });
});

async function controller(source: (sinceMs: number) => SubagentRequest[] | null, at: { now: number }, file?: string) {
  const stateFile = file ?? join(await mkdtemp(join(tmpdir(), "orq-sub-ttl-")), "subagent-cache-ttl.json");
  const c = new SubagentCacheTtlController({ stateFile, now: () => at.now, requests: source });
  await c.init();
  return { c, stateFile };
}

test("always-1h and always-5m apply as chosen without reading any usage", async () => {
  const { c } = await controller(() => assert.fail("usage must not be read"), { now: NOW });
  assert.equal(await c.resolve("1h"), "1h");
  assert.equal(await c.resolve("5m"), "5m");
});

test("auto decides from the last 14 days and keeps the decision for a week", async () => {
  const at = { now: NOW };
  const asked: number[] = [];
  let usage = idleAgents(300, 10);
  const { c, stateFile } = await controller((since) => (asked.push(since), usage), at);
  assert.equal(await c.resolve("auto"), "1h");
  assert.deepEqual(asked, [NOW - 14 * DAY]);

  // Usage turns against 1h, but the week is not over.
  usage = busyAgents(300);
  at.now = NOW + 7 * DAY - 1;
  assert.equal(await c.resolve("auto"), "1h");
  assert.equal(asked.length, 1);

  at.now = NOW + 7 * DAY;
  assert.equal(await c.resolve("auto"), "5m");
  assert.equal(asked.length, 2);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).ttl, "5m");
});

test("auto's decision survives a daemon restart", async () => {
  const at = { now: NOW };
  const { c, stateFile } = await controller(() => idleAgents(300, 10), at);
  assert.equal(await c.resolve("auto"), "1h");
  const restarted = await controller(() => assert.fail("the stored decision is still current"), at, stateFile);
  assert.equal(await restarted.c.resolve("auto"), "1h");
});

test("auto waits for the transcript scan instead of deciding on nothing", async () => {
  const at = { now: NOW };
  let usage: SubagentRequest[] | null = null;
  const { c } = await controller(() => usage, at);
  assert.equal(await c.resolve("auto"), "5m");
  assert.equal((await c.status("auto")).lastCheck, null);
  usage = idleAgents(300, 10);
  assert.equal(await c.resolve("auto"), "1h");
});

test("auto looks again the next day when there was too little usage to judge", async () => {
  const at = { now: NOW };
  let usage = idleAgents(10, 10);
  const { c } = await controller(() => usage, at);
  assert.equal(await c.resolve("auto"), "5m");
  usage = idleAgents(300, 10);
  at.now = NOW + DAY - 1;
  assert.equal(await c.resolve("auto"), "5m");
  at.now = NOW + DAY;
  assert.equal(await c.resolve("auto"), "1h");
});

test("an unreadable stored decision is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-sub-ttl-"));
  const stateFile = join(dir, "subagent-cache-ttl.json");
  await writeFile(stateFile, "{not json", "utf8");
  const { c } = await controller(() => idleAgents(300, 10), { now: NOW }, stateFile);
  assert.equal(await c.resolve("auto"), "1h");
});

test("status reports the mode, what launches get, and auto's last and next check", async () => {
  const at = { now: NOW };
  const { c } = await controller(() => idleAgents(300, 10), at);
  assert.deepEqual(await c.status("auto"), {
    mode: "auto",
    ttl: "1h",
    lastCheck: { at: new Date(NOW).toISOString(), outcome: "1h", requests: 600, windowDays: 14, changePct: -16 },
    nextCheckAt: new Date(NOW + 7 * DAY).toISOString()
  });
  // A fixed mode reports itself and never schedules a check.
  const fixed = await c.status("5m");
  assert.equal(fixed.mode, "5m");
  assert.equal(fixed.ttl, "5m");
  assert.equal(fixed.nextCheckAt, null);
});
