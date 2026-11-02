import { after, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { appendFile, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setUsagePricingConfig } from "./usage-pricing.ts";
import { estimateCostParts, UsageTokensScanner } from "./usage-tokens.ts";

const fixtureRoot = await mkdtemp(join(tmpdir(), "orq-usage-tokens-fixtures-"));
after(() => rm(fixtureRoot, { recursive: true, force: true }));

// The scanner reads the host's transcripts through these: every test scans its own home instead.
const callerEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
after(() => {
  for (const [name, value] of Object.entries(callerEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("1h-TTL cache writes bill at 2x input, 5m at 1.25x", () => {
  // 1M total writes, 400k of them 1h: 600k*6.25 + 400k*10 = 3.75 + 4.00
  const cost = estimateCostParts("claude-opus-4-8", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 400_000 });
  assert.equal(cost?.cache, 7.75);
});

test("unknown model yields null cost", () => {
  assert.equal(estimateCostParts("made-up-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }), null);
});

test("versioned model ids stay priced (F1)", () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  assert.notEqual(estimateCostParts("claude-opus-4-8-20260115", tokens), null);
  assert.notEqual(estimateCostParts("gpt-5.4-codex-preview", tokens), null);
});

const T0 = () => Date.parse("2026-07-07T00:00:00Z");

test("scanCodex reads the real event_msg/token_count/info shape and sums per-turn usage", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-codex-"));
  const sdir = join(home, ".codex", "sessions");
  await mkdir(sdir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  await writeFile(
    join(sdir, "s.jsonl"),
    [
      line({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 125 }, last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 5, total_tokens: 125 } } } }),
      line({ type: "event_msg", payload: { type: "agent_message", text: "hi" } }),
      line({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 185 }, last_token_usage: { input_tokens: 50, output_tokens: 10, cached_input_tokens: 0, total_tokens: 60 } } } })
    ].join("\n"),
    "utf8"
  );
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "cache.json"), now: T0 });
  await scanner.init();
  const snap = await scanner.snapshot(true);
  const codex = snap.rows.filter((r) => r.agent === "codex");
  // input_tokens INCLUDES cached tokens, so the non-cached remainder is recorded
  // as input: (100-5) + (50-0) = 145; the 5 cached go to cacheRead.
  assert.equal(codex.reduce((a, r) => a + r.inputTokens, 0), 145);
  assert.equal(codex.reduce((a, r) => a + r.outputTokens, 0), 30);
  assert.equal(codex.reduce((a, r) => a + r.cacheReadTokens, 0), 5);
});

test("scanClaude reads the 1h cache-write split and skips zero-usage rows", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-1h-"));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  await writeFile(
    join(pdir, "t.jsonl"),
    [
      line({
        timestamp: "2026-07-07T00:00:00Z",
        requestId: "r1",
        message: {
          id: "m1",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 2,
            output_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }
          }
        }
      }),
      // Zero-usage synthetic row must not surface at all.
      line({ timestamp: "2026-07-07T00:00:00Z", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } })
    ].join("\n"),
    "utf8"
  );
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  const snap = await scanner.snapshot(true);
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].cacheWriteTokens, 50);
  assert.equal(snap.rows[0].cacheWrite1hTokens, 30);
});

test("scanClaude dedupes repeated message.id+requestId across files (F2)", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-dedup-"));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  const turn = {
    timestamp: "2026-07-07T00:00:00Z",
    requestId: "req_1",
    message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 4 } }
  };
  // A resumed session copies the same turn (same id + requestId) into a second file.
  await writeFile(join(pdir, "a.jsonl"), JSON.stringify(turn), "utf8");
  await writeFile(join(pdir, "b.jsonl"), JSON.stringify(turn), "utf8");
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  const snap = await scanner.snapshot(true);
  const row = snap.rows.find((r) => r.agent === "claude");
  assert.ok(row);
  assert.equal(row?.inputTokens, 10); // counted once, not 20
  assert.equal(row?.outputTokens, 4);
});

