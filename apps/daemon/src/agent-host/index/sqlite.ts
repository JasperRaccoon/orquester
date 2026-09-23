/**
 * Agent host — the thread index's SQLite driver and file lifecycle (design
 * 2026-09-23 "thread index and lazy boot", §C, invariants 1, 5 and 8).
 *
 * **The driver is resolved exactly once, when this module loads** — never
 * lazily later. AGENTS.md forbids a lazy dynamic `import()` anywhere under
 * `agent-host/`, because a host that survives a deploy keeps running old code
 * until its drain-restart and must not pull changed source in. A host with no
 * usable native binding therefore gets `defaultSqliteDriver === null` here,
 * and the index runs unavailable (history 503, search `indexed: false`) rather
 * than failing anything else.
 *
 * The file is a cache (invariant 1): whatever is wrong with it — another
 * schema version, a failed `quick_check`, not a database at all — is fixed by
 * deleting it (plus `-wal`/`-shm`) and starting empty; the boot catch-up then
 * re-derives every thread from its log. It holds the full text of every
 * conversation, so it is created 0600 and chmodded 0600 on every open
 * (invariant 8). SQLite gives the `-wal`/`-shm` siblings the main file's mode.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import type { AdapterLogger } from "../adapter.ts";
import {
  INDEX_SCHEMA_VERSION,
  INDEX_TABLES,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION_KEY
} from "./schema.ts";

// ---------------------------------------------------------------------------
// The driver seam
// ---------------------------------------------------------------------------

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** The subset of a better-sqlite3 `Statement` the index uses. */
export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The subset of a better-sqlite3 `Database` the index uses. */
export interface SqliteDatabase {
  prepare(source: string): SqliteStatement;
  exec(source: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  /** Wrap `fn` so each call runs inside BEGIN/COMMIT, rolled back on a throw. */
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

/** Test seam: how a database file is opened. */
export interface SqliteDriver {
  open(filePath: string): SqliteDatabase;
}

function wrapDatabase(db: BetterSqlite3.Database): SqliteDatabase {
  return {
    prepare: (source) => db.prepare(source),
    exec: (source) => {
      db.exec(source);
    },
    pragma: (source, options) => db.pragma(source, options),
    transaction: <T>(fn: () => T) => db.transaction(fn),
    close: () => {
      db.close();
    }
  };
}

interface DriverResolution {
  driver: SqliteDriver | null;
  error: string | null;
}

function resolveDefaultDriver(): DriverResolution {
  try {
    // Inside the try on purpose: in a CJS bundle (the desktop's esbuild
    // output) `import.meta.url` is empty and `createRequire` itself throws,
    // which must read as "no driver", never as a crash at load.
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as typeof BetterSqlite3;
    // better-sqlite3's JS loads without its native binding; the binding is
    // loaded by the first open. Probe it here, once, so a host with a missing
    // or ABI-mismatched build runs without an index instead of deleting a
    // healthy file because it could not open it.
    new Database(":memory:").close();
    return {
      driver: { open: (filePath) => wrapDatabase(new Database(filePath)) },
      error: null
    };
  } catch (error) {
    return { driver: null, error: describeError(error) };
  }
}

const resolution = resolveDefaultDriver();

/** better-sqlite3, or null when it (or its native binding) cannot load here. */
export const defaultSqliteDriver: SqliteDriver | null = resolution.driver;

/** Why {@link defaultSqliteDriver} is null, for the one log line that says so. */
export const defaultSqliteDriverError: string | null = resolution.error;

// ---------------------------------------------------------------------------
// Open, verify, rebuild
// ---------------------------------------------------------------------------

export interface OpenedIndexFile {
  db: SqliteDatabase;
  /** True when the file was deleted and recreated empty on this open. */
  rebuilt: boolean;
}

/**
 * Open `filePath` as a thread index: WAL, `synchronous=NORMAL`, 0600,
 * `quick_check` clean and at {@link INDEX_SCHEMA_VERSION} (an empty file gets
 * the schema). Anything else deletes the file and its siblings and starts
 * over once; null when even that fails (the index then runs unavailable).
 * Never throws.
 */
export function openIndexFile(input: {
  filePath: string;
  driver: SqliteDriver;
  logger: AdapterLogger;
}): OpenedIndexFile | null {
  const { filePath, driver, logger } = input;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  } catch (error) {
    logger.warn("agent-host: thread index directory is unusable; running without an index", {
      filePath,
      error: describeError(error)
    });
    return null;
  }

  try {
    return { db: openVerified(filePath, driver), rebuilt: false };
  } catch (error) {
    // Expected on a first boot after a schema bump, so it is not an error —
    // but it does mean every thread is re-indexed from its log.
    logger.warn("agent-host: thread index is unusable; deleting and rebuilding it", {
      filePath,
      error: describeError(error)
    });
  }

  try {
    removeIndexFiles(filePath);
    return { db: openVerified(filePath, driver), rebuilt: true };
  } catch (error) {
    logger.warn("agent-host: thread index could not be recreated; running without an index", {
      filePath,
      error: describeError(error)
    });
    return null;
  }
}

/** The main file plus every sibling SQLite may leave behind. */
export function removeIndexFiles(filePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${filePath}${suffix}`, { force: true });
  }
}

function openVerified(filePath: string, driver: SqliteDriver): SqliteDatabase {
  // Created 0600 BEFORE SQLite touches it, so the WAL and shared-memory
  // siblings — which SQLite creates with the main file's mode — are private
  // from their first byte. An empty file is a valid empty database.
  closeSync(openSync(filePath, "a", 0o600));
  chmodPrivate(filePath);

  const db = driver.open(filePath);
  try {
    // Garbage in the file surfaces here, as SQLITE_NOTADB.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") {
      throw new Error(`quick_check failed: ${String(check)}`);
    }
    const version = readSchemaVersion(db);
    if (version === null) {
      createSchema(db);
    } else if (version !== INDEX_SCHEMA_VERSION) {
      throw new Error(`schema version ${version}, expected ${INDEX_SCHEMA_VERSION}`);
    } else {
      assertTablesPresent(db);
    }
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${filePath}${suffix}`)) {
        chmodPrivate(`${filePath}${suffix}`);
      }
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Already unusable; the caller deletes the file next.
    }
    throw error;
  }
}

/** Null for an empty database, the recorded version otherwise. Throws on a foreign file. */
function readSchemaVersion(db: SqliteDatabase): number | null {
  const tables = tableNames(db);
  if (tables.size === 0) {
    return null;
  }
  if (!tables.has("meta")) {
    throw new Error("not a thread index (no meta table)");
  }
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(SCHEMA_VERSION_KEY) as { value?: unknown } | undefined;
  const version = Number(row?.value);
  if (!Number.isInteger(version)) {
    throw new Error("thread index has no schema version");
  }
  return version;
}

function assertTablesPresent(db: SqliteDatabase): void {
  const tables = tableNames(db);
  const missing = INDEX_TABLES.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    throw new Error(`thread index is missing ${missing.join(", ")}`);
  }
}

function tableNames(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function createSchema(db: SqliteDatabase): void {
  db.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      SCHEMA_VERSION_KEY,
      String(INDEX_SCHEMA_VERSION)
    );
  })();
}

function chmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort off POSIX; the file was created 0600 anyway.
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
