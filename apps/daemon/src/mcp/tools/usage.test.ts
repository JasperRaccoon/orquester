import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Turn } from "@orquester/api/agent-chat";
import type { AnyOrquesterTool, CallContext, ThreadCaller } from "../catalog/contract.ts";
import { chatSummary, head, snapshot, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import { isoWeek } from "../usage-view.ts";
import { usageFamily } from "./usage.ts";

const getUsage: AnyOrquesterTool = usageFamily.find((t) => t.name === "get_usage")!;
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const external: CallContext["caller"] = { kind: "external" };
const chat: ThreadCaller = { kind: "thread", threadId: "me", title: "Me", projectPath: "", workspace: "", cwd: "/", agentId: "claude", callId: "c", runtimeMode: "auto", planning: false, workflowOwned: false, exchange: null };
/** The arguments as the executor hands them to `run`: parsed, defaults applied. */
const run = async (api: FakeDaemonApi, args: Record<string, unknown>, caller: CallContext["caller"] = external) =>
  (await getUsage.run(z.object(getUsage.input).strict().parse(args), { api, signal: new AbortController().signal, now: () => NOW, caller, turn: { interactionMode: "default", provenance: (_o, t) => t } })) as Record<string, any>;
/** A result's size as ok() counts it (result.ts): its JSON, in UTF-8 bytes. */
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const dayOf = (k: number) => new Date(Date.UTC(2026, 8, 22 - k)).toISOString().slice(0, 10); // k days before today

const quotaApi = () => new FakeDaemonApi()
  .on("GET", "/api/usage", { status: 200, body: { agents: [{ id: "codex", available: true, stale: false, session: null, weekly: null, accounts: [{ id: "acc-1", label: "Work", available: true, stale: false, session: { percent: 12 }, weekly: null }] }] } })
  .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [{ id: "acc-1", agent: "codex", label: "Work", email: "w@x.io", plan: null, needsReauth: false, createdAt: "", importedAt: "" }], defaults: {} } });

test("get_usage forwards the explicit refresh request; quota is the default and stays at the top level (parity)", async () => {
  const api = quotaApi();
  const r = await run(api, { refresh: true });
  await run(api, {});
  assert.deepEqual(api.calls.filter((call) => call.path === "/api/usage").map((call) => call.query), [{ refresh: "1" }, undefined]);
  assert.equal(r.agents[0].id, "codex");
  assert.equal(r.cost, undefined);
  assert.equal(r.session, undefined);
  assert.equal(r.agents[0].accounts[0].email, "w@x.io", "external callers keep the account email");
  const asChat = await run(api, {}, chat);
  assert.ok(!JSON.stringify(asChat).includes("w@x.io"), "chat callers never see an account email");
});

test("get_usage cost windows the rows to the last N UTC days and totals them", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows: [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5, costSource: "api_equivalent" },
    { agent: "claude", model: "opus", day: "2026-09-21", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, costSource: "api_equivalent" },
    { agent: "codex", model: "gpt", day: "2026-09-01", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 9, costSource: "api_equivalent" }
  ] } });
  const r = (await run(api, { include: ["cost"], days: 7 })).cost;
  assert.equal(r.days, 7); assert.equal(r.bucket, "day"); assert.equal(r.totalUsd, 2); assert.deepEqual(r.byDay, [{ day: "2026-09-21", usd: 0.5 }, { day: "2026-09-22", usd: 1.5 }]);
  assert.equal((r.rows as unknown[]).length, 2); assert.equal(r.asOf, "2026-09-22T11:00:00.000Z");
  assert.ok(!api.calls.some((call) => call.path === "/api/usage"), "no quota read unless included");
});

test("get_usage cost rounds row costs, keeps an unpriced row's null and projects the row shape", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows: [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, cacheWrite1hTokens: 1, costUsd: 0.123456789, costBreakdown: { input: 0.1, output: 0.02, cache: 0.003456789 }, costSource: "api_equivalent" },
    { agent: "codex", model: "unpriced", day: "2026-09-22", inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costBreakdown: null, costSource: "api_equivalent" }
  ] } });
  const r = (await run(api, { include: ["cost"], days: 1 })).cost;
  assert.deepEqual(r.rows, [
    { agent: "claude", model: "opus", day: "2026-09-22", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, costUsd: 0.1235 },
    { agent: "codex", model: "unpriced", day: "2026-09-22", inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }
  ]);
  assert.deepEqual(r.byDay, [{ day: "2026-09-22", usd: 0.1235 }]); assert.equal(r.totalUsd, 0.1235, "an unpriced row counts as $0");
  assert.equal("truncated" in r, false);
});