test("recompute caches unchanged files and stays correct on partial rescan (F5)", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-cache-"));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  const turnA = { timestamp: "2026-07-07T00:00:00Z", requestId: "rA", message: { id: "mA", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 0 } } };
  await writeFile(join(pdir, "a.jsonl"), JSON.stringify(turnA), "utf8");
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  await scanner.snapshot(true);

  // Add a second, distinct turn in a new file, then recompute. `a.jsonl` is
  // unchanged (served from cache); the total must reflect both, no double count.
  const turnB = { timestamp: "2026-07-07T00:00:00Z", requestId: "rB", message: { id: "mB", model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 0 } } };
  await writeFile(join(pdir, "b.jsonl"), JSON.stringify(turnB), "utf8");
  const snap = await scanner.snapshot(true);
  const row = snap.rows.find((r) => r.agent === "claude");
  assert.equal(row?.inputTokens, 15);

  // Recompute again with no changes — cached rows must not double count.
  const snap2 = await scanner.snapshot(true);
  assert.equal(snap2.rows.find((r) => r.agent === "claude")?.inputTokens, 15);
});

test("an unchanged refresh has a fresh persisted timestamp and repairs caller mutations", async (t) => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  await writeFile(join(pdir, "a.jsonl"), JSON.stringify({
    timestamp: "2026-07-07T00:00:00Z", requestId: "rA",
    message: { id: "mA", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 4 } }
  }) + "\n");
  let now = T0();
  const cacheFile = join(home, "c.json");
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile, now: () => now });
  const first = await scanner.snapshot(true);
  first.rows[0]!.inputTokens = 999;
  first.rows[0]!.costBreakdown!.input = 999;
  now += 1000;
  const refreshed = await scanner.snapshot(true);
  assert.equal(refreshed.rows[0]?.inputTokens, 10);
  assert.equal(refreshed.rows[0]?.outputTokens, 4);
  assert.ok(Math.abs((refreshed.rows[0]?.costBreakdown?.input ?? NaN) - 0.00005) < 1e-12);
  assert.equal(refreshed.asOf, new Date(now).toISOString());
  assert.equal(first.asOf, new Date(T0()).toISOString(), "an earlier snapshot keeps its timestamp");
  assert.deepEqual(JSON.parse(await readFile(cacheFile, "utf8")), refreshed);
});

test("refresh invalidates totals and dedup winners after deletion, same-size rewrite, truncation and recreation", async (t) => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-invalidate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  const a = join(pdir, "a.jsonl");
  const b = join(pdir, "b.jsonl");
  const turn = (tokens: number, id = "same") => JSON.stringify({
    timestamp: "2026-07-07T00:00:00Z", requestId: id, isSidechain: true, agentId: "sub",
    message: { id, model: "claude-opus-4-8", usage: { input_tokens: tokens, cache_read_input_tokens: tokens } }
  }) + "\n";
  await writeFile(a, turn(10));
  await writeFile(b, turn(20));
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 10, "sorted first file wins dedup");
  await rm(a);
  assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 20, "deleting the winner exposes its duplicate");
  assert.equal(scanner.subagentRequests(0)?.[0]?.cacheRead, 20);
  await writeFile(b, turn(21));
  await utimes(b, new Date(T0()), new Date(T0()));
  assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 21, "a same-size edit changes totals");
  assert.equal(scanner.subagentRequests(0)?.[0]?.cacheRead, 21);
  await writeFile(b, turn(21) + turn(8, "extra"));
  await scanner.snapshot(true);
  await writeFile(b, turn(7));
  assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 7, "a nonempty shorter rewrite replaces the previous turn");
  await writeFile(b, "");
  assert.deepEqual((await scanner.snapshot(true)).rows, [], "truncation clears old usage");
  assert.deepEqual(scanner.subagentRequests(0), []);
  await writeFile(a, turn(10));
  assert.equal((await scanner.snapshot(true)).rows[0]?.inputTokens, 10, "a previously missing path is scanned again");
});

