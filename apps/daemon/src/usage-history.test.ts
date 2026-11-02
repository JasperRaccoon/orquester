import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";

import { parseUsageHistoryRange, UsageHistory, type UsageHistoryRange } from "./usage-history.ts";
import { setUsagePricingConfig } from "./usage-pricing.ts";
import { HOUR_MS, type UsageRecord, type UsageRecordSource } from "./usage-records.ts";

afterEach(() => setUsagePricingConfig({ overrides: {}, aliases: {} }));

const M = 1_000_000;
const NOW = Date.parse("2026-11-02T20:30:00Z");
const hourOf = (iso: string) => Math.floor(Date.parse(iso) / HOUR_MS);

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    source: "transcripts", agent: "claude", model: "claude-opus-5-5", hour: hourOf("2026-11-02T10:00:00Z"), cwd: null, session: "s1", speed: "standard",
    input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 10, reasoning: 0, requests: 1, reportedCostUsd: 0, reportedRequests: 0,
    ...over
  };
}

/** A scanner stand-in: whatever records it holds right now. */
const source = (records: UsageRecord[] | null): UsageRecordSource & { records: UsageRecord[] | null } => ({
  records,
  historyRecords() {
    return this.records;
  }
});

const range = (raw: string): UsageHistoryRange => parseUsageHistoryRange(raw)!;

async function world(t: { after: (fn: () => Promise<void>) => void }, opts: { now?: () => number; workspacesDir?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-usage-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "usage-history.json");
  const make = () => new UsageHistory({ path, workspacesDir: () => opts.workspacesDir ?? join(dir, "workspaces"), now: opts.now ?? (() => NOW) });
  return { dir, path, make };
}

test("the ledger keeps a deleted transcript's hours, keeps a bucket's high-water by requests and unions its sessions", async (t) => {
  const { make } = await world(t);
  const history = make();
  const scanner = source([
    rec({ session: "a", requests: 3, input: 300 }),
    rec({ hour: hourOf("2026-11-01T10:00:00Z"), session: "old", input: 50 })
  ]);
  assert.equal(history.ingest(scanner), true);

  // The older transcript is gone and the newer one was partly rewritten (fewer requests): both stay.
  scanner.records = [rec({ session: "b", requests: 2, input: 200 })];
  history.ingest(scanner);
  let answer = history.query({ range: range("7d"), timeZone: "UTC", scanning: false });
  assert.deepEqual(answer.buckets.map((b) => [answer.periods[b.period], b.requests, b.tokens.input]), [["2026-11-01", 1, 50], ["2026-11-02", 3, 300]]);
  assert.equal(answer.sessions.total, 3);

  // As many requests or more live: the live bucket wins.
  scanner.records = [rec({ session: "b", requests: 4, input: 410 })];
  history.ingest(scanner);
  answer = history.query({ range: range("1d"), timeZone: "UTC", scanning: false });
  assert.deepEqual(answer.buckets.map((b) => [b.requests, b.tokens.input]), [[4, 410]]);
  assert.equal(answer.sessions.byAgent.claude, 2);
});

test("buckets older than 120 days are dropped", async (t) => {
  let now = NOW;
  const { make } = await world(t, { now: () => now });
  const history = make();
  const day = 24 * HOUR_MS;
  const nowHour = Math.floor(NOW / HOUR_MS);
  history.ingest(source([
    rec({ hour: nowHour - 121 * 24 }),
    rec({ hour: nowHour - 119 * 24 }),
    rec({ hour: nowHour - 24 })
  ]));
  const oldest = () => history.query({ range: range("1d"), timeZone: "UTC", scanning: false }).sources.find((s) => s.agent === "claude")!.oldestAt;
  assert.equal(oldest(), new Date((nowHour - 119 * 24) * HOUR_MS).toISOString());
  now += 2 * day;
  history.ingest(source([]));
  assert.equal(oldest(), new Date((nowHour - 24) * HOUR_MS).toISOString());
});

