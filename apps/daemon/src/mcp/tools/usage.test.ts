import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { ThreadItem, Turn } from "@orquester/api/agent-chat";
import type { AnyOrquesterTool, CallContext, ThreadCaller } from "../catalog/contract.ts";
import { chatSummary, head, snapshot, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import { costView } from "../usage-view.ts";
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

test("weekly cost uses the ISO week-year across December and January", () => {
  for (const [day, week, from] of [
    ["2027-01-01", "2026-W53", "2026-12-28"],
    ["2024-12-30", "2025-W01", "2024-12-30"]
  ] as const) {
    const result = costView({ asOf: day, rows: [{ agent: "codex", model: "model", day, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, costSource: "api_equivalent" }] },
      { days: 1, bucket: "week", now: Date.parse(`${day}T12:00:00Z`) });
    assert.deepEqual(result.byWeek, [{ week, from, usd: 1 }]);
  }
});

test("get_usage cost by week extends the window back to the Monday of its first week: no partial week (days 7 on Thursday 2026-10-15)", async () => {
  const row = (day: string, costUsd: number) => ({ agent: "claude", model: "opus", day, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, costSource: "api_equivalent" });
  const api = new FakeDaemonApi().on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-10-15T11:00:00.000Z", rows: [
    row("2026-10-15", 1), row("2026-10-12", 2), row("2026-10-09", 4), row("2026-10-05", 8), row("2026-10-04", 16)
  ] } });
  const at = Date.parse("2026-10-15T12:00:00.000Z");
  const cost = async (args: Record<string, unknown>) => ((await getUsage.run(z.object(getUsage.input).strict().parse(args), { api, signal: new AbortController().signal, now: () => at, caller: external, turn: { interactionMode: "default", provenance: (_o, t) => t } })) as Record<string, any>).cost;
  const weekly = await cost({ include: ["cost"], bucket: "week", days: 7 });
  // Seven days back is Friday 2026-10-09; its week began Monday 2026-10-05, so W41 is counted whole.
  assert.equal(weekly.since, "2026-10-05");
  assert.deepEqual(weekly.byWeek, [{ week: "2026-W41", from: "2026-10-05", usd: 12 }, { week: "2026-W42", from: "2026-10-12", usd: 3 }]);
  assert.equal(weekly.totalUsd, 15);
  const daily = await cost({ include: ["cost"], days: 7 });
  assert.equal(daily.since, "2026-10-09");
  assert.equal(daily.totalUsd, 7, "days stay exactly the window");
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
  // Nine days back is Monday the 14th: the window already starts on its week's Monday, so the 13th stays out.
  assert.equal(r.since, "2026-09-14");
  assert.equal(r.totalUsd, 15, "the 13th is outside nine days");
  assert.deepEqual(r.rows, [
    { agent: "codex", model: "gpt-5.6-sol", week: "2026-W39", inputTokens: 11, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0, costUsd: 3 },
    { agent: "codex", model: "mystery", week: "2026-W39", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: null },
    { agent: "codex", model: "gpt-5.6-sol", week: "2026-W38", inputTokens: 2, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0, costUsd: 12 }
  ]);
});

