/**
 * Streaming-index and history-boundary costs with the production indexer and
 * queries on a real, in-memory SQLite database. From apps/daemon:
 * TSX_DISABLE_CACHE=1 node --import tsx src/agent-host/index/history.bench.ts [turns=10000] [chunks=500] [revision]
 *
 * An optional revision loads its production indexer and queries through
 * temporary sibling modules in a child process, removed even on failure.
 * Static imports keep this harness within the host's no-dynamic-import rule.
 * Seeding and the first
 * cold load are outside the timed region; every chunk is its own committed
 * batch, like a live append. The final cursor, range and indexed text are
 * asserted so dropping work cannot make the benchmark faster.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { DomainEvent } from "@orquester/api/agent-chat";

import { createThreadIndexer } from "./indexer.ts";
import { createThreadIndexQueries } from "./queries.ts";
import { SCHEMA_STATEMENTS } from "./schema.ts";
import { defaultSqliteDriver, defaultSqliteDriverError } from "./sqlite.ts";
import { testLogger } from "./testing.ts";

function historicalRevision(revision: string): number {
  const prefix = `.history-baseline-${process.pid}`;
  const indexerFile = new URL(`${prefix}-indexer.ts`, import.meta.url);
  const queriesFile = new URL(`${prefix}-queries.ts`, import.meta.url);
  const benchmarkFile = new URL(`${prefix}-bench.ts`, import.meta.url);
  const fromRevision = (name: string): string => execFileSync(
    "git", ["show", `${revision}:apps/daemon/src/agent-host/index/${name}.ts`], { encoding: "utf8" }
  );
  try {
    writeFileSync(indexerFile, fromRevision("indexer"));
    writeFileSync(
      queriesFile,
      fromRevision("queries").replace('from "./indexer.ts"', `from "./${prefix}-indexer.ts"`)
    );
    writeFileSync(
      benchmarkFile,
      readFileSync(new URL(import.meta.url), "utf8")
        .replace('from "./indexer.ts"', `from "./${prefix}-indexer.ts"`)
        .replace('from "./queries.ts"', `from "./${prefix}-queries.ts"`)
    );
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(benchmarkFile), ...process.argv.slice(2, 4)],
      { stdio: "inherit", env: { ...process.env, HISTORY_BENCH_REVISION: revision, TSX_DISABLE_CACHE: "1" } }
    );
    if (result.error !== undefined) throw result.error;
    if (result.signal !== null) throw new Error(`historical benchmark ended with ${result.signal}`);
    return result.status ?? 1;
  } finally {
    for (const file of [benchmarkFile, queriesFile, indexerFile]) rmSync(file, { force: true });
  }
}

const revision = process.argv[4];
if (revision !== undefined) process.exit(historicalRevision(revision));

function count(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  assert.ok(Number.isSafeInteger(value) && value > 0, "workload sizes must be positive integers");
  return value;
}

const turns = count(process.argv[2], 10_000);
const chunks = count(process.argv[3], 500);
const stamp = "2026-01-01T00:00:00.000Z";
assert.ok(defaultSqliteDriver, defaultSqliteDriverError ?? "SQLite driver unavailable");
const db = defaultSqliteDriver.open(":memory:");

function median(values: number[]): number {
  return values.sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
}

try {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  db.prepare(
    `INSERT INTO threads (thread_id, project_path, title, last_seq, last_byte, updated_at, open_turn_id)
     VALUES ('thread', '/w/project', 'History benchmark', ?, ?, ?, ?)`
  ).run(turns, turns * 10, stamp, `t${turns}`);
  const insert = db.prepare(
    `INSERT INTO turns (thread_id, turn_id, ordinal, user_message_id, requested_at, started_at,
                        first_seq, last_seq, first_byte, end_byte)
     VALUES ('thread', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (let n = 1; n <= turns; n += 1) {
      insert.run(`t${n}`, n, `p${n}`, stamp, stamp, n, n, (n - 1) * 10, n * 10);
    }
  })();

  const indexer = createThreadIndexer({
    db,
    logger: testLogger(),
    clock: { nowIso: () => stamp, now: () => new Date(stamp) }
  });
  const meta = { threadId: "thread", projectPath: "/w/project", title: "History benchmark" };
  let seq = turns;
  let bytes = turns * 10;
  let text = "";
  const append = (streaming: boolean): void => {
    seq += 1;
    const event: DomainEvent = {
      seq,
      eventId: `e${seq}`,
      threadId: "thread",
      type: "thread.message-sent",
      payload: { messageId: "answer", role: "assistant", text: streaming ? "x" : "", streaming, turnId: `t${turns}` },
      occurredAt: stamp,
      commandId: null,
      causationEventId: null,
      metadata: {}
    };
    const byteLength = Buffer.byteLength(JSON.stringify(event)) + 1;
    indexer.applyBatch(meta, [event], [{ seq, byteOffset: bytes, byteLength }]);
    bytes += byteLength;
    if (streaming) text += "x";
  };
  append(true); // Cold row load and cache population do not count as streaming work.
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const start = performance.now();
    for (let n = 0; n < chunks; n += 1) append(true);
    samples.push((performance.now() - start) / chunks);
  }
  append(false);
  const statements: string[] = [];
  const queries = createThreadIndexQueries({
    prepare(source) { statements.push(source); return db.prepare(source); },
    exec: (source) => db.exec(source),
    pragma: (source, options) => db.pragma(source, options),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close()
  });
  assert.deepEqual(indexer.cursor("thread"), { lastSeq: seq, lastByte: bytes });
  const latest = queries.turnByOrdinal("thread", turns)!;
  assert.equal(latest.lastSeq, seq);
  assert.equal(latest.endByte, bytes);
  assert.equal(queries.totalTurns("thread"), turns);
  assert.deepEqual(db.prepare("SELECT text FROM messages_fts WHERE message_id = 'answer'").get(), { text });

  const legacy = db.prepare(
    `SELECT turn_id FROM turns WHERE thread_id = ? AND first_seq <= ?
     ORDER BY (last_seq >= ?) DESC, first_seq DESC, ordinal DESC LIMIT 1`
  );
  const boundaries = [1, Math.max(1, Math.floor(turns / 2)), turns];
  const originalLookup = (boundary: number): unknown => legacy.get("thread", boundary, boundary);
  for (const boundary of boundaries) {
    assert.deepEqual(originalLookup(boundary), { turn_id: queries.turnOfSeq("thread", boundary)?.turnId });
  }
  const lookups: number[] = [];
  const baselineLookups: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const before = performance.now();
    for (let n = 0; n < 50; n += 1) originalLookup(boundaries[n % boundaries.length]!);
    baselineLookups.push((performance.now() - before) / 50);
    const start = performance.now();
    for (let n = 0; n < 50; n += 1) {
      const boundary = boundaries[n % boundaries.length]!;
      assert.equal(queries.turnOfSeq("thread", boundary)?.turnId, `t${boundary}`);
    }
    lookups.push((performance.now() - start) / 50);
  }
  const lookupSql = statements.find((source) =>
    source.includes("ORDER BY (last_seq >= ?)") ||
    (source.includes("SELECT MAX(first_seq)") && source.includes("AND last_seq >= ?"))
  )!;
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${lookupSql}`).all(
    ...(lookupSql.includes("SELECT MAX(first_seq)")
      ? ["thread", "thread", turns, turns, turns]
      : ["thread", turns, turns])
  );
  console.log(JSON.stringify({
    revision: process.env.HISTORY_BENCH_REVISION ?? "working-tree",
    node: process.version,
    turns,
    chunksPerSample: chunks,
    samples: 7,
    historyBoundaries: boundaries,
    streamingMsPerChunk: median(samples),
    historyBoundaryBaselineMs: median(baselineLookups),
    historyBoundaryMs: median(lookups),
    historyBoundaryPlan: plan,
    verified: { lastSeq: seq, lastByte: bytes, indexedTextChars: text.length }
  }, null, 2));
} finally {
  db.close();
}