test("the ledger survives a restart, keeping fields a newer writer added", async (t) => {
  const { path, make } = await world(t);
  const hour = hourOf("2026-11-02T09:00:00Z");
  await writeFile(path, JSON.stringify({
    version: 1,
    recordedSince: "2026-10-01T00:00:00.000Z",
    note: "kept",
    sessions: ["x", "y"],
    buckets: [
      ["transcripts", "codex", "gpt-5.5", "fast", hour, "", 1, 2, 3, 1, 5, 1, 2, 0, 0, [0, 1], "future-column"],
      ["transcripts", "codex", "broken"]
    ]
  }));
  const first = make();
  await first.load();
  first.ingest(source([rec({ session: "z" })]));
  await first.flush();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.note, "kept");
  assert.equal(saved.buckets.find((row: unknown[]) => row[1] === "codex").at(-1), "future-column");

  const second = make();
  await second.load();
  const query = { range: range("7d"), timeZone: "Europe/Berlin", scanning: false };
  assert.deepEqual(second.query(query), first.query(query));
  const answer = second.query(query);
  assert.equal(answer.recordedSince, "2026-10-01T00:00:00.000Z");
  assert.equal(answer.sessions.total, 3);
  assert.deepEqual(answer.buckets.find((b) => b.agent === "codex")!.tokens, { input: 1, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, output: 5, reasoning: 1 });
});

test("a corrupt ledger is moved aside, and a newer version is kept as a backup the ledger never overwrites", async (t) => {
  const { dir, path, make } = await world(t);
  await writeFile(path, "{not json");
  const fromCorrupt = make();
  await fromCorrupt.load();
  assert.equal(fromCorrupt.query({ range: range("7d"), scanning: false }).buckets.length, 0);
  assert.ok((await readdir(dir)).some((name) => name.startsWith("usage-history.json.corrupt-")));

  const newer = JSON.stringify({ version: 2, buckets: "whatever" });
  await writeFile(path, newer);
  const fromNewer = make();
  await fromNewer.load();
  assert.equal(fromNewer.query({ range: range("7d"), scanning: false }).recordedSince, null);
  fromNewer.ingest(source([rec()]));
  await fromNewer.flush();
  assert.equal(await readFile(`${path}.v2.bak`, "utf8"), newer);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
});

test("changes are written at most once a minute, and only when something changed", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let now = NOW;
  const { path, make } = await world(t, { now: () => now });
  const history = make();
  const scanner = source([rec({ input: 1 })]);
  const savedInput = async () => JSON.parse(await readFile(path, "utf8")).buckets[0][6];

  history.ingest(scanner);
  mock.timers.tick(0);
  await history.flush();
  assert.equal(await savedInput(), 1);

  scanner.records = [rec({ input: 2 })];
  history.ingest(scanner);
  now += 30_000;
  mock.timers.tick(30_000);
  assert.equal(await savedInput(), 1);
  now += 30_000;
  mock.timers.tick(30_000);
  await history.flush();
  assert.equal(await savedInput(), 2);

  await rm(path);
  history.ingest(scanner);
  now += 60_000;
  mock.timers.tick(60_000);
  await history.flush();
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("a source's first scan is merged at once, later scans at most every five minutes or when the ledger is read or flushed", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let now = NOW;
  const { path, make } = await world(t, { now: () => now });
  const history = make();
  let reads = 0;
  const scanner = source([rec({ input: 1 })]);
  const counted: UsageRecordSource = { historyRecords: () => (reads++, scanner.historyRecords()) };
  const input = () => history.query({ range: range("1d"), timeZone: "UTC", scanning: false }).buckets[0]?.tokens.input;

  history.scanned(counted);
  assert.equal(reads, 1);
  assert.equal(history.hasIngested(counted), true);

  scanner.records = [rec({ input: 2 })];
  history.scanned(counted);
  history.scanned(counted);
  now += 60_000;
  mock.timers.tick(60_000);
  assert.equal(reads, 1, "two scans within the interval are not merged yet");
  now += 4 * 60_000;
  mock.timers.tick(4 * 60_000);
  assert.equal(reads, 2, "and then once");

  scanner.records = [rec({ input: 3 })];
  history.scanned(counted);
  assert.equal(input(), 3, "a reader merges the deferred scan first");
  assert.equal(reads, 3);

  scanner.records = [rec({ input: 4 })];
  history.scanned(counted);
  await history.flush();
  assert.equal(reads, 4);
  assert.equal(JSON.parse(await readFile(path, "utf8")).buckets[0][6], 4);
});

