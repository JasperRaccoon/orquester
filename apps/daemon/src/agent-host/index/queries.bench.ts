/**
 * Reproduce prompt-turn lookup costs with the real SQLite schema and search.
 * From apps/daemon:
 * TSX_DISABLE_CACHE=1 node --import tsx src/agent-host/index/queries.bench.ts [turns=10000] [hits=50]
 *
 * The baseline removes only the explicit prompt-index choice from the current
 * queries. Both versions read the same in-memory database and must answer
 * identically. This isolates synchronous query work from filesystem latency.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createThreadIndexQueries } from "./queries.ts";
import { SCHEMA_STATEMENTS } from "./schema.ts";
import { defaultSqliteDriver, defaultSqliteDriverError, type SqliteDatabase } from "./sqlite.ts";

function positiveCount(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  assert.ok(Number.isSafeInteger(value) && value > 0, "workload sizes must be positive integers");
  return value;
}

const turns = positiveCount(process.argv[2], 10_000);
const hits = positiveCount(process.argv[3], 50);
assert.ok(hits <= turns, "hits must not exceed turns");
assert.ok(defaultSqliteDriver, defaultSqliteDriverError ?? "SQLite driver unavailable");
const db = defaultSqliteDriver.open(":memory:");

function queryDatabase(transform: (source: string) => string): SqliteDatabase {
  return {
    prepare: (source) => db.prepare(transform(source)),
    exec: (source) => db.exec(source),
    pragma: (source, options) => db.pragma(source, options),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close()
  };
}

/** The median of seven samples, in milliseconds per query. */
function measure(query: () => unknown, iterations: number): number {
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const start = performance.now();
    for (let n = 0; n < iterations; n += 1) query();
    samples.push((performance.now() - start) / iterations);
  }
  return samples.sort((left, right) => left - right)[3]!;
}

try {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  const insertThread = db.prepare(
    `INSERT INTO threads (thread_id, project_path, title, last_seq, last_byte, updated_at)
     VALUES ('thread', '/w/project', 'Conversation', 0, 0, '')`
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (thread_id, turn_id, ordinal, user_message_id, requested_at,
                        first_seq, last_seq, first_byte, end_byte)
     VALUES ('thread', ?, ?, ?, '2026-01-01', ?, ?, 0, 1)`
  );
  const insertDoc = db.prepare(
    `INSERT INTO message_docs (thread_id, message_id, seq, first_seq, first_byte,
                              first_length, role, agent_id, turn_id, created_at)
     VALUES ('thread', ?, ?, ?, 0, 1, 'user', NULL, NULL, '2026-01-01')`
  );
  const insertText = db.prepare(
    `INSERT INTO messages_fts (rowid, text, thread_id, message_id, turn_id, role, seq, at)
     VALUES (?, ?, 'thread', ?, NULL, 'user', ?, '2026-01-01')`
  );
  db.transaction(() => {
    insertThread.run();
    for (let n = 1; n <= turns; n += 1) {
      const messageId = `p${n}`;
      insertTurn.run(`t${n}`, n, messageId, n, n);
      const doc = insertDoc.run(messageId, n, n);
      insertText.run(
        doc.lastInsertRowid,
        n > turns - hits ? "needle benchmark" : "other conversation",
        messageId,
        n
      );
    }
  })();

  const sources: string[] = [];
  const optimized = createThreadIndexQueries(queryDatabase((source) => {
    sources.push(source);
    return source;
  }));
  const legacy = (source: string): string => source.replaceAll(" INDEXED BY turns_by_prompt", "");
  const baseline = createThreadIndexQueries(queryDatabase(legacy));
  const request = { q: "needle", limit: 50 };
  const promptId = `p${turns}`;
  assert.deepEqual(optimized.search(request), baseline.search(request));
  assert.deepEqual(optimized.turnByPrompt("thread", promptId), baseline.turnByPrompt("thread", promptId));
  assert.equal(optimized.search(request).length, Math.min(hits, 50));

  const searchSql = sources.find((source) => source.includes("snippet(messages_fts"))!;
  const plan = (source: string): unknown[] =>
    db.prepare(`EXPLAIN QUERY PLAN ${source}`).all('"needle"', null, null, 50);
  console.log(JSON.stringify({ baselinePlan: plan(legacy(searchSql)), optimizedPlan: plan(searchSql) }, null, 2));
  for (let warm = 0; warm < 3; warm += 1) {
    baseline.search(request);
    optimized.search(request);
  }
  const searchBaselineMs = measure(() => baseline.search(request), 5);
  const searchOptimizedMs = measure(() => optimized.search(request), 5);
  const promptBaselineMs = measure(() => baseline.turnByPrompt("thread", promptId), 50);
  const promptOptimizedMs = measure(() => optimized.turnByPrompt("thread", promptId), 50);
  console.log(JSON.stringify({
    node: process.version,
    turns,
    hits,
    search: { baselineMs: searchBaselineMs, optimizedMs: searchOptimizedMs, speedup: searchBaselineMs / searchOptimizedMs },
    turnByPrompt: { baselineMs: promptBaselineMs, optimizedMs: promptOptimizedMs, speedup: promptBaselineMs / promptOptimizedMs }
  }, null, 2));
} finally {
  db.close();
}