test("get_usage cost keeps an oversized result in budget by dropping the oldest days' rows, never the totals", async () => {
  const models = Array.from({ length: 5 }, (_, i) => `模型-${"深度求索".repeat(8)}-${i}`);
  // 400 rows over 90 days: four models every day, a fifth on the newest 40 (so $1.25 a day there, $1 before).
  const rows = Array.from({ length: 400 }, (_, i) => ({ agent: "claude", model: models[Math.floor(i / 90)]!, day: dayOf(i % 90), inputTokens: 123_456, outputTokens: 12_345, cacheReadTokens: 1_234_567, cacheWriteTokens: 123_456, costUsd: 0.25, costSource: "api_equivalent" }));
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows } });
  const r = (await run(api, { include: ["cost"], days: 90 })).cost;
  assert.ok(bytes(r) <= 50_000, "within the budget, in bytes");
  assert.equal(r.truncated, true);
  const kept = r.rows as { day: string }[];
  const dropped = r.rowsDropped as number;
  assert.ok(dropped > 0, "rows were dropped"); assert.equal(kept.length + dropped, 400);
  assert.ok(kept.length > 0, "rows are kept, not all dropped");
  const keptDays = [...new Set(kept.map((row) => row.day))];
  assert.deepEqual(keptDays, Array.from({ length: keptDays.length }, (_, k) => dayOf(k)), "the newest days, newest first");
  assert.equal(kept.length, rows.filter((row) => keptDays.includes(row.day)).length, "whole days: a kept day keeps every row");
  assert.deepEqual(r.byDay, Array.from({ length: 90 }, (_, i) => ({ day: dayOf(89 - i), usd: 89 - i < 40 ? 1.25 : 1 })));
  assert.equal(r.totalUsd, 100); assert.equal(r.days, 90); assert.equal(r.asOf, "2026-09-22T11:00:00.000Z");
});

test("isoWeek: ISO 8601 weeks in UTC, the week-year of the Thursday, Monday as `from`", () => {
  assert.deepEqual(isoWeek("2026-09-22"), { week: "2026-W39", from: "2026-09-21" });
  assert.deepEqual(isoWeek("2026-09-27"), { week: "2026-W39", from: "2026-09-21" }, "Sunday ends the week");
  assert.deepEqual(isoWeek("2026-09-28"), { week: "2026-W40", from: "2026-09-28" });
  assert.deepEqual(isoWeek("2027-01-01"), { week: "2026-W53", from: "2026-12-28" }, "a Friday's week belongs to the previous year");
  assert.deepEqual(isoWeek("2024-12-30"), { week: "2025-W01", from: "2024-12-30" }, "a Monday's week can belong to the next year");
});

test("get_usage cost by week: one row per agent, model and ISO week, priced when any day is; week totals with their Monday", async () => {
  const row = (day: string, model: string, costUsd: number | null, input = 1) => ({ agent: "codex", model, day, inputTokens: input, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd, costSource: "api_equivalent" });
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-09-22T11:00:00.000Z", rows: [
    row("2026-09-22", "gpt-5.6-sol", 1), row("2026-09-21", "gpt-5.6-sol", 2, 10), row("2026-09-20", "gpt-5.6-sol", 4), row("2026-09-14", "gpt-5.6-sol", 8),
    row("2026-09-21", "mystery", null), row("2026-09-13", "gpt-5.6-sol", 100)
  ] } });
  const r = (await run(api, { include: ["cost"], bucket: "week", days: 9 })).cost;
  assert.equal(r.bucket, "week");
  assert.equal(r.byDay, undefined);
  assert.deepEqual(r.byWeek, [{ week: "2026-W38", from: "2026-09-14", usd: 12 }, { week: "2026-W39", from: "2026-09-21", usd: 3 }]);
  assert.equal(r.totalUsd, 15, "the 13th is outside nine days");
  assert.deepEqual(r.rows, [
    { agent: "codex", model: "gpt-5.6-sol", week: "2026-W39", inputTokens: 11, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0, costUsd: 3 },
    { agent: "codex", model: "mystery", week: "2026-W39", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: null },
    { agent: "codex", model: "gpt-5.6-sol", week: "2026-W38", inputTokens: 2, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0, costUsd: 12 }
  ]);
});