test("days are the zone's calendar days across a DST change and at a quarter-hour offset; 24h is the last 24 UTC hours", async (t) => {
  const { make } = await world(t);
  const history = make();
  const at = (iso: string, session: string) => rec({ hour: hourOf(iso), session });
  history.ingest(source([
    at("2026-11-01T06:00:00Z", "la-oct31"), // 23:00 PDT Oct 31
    at("2026-11-01T07:00:00Z", "la-nov1-start"), // 00:00 PDT Nov 1
    at("2026-11-02T07:00:00Z", "la-nov1-end"), // 23:00 PST Nov 1 (the day had 25 hours)
    at("2026-11-02T08:00:00Z", "la-nov2"), // 00:00 PST Nov 2
    at("2026-11-02T18:00:00Z", "ktm-nov2"), // 23:45 Nov 2 in Kathmandu
    at("2026-11-02T19:00:00Z", "ktm-nov3"), // 00:45 Nov 3 in Kathmandu
    at("2026-11-01T20:00:00Z", "utc-25h-ago"),
    at("2026-11-02T20:00:00Z", "utc-this-hour")
  ]));
  const periodRequests = (answer: ReturnType<UsageHistory["query"]>) => {
    const out: Record<string, number> = {};
    for (const b of answer.buckets) out[answer.periods[b.period]!] = (out[answer.periods[b.period]!] ?? 0) + b.requests;
    return out;
  };

  const la = history.query({ range: range("2d"), timeZone: "America/Los_Angeles", scanning: false });
  assert.deepEqual(la.periods, ["2026-11-01", "2026-11-02"]);
  assert.equal(la.since, "2026-11-01T07:00:00.000Z");
  assert.equal(la.until, "2026-11-03T08:00:00.000Z");
  assert.deepEqual(periodRequests(la), { "2026-11-01": 3, "2026-11-02": 4 });

  const ktm = history.query({ range: range("1d"), timeZone: "Asia/Kathmandu", scanning: false });
  assert.deepEqual(ktm.periods, ["2026-11-03"]);
  assert.equal(ktm.since, "2026-11-02T18:15:00.000Z");
  assert.deepEqual(periodRequests(ktm), { "2026-11-03": 2 }); // 00:45 and 01:45

  const day = history.query({ range: range("24h"), timeZone: "Asia/Kathmandu", scanning: false });
  assert.equal(day.resolution, "hour");
  assert.equal(day.periods.length, 24);
  assert.equal(day.periods[0], "2026-11-01T21:00:00.000Z");
  assert.equal(day.until, "2026-11-02T21:00:00.000Z");
  assert.equal(day.buckets.find((b) => b.period === 23)?.requests, 1);
  assert.equal(day.sessions.total, 5); // 07Z to 20Z on Nov 2; 20Z on Nov 1 is 25 hours ago

  const fallback = history.query({ range: range("1d"), timeZone: "Mars/Olympus_Mons", scanning: false });
  assert.equal(fallback.timeZone, "UTC");
  assert.deepEqual(fallback.periods, ["2026-11-02"]);
});

test("ranges are 24h or 1 to 90 days", () => {
  for (const bad of ["", "0d", "91d", "07d", "1w", "24H", undefined, 7]) assert.equal(parseUsageHistoryRange(bad), null, String(bad));
  assert.deepEqual(parseUsageHistoryRange("90d"), { label: "90d", resolution: "day", days: 90 });
});