test("the first empty scan replaces a persisted snapshot from removed transcripts", async (t) => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-empty-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cacheFile = join(home, "c.json");
  await writeFile(cacheFile, JSON.stringify({ rows: [{ agent: "claude", inputTokens: 999 }], asOf: "old" }));
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile, now: T0 });
  await scanner.init();
  assert.equal((await scanner.snapshot()).rows.length, 1);
  assert.deepEqual((await scanner.snapshot(true)).rows, []);
});

test("codex parser state (model, cumulative gate) carries across appended chunks", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-codexincr-"));
  const sdir = join(home, ".codex", "sessions", "s");
  await mkdir(sdir, { recursive: true });
  const file = join(sdir, "s.jsonl");
  const l = (o: unknown) => JSON.stringify(o);
  await writeFile(
    file,
    [
      l({ type: "turn_context", payload: { model: "gpt-5.4-codex" } }),
      l({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 0 } } } })
    ].join("\n") + "\n",
    "utf8"
  );
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  await scanner.snapshot(true);

  // Append: a duplicate cumulative total (must be gated out) and a real new
  // turn with no model on it (must inherit gpt-5.4-codex from the first chunk).
  const fs = await import("node:fs/promises");
  await fs.appendFile(
    file,
    [
      l({ timestamp: "2026-07-07T00:01:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 0 } } } }),
      l({ timestamp: "2026-07-07T00:02:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 150 }, last_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0 } } } })
    ].join("\n") + "\n",
    "utf8"
  );
  const snap = await scanner.snapshot(true);
  const row = snap.rows.find((r) => r.agent === "codex");
  assert.equal(row?.model, "gpt-5.4-codex");
  assert.equal(row?.inputTokens, 120); // 80 + 40, duplicate gated
  assert.equal(row?.outputTokens, 30); // 20 + 10
  assert.ok(row?.costUsd && row.costUsd > 0);
  assert.equal(row?.costSource, "api_equivalent");
});

test("an unterminated tail line is counted once, then not double-counted when completed", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-tail-"));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  const file = join(pdir, "t.jsonl");
  const turn1 = JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", requestId: "r1", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 0 } } });
  await writeFile(file, turn1, "utf8"); // NO trailing newline
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  assert.equal((await scanner.snapshot(true)).rows.find((r) => r.agent === "claude")?.inputTokens, 10);

  // Terminate the tail and append a second turn.
  const fs = await import("node:fs/promises");
  const turn2 = JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", requestId: "r2", message: { id: "m2", model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 0 } } });
  await fs.appendFile(file, "\n" + turn2 + "\n", "utf8");
  assert.equal((await scanner.snapshot(true)).rows.find((r) => r.agent === "claude")?.inputTokens, 15);
});

test("managed-account home transcripts are counted with and without a system home", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-acct-"));
  const acctHome = join(home, "agent-accounts", "claude", "a1", "home");
  const acctPdir = join(acctHome, "projects", "p");
  await mkdir(acctPdir, { recursive: true });
  await writeFile(
    join(acctPdir, "t.jsonl"),
    JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", requestId: "ra", message: { id: "ma", model: "claude-opus-4-8", usage: { input_tokens: 9, output_tokens: 2 } } }),
    "utf8"
  );
  const scanner = new UsageTokensScanner({
    userhome: home,
    cacheFile: join(home, "c.json"),
    now: T0,
    accountHomes: () => [{ agent: "claude", home: acctHome }]
  });
  await scanner.init();
  const managed = await scanner.snapshot(true);
  assert.deepEqual(managed.rows.map((r) => r.agent), ["claude"]);
  assert.equal(managed.rows[0].inputTokens, 9);
  assert.equal(managed.rows[0].outputTokens, 2);

  const sysPdir = join(home, ".claude", "projects", "p");
  await mkdir(sysPdir, { recursive: true });
  await writeFile(
    join(sysPdir, "t.jsonl"),
    JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", requestId: "rs", message: { id: "ms", model: "claude-opus-4-8", usage: { input_tokens: 4, output_tokens: 1 } } }),
    "utf8"
  );
  const snap = await scanner.snapshot(true);
  assert.deepEqual([...new Set(snap.rows.map((r) => r.agent))], ["claude"]);
  assert.equal(snap.rows.reduce((a, r) => a + r.inputTokens, 0), 13);
  assert.equal(snap.rows.reduce((a, r) => a + r.outputTokens, 0), 3);
});

