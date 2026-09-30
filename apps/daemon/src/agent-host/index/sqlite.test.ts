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

import { createThreadIndex } from "./index.ts";
import { created, testLogger, TestLog, userMessage } from "./testing.ts";

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
  it("bootstraps a fresh private WAL database and its parent directories", async () => {
    const logger = testLogger();
    const index = createThreadIndex({ filePath, logger });
    assert.equal(index.available, true);
    index.close();

    const mode = (await stat(filePath)).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(inspect((db) => db.pragma("journal_mode", { simple: true })), "wal");
  });

  it("reopens an intact file without rebuilding it", async () => {
    const log = new TestLog();
    const first = createThreadIndex({ filePath, logger: testLogger() });
    first.observe({ threadId: log.threadId, projectPath: "/w/p", title: "T", ...log.append(created()) });
    await first.drain();
    first.close();

    const logger = testLogger();
    const second = createThreadIndex({ filePath, logger });
    assert.equal(second.available, true);
    assert.deepEqual(second.cursor(log.threadId), { lastSeq: 1, lastByte: log.size });
    second.close();
  });

  it("tightens a pre-existing file to 0600", async () => {
    createThreadIndex({ filePath, logger: testLogger() }).close();
    await chmod(filePath, 0o644);
    createThreadIndex({ filePath, logger: testLogger() }).close();
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });

  for (const version of ["1", "999"]) {
    it(`replaces a file with incompatible schema version ${version} and starts empty`, async () => {
      const log = new TestLog();
      const first = createThreadIndex({ filePath, logger: testLogger() });
      first.observe({
        threadId: log.threadId,
        projectPath: "/w/p",
        title: "T",
        ...log.append(created(), userMessage("u1", "remember the parser"))
      });
      await first.drain();
      first.close();
      const writable = new Database(filePath);
      writable.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
      writable.close();

      const logger = testLogger();
      const second = createThreadIndex({ filePath, logger });
      assert.equal(second.available, true);
      assert.equal(second.cursor(log.threadId), null, "the old rows are gone");
      assert.deepEqual(second.search({ q: "parser", limit: 10 }), []);
      second.close();
    });
  }

  it("replaces a file that is not a database at all", async () => {
    await mkdir(join(dir, "daemon", "agent"), { recursive: true });
    await writeFile(filePath, "this is not a sqlite file, just some text that is long enough".repeat(20));
    const index = createThreadIndex({ filePath, logger: testLogger() });
    assert.equal(index.available, true);
    const log = new TestLog();
    index.observe({ threadId: log.threadId, projectPath: "/w/p", title: "T", ...log.append(created()) });
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1, lastByte: log.size });
    index.close();
  });

  it("replaces a file that claims the version but lacks a table", async () => {
    createThreadIndex({ filePath, logger: testLogger() }).close();
    const writable = new Database(filePath);
    writable.exec("DROP TABLE markers");
    writable.close();
    const index = createThreadIndex({ filePath, logger: testLogger() });
    assert.equal(index.available, true);
    index.close();
  });

  it("rebuilds a file at this version whose tables predate a column this build writes", () => {
    createThreadIndex({ filePath, logger: testLogger() }).close();
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

    const logger = testLogger();
    const index = createThreadIndex({ filePath, logger });
    assert.equal(index.available, true);
    index.close();
  });

  it("runs unavailable when the file can be neither opened nor recreated", async () => {
    const logger = testLogger();
    await mkdir(filePath, { recursive: true });
    const index = createThreadIndex({ filePath, logger });
    assert.equal(index.available, false);
  });
});
