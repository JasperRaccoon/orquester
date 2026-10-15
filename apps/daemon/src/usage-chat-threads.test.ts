/**
 * Grok's usage from Orquester's own chat logs (final review ruling): the per-turn reported cost and
 * tokens of an agent's `thread.session-set` rows, summed per UTC day and model; other agents' logs
 * never read past their first line; appended bytes read once; a partial last line waits; a rebuilt
 * log is read again; a removed thread drops out.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ChatThreadUsageScanner } from "./usage-chat-threads.ts";

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const created = (adapter: string, model: string) => line({ type: "thread.created", occurredAt: "2026-10-01T00:00:00Z", payload: { adapter, modelSelection: { model } }, seq: 1 });
const settled = (at: string, cost: number | undefined, tokens: { input: number; output: number; cached?: number }) =>
  line({
    type: "thread.session-set",
    occurredAt: at,
    payload: {
      session: { status: "ready", activeTurnId: null },
      turn: { turnId: `t-${at}`, tokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: tokens.input, outputTokens: tokens.output, cachedInputTokens: tokens.cached ?? 0, hasSubagents: false }, ...(cost !== undefined ? { totalCostUsd: cost } : {}) }
    }
  });

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "chat-usage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const thread = async (id: string, text: string) => {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, "events.ndjson"), text);
  };
  const scanner = new ChatThreadUsageScanner({ threadsDir: dir, agents: ["grok"], now: () => Date.parse("2026-10-16T00:00:00Z") });
  return { dir, thread, scanner };
}

test("sums each settled turn's reported cost and tokens per UTC day and model, for that agent's chats only", async (t) => {
  const w = await world(t);
  await w.thread(
    "g1",
    created("grok", "grok-4") +
      settled("2026-10-14T10:00:00Z", 0.01, { input: 1_000, output: 100, cached: 400 }) +
      settled("2026-10-14T23:59:59Z", 0.02, { input: 2_000, output: 200 }) +
      // The model changes for the next turn.
      line({ type: "thread.turn-start-requested", occurredAt: "2026-10-15T00:00:00Z", payload: { turnId: null, messageId: "m", interactionMode: "default", modelSelection: { model: "grok-4-fast" } } }) +
      settled("2026-10-15T08:00:00Z", undefined, { input: 50, output: 5 })
  );
  await w.thread("g2", created("grok", "grok-4") + settled("2026-10-14T12:00:00Z", 0.005, { input: 10, output: 1 }));
  await w.thread("c1", created("claude", "opus") + settled("2026-10-14T12:00:00Z", 9, { input: 10, output: 1 }));
  const usage = await w.scanner.snapshot("grok");
  assert.equal(usage.scope, "orquester-chats");
  assert.deepEqual(usage.rows, [
    { day: "2026-10-15", model: "grok-4-fast", turns: 1, costedTurns: 0, inputTokens: 50, outputTokens: 5, cachedInputTokens: 0, costUsd: null },
    { day: "2026-10-14", model: "grok-4", turns: 3, costedTurns: 3, inputTokens: 3_010, outputTokens: 301, cachedInputTokens: 400, costUsd: 0.035 }
  ]);
  assert.deepEqual((await w.scanner.snapshot("claude")).rows, [], "only the agents it was built for");
});

test("appended turns are counted once; a partial last line waits for its newline; a rebuilt log is read again; a removed thread drops out", async (t) => {
  const w = await world(t);
  await w.thread("g1", created("grok", "grok-4") + settled("2026-10-14T10:00:00Z", 0.01, { input: 10, output: 1 }));
  assert.equal((await w.scanner.snapshot("grok")).rows[0]!.turns, 1);
  const next = settled("2026-10-14T11:00:00Z", 0.02, { input: 10, output: 1 });
  await appendFile(join(w.dir, "g1", "events.ndjson"), next.slice(0, 40));
  assert.equal((await w.scanner.snapshot("grok")).rows[0]!.turns, 1, "half a line is not a turn");
  await appendFile(join(w.dir, "g1", "events.ndjson"), next.slice(40));
  const twice = await w.scanner.snapshot("grok");
  assert.equal(twice.rows[0]!.turns, 2);
  assert.equal(twice.rows[0]!.costUsd, 0.03);
  assert.equal((await w.scanner.snapshot("grok")).rows[0]!.turns, 2, "nothing is counted twice");
  // Rebuilt shorter: read from the start.
  await w.thread("g1", created("grok", "grok-4") + settled("2026-10-13T10:00:00Z", 0.5, { input: 1, output: 1 }));
  assert.deepEqual((await w.scanner.snapshot("grok")).rows.map((row) => [row.day, row.turns, row.costUsd]), [["2026-10-13", 1, 0.5]]);
  await rm(join(w.dir, "g1"), { recursive: true });
  assert.deepEqual((await w.scanner.snapshot("grok")).rows, []);
});

test("no threads directory yet: no rows", async () => {
  const scanner = new ChatThreadUsageScanner({ threadsDir: join(tmpdir(), "chat-usage-missing-dir-x"), agents: ["grok"], now: () => 0 });
  assert.deepEqual((await scanner.snapshot("grok")).rows, []);
});
