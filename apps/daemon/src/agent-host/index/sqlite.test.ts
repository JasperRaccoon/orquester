/**
 * The index file's lifecycle: bootstrap, 0600, WAL, and "any doubt → delete
 * and start empty" (design 2026-09-23 §C, invariants 1, 5 and 8).
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type BetterSqlite3 from "better-sqlite3";

import { createThreadIndex, INDEX_SCHEMA_VERSION } from "./index.ts";
import { INDEX_TABLES } from "./schema.ts";
import { defaultSqliteDriver, type SqliteDriver } from "./sqlite.ts";
import {
  checkpoint,
  created,
  done,
  legacyCompaction,
  liveTurn,
  recordingLogger,
  reverted,
  session,
  subagentCompaction,
  TestLog,
  turnStart,
  userMessage
} from "./testing.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-index-"));
  filePath = join(dir, "daemon", "agent", "index.sqlite");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A second connection, for looking at what the index wrote. */
function inspect<T>(query: (db: BetterSqlite3.Database) => T): T {
  const db = new Database(filePath, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

describe("thread index file", () => {
  it("resolves the real driver once at load", () => {
    assert.notEqual(defaultSqliteDriver, null);
  });

  it("bootstraps a fresh file: INDEX_SCHEMA_VERSION, WAL, mode 0600, parent dirs created", async () => {
    const logger = recordingLogger();
    const index = createThreadIndex({ filePath, logger });
    assert.equal(index.available, true);
    index.close();

    const mode = (await stat(filePath)).mode & 0o777;
    assert.equal(mode, 0o600);
    const { version, journal, tables } = inspect((db) => ({
      version: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value,
      journal: db.pragma("journal_mode", { simple: true }),
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name)
    }));
    assert.equal(version, String(INDEX_SCHEMA_VERSION));
    assert.equal(journal, "wal");
    for (const table of INDEX_TABLES) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
    assert.deepEqual(
      logger.entries.filter((entry) => entry.level === "warn"),
      [],
      "a fresh file is not a warning"
    );
  });

  it("reopens an intact file without rebuilding it", async () => {
    const log = new TestLog();
    const first = createThreadIndex({ filePath, logger: recordingLogger() });
    first.observe({ threadId: log.threadId, projectPath: "/w/p", title: "T", ...log.append(created()) });
    await first.drain();
    first.close();

    const logger = recordingLogger();
    const second = createThreadIndex({ filePath, logger });
    assert.equal(second.available, true);
    assert.deepEqual(second.cursor(log.threadId), { lastSeq: 1, lastByte: log.size });
    assert.equal(logger.entries.filter((entry) => entry.level === "warn").length, 0);
    second.close();
  });

  it("tightens a pre-existing file to 0600", async () => {
    createThreadIndex({ filePath, logger: recordingLogger() }).close();
    await chmod(filePath, 0o644);
    createThreadIndex({ filePath, logger: recordingLogger() }).close();
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });

  it("replaces a file with another schema version and starts empty", async () => {
    const log = new TestLog();
    const first = createThreadIndex({ filePath, logger: recordingLogger() });
    first.observe({
      threadId: log.threadId,
      projectPath: "/w/p",
      title: "T",
      ...log.append(created(), userMessage("u1", "remember the parser"))
    });
    await first.drain();
    first.close();
    const writable = new Database(filePath);
    writable.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    writable.close();

    const logger = recordingLogger();
    const second = createThreadIndex({ filePath, logger });
    assert.equal(second.available, true);
    assert.equal(second.cursor(log.threadId), null, "the old rows are gone");
    assert.deepEqual(second.search({ q: "parser", limit: 10 }), []);
    second.close();
    const version = inspect(
      (db) =>
        (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
          .value
    );
    assert.equal(version, String(INDEX_SCHEMA_VERSION));
    assert.ok(
      logger.entries.some((entry) => entry.level === "warn" && /rebuilding/.test(entry.message)),
      "the rebuild is logged"
    );
  });

  it("replaces a file that is not a database at all", async () => {
    await mkdir(join(dir, "daemon", "agent"), { recursive: true });
    await writeFile(filePath, "this is not a sqlite file, just some text that is long enough".repeat(20));
    const index = createThreadIndex({ filePath, logger: recordingLogger() });
    assert.equal(index.available, true);
    const log = new TestLog();
    index.observe({ threadId: log.threadId, projectPath: "/w/p", title: "T", ...log.append(created()) });
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1, lastByte: log.size });
    index.close();
  });

  it("replaces a file that claims the version but lacks a table", async () => {
    createThreadIndex({ filePath, logger: recordingLogger() }).close();
    const writable = new Database(filePath);
    writable.exec("DROP TABLE markers");
    writable.close();
    const index = createThreadIndex({ filePath, logger: recordingLogger() });
    assert.equal(index.available, true);
    index.close();
    const tables = inspect((db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name)
    );
    assert.ok(tables.includes("markers"), "the missing table is back");
  });

  it("rebuilds a file at this version whose tables predate a column this build writes", () => {
    createThreadIndex({ filePath, logger: recordingLogger() }).close();
    const writable = new Database(filePath);
    writable.exec(`
      DROP TABLE message_docs;
      CREATE TABLE message_docs (
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      );
    `);
    writable.close();

    const logger = recordingLogger();
    const index = createThreadIndex({ filePath, logger });
    assert.equal(index.available, true);
    index.close();
    const columns = inspect((db) =>
      (db.prepare("PRAGMA table_info(message_docs)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    assert.ok(columns.includes("first_seq"), "the table was recreated with the new columns");
    assert.ok(
      logger.entries.some((entry) => /does not fit this build/.test(entry.message)),
      "the rebuild is logged"
    );
  });

  it("rebuilds a stray v1 file — before threads.inflight — as another version, not a misfit", async () => {
    createThreadIndex({ filePath, logger: recordingLogger() }).close();
    const writable = new Database(filePath);
    writable.exec("ALTER TABLE threads DROP COLUMN inflight");
    writable.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    writable.close();

    const logger = recordingLogger();
    const index = createThreadIndex({ filePath, logger });
    assert.equal(index.available, true);
    const log = new TestLog();
    index.observe({ threadId: log.threadId, projectPath: "/w/p", title: "T", ...log.append(created()) });
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1, lastByte: log.size });
    index.close();

    const { version, columns } = inspect((db) => ({
      version: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value,
      columns: (db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    }));
    assert.notEqual(INDEX_SCHEMA_VERSION, 1, "the premise: v1 is another version");
    assert.equal(version, String(INDEX_SCHEMA_VERSION));
    assert.ok(columns.includes("inflight"));
    assert.ok(
      logger.entries.some((entry) => entry.level === "warn" && /rebuilding/.test(entry.message)),
      "rebuilt by the version check"
    );
    assert.equal(
      logger.entries.some((entry) => /does not fit this build/.test(entry.message)),
      false,
      "never got as far as preparing statements against it"
    );
  });

  it("rebuilds a version-2 file — markers derived by the rule before the shared one — and re-derives them", async () => {
    // A thread the two rules disagree on: version 2 skipped the legacy settled
    // marker in turn 1 and kept a subagent's own compaction in turn 2 as the
    // conversation's; version 3 does the opposite.
    const log = new TestLog();
    log.append(
      created(),
      ...liveTurn({ n: 1, prompt: "one", extra: [legacyCompaction("legacy", "t1")] }),
      ...liveTurn({
        n: 2,
        prompt: "two",
        extra: [subagentCompaction("sub", "t2", { agentId: "sub-1", on: "row" })]
      }),
      ...liveTurn({ n: 3, prompt: "three" })
    );
    const seqOf = (activityId: string): number => {
      const event = log
        .all()
        .events.find(
          (candidate) =>
            candidate.type === "thread.activity-appended" &&
            candidate.payload.activity.id === activityId
        );
      assert.ok(event !== undefined, `no activity ${activityId}`);
      return event.seq;
    };
    const catchUp = {
      threadId: log.threadId,
      projectPath: "/w/p",
      title: "T",
      logSeq: log.lastSeq,
      read: log.readEventsFrom
    };
    const first = createThreadIndex({ filePath, logger: recordingLogger() });
    await first.catchUp(catchUp);
    first.close();
    // What version 2 left behind: the same statements, so the file passes every
    // check but the version — its rows are the only thing wrong with it.
    const writable = new Database(filePath);
    writable.prepare("DELETE FROM markers").run();
    writable
      .prepare("INSERT INTO markers (thread_id, seq, kind) VALUES (?, ?, 'compacted')")
      .run(log.threadId, seqOf("sub"));
    writable.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    writable.close();

    const logger = recordingLogger();
    const second = createThreadIndex({ filePath, logger });
    assert.notEqual(INDEX_SCHEMA_VERSION, 2, "the premise: v2 is another version");
    assert.equal(second.available, true);
    assert.equal(second.cursor(log.threadId), null, "nothing of the version-2 file is trusted");
    assert.equal(second.totalTurns(log.threadId), 0);
    assert.ok(
      logger.entries.some((entry) => entry.level === "warn" && /rebuilding/.test(entry.message)),
      "rebuilt by the version check"
    );
    assert.equal(
      logger.entries.some((entry) => /does not fit this build/.test(entry.message)),
      false,
      "never got as far as preparing statements against it"
    );

    // The boot catch-up re-derives the thread from its log, by the shared rule.
    await second.catchUp(catchUp);
    const id = log.threadId;
    assert.deepEqual(
      [1, 2, 3].map((n) => second.rewindable(id, second.turnByOrdinal(id, n)!)),
      [false, true, true]
    );
    second.close();
    const { version, markers } = inspect((db) => ({
      version: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value,
      markers: db.prepare("SELECT seq, kind FROM markers").all()
    }));
    assert.equal(version, String(INDEX_SCHEMA_VERSION));
    assert.deepEqual(markers, [{ seq: seqOf("legacy"), kind: "compacted" }]);
  });

  // Version 3, and version 4 as the prompts build wrote it: the same
  // statements, but no `clipAtCut` — turn 1 still stretched past the cut.
  for (const version of ["3", "4"]) {
    it(`rebuilds a version-${version} file — a surviving turn's range left reaching past a revert's cut — and re-derives it`, async () => {
      // Turn 1's capture landed after turn 2 began, stretching turn 1's range
      // over turn 2's first lines; a rewind to turn 1 then removed turn 2.
      // Such a file left turn 1 reaching into turn 2's lines, and history
      // planning served them again; this version clips it at the cut.
      const log = new TestLog();
      log.append(
        created(), // 1
        userMessage("u1", "first"), // 2
        turnStart("u1"), // 3
        session("running", "t1"), // 4
        done("a1", "t1", "answer one"), // 5
        session("ready", null, "t1"), // 6
        userMessage("u2", "second"), // 7
        turnStart("u2"), // 8
        session("running", "t2"), // 9
        checkpoint("t1", 1), // 10 — names t1
        done("a2", "t2", "answer two"), // 11
        session("ready", null, "t2"), // 12
        reverted(1) // 13
      );
      const catchUp = {
        threadId: log.threadId,
        projectPath: "/w/p",
        title: "T",
        logSeq: log.lastSeq,
        read: log.readEventsFrom
      };
      const first = createThreadIndex({ filePath, logger: recordingLogger() });
      await first.catchUp(catchUp);
      const clipped = first.turnByOrdinal(log.threadId, 1);
      first.close();
      assert.deepEqual([clipped?.lastSeq, clipped?.endByte], [6, log.at(7).byteOffset]);
      // What such a build left behind: the same statements, turn 1 still stretched.
      const writable = new Database(filePath);
      writable
        .prepare("UPDATE turns SET last_seq = 10, end_byte = ? WHERE thread_id = ? AND turn_id = 't1'")
        .run(log.endOf(10), log.threadId);
      writable.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
      writable.close();

      const logger = recordingLogger();
      const second = createThreadIndex({ filePath, logger });
      assert.notEqual(String(INDEX_SCHEMA_VERSION), version, `the premise: v${version} is another version`);
      assert.equal(second.available, true);
      assert.equal(second.cursor(log.threadId), null, `nothing of the version-${version} file is trusted`);
      assert.ok(
        logger.entries.some((entry) => entry.level === "warn" && /rebuilding/.test(entry.message)),
        "rebuilt by the version check"
      );
      // The boot catch-up re-derives the thread from its log, clipped.
      await second.catchUp(catchUp);
      assert.deepEqual(second.turnByOrdinal(log.threadId, 1), clipped);
      second.close();
    });
  }

  // Version 3, and version 4 as the clipping build wrote it: no author, turn
  // or stamp columns on `message_docs`, no `message_docs_prompts`.
  for (const version of ["3", "4"]) {
    it(`rebuilds a version-${version} file — message_docs without its author, turn and stamp — as another version`, async () => {
      createThreadIndex({ filePath, logger: recordingLogger() }).close();
      const writable = new Database(filePath);
      writable.exec(`
        DROP INDEX message_docs_prompts;
        ALTER TABLE message_docs DROP COLUMN role;
        ALTER TABLE message_docs DROP COLUMN agent_id;
        ALTER TABLE message_docs DROP COLUMN turn_id;
        ALTER TABLE message_docs DROP COLUMN created_at;
      `);
      writable.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
      writable.close();

      const logger = recordingLogger();
      const index = createThreadIndex({ filePath, logger });
      assert.equal(index.available, true);
      const log = new TestLog();
      index.observe({
        threadId: log.threadId,
        projectPath: "/w/p",
        title: "T",
        ...log.append(created(), userMessage("u1", "hello"), userMessage("sub", "brief", null, "a-1"))
      });
      await index.drain();
      assert.deepEqual(
        index.prompts(log.threadId, { limit: 5 })?.prompts.map((entry) => entry.messageId),
        ["u1"]
      );
      index.close();

      const { authors, indexes } = inspect((db) => ({
        authors: db
          .prepare(
            "SELECT message_id, role, agent_id, turn_id, created_at FROM message_docs ORDER BY first_seq"
          )
          .all(),
        indexes: (db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'message_docs'")
          .all() as Array<{ name: string }>).map((row) => row.name)
      }));
      assert.notEqual(String(INDEX_SCHEMA_VERSION), version, `the premise: v${version} is another version`);
      assert.deepEqual(authors, [
        { message_id: "u1", role: "user", agent_id: null, turn_id: null, created_at: log.event(2).occurredAt },
        { message_id: "sub", role: "user", agent_id: "a-1", turn_id: null, created_at: log.event(3).occurredAt }
      ]);
      assert.ok(indexes.includes("message_docs_prompts"));
      assert.ok(
        logger.entries.some((entry) => entry.level === "warn" && /rebuilding/.test(entry.message)),
        "rebuilt by the version check"
      );
      assert.equal(
        logger.entries.some((entry) => /does not fit this build/.test(entry.message)),
        false,
        "never got as far as preparing statements against it"
      );
    });
  }

  it("runs unavailable when the file can be neither opened nor recreated", () => {
    const logger = recordingLogger();
    const broken: SqliteDriver = {
      open: () => {
        throw new Error("unable to open database file");
      }
    };
    const index = createThreadIndex({ filePath, logger, driver: broken });
    assert.equal(index.available, false);
    assert.ok(
      logger.entries.some((entry) => /could not be recreated/.test(entry.message)),
      "the failure is logged"
    );
  });
});