test("a session active on several days counts once; projects come from the cwd under the workspaces root, as given or resolved", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "orq-usage-projects-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, "real-root");
  await mkdir(real);
  const link = join(base, "link-root");
  await symlink(real, link);
  const { make } = await world(t, { workspacesDir: link });
  const history = make();
  history.ingest(source([
    rec({ hour: hourOf("2026-10-30T10:00:00Z"), session: "long", cwd: join(link, "ws", "app") }),
    rec({ hour: hourOf("2026-11-02T10:00:00Z"), session: "long", cwd: join(real, "ws", "app", ".claude", "worktrees", "agent-1") }),
    rec({ session: "ws-only", cwd: join(real, "ws") }),
    rec({ session: "elsewhere", cwd: "/tmp/somewhere/else" }),
    rec({ agent: "codex", model: "gpt-5.5", session: "long", cwd: join(real, "ws", "api") })
  ]));
  const answer = history.query({ range: range("7d"), timeZone: "UTC", scanning: false });
  assert.deepEqual(answer.sessions, {
    total: 4,
    byAgent: { claude: 3, codex: 1 },
    byModel: { "claude:claude-opus-5-5": 3, "codex:gpt-5.5": 1 },
    byProject: { "ws/app": 1, "": 2, "ws/api": 1 }
  });
  assert.deepEqual(answer.projectBuckets.map((p) => [p.project, p.agent, p.requests]), [["", "claude", 2], ["ws/api", "codex", 1], ["ws/app", "claude", 2]]);
});

test("cells are priced override > reported > built-in > unpriced, after aliases fold models", async (t) => {
  const { make } = await world(t);
  const history = make();
  history.ingest(source([
    rec({ model: "claude-opus-5-5", input: M, cacheRead: M, output: 0, session: "c1" }),
    rec({ model: "my-proxy-opus", input: M, output: 0, session: "c2" }),
    rec({ model: "house-model", input: M, output: 0, session: "c3" }),
    rec({ source: "orquester-chats", agent: "grok", model: "grok-build", input: 3 * M, output: M, requests: 4, reportedRequests: 3, reportedCostUsd: 1.5, session: "g1" })
  ]));
  const cells = () => {
    const answer = history.query({ range: range("1d"), timeZone: "UTC", scanning: false });
    return Object.fromEntries(answer.buckets.map((b) => [b.model, b]));
  };

  let byModel = cells();
  assert.equal(byModel["claude-opus-5-5"]!.costSource, "estimated");
  assert.equal(byModel["claude-opus-5-5"]!.costUsd, 4 + 0.2);
  assert.equal(byModel["claude-opus-5-5"]!.cacheSavingsUsd, 3.8);
  assert.equal(byModel["grok-build"]!.costSource, "reported");
  assert.equal(byModel["grok-build"]!.costUsd, 1.5);
  assert.equal(byModel["grok-build"]!.unpricedTokens, M); // one of four requests reported nothing
  assert.equal(byModel["house-model"]!.costSource, "unpriced");
  assert.equal(byModel["house-model"]!.costUsd, null);
  assert.equal(byModel["house-model"]!.unpricedTokens, M);

  setUsagePricingConfig({ overrides: { "grok-build": { input: 1, output: 1 } }, aliases: { "my-proxy-opus": "claude-opus-5-5" } });
  byModel = cells();
  assert.equal(byModel["grok-build"]!.costSource, "estimated");
  assert.equal(byModel["grok-build"]!.costUsd, 4);
  assert.equal(byModel["my-proxy-opus"], undefined);
  assert.equal(byModel["claude-opus-5-5"]!.requests, 2);
  assert.equal(byModel["claude-opus-5-5"]!.costUsd, 8 + 0.2);

  const project = history.query({ range: range("1d"), timeZone: "UTC", scanning: false }).projectBuckets;
  assert.equal(project.find((p) => p.model === "house-model")!.costUsd, null);
  assert.deepEqual(
    history.seenModels().map((m) => [m.model, m.status, m.aliasOf]),
    [["grok-build", "override", null], ["claude-opus-5-5", "builtin", null], ["house-model", "unpriced", null], ["my-proxy-opus", "alias", "claude-opus-5-5"]]
  );
});