test("subagent requests are reported once each, with their time and cache usage, apart from the main thread", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-sub-"));
  const sdir = join(home, ".claude", "projects", "p", "sess", "subagents");
  await mkdir(sdir, { recursive: true });
  const turn = (id: string, timestamp: string, extra: object, usage: object) =>
    JSON.stringify({ timestamp, requestId: `req_${id}`, ...extra, message: { id: `msg_${id}`, model: "claude-opus-5", usage } });
  const sub = { isSidechain: true, agentId: "a1" };
  await writeFile(
    join(sdir, "agent-a1.jsonl"),
    [
      turn("1", "2026-07-06T00:00:00Z", sub, { cache_creation_input_tokens: 70, cache_read_input_tokens: 5 }),
      turn("2", "2026-07-06T23:50:00Z", sub, {
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }
      }),
      // A streamed message is logged once per content block, with the same usage.
      turn("2", "2026-07-06T23:50:01Z", sub, { cache_creation_input_tokens: 50, cache_read_input_tokens: 100 })
    ].join("\n"),
    "utf8"
  );
  // Older transcripts mark a subagent only by where its file lives.
  await writeFile(
    join(sdir, "agent-old.jsonl"),
    turn("3", "2026-07-06T23:55:00Z", {}, { cache_creation_input_tokens: 9, cache_read_input_tokens: 1 }),
    "utf8"
  );
  await writeFile(
    join(home, ".claude", "projects", "p", "sess.jsonl"),
    turn("4", "2026-07-06T23:59:00Z", { isSidechain: false }, { cache_creation_input_tokens: 11, cache_read_input_tokens: 22 }),
    "utf8"
  );
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  await scanner.snapshot(true);
  const since = Date.parse("2026-07-06T12:00:00Z");
  assert.deepEqual(scanner.subagentRequests(since), [
    { sub: "a1", ts: Date.parse("2026-07-06T23:50:00Z"), cacheRead: 100, cacheWrite: 50, cacheWrite1h: 30 },
    { sub: join(sdir, "agent-old.jsonl"), ts: Date.parse("2026-07-06T23:55:00Z"), cacheRead: 1, cacheWrite: 9, cacheWrite1h: 0 }
  ]);
  assert.equal(scanner.subagentRequests(0)?.length, 3);
});

test("subagent requests are unknown until the transcripts have been scanned once", async () => {
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-sub-cold-"));
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  assert.equal(scanner.subagentRequests(0), null);
  await scanner.recompute();
  assert.deepEqual(scanner.subagentRequests(0), []);
});