test("get_usage cost counts Grok from Orquester's own chats (its reported cost), labelled Orquester chats only; an unreadable source says so", async () => {
  const claudeRow = (day: string, costUsd: number) => ({ agent: "claude", model: "opus", day, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, costSource: "api_equivalent" });
  const grokRow = (day: string, costUsd: number | null) => ({ day, model: "grok-4", turns: 2, costedTurns: costUsd === null ? 0 : 2, inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 400, costUsd });
  const api = new FakeDaemonApi()
    .on("GET", "/api/usage/tokens", { status: 200, body: { asOf: "2026-10-15T11:00:00.000Z", rows: [claudeRow("2026-10-15", 1), claudeRow("2026-10-06", 2)] } })
    .on("GET", "/api/usage/chat-threads", ({ query }) => {
      assert.deepEqual(query, { agent: "grok" });
      return { status: 200, body: { agent: "grok", scope: "orquester-chats", asOf: "2026-10-15T11:00:00.000Z", rows: [grokRow("2026-10-14", 0.25), grokRow("2026-10-07", 0.5), grokRow("2026-10-01", 9), grokRow("2026-10-13", null)] } };
    });
  const at = Date.parse("2026-10-15T12:00:00.000Z");
  const cost = async (args: Record<string, unknown>) => ((await getUsage.run(z.object(getUsage.input).strict().parse(args), { api, signal: new AbortController().signal, now: () => at, caller: external, turn: { interactionMode: "default", provenance: (_o, t) => t } })) as Record<string, any>).cost;
  // Ten days back from Thursday the 15th is Tuesday the 6th: weeks W41 (from Monday the 5th) and W42; the 1st is outside.
  const weekly = await cost({ include: ["cost"], bucket: "week", days: 10 });
  assert.deepEqual(weekly.byWeek, [{ week: "2026-W41", from: "2026-10-05", usd: 2.5 }, { week: "2026-W42", from: "2026-10-12", usd: 1.25 }]);
  assert.deepEqual(
    weekly.rows.filter((row: { agent: string }) => row.agent === "grok"),
    [
      { agent: "grok", model: "grok-4", week: "2026-W42", inputTokens: 1_200, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 0.25, scope: "orquester-chats" },
      { agent: "grok", model: "grok-4", week: "2026-W41", inputTokens: 600, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0, costUsd: 0.5, scope: "orquester-chats" }
    ],
    "fresh input = input − cached; the reported cost; a turn without one adds tokens only"
  );
  assert.equal(weekly.orquesterChatsOnly.length, 1);
  assert.equal(weekly.orquesterChatsOnly[0].agent, "grok");
  assert.match(weekly.orquesterChatsOnly[0].note, /Orquester chats only.*outside Orquester .*not counted/);
  // The source unreadable (an older daemon): Grok is not counted, and the result says so.
  api.on("GET", "/api/usage/chat-threads", { status: 404, body: { code: "NOT_FOUND", message: "x" } });
  const without = await cost({ include: ["cost"], bucket: "week", days: 14 });
  assert.ok(!without.rows.some((row: { agent: string }) => row.agent === "grok"));
  assert.equal(without.orquesterChatsOnly[0].unavailable, true);
  assert.match(without.orquesterChatsOnly[0].note, /could not be read/);
});

/** A chat session `s1` whose snapshot holds `turns` (and a history window when `hasOlder`). */
function sessionApi(turns: Turn[], over: { model?: string; refId?: string; adapter?: "claude" | "codex" | "grok" | "opencode"; hasOlder?: boolean; providers?: unknown; items?: ThreadItem[] } = {}): FakeDaemonApi {
  const adapter = over.adapter ?? "codex";
  const thread = snapshot({ ...(over.items ? { items: over.items } : {}), head: head({ id: "s1", refId: over.refId ?? adapter, adapter, modelSelection: { model: over.model ?? "gpt-5.6-sol", options: [] } }), turns, ...(over.hasOlder !== undefined ? { history: { indexed: true, hasOlder: over.hasOlder, beforeCursor: over.hasOlder ? "c" : null, oldestRetainedOrdinal: 4, totalTurns: 9 } } : {}) });
  return new FakeDaemonApi()
    .on("GET", "/api/agent/providers", { status: 200, body: over.providers ?? { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "s1", refId: over.refId ?? adapter, projectPath: "" })] })
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
    costUsd: 8.1, costSource: "estimated", estimatedUsd: 8.1, turnsWithoutUsage: 1, mainAgentOnly: true
  });
  // A sessionId alone means the session view; quota is not read.
  assert.ok(!api.calls.some((call) => call.path === "/api/usage"));
});

