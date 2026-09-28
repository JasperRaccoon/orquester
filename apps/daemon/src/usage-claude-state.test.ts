/**
 * The Claude usage source's endpoint budget and persisted state: one request per account per
 * window, a `Retry-After` and the last reading that survive a restart, and live readings (off a
 * chat thread's model responses) that make a poll unnecessary.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_USAGE_MIN_INTERVAL_MS,
  claudeLiveUsageFromWindows,
  createClaudeSource,
  type ClaudeUsageRecord,
  type ClaudeUsageStateStore
} from "./usage-sources.ts";
import { UsageStateFile, parseUsageRecord } from "./usage-state.ts";

const NOW = Date.parse("2026-09-28T14:00:00Z");
const MIN = 60_000;

class MemoryStore implements ClaudeUsageStateStore {
  readonly records = new Map<string, ClaudeUsageRecord>();
  get(key: string) {
    return this.records.get(key);
  }
  set(key: string, record: ClaudeUsageRecord) {
    this.records.set(key, record);
  }
}

async function claudeHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "usage-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 48 * 60 * MIN, subscriptionType: "max" } })
  );
  return home;
}

function endpoint(answers: Array<{ status: number; body?: unknown; retryAfter?: string }>) {
  const calls: number[] = [];
  let clock = () => NOW;
  const fetchImpl = (async () => {
    calls.push(clock());
    const answer = answers.shift() ?? { status: 500 };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (answer.retryAfter ?? null) : null) },
      json: async () => answer.body ?? {}
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, setClock: (fn: () => number) => (clock = fn) };
}

const usageBody = (session: number, weekly: number) => ({
  five_hour: { utilization: session, resets_at: new Date(NOW + 3 * 60 * MIN).toISOString() },
  seven_day: { utilization: weekly, resets_at: new Date(NOW + 5 * 24 * 60 * MIN).toISOString() }
});

test("asks the endpoint at most once per window, even with nothing to show", async (t) => {
  const home = await claudeHome(t);
  let clock = NOW;
  const api = endpoint([{ status: 429, retryAfter: "10" }, { status: 200, body: usageBody(4, 20) }]);
  api.setClock(() => clock);
  const source = createClaudeSource({ userhome: home, claudeHome: home, now: () => clock, fetchImpl: api.fetchImpl });

  const first = await source();
  assert.equal(first?.session, null);
  assert.equal(first?.stale, true);
  // A burst of recomputes (the transcript watcher's nudges) inside the window asks nothing.
  for (const offset of [5_000, MIN, 4 * MIN]) {
    clock = NOW + offset;
    await source();
  }
  assert.equal(api.calls.length, 1, "a Retry-After shorter than the window is floored at the window");
  clock = NOW + CLAUDE_USAGE_MIN_INTERVAL_MS;
  const fresh = await source();
  assert.equal(api.calls.length, 2);
  assert.equal(fresh?.session?.percent, 4);
  assert.equal(fresh?.stale, false);
  // A good reading is served, not re-asked, for the next window.
  clock += 2 * MIN;
  assert.equal((await source())?.stale, false);
  assert.equal(api.calls.length, 2);
});

test("a restart keeps the last reading and waits out the window the previous process opened", async (t) => {
  const home = await claudeHome(t);
  const store = new MemoryStore();
  const api = endpoint([{ status: 200, body: usageBody(10, 90) }, { status: 200, body: usageBody(11, 91) }]);
  const make = (now: number) =>
    createClaudeSource({ userhome: home, claudeHome: home, now: () => now, fetchImpl: api.fetchImpl, state: { store, key: "claude:a" } });

  assert.equal((await make(NOW)())?.weekly?.percent, 90);
  // The daemon restarts two minutes later: the new source shows the numbers at once, asks nothing.
  const restarted = await make(NOW + 2 * MIN)();
  assert.equal(restarted?.weekly?.percent, 90);
  assert.equal(restarted?.stale, false);
  assert.equal(api.calls.length, 1);
  // Past the window it asks again.
  assert.equal((await make(NOW + 6 * MIN)())?.weekly?.percent, 91);
  assert.equal(api.calls.length, 2);
});

test("a 429's Retry-After survives a restart and the last reading is served greyed meanwhile", async (t) => {
  const home = await claudeHome(t);
  const store = new MemoryStore();
  const api = endpoint([
    { status: 200, body: usageBody(10, 50) },
    { status: 429, retryAfter: "1800" },
    { status: 200, body: usageBody(12, 52) }
  ]);
  const make = (now: number) =>
    createClaudeSource({ userhome: home, claudeHome: home, now: () => now, fetchImpl: api.fetchImpl, state: { store, key: "k" } });

  await make(NOW)();
  const limited = await make(NOW + 6 * MIN)();
  assert.equal(api.calls.length, 2);
  assert.equal(limited?.stale, true, "a failed refresh greys the reading");
  assert.equal(limited?.weekly?.percent, 50);
  // Restarted 20 minutes later: still inside the 30-minute Retry-After.
  await make(NOW + 26 * MIN)();
  assert.equal(api.calls.length, 2);
  assert.equal((await make(NOW + 37 * MIN)())?.weekly?.percent, 52);
  assert.equal(api.calls.length, 3);
});

test("a live reading replaces the account windows, keeps the scoped ones, and skips the poll", async (t) => {
  const home = await claudeHome(t);
  let clock = NOW;
  const api = endpoint([
    {
      status: 200,
      body: {
        ...usageBody(10, 50),
        limits: [{ kind: "weekly_scoped", percent: 30, resets_at: new Date(NOW + 2 * 24 * 60 * MIN).toISOString(), scope: { model: { display_name: "Fable" } } }]
      }
    },
    { status: 200, body: usageBody(99, 99) }
  ]);
  const source = createClaudeSource({ userhome: home, claudeHome: home, now: () => clock, fetchImpl: api.fetchImpl });
  await source();

  clock = NOW + 4 * MIN;
  assert.equal(source.ingestLive({ session: { percent: 14 }, weekly: { percent: 52 }, observedAt: clock }), true);
  // Older than what is held: ignored.
  assert.equal(source.ingestLive({ session: { percent: 1 }, observedAt: NOW - MIN }), false);
  clock = NOW + 6 * MIN; // past the endpoint's window, but the live reading is 2 minutes old
  const served = await source();
  assert.equal(api.calls.length, 1, "a fresh live reading makes the poll pointless");
  assert.equal(served?.session?.percent, 14);
  assert.equal(served?.weekly?.percent, 52);
  assert.equal(served?.scopedWindows?.[0]?.percent, 30);
  assert.equal(served?.asOf, new Date(NOW + 4 * MIN).toISOString());
  assert.equal(served?.plan, "Max");
  // Once the live feed goes quiet the endpoint is asked again.
  clock = NOW + 10 * MIN;
  assert.equal((await source())?.session?.percent, 99);
  assert.equal(api.calls.length, 2);
});

test("a live reading on an account with no reading yet stands on its own", async (t) => {
  const home = await claudeHome(t);
  const api = endpoint([]);
  const source = createClaudeSource({ userhome: home, claudeHome: home, now: () => NOW, fetchImpl: api.fetchImpl });
  source.ingestLive({ session: { percent: 3 }, weekly: { percent: 16 }, observedAt: NOW });
  const served = await source();
  assert.equal(api.calls.length, 0);
  assert.equal(served?.available, true);
  assert.equal(served?.stale, false);
  assert.equal(served?.weekly?.percent, 16);
});

test("a stamp from the future (the clock moved back) does not block the endpoint", async (t) => {
  const home = await claudeHome(t);
  const store = new MemoryStore();
  store.set("k", { lastGood: null, lastFetchAt: NOW + 60 * MIN, retryAt: NOW + 100 * 24 * 60 * MIN, liveAt: 0, failed: false });
  const api = endpoint([{ status: 200, body: usageBody(5, 6) }]);
  const source = createClaudeSource({ userhome: home, claudeHome: home, now: () => NOW, fetchImpl: api.fetchImpl, state: { store, key: "k" } });
  assert.equal((await source())?.session?.percent, 5);
});

test("UsageStateFile round-trips, drops what does not parse and moves a corrupt file aside", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "usage-state-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "daemon", "usage-state.json");
  await mkdir(join(dir, "daemon"));

  const written = new UsageStateFile(file);
  await written.load(); // ENOENT: starts empty
  const record: ClaudeUsageRecord = {
    lastGood: { id: "claude", available: true, stale: false, plan: "Max 20x", session: { percent: 4, resetsAt: "2026-09-28T18:00:00.000Z" }, weekly: null, asOf: "2026-09-28T14:00:00.000Z" },
    lastFetchAt: NOW,
    retryAt: 0,
    liveAt: NOW,
    failed: false
  };
  written.set("claude:/a", record);
  await written.flush();
  assert.equal((await readFile(file, "utf8")).includes('"version":1'), true);

  const read = new UsageStateFile(file);
  await read.load();
  assert.deepEqual(read.get("claude:/a"), record);

  await writeFile(file, JSON.stringify({ version: 1, sources: { good: record, bad: "x", noUsage: { lastGood: { id: "codex" }, lastFetchAt: 5 } } }));
  const tolerant = new UsageStateFile(file);
  await tolerant.load();
  assert.deepEqual(tolerant.get("good"), record);
  assert.equal(tolerant.get("bad"), undefined);
  assert.deepEqual(tolerant.get("noUsage"), { lastGood: null, lastFetchAt: 5, retryAt: 0, liveAt: 0, failed: false });

  await writeFile(file, "{not json");
  const corrupt = new UsageStateFile(file, { warn: () => undefined });
  await corrupt.load();
  assert.equal(corrupt.get("good"), undefined);
  assert.equal((await readdir(join(dir, "daemon"))).some((name) => name.startsWith("usage-state.json.corrupt-")), true);
  assert.equal(parseUsageRecord(null), undefined);
});

test("a thread's live windows become the account's session and weekly readings", () => {
  const live = claudeLiveUsageFromWindows(
    [
      { id: "session", usedPercent: 4, resetsAt: "2026-09-28T18:00:00.000Z" },
      { id: "weekly_all", usedPercent: 116 },
      { id: "scoped:fable", usedPercent: 30 }
    ],
    "2026-09-28T14:00:00.000Z"
  );
  assert.deepEqual(live, {
    session: { percent: 4, resetsAt: "2026-09-28T18:00:00.000Z" },
    weekly: { percent: 100 },
    observedAt: NOW
  });
  // Only the session window: the weekly one is left as it was (absent, not null).
  assert.equal("weekly" in (claudeLiveUsageFromWindows([{ id: "session", usedPercent: 1 }], "2026-09-28T14:00:00Z") ?? {}), false);
  assert.equal(claudeLiveUsageFromWindows([{ id: "scoped:fable", usedPercent: 1 }], "2026-09-28T14:00:00Z"), null);
  assert.equal(claudeLiveUsageFromWindows([{ id: "session", usedPercent: 1 }], "not a time"), null);
});