test("claude-opus-5-5 has its own row: it reproduces the CLI's charges in claude fixtures 17, 18 and 19 (1-hour cache writes)", () => {
  // Not the claude-opus-5 row any more (the prefix fallback priced it at opus 5's rates before).
  assert.notEqual(estimateCostParts("claude-opus-5-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })!.input, 5);
  const cost = (input: number, output: number, cacheRead: number, cacheWrite: number) => {
    const parts = estimateCostParts("claude-opus-5-5", { input, output, cacheRead, cacheWrite, cacheWrite1h: cacheWrite })!;
    return parts.input + parts.output + parts.cache;
  };
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  close(cost(4, 333, 29_426, 6_900), 0.0677612); // fixture 17, turn 1
  close(cost(4, 202, 29_295, 6_651), 0.063123); // fixture 18
  close(cost(4, 176, 31_004, 4_847), 0.0485128); // fixture 19, turn 1
});

test("a trailing context tag is dropped before the lookup: claude-opus-4-8[1m] bills at standard opus 4.8 rates (claude fixture 01: 0.21547)", () => {
  assert.notEqual(estimateCostParts("claude-fable-5[1m]", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }), null);
  const parts = estimateCostParts("claude-opus-4-8[1m]", { input: 2, output: 4, cacheRead: 0, cacheWrite: 21_536, cacheWrite1h: 21_536 })!;
  assert.ok(Math.abs(parts.input + parts.output + parts.cache - 0.21547) < 1e-9);
});

test("codex rollouts an Agent Profile home writes through its sessions link are counted once", async () => {
  // A prepared profile CODEX_HOME links `sessions` to the account's, which links to the system one;
  // the scanner walks the system and account dirs (deduped by realpath), never prepared homes.
  const home = await mkdtemp(join(fixtureRoot, "orq-utok-profile-"));
  const systemSessions = join(home, ".codex", "sessions");
  await mkdir(systemSessions, { recursive: true });
  const fs = await import("node:fs/promises");
  const acctHome = join(home, "agent-accounts", "codex", "a1", "home");
  await mkdir(acctHome, { recursive: true });
  await fs.symlink(systemSessions, join(acctHome, "sessions"));
  const profileHome = join(home, "session-profiles", "prepared", "editor", "codex", "a1", "v-1");
  await mkdir(profileHome, { recursive: true });
  await fs.symlink(join(acctHome, "sessions"), join(profileHome, "sessions"));
  await writeFile(
    join(profileHome, "sessions", "p.jsonl"),
    JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 12 }, last_token_usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, total_tokens: 12 } } } }),
    "utf8"
  );
  const scanner = new UsageTokensScanner({
    userhome: home,
    cacheFile: join(home, "c.json"),
    now: T0,
    accountHomes: () => [{ agent: "codex", home: acctHome }]
  });
  await scanner.init();
  const codex = (await scanner.snapshot(true)).rows.filter((r) => r.agent === "codex");
  assert.equal(codex.reduce((a, r) => a + r.inputTokens, 0), 10);
  assert.equal(codex.reduce((a, r) => a + r.outputTokens, 0), 2);
});

// --- history records (Usage view) -------------------------------------------------

const hourOf = (iso: string) => Math.floor(Date.parse(iso) / 3_600_000);
const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

/** A scanner over a fresh home, with Claude transcripts and Codex rollouts written under it. */
async function historyWorld(t: { after: (fn: () => Promise<void>) => void }, name: string) {
  const home = await mkdtemp(join(fixtureRoot, name));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claudeDir = join(home, ".claude", "projects", "p");
  const codexDir = join(home, ".codex", "sessions");
  await mkdir(claudeDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  const cacheFile = join(home, "c.json");
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile, now: T0 });
  return { claudeDir, codexDir, cacheFile, scanner };
}

const claudeTurn = (o: { id: string; at: string; model?: string; usage: Record<string, unknown>; session?: string; cwd?: string }) => ({
  type: "assistant",
  timestamp: o.at,
  requestId: `req_${o.id}`,
  sessionId: o.session ?? "sess-1",
  cwd: o.cwd ?? "/work/ws/proj",
  message: { id: `msg_${o.id}`, model: o.model ?? "claude-opus-5", usage: o.usage }
});

