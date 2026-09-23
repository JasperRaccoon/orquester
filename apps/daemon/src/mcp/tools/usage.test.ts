import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { MAX_COST_RESULT_CHARS, usageTools } from "./usage.ts";

const tool = (name: string) => usageTools.find((t) => t.name === name)!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") });

test("get_usage passes refresh through and joins accounts", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/usage", ({ query }) => ({ status: 200, body: { agents: [{ id: "codex", available: true, stale: false, plan: "Pro", session: null, weekly: { percent: 34, resetsAt: "2026-09-23T20:38:00.000Z" }, asOf: "2026-09-22T11:50:00.000Z", accounts: [{ id: "acc-2", label: "therealeduard465", available: true, stale: false, plan: "Pro", session: null, weekly: { percent: 34, resetsAt: "2026-09-23T20:38:00.000Z" }, asOf: "2026-09-22T11:50:00.000Z" }], refreshed: query?.refresh === "1" }] } }))
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [{ id: "acc-2", agent: "codex", label: "therealeduard465", email: "e@x.io", plan: null, needsReauth: false, createdAt: "", importedAt: "" }], defaults: {} } });
  const r = await tool("get_usage").run({ refresh: true }, ctx(api));
  assert.deepEqual(api.calls[0].query, { refresh: "1" });
  const agent = (r.agents as { name: string; accounts: { label: string; email: string; windows: { label: string; percentUsed: number; resetsIn: string }[] }[] }[])[0];
  assert.equal(agent.name, "Codex"); assert.equal(agent.accounts[0].email, "e@x.io"); assert.deepEqual(agent.accounts[0].windows[0], { id: "weekly", label: "Week", percentUsed: 34, resetsAt: "2026-09-23T20:38:00.000Z", resetsIn: "1d 8h 38m" });
  await tool("get_usage").run({ refresh: false }, ctx(api));
  assert.equal(api.calls.at(-2)!.query, undefined);
});

test("get_cost windows the rows to the last N UTC days and totals them", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows: [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5, costSource: "api_equivalent" },
    { agent: "claude", model: "opus", day: "2026-09-21", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, costSource: "api_equivalent" },
    { agent: "codex", model: "gpt", day: "2026-09-01", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 9, costSource: "api_equivalent" }
  ] } });
  const r = await tool("get_cost").run({ days: 7 }, ctx(api));
  assert.equal(r.days, 7); assert.equal(r.totalUsd, 2); assert.deepEqual(r.byDay, [{ day: "2026-09-21", usd: 0.5 }, { day: "2026-09-22", usd: 1.5 }]);
  assert.equal((r.rows as unknown[]).length, 2); assert.equal(r.asOf, "2026-09-22T11:00:00.000Z");
});

test("get_cost rounds row costs, keeps an unpriced row's null and projects the row shape", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows: [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, cacheWrite1hTokens: 1, costUsd: 0.123456789, costBreakdown: { input: 0.1, output: 0.02, cache: 0.003456789 }, costSource: "api_equivalent" },
    { agent: "codex", model: "unpriced", day: "2026-09-22", inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costBreakdown: null, costSource: "api_equivalent" }
  ] } });
  const r = await tool("get_cost").run({ days: 1 }, ctx(api));
  assert.deepEqual(r.rows, [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, costUsd: 0.1235 },
    { agent: "codex", model: "unpriced", day: "2026-09-22", inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }
  ]);
  assert.deepEqual(r.byDay, [{ day: "2026-09-22", usd: 0.1235 }]); assert.equal(r.totalUsd, 0.1235, "an unpriced row counts as $0");
  assert.equal("truncated" in r, false);
});

test("get_cost keeps an oversized result in budget by dropping the oldest days' rows, never the totals", async () => {
  const models = ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "gpt-5-codex", "grok-code-fast-1", "claude-haiku-4-5-20251001"];
  const dayOf = (k: number) => new Date(Date.UTC(2026, 8, 22 - k)).toISOString().slice(0, 10); // k days before today
  // 400 rows over 90 days: four models every day, a fifth on the newest 40 (so $1.25 a day there, $1 before).
  const rows = Array.from({ length: 400 }, (_, i) => ({ agent: "claude", model: models[Math.floor(i / 90)]!, day: dayOf(i % 90), inputTokens: 123_456, outputTokens: 12_345, cacheReadTokens: 1_234_567, cacheWriteTokens: 123_456, costUsd: 0.25, costSource: "api_equivalent" }));
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows } });
  const r = await tool("get_cost").run({ days: 90 }, ctx(api));
  assert.ok(JSON.stringify(r).length <= MAX_COST_RESULT_CHARS);
  assert.equal(r.truncated, true);
  const kept = r.rows as { day: string }[];
  const dropped = r.rowsDropped as number;
  assert.ok(dropped > 0); assert.equal(kept.length + dropped, 400);
  const keptDays = [...new Set(kept.map((row) => row.day))];
  assert.deepEqual(keptDays, Array.from({ length: keptDays.length }, (_, k) => dayOf(k)), "the newest days, newest first");
  assert.equal(kept.length, rows.filter((row) => keptDays.includes(row.day)).length, "whole days: a kept day keeps every row");
  assert.deepEqual(r.byDay, Array.from({ length: 90 }, (_, i) => ({ day: dayOf(89 - i), usd: 89 - i < 40 ? 1.25 : 1 })));
  assert.equal(r.totalUsd, 100); assert.equal(r.days, 90); assert.equal(r.asOf, "2026-09-22T11:00:00.000Z");
});
