import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { usageTools } from "./usage.ts";

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
