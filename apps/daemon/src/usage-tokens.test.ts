import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateCostUsd, aggregateRows, UsageTokensScanner } from "./usage-tokens.ts";

test("estimateCostUsd multiplies by the per-million price table", () => {
  // claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 per 1M
  const cost = estimateCostUsd("claude", "claude-opus-4-8", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 30);
});

test("unknown model yields null cost", () => {
  assert.equal(estimateCostUsd("claude", "made-up-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
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
  assert.equal(codex.reduce((a, r) => a + r.inputTokens, 0), 150);
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