test("history records carry each Claude request's hour, session, cwd and speed; advisor calls are rows of their own model; synthetic lines never count", async (t) => {
  const w = await historyWorld(t, "orq-utok-hist-claude-");
  assert.equal(w.scanner.historyRecords(), null, "unknown before the first scan");
  const advised = claudeTurn({
    id: "1", at: "2026-07-07T10:15:00Z",
    usage: {
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 15 },
      iterations: [
        { type: "message", input_tokens: 999, output_tokens: 999 },
        { type: "advisor_message", model: "claude-fable-5", input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
        { type: "advisor_message", model: "<synthetic>", input_tokens: 500, output_tokens: 500 }
      ]
    }
  });
  await writeFile(join(w.claudeDir, "a.jsonl"), jsonl(
    advised,
    claudeTurn({ id: "2", at: "2026-07-07T10:45:00Z", usage: { input_tokens: 5, output_tokens: 5, speed: "fast" } }),
    claudeTurn({ id: "3", at: "2026-07-07T11:05:00Z", session: "sess-2", cwd: "/work/ws/other", usage: { input_tokens: 7, output_tokens: 1 } }),
    claudeTurn({ id: "4", at: "2026-07-07T11:06:00Z", model: "<synthetic>", usage: { input_tokens: 100, output_tokens: 100 } })
  ));
  // A resumed transcript repeats the advised turn, advisor iteration included: both count once.
  await writeFile(join(w.claudeDir, "b.jsonl"), jsonl(advised));
  const tokens = await w.scanner.snapshot(true);
  assert.ok(!tokens.rows.some((row) => row.model === "<synthetic>"));
  const records = w.scanner.historyRecords()!;
  const pick = (model: string, speed: string, session: string) => records.filter((r) => r.model === model && r.speed === speed && r.session === session);
  assert.deepEqual(pick("claude-opus-5", "standard", "sess-1"), [{
    source: "transcripts", agent: "claude", model: "claude-opus-5", hour: hourOf("2026-07-07T10:15:00Z"), cwd: "/work/ws/proj", session: "sess-1", speed: "standard",
    input: 10, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15, output: 20, reasoning: 0, requests: 1, reportedCostUsd: 0, reportedRequests: 0
  }]);
  assert.deepEqual(pick("claude-fable-5", "standard", "sess-1").map((r) => [r.hour, r.input, r.output, r.cacheRead, r.cacheWrite, r.requests]), [[hourOf("2026-07-07T10:00:00Z"), 1, 2, 3, 4, 1]]);
  assert.deepEqual(pick("claude-opus-5", "fast", "sess-1").map((r) => [r.hour, r.input, r.requests]), [[hourOf("2026-07-07T10:00:00Z"), 5, 1]]);
  assert.deepEqual(pick("claude-opus-5", "standard", "sess-2").map((r) => [r.hour, r.cwd]), [[hourOf("2026-07-07T11:00:00Z"), "/work/ws/other"]]);
  assert.equal(records.length, 4, "nothing else: neither the synthetic line nor the copy");
  // The Cost tab prices the fast request at the fast tier (opus 5: 2x every rate) and the advisor at its own model.
  const sum = (p: { input: number; output: number; cache: number } | null) => p!.input + p!.output + p!.cache;
  const standard = sum(estimateCostParts("claude-opus-5", { input: 17, output: 21, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 15 }));
  const fastAtStandard = sum(estimateCostParts("claude-opus-5", { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }));
  const opus = tokens.rows.find((row) => row.model === "claude-opus-5")!;
  assert.ok(Math.abs(opus.costUsd! - (standard + 2 * fastAtStandard)) < 1e-12, `${opus.costUsd}`);
  assert.equal(tokens.rows.find((row) => row.model === "claude-fable-5")?.inputTokens, 1);
});

const codexCount = (at: string, total: number, last: Record<string, number>) => ({
  timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last } }
});