/** A chat session `s1` whose snapshot holds `turns` (and a history window when `hasOlder`). */
function sessionApi(turns: Turn[], over: { model?: string; refId?: string; hasOlder?: boolean } = {}): FakeDaemonApi {
  const thread = snapshot({ head: head({ id: "s1", refId: over.refId ?? "codex", adapter: "codex", modelSelection: { model: over.model ?? "gpt-5.6-sol", options: [] } }), turns, ...(over.hasOlder !== undefined ? { history: { indexed: true, hasOlder: over.hasOlder, beforeCursor: over.hasOlder ? "c" : null, oldestRetainedOrdinal: 4, totalTurns: 9 } } : {}) });
  return new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "s1", refId: over.refId ?? "codex", projectPath: "" })] })
    .on("GET", "/api/sessions/s1/thread", { status: 200, body: { kind: "snapshot", thread } });
}
const usage = (inputTokens: number, outputTokens: number, extra: Partial<{ cachedInputTokens: number; cacheCreationTokens: number; reasoningTokens: number }> = {}) =>
  ({ usageScope: "main_agent", usageStatus: "complete", inputTokens, outputTokens, hasSubagents: false, ...extra }) as const;

test("get_usage session: sums the snapshot's turn tokens and prices Codex turns from the cost table (costSource estimated)", async () => {
  const api = sessionApi([
    // 1M fresh input, 200k cached (in inputTokens), 100k output at gpt-5.6-sol ($5 / $0.5 / $30 per M).
    turn({ turnId: "t1", tokenUsage: usage(1_200_000, 100_000, { cachedInputTokens: 200_000, reasoningTokens: 40_000 }) }),
    turn({ turnId: "t2", tokenUsage: usage(0, 0) }),
    turn({ turnId: "t3", state: "running", completedAt: null })
  ]);
  const r = (await run(api, { sessionId: "s1" })).session;
  assert.deepEqual(r, {
    sessionId: "s1", agent: "codex", model: "gpt-5.6-sol", turnsCounted: 3, partial: false,
    inputTokens: 1_200_000, outputTokens: 100_000, cachedInputTokens: 200_000, cacheCreationTokens: 0, reasoningTokens: 40_000,
    costUsd: 8.1, costSource: "estimated", estimatedUsd: 8.1, turnsWithoutUsage: 1
  });
  // A sessionId alone means the session view; quota is not read.
  assert.ok(!api.calls.some((call) => call.path === "/api/usage"));
});

test("get_usage session: a provider-reported cost wins per turn; reported + estimated is mixed; a turn's own model prices it; unpriced and partial are said", async () => {
  const claude = sessionApi([turn({ tokenUsage: usage(10, 5), totalCostUsd: 0.42 }), turn({ turnId: "t2", totalCostUsd: 0.08 })], { refId: "claude", model: "claude-opus-5" });
  const reported = (await run(claude, { include: ["session"], sessionId: "s1" })).session;
  assert.equal(reported.costUsd, 0.5); assert.equal(reported.costSource, "reported"); assert.equal(reported.estimatedUsd, undefined);
  const mixed = (await run(sessionApi([
    turn({ tokenUsage: usage(1_000_000, 0), totalCostUsd: 1 }),
    turn({ turnId: "t2", model: "gpt-5.6-luna", tokenUsage: usage(1_000_000, 0) }),
    turn({ turnId: "t3", model: "no-such-model", tokenUsage: usage(5, 5) })
  ], { hasOlder: true }), { include: ["session"], sessionId: "s1" })).session;
  assert.equal(mixed.costSource, "mixed");
  assert.equal(mixed.costUsd, 2, "$1 reported + 1M luna input at $1/M");
  assert.equal(mixed.unpricedTurns, 1);
  assert.equal(mixed.partial, true, "older turns lie outside the snapshot");
  assert.equal(mixed.totalTurns, 9);
  const none = (await run(sessionApi([turn({ tokenUsage: usage(5, 5) })], { model: "no-such-model" }), { sessionId: "s1" })).session;
  assert.deepEqual([none.costUsd, none.costSource, none.unpricedTurns], [null, undefined, 1]);
});

test("get_usage session needs a sessionId and a chat session; its scope is that session's metadata", async () => {
  const api = sessionApi([]);
  await assert.rejects(run(api, { include: ["session"] }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(run(api, { sessionId: "nope" }), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  const scope = await getUsage.scope(z.object(getUsage.input).parse({ sessionId: "s1" }), { api, signal: new AbortController().signal, now: () => NOW, caller: chat });
  assert.deepEqual(scope, { projects: [], sessions: ["s1"], reads: "metadata", writes: false, causesTurnIn: [] });
  assert.deepEqual(await getUsage.scope(z.object(getUsage.input).parse({}), { api, signal: new AbortController().signal, now: () => NOW, caller: chat }), { projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] });
});
