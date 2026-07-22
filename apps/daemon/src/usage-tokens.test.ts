import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateCostUsd, resolveModelKey, aggregateRows, UsageTokensScanner } from "./usage-tokens.ts";

test("estimateCostUsd multiplies by the per-million price table", () => {
  // claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 per 1M
  const cost = estimateCostUsd("claude", "claude-opus-4-8", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 30);
});

test("unknown model yields null cost", () => {
  assert.equal(estimateCostUsd("claude", "made-up-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test("versioned model ids resolve to the bare pricing key (F1)", () => {
  // Transcripts record e.g. "claude-opus-4-8-20260115"; a trailing -YYYYMMDD
  // suffix (or any longer variant) must match the bare key.
  assert.equal(resolveModelKey("claude-opus-4-8-20260115"), "claude-opus-4-8");
  assert.equal(resolveModelKey("gpt-5.4-codex-preview"), "gpt-5.4-codex");
  assert.equal(resolveModelKey("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(resolveModelKey("mystery-model"), null);
  // A versioned id must yield a real cost, not null.
  const cost = estimateCostUsd("claude", "claude-opus-4-8-20260115", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 5);
});

test("aggregateRows groups by agent/model/day and sums tokens", () => {
  const rows = aggregateRows([
    { agent: "claude", model: "claude-opus-4-8", day: "2026-07-07", input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
    { agent: "claude", model: "claude-opus-4-8", day: "2026-07-07", input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 15);
  assert.equal(rows[0].outputTokens, 5);
  assert.equal(rows[0].costSource, "api_equivalent");
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

test("scanClaude also walks managed-account homes", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const host = await mkdtemp(join(tmpdir(), "orq-utok-host-")); // empty ~/.claude
  const acctHome = await mkdtemp(join(tmpdir(), "orq-acct-home-"));
  const pdir = join(acctHome, "projects", "p");
  await mkdir(pdir, { recursive: true });
  await writeFile(
    join(pdir, "t.jsonl"),
    JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", message: { model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 } } }),
    "utf8"
  );
  const scanner = new UsageTokensScanner({
    userhome: host,
    cacheFile: join(host, "c.json"),
    now: T0,
    accountHomes: () => [{ agent: "claude", home: acctHome }]
  });
  await scanner.init();
  const snap = await scanner.snapshot(true);
  const row = snap.rows.find((r) => r.agent === "claude");
  assert.ok(row);
  assert.equal(row?.inputTokens, 7);
  assert.equal(row?.outputTokens, 3);
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

test("scanCodex reads model from turn_context payload and prices it (F4)", async () => {
  delete process.env.CODEX_HOME;
  const home = await mkdtemp(join(tmpdir(), "orq-utok-model-"));
  const sdir = join(home, ".codex", "sessions");
  await mkdir(sdir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  await writeFile(
    join(sdir, "s.jsonl"),
    [
      line({ type: "session_meta", payload: { session_id: "x", model_provider: "openai" } }),
      line({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.4-codex" } }),
      line({ timestamp: "2026-07-07T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 0, total_tokens: 100 } } } })
    ].join("\n"),
    "utf8"
  );
  const scanner = new UsageTokensScanner({ userhome: home, cacheFile: join(home, "c.json"), now: T0 });
  await scanner.init();
  const snap = await scanner.snapshot(true);
  const row = snap.rows.find((r) => r.agent === "codex");
  assert.ok(row);
  assert.equal(row?.model, "gpt-5.4-codex");
  assert.ok(row?.costUsd && row.costUsd > 0); // priced, not null
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