test("codex records: session from the first meta, cwd from the meta then the latest turn context, cache writes and reasoning split out, speed from the thread settings", async (t) => {
  const w = await historyWorld(t, "orq-utok-hist-codex-");
  await writeFile(join(w.codexDir, "r.jsonl"), jsonl(
    { timestamp: "2026-07-07T09:00:00Z", type: "session_meta", payload: { id: "codex-s1", cwd: "/work/ws/a", model: "gpt-6-sol" } },
    // A copied ancestor's meta says nothing of this rollout.
    { timestamp: "2026-07-07T09:00:00Z", type: "session_meta", payload: { id: "ancestor", cwd: "/elsewhere" } },
    codexCount("2026-07-07T09:10:00Z", 100, { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 15, output_tokens: 20, reasoning_output_tokens: 8 }),
    { timestamp: "2026-07-07T09:20:00Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-6-sol", service_tier: "priority" } } },
    { timestamp: "2026-07-07T09:20:00Z", type: "turn_context", payload: { cwd: "/work/ws/b", model: "gpt-6-sol" } },
    codexCount("2026-07-07T10:30:00Z", 200, { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10 })
  ));
  await w.scanner.snapshot(true);
  assert.deepEqual(w.scanner.historyRecords()!.map((r) => [r.hour, r.session, r.cwd, r.speed, r.input, r.cacheRead, r.cacheWrite, r.output, r.reasoning, r.requests]), [
    [hourOf("2026-07-07T09:00:00Z"), "codex-s1", "/work/ws/a", "standard", 25, 60, 15, 20, 8, 1],
    [hourOf("2026-07-07T10:00:00Z"), "codex-s1", "/work/ws/b", "fast", 50, 0, 0, 10, 0, 1]
  ]);
});

test("a codex fork's copied history is not billed, the first real request after the burst is; a rollout that is no fork bills the same events", async (t) => {
  const w = await historyWorld(t, "orq-utok-hist-fork-");
  const body = [
    { timestamp: "2026-07-07T12:00:00.500Z", type: "turn_context", payload: { model: "gpt-6-sol" } },
    // The parent's history, replayed within milliseconds of each other.
    codexCount("2026-07-07T12:00:00.600Z", 1_000, { input_tokens: 900, output_tokens: 100 }),
    codexCount("2026-07-07T12:00:01.300Z", 3_000, { input_tokens: 1_800, output_tokens: 200 }),
    // The fork's own first request, seconds later.
    codexCount("2026-07-07T12:00:09.000Z", 3_050, { input_tokens: 40, output_tokens: 10 })
  ];
  await writeFile(join(w.codexDir, "fork.jsonl"), jsonl({ timestamp: "2026-07-07T12:00:00Z", type: "session_meta", payload: { id: "child", forked_from_id: "parent" } }, ...body));
  await writeFile(join(w.codexDir, "spawn.jsonl"), jsonl({ timestamp: "2026-07-07T12:00:00Z", type: "session_meta", payload: { id: "sub", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } } }, ...body));
  await writeFile(join(w.codexDir, "plain.jsonl"), jsonl({ timestamp: "2026-07-07T12:00:00Z", type: "session_meta", payload: { id: "plain" } }, ...body));
  await w.scanner.snapshot(true);
  const bySession = new Map(w.scanner.historyRecords()!.map((r) => [r.session, [r.input, r.output, r.requests]]));
  assert.deepEqual(bySession.get("child"), [40, 10, 1]);
  assert.deepEqual(bySession.get("sub"), [40, 10, 1], "a spawned subagent without forked_from_id is a fork too");
  assert.deepEqual(bySession.get("plain"), [2_740, 310, 3]);
});