test("get_usage session: a per-turn reported cost (OpenCode, Grok) wins; reported + estimated is mixed; a turn's own model prices it; unpriced and partial are said", async () => {
  const grok = sessionApi([turn({ tokenUsage: usage(10, 5), totalCostUsd: 0.42 }), turn({ turnId: "t2", totalCostUsd: 0.08 })], { adapter: "grok", model: "grok-4.6" });
  const reported = (await run(grok, { include: ["session"], sessionId: "s1" })).session;
  assert.equal(reported.costUsd, 0.5); assert.equal(reported.costSource, "reported"); assert.equal(reported.estimatedUsd, undefined);
  const mixed = (await run(sessionApi([
    turn({ tokenUsage: usage(1_000_000, 0), totalCostUsd: 1 }),
    turn({ turnId: "t2", model: "gpt-5.6-luna", tokenUsage: usage(1_000_000, 0) }),
    turn({ turnId: "t3", model: "no-such-model", tokenUsage: usage(5, 5) })
  ], { adapter: "opencode", hasOlder: true }), { include: ["session"], sessionId: "s1" })).session;
  assert.equal(mixed.costSource, "mixed");
  assert.equal(mixed.costUsd, 2, "$1 reported + 1M luna input at $1/M");
  assert.equal(mixed.unpricedTurns, 1);
  assert.equal(mixed.partial, true, "older turns lie outside the snapshot");
  assert.equal(mixed.totalTurns, 9);
  const none = (await run(sessionApi([turn({ tokenUsage: usage(5, 5) })], { model: "no-such-model" }), { sessionId: "s1" })).session;
  assert.deepEqual([none.costUsd, none.costSource, none.unpricedTurns], [null, undefined, 1]);
});

/**
 * The Claude CLI's `result.total_cost_usd` is CUMULATIVE per CLI process: fixture 11 (`test/fixtures/claude/
 * 11-resume-and-fork.ndjson`) reports 0.0348223 then 0.0455023 in one process, then 0.0108531 after a resume. The
 * per-turn `usage` blocks of those frames (claude-sonnet-5; cache writes at the 1-hour TTL) are what the turns carry.
 */
const FIXTURE_11 = [
  { tokens: { input: 2, read: 30_681, write: 4_159, output: 4 }, cumulative: 0.03482230000000001 },
  { tokens: { input: 2, read: 34_840, write: 27, output: 4 }, cumulative: 0.04550230000000001 },
  { tokens: { input: 2, read: 34_867, write: 27, output: 15 }, cumulative: 0.010853100000000001 }
];
const claudeTurn = (id: string, t: { input: number; read: number; write: number; output: number }, totalCostUsd?: number, model?: string) =>
  turn({ turnId: id, ...(model ? { model } : {}), ...(totalCostUsd !== undefined ? { totalCostUsd } : {}), tokenUsage: usage(t.input + t.read + t.write, t.output, { cachedInputTokens: t.read, cacheCreationTokens: t.write }) });

test("get_usage session: a Claude session is priced from its turns' own tokens, never by summing the CLI's cumulative total_cost_usd (fixtures 11, 12, 17, 19)", async () => {
  const api = sessionApi(FIXTURE_11.map((f, i) => claudeTurn(`t${i}`, f.tokens, f.cumulative)), { adapter: "claude", model: "claude-sonnet-5" });
  const r = (await run(api, { sessionId: "s1" })).session;
  assert.equal(r.costSource, "estimated");
  // The per-turn costs the fixture's cumulative totals imply for the sonnet model (process 1: 0.0342243, then +0.01068; process 2: 0.0108531).
  assert.equal(r.costUsd, 0.0558);
  assert.ok(Math.abs(r.estimatedUsd - (0.0342243 + 0.01068 + 0.0108531)) < 0.0001);
  const summed = FIXTURE_11.reduce((sum, f) => sum + f.cumulative, 0);
  assert.ok(summed > r.costUsd * 1.6, `summing the cumulative values would report ${summed}`);
  assert.deepEqual([r.inputTokens, r.cachedInputTokens, r.cacheCreationTokens, r.outputTokens], [6 + 100_388 + 4_213, 100_388, 4_213, 23]);
  // Fixtures 17 and 19 (two turns each, one process): the tokens of both turns are summed, the cumulative costs never.
  const workflow = (await run(sessionApi([
    claudeTurn("t1", { input: 4, read: 29_426, write: 6_900, output: 333 }, 0.06897020000000001, "claude-opus-5-5"),
    claudeTurn("t2", { input: 4, read: 18_714, write: 954, output: 33 }, 0.161081, "claude-opus-5-5")
  ], { adapter: "claude" }), { sessionId: "s1" })).session;
  assert.deepEqual([workflow.outputTokens, workflow.cachedInputTokens, workflow.cacheCreationTokens, workflow.costSource], [366, 48_140, 7_854, "estimated"]);
  // Turn 1 is exactly the CLI's opus charge; turn 2's cumulative also carries the workflow's agents, which no main-agent
  // usage holds (hence mainAgentOnly: the estimate is a floor).
  assert.equal(workflow.costUsd, Math.round((0.0677612 + 0.0120508) * 10_000) / 10_000);
  assert.ok(workflow.costUsd < 0.161081 + 0.06897020000000001 - 0.05, "not the sum of the cumulative totals");
});

