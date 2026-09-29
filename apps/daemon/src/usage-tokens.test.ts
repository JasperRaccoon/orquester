import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateCostParts, UsageTokensScanner } from "./usage-tokens.ts";

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
  delete process.env.CODEX_HOME;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-codex-"));
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
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-1h-"));
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
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-dedup-"));
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
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-cache-"));
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

test("a truncated/rewritten file is fully re-parsed", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-trunc-"));
  const pdir = join(home, ".claude", "projects", "p");
  await mkdir(pdir, { recursive: true });
  const file = join(pdir, "t.jsonl");
  const mk = (id: string, tokens: number) =>
    JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", requestId: id, message: { id, model: "claude-opus-4-8", usage: { input_tokens: tokens, output_tokens: 0 } } });
  await writeFile(file, mk("r1", 10) + "\n" + mk("r2", 20) + "\n", "utf8");
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  assert.equal((await scanner.snapshot(true)).rows.find((r) => r.agent === "claude")?.inputTokens, 30);

  // Shrink the file to a single different turn — totals must reflect only it.
  await writeFile(file, mk("r3", 7) + "\n", "utf8");
  assert.equal((await scanner.snapshot(true)).rows.find((r) => r.agent === "claude")?.inputTokens, 7);
});

test("codex parser state (model, cumulative gate) carries across appended chunks", async () => {
  delete process.env.CODEX_HOME;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-codexincr-"));
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
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-tail-"));
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
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-acct-"));
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