test("codex parser state (session, cwd, speed, fork suppression) carries across appended chunks and an unterminated tail", async (t) => {
  const w = await historyWorld(t, "orq-utok-hist-chunks-");
  const file = join(w.codexDir, "fork.jsonl");
  await writeFile(file, jsonl(
    { timestamp: "2026-07-07T12:00:00Z", type: "session_meta", payload: { id: "child", cwd: "/work/ws/a", forked_from_id: "parent" } },
    { timestamp: "2026-07-07T12:00:00.100Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-6-sol", service_tier: "ultrafast" } } },
    codexCount("2026-07-07T12:00:00.200Z", 1_000, { input_tokens: 900, output_tokens: 100 })
  ) + JSON.stringify(codexCount("2026-07-07T12:00:00.700Z", 2_000, { input_tokens: 900, output_tokens: 100 })));
  await w.scanner.snapshot(true);
  assert.deepEqual(w.scanner.historyRecords(), [], "the unterminated copy is still inside the burst");
  await appendFile(file, "\n" + jsonl(
    codexCount("2026-07-07T12:00:01.100Z", 2_500, { input_tokens: 450, output_tokens: 50 }),
    codexCount("2026-07-07T12:00:05.000Z", 2_530, { input_tokens: 20, output_tokens: 10 })
  ));
  await w.scanner.snapshot(true);
  assert.deepEqual(w.scanner.historyRecords()!.map((r) => [r.session, r.cwd, r.speed, r.model, r.input, r.output, r.requests]), [["child", "/work/ws/a", "ultrafast", "gpt-6-sol", 20, 10, 1]]);
});

test("history records are de-duplicated across transcripts, and a deleted winner's copy takes its place", async (t) => {
  const w = await historyWorld(t, "orq-utok-hist-dedup-");
  const turn = claudeTurn({ id: "x", at: "2026-07-07T08:00:00Z", usage: { input_tokens: 3, output_tokens: 4 } });
  await writeFile(join(w.claudeDir, "a.jsonl"), jsonl(turn));
  await writeFile(join(w.claudeDir, "b.jsonl"), jsonl(turn, claudeTurn({ id: "y", at: "2026-07-07T08:30:00Z", usage: { input_tokens: 1, output_tokens: 1 } })));
  await w.scanner.snapshot(true);
  assert.deepEqual(w.scanner.historyRecords()!.map((r) => [r.input, r.output, r.requests]), [[4, 5, 2]]);
  await rm(join(w.claudeDir, "a.jsonl"));
  await w.scanner.snapshot(true);
  assert.deepEqual(w.scanner.historyRecords()!.map((r) => [r.input, r.output, r.requests]), [[4, 5, 2]], "b's copy now counts, still once");
});

test("a price change reprices the Cost tab's rows from the scanned sums, without a rescan, and persists them", async (t) => {
  const w = await historyWorld(t, "orq-utok-reprice-");
  t.after(async () => setUsagePricingConfig({ overrides: {}, aliases: {} }));
  await writeFile(join(w.claudeDir, "a.jsonl"), jsonl(claudeTurn({ id: "1", at: "2026-07-07T08:00:00Z", model: "mystery-model", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } })));
  await w.scanner.init();
  assert.equal((await w.scanner.snapshot(true)).rows[0]?.costUsd, null, "unpriced at first");
  // Gone from disk: only the scanned sums can answer now.
  await rm(join(w.claudeDir, "a.jsonl"));
  setUsagePricingConfig({ overrides: { "mystery-model": { input: 2, output: 8 } }, aliases: {} });
  const repriced = await w.scanner.snapshot();
  assert.equal(repriced.rows[0]?.inputTokens, 1_000_000);
  assert.equal(repriced.rows[0]?.costUsd, 10);
  assert.deepEqual(repriced.rows[0]?.costBreakdown, { input: 2, output: 8, cache: 0 });
  assert.deepEqual(JSON.parse(await readFile(w.cacheFile, "utf8")), repriced);
  setUsagePricingConfig({ overrides: {}, aliases: { "mystery-model": "claude-opus-5" } });
  assert.equal((await w.scanner.snapshot()).rows[0]?.costUsd, 30, "an alias prices it as its target (opus 5: 5 + 25)");
});