test("get_usage session: a Claude alias slug is priced as the model the provider catalogue resolves it to", async () => {
  const providers = { hostInstanceId: "h", providers: [{ id: "claude", installed: true, status: "ready", auth: { status: "authenticated" }, models: [
    { slug: "default", name: "Default · Sonnet", subProvider: "claude-sonnet-5", capabilities: null }, { slug: "opus", name: "Opus", capabilities: null }
  ] }] };
  const api = sessionApi([claudeTurn("t1", FIXTURE_11[0]!.tokens, 0.0348)], { adapter: "claude", model: "default", providers });
  const r = (await run(api, { sessionId: "s1" })).session;
  assert.equal(r.costUsd, 0.0342);
  const alias = (await run(sessionApi([claudeTurn("t1", FIXTURE_11[0]!.tokens)], { adapter: "claude", model: "opus", providers }), { sessionId: "s1" })).session;
  assert.deepEqual([alias.costUsd, alias.unpricedTurns], [null, 1], "an alias the catalogue does not resolve stays unpriced, never guessed");
});

test("get_usage session: Codex cache-written tokens bill at the input price (its row has no cache-write rate), as the Cost tab counts them", async () => {
  const api = sessionApi([turn({ tokenUsage: usage(1_000_000, 0, { cacheCreationTokens: 400_000 }) })], { model: "gpt-5.6-sol" });
  assert.equal((await run(api, { sessionId: "s1" })).session.costUsd, 5, "1M input at $5/M, the 400k written ones included");
});

test("get_usage session needs a sessionId and a chat session; its scope is that session's metadata", async () => {
  const api = sessionApi([]);
  await assert.rejects(run(api, { include: ["session"] }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  // A sessionId the call would ignore is refused, in scope too (before any card).
  await assert.rejects(run(api, { include: ["quota"], sessionId: "s1" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /sessionId/.test(e.message));
  await assert.rejects(getUsage.scope(z.object(getUsage.input).parse({ include: ["cost"], sessionId: "s1" }), { api, signal: new AbortController().signal, now: () => NOW, caller: chat }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(run(api, { sessionId: "nope" }), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  const scope = await getUsage.scope(z.object(getUsage.input).parse({ sessionId: "s1" }), { api, signal: new AbortController().signal, now: () => NOW, caller: chat });
  assert.deepEqual(scope, { projects: [], sessions: ["s1"], reads: "metadata", writes: false, causesTurnIn: [] });
  assert.deepEqual(await getUsage.scope(z.object(getUsage.input).parse({}), { api, signal: new AbortController().signal, now: () => NOW, caller: chat }), { projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] });
});

test("get_usage session: mainAgentOnly always, with the turns that ran subagents and the conversation's compactions counted (the estimate is a floor there)", async () => {
  const compaction = (id: string, state: string): ThreadItem => ({ kind: "activity", id, tone: "info", activityKind: "context-compaction", summary: "Compacted", payload: { state }, turnId: "t2", createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" });
  const api = sessionApi([
    turn({ turnId: "t1", tokenUsage: { ...usage(10, 5), hasSubagents: true } }),
    turn({ turnId: "t2", tokenUsage: usage(10, 5) })
  ], { items: [compaction("k1", "compacted"), compaction("k2", "compacting")] });
  const r = (await run(api, { sessionId: "s1" })).session;
  assert.deepEqual([r.mainAgentOnly, r.turnsWithSubagents, r.compactions], [true, 1, 1], "only a settled compaction counts");
  const plain = (await run(sessionApi([turn({ tokenUsage: usage(1, 1) })]), { sessionId: "s1" })).session;
  assert.deepEqual([plain.mainAgentOnly, plain.turnsWithSubagents, plain.compactions], [true, undefined, undefined]);
});
