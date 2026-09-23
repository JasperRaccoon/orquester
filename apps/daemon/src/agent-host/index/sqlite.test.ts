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
import { created, recordingLogger, TestLog, userMessage } from "./testing.ts";

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
