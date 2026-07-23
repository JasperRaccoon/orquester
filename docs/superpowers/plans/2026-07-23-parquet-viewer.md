# Parquet Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fast spreadsheet-like parquet viewer in the file browser: the daemon reads schema + row windows with hyparquet, the shared UI renders them in a custom virtualized grid with server-side column sort.

**Architecture:** New `GET /api/fs/parquet` route on the daemon backed by a new `apps/daemon/src/parquet.ts` module (hyparquet, pure JS, random-access reads — never the whole file). New `FsParquetResponse` wire type, `ApiClient.readParquet`, a `parquet` file kind, and a net-new `ParquetViewer` virtualized grid component. Spec: `docs/superpowers/specs/2026-07-23-parquet-viewer-design.md`.

**Tech Stack:** hyparquet ^1.26 + hyparquet-compressors ^1.1 (daemon only, zero native/wasm deps). Zero new dependencies in `packages/ui`.

## Global Constraints

- **This repo has NO test runner** (AGENTS.md). Verification per task = `pnpm check` (typecheck, the pre-commit gate) + the concrete verification scripts/commands given in each task. The TDD test-file steps of the usual cycle are replaced by these runnable verification scripts.
- **⛔ Never start a daemon in this checkout and never bind `127.0.0.1:47831` or this checkout's `.stage`** — a live Orquester daemon is serving this very workspace. Daemon-driving verification tasks use a **git worktree** (separate checkout) with a **scratch appdir** (unix socket only, or HTTP on port **47899**). This plan's daemon launches are explicitly user-approved via plan approval.
- **Commit to the current branch (`main`) as-is** — do not create a branch (AGENTS.md override).
- ESM everywhere; the daemon runs TypeScript via tsx — no build step for daemon changes.
- Wire values must be JSON-safe (no BigInt/Date/Uint8Array in `FsParquetResponse.rows`).
- Server row-window: default limit **200**, max **1000**. Sort cap: **2,000,000 rows**.
- Environment for all shell steps: `export SCRATCH=<session-scratchpad>/parquet-dev` — substitute your session's scratchpad directory (listed in your system prompt); create it with `mkdir -p "$SCRATCH"`. Never use `/tmp`.
- Every task ends with `pnpm check` clean before its commit.

---

### Task 1: Wire types in `packages/api`

**Files:**
- Modify: `packages/api/src/index.ts` (insert after `FsArchiveResponse`, which ends at line 249)

**Interfaces:**
- Consumes: nothing.
- Produces: `ParquetColumn { name: string; type: string }` and `FsParquetResponse { supported: boolean; rowCount: number; columns: ParquetColumn[]; rows: unknown[][]; offset: number; reason?: string }` — imported by Tasks 2, 3, 5.

- [ ] **Step 1: Add the types**

Insert immediately after the `FsArchiveResponse` interface (line 249), before `FsCreateRequest`:

```ts
/** One column of a parquet file (from GET /api/fs/parquet). */
export interface ParquetColumn {
  name: string;
  /** Human-readable type label, e.g. "INT64" | "STRING" | "TIMESTAMP" | "LIST". */
  type: string;
}

export interface FsParquetResponse {
  /** False when the file can't be parsed (corrupt, exotic codec). */
  supported: boolean;
  /** Total rows in the file (not the window). */
  rowCount: number;
  columns: ParquetColumn[];
  /** Window of rows, positional per `columns`. Values are JSON-safe. */
  rows: unknown[][];
  /** Echo of the effective (clamped) window offset. */
  offset: number;
  /** Why unsupported, when supported is false. */
  reason?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): FsParquetResponse wire type for the parquet preview"
```

---

### Task 2: Daemon parquet reader module + fixtures + script verification

**Files:**
- Modify: `apps/daemon/package.json` (dependencies)
- Create: `apps/daemon/src/parquet.ts`
- Create (scratch, NOT committed): `$SCRATCH/gen_fixtures.py`, `$SCRATCH/verify-parquet.mts`, `$SCRATCH/fixtures/*.parquet`

**Interfaces:**
- Consumes: `ParquetColumn`, `FsParquetResponse` from `@orquester/api` (Task 1).
- Produces (used by Task 3's route):
  - `readParquetWindow(absPath: string, opts?: { offset?: number; limit?: number; orderBy?: string; desc?: boolean }): Promise<FsParquetResponse>` — never throws for data-level problems (returns `supported: false`); throws `ParquetRequestError` for bad requests (unknown sort column, file over the sort row cap).
  - `class ParquetRequestError extends Error`
  - Constants `DEFAULT_LIMIT = 200`, `MAX_LIMIT = 1000` (exported).

- [ ] **Step 1: Install the daemon deps**

```bash
pnpm --filter @orquester/daemon add hyparquet@^1.26.2 hyparquet-compressors@^1.1.1
```

Expected: lockfile updated, no build scripts run (both are pure JS).

- [ ] **Step 2: Confirm the hyparquet API surface**

```bash
pnpm --filter @orquester/daemon exec node -e "import('hyparquet').then(m => console.log(Object.keys(m).join('\n')))"
```

Expected exports include: `asyncBufferFromFile`, `parquetMetadataAsync`, `parquetReadObjects`, `parquetSchema`. Also skim `apps/daemon/node_modules/hyparquet/src/hyparquet.d.ts` (or the package's `types`) to confirm: `parquetReadObjects` options `{ file, metadata?, columns?, rowStart?, rowEnd?, compressors? }` resolving to `Record<string, unknown>[]`; `parquetSchema(metadata)` returning a tree of `{ element, children }`; `metadata.num_rows: bigint`. If any name differs from the code in Step 4, adapt the code to the real names (keep the exported signatures from the Interfaces block unchanged).

- [ ] **Step 3: Generate fixtures**

Write `$SCRATCH/gen_fixtures.py`:

```python
import pyarrow as pa, pyarrow.parquet as pq
import datetime as dt, random, os, sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
random.seed(7)

n = 5000
base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
basic = pa.table({
    "id": pa.array(range(n), pa.int64()),
    "app_name": pa.array([f"App {i % 997}" for i in range(n)], pa.string()),
    "score": pa.array([None if i % 37 == 0 else round(random.random() * 100, 3) for i in range(n)], pa.float64()),
    "free": pa.array([i % 3 == 0 for i in range(n)], pa.bool_()),
    "created": pa.array([base + dt.timedelta(minutes=i) for i in range(n)], pa.timestamp("us", tz="UTC")),
    "big": pa.array([2**60 + i if i % 100 == 0 else i for i in range(n)], pa.int64()),
    "tags": pa.array([["a", "b"] if i % 2 else ["solo"] for i in range(n)], pa.list_(pa.string())),
})
pq.write_table(basic, f"{out}/basic.parquet", compression="snappy")

m = 100_000
big = pa.table({
    "id": pa.array(range(m), pa.int64()),
    "rank": pa.array([random.randint(0, 10**6) for _ in range(m)], pa.int64()),
    "name": pa.array([f"row-{i}" for i in range(m)], pa.string()),
})
pq.write_table(big, f"{out}/large_zstd.parquet", compression="zstd")

wide = pa.table({f"col_{i:02d}": pa.array([f"v{i}-{r}" for r in range(50)], pa.string()) for i in range(40)})
pq.write_table(wide, f"{out}/wide.parquet", compression="snappy")

pq.write_table(basic.slice(0, 0), f"{out}/empty.parquet", compression="snappy")

with open(f"{out}/basic.parquet", "rb") as f:
    head = f.read(1000)
with open(f"{out}/corrupt.parquet", "wb") as f:
    f.write(head)
print("fixtures written to", out)
```

Run: `uv run --with pyarrow python "$SCRATCH/gen_fixtures.py" "$SCRATCH/fixtures"`
(`uv` is provisioned on this host; if absent, `python3 -m venv` + `pip install pyarrow` works too.)
Expected: `fixtures written to …` and 5 files in `$SCRATCH/fixtures`.

- [ ] **Step 4: Write `apps/daemon/src/parquet.ts`**

```ts
/**
 * Parquet schema + row-window reader for the file browser preview. Pure-JS
 * (hyparquet) random-access reads: footer + only the touched row groups —
 * never the whole file, so there is no file-size cap. Data-level failures
 * (corrupt file, exotic codec) degrade to { supported: false }; only bad
 * requests throw (ParquetRequestError -> HTTP 400 in the route).
 */
import { stat } from "node:fs/promises";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { FsParquetResponse, ParquetColumn } from "@orquester/api";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
/** Sorting materializes one full column + an index permutation — cap the rows. */
const MAX_SORT_ROWS = 2_000_000;
const CELL_MAX_CHARS = 500;
const BYTES_PREVIEW = 32;

/** Bad request (unknown sort column, too many rows to sort) -> HTTP 400. */
export class ParquetRequestError extends Error {}

export interface ParquetWindowOptions {
  offset?: number;
  limit?: number;
  orderBy?: string;
  desc?: boolean;
}

/** Single-slot cache of a sorted row order, so scrolling under a sort only
 *  pays the column scan once. Keyed by (path, mtime, column, direction). */
interface SortSlot {
  path: string;
  mtimeMs: number;
  column: string;
  desc: boolean;
  order: Uint32Array;
}
let sortSlot: SortSlot | null = null;

export async function readParquetWindow(
  absPath: string,
  opts: ParquetWindowOptions = {}
): Promise<FsParquetResponse> {
  let file: Awaited<ReturnType<typeof asyncBufferFromFile>>;
  let metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>;
  let rowCount: number;
  let columns: ParquetColumn[];
  try {
    file = await asyncBufferFromFile(absPath);
    metadata = await parquetMetadataAsync(file);
    rowCount = Number(metadata.num_rows);
    columns = columnsOf(metadata);
  } catch (error) {
    return unsupported(error);
  }
  const limit = clampInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(opts.offset, 0, 0, rowCount);
  try {
    let raw: Record<string, unknown>[];
    if (opts.orderBy !== undefined) {
      const orderBy = opts.orderBy;
      if (!columns.some((c) => c.name === orderBy)) {
        throw new ParquetRequestError(`Unknown column: ${orderBy}`);
      }
      if (rowCount > MAX_SORT_ROWS) {
        throw new ParquetRequestError(
          `Too many rows to sort (${rowCount.toLocaleString()} > ${MAX_SORT_ROWS.toLocaleString()}).`
        );
      }
      const order = await sortedOrder(absPath, file, metadata, rowCount, orderBy, opts.desc ?? false);
      const indices = Array.from(order.subarray(offset, Math.min(offset + limit, rowCount)));
      raw = await readRowsByIndex(file, metadata, indices);
    } else {
      raw = await parquetReadObjects({
        file,
        metadata,
        rowStart: offset,
        rowEnd: Math.min(offset + limit, rowCount),
        compressors
      });
    }
    const rows = raw.map((r) => columns.map((c) => serializeCell(r[c.name])));
    return { supported: true, rowCount, columns, rows, offset };
  } catch (error) {
    if (error instanceof ParquetRequestError) throw error;
    return unsupported(error);
  }
}

function unsupported(error: unknown): FsParquetResponse {
  return {
    supported: false,
    rowCount: 0,
    columns: [],
    rows: [],
    offset: 0,
    reason: error instanceof Error ? error.message.split("\n")[0] : "Cannot read parquet file."
  };
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number): number {
  const n = v === undefined || !Number.isFinite(v) ? dflt : Math.floor(v);
  return Math.min(max, Math.max(min, n));
}

/** Top-level schema columns with human-readable type labels. */
function columnsOf(metadata: Parameters<typeof parquetSchema>[0]): ParquetColumn[] {
  const root = parquetSchema(metadata);
  return root.children.map((child) => ({ name: child.element.name, type: typeLabel(child) }));
}

type SchemaNode = ReturnType<typeof parquetSchema>;

function typeLabel(node: SchemaNode): string {
  const el = node.element;
  if (node.children.length > 0) {
    const ct = el.converted_type;
    if (ct === "LIST") return "LIST";
    if (ct === "MAP" || ct === "MAP_KEY_VALUE") return "MAP";
    return "STRUCT";
  }
  const logical = el.logical_type?.type;
  if (logical === "TIMESTAMP") return "TIMESTAMP";
  if (logical === "DATE") return "DATE";
  if (logical === "STRING") return "STRING";
  if (logical === "DECIMAL") return "DECIMAL";
  const ct = el.converted_type;
  if (ct === "UTF8") return "STRING";
  if (ct === "DATE") return "DATE";
  if (typeof ct === "string" && ct.startsWith("TIMESTAMP")) return "TIMESTAMP";
  if (ct === "DECIMAL") return "DECIMAL";
  return el.type ?? "UNKNOWN";
}

/** Cached (or freshly computed) row order for a sorted view. */
async function sortedOrder(
  absPath: string,
  file: Parameters<typeof parquetReadObjects>[0]["file"],
  metadata: Parameters<typeof parquetReadObjects>[0]["metadata"],
  rowCount: number,
  column: string,
  desc: boolean
): Promise<Uint32Array> {
  const { mtimeMs } = await stat(absPath);
  if (
    sortSlot &&
    sortSlot.path === absPath &&
    sortSlot.mtimeMs === mtimeMs &&
    sortSlot.column === column &&
    sortSlot.desc === desc
  ) {
    return sortSlot.order;
  }
  const values = await parquetReadObjects({ file, metadata, columns: [column], compressors });
  const order = new Uint32Array(rowCount);
  for (let i = 0; i < rowCount; i++) order[i] = i;
  const dir = desc ? -1 : 1;
  order.sort((a, b) => {
    const va = values[a]?.[column];
    const vb = values[b]?.[column];
    const na = va === null || va === undefined;
    const nb = vb === null || vb === undefined;
    if (na || nb) return na && nb ? 0 : na ? 1 : -1; // nulls always last
    return dir * compareValues(va, vb);
  });
  sortSlot = { path: absPath, mtimeMs, column, desc, order };
  return order;
}

function compareValues(a: unknown, b: unknown): number {
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) {
    // Number() may lose precision past 2^53 — acceptable for view ordering.
    const na = Number(a);
    const nb = Number(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      return Number.isNaN(na) && Number.isNaN(nb) ? 0 : Number.isNaN(na) ? 1 : -1;
    }
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Fetch scattered row indices by grouping them into contiguous ascending runs. */
async function readRowsByIndex(
  file: Parameters<typeof parquetReadObjects>[0]["file"],
  metadata: Parameters<typeof parquetReadObjects>[0]["metadata"],
  indices: number[]
): Promise<Record<string, unknown>[]> {
  const tagged = indices.map((row, pos) => ({ row, pos })).sort((x, y) => x.row - y.row);
  const out = new Array<Record<string, unknown>>(indices.length);
  let i = 0;
  while (i < tagged.length) {
    let j = i;
    while (j + 1 < tagged.length && tagged[j + 1].row === tagged[j].row + 1) j++;
    const rowStart = tagged[i].row;
    const chunk = await parquetReadObjects({
      file,
      metadata,
      rowStart,
      rowEnd: tagged[j].row + 1,
      compressors
    });
    for (let k = i; k <= j; k++) out[tagged[k].pos] = chunk[tagged[k].row - rowStart];
    i = j + 1;
  }
  return out;
}

/** JSON-safe, size-capped cell value for the wire. */
function serializeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return capString(value);
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, BYTES_PREVIEW), (b) => b.toString(16).padStart(2, "0")).join("");
    return `0x${hex}${value.length > BYTES_PREVIEW ? "…" : ""}`;
  }
  try {
    return capString(
      JSON.stringify(value, (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `0x…(${v.length}B)` : v
      )
    );
  } catch {
    return capString(String(value));
  }
}

function capString(s: string): string {
  return s.length > CELL_MAX_CHARS ? `${s.slice(0, CELL_MAX_CHARS)}…` : s;
}
```

Note on `SchemaNode`/parameter types: these `Parameters<…>`/`ReturnType<…>` derivations depend on hyparquet's shipped `.d.ts`. If they don't line up (Step 2's inspection), substitute hyparquet's own exported types (e.g. `AsyncBuffer`, `FileMetaData`, `SchemaTree` from `hyparquet`) — the runtime code stays the same.

- [ ] **Step 5: Write the verification script**

Write `$SCRATCH/verify-parquet.mts` (adjust the repo path if your checkout differs):

```ts
import assert from "node:assert";
import { readParquetWindow, ParquetRequestError } from "/var/lib/orquester/workspaces/jaspersito/orquester2/apps/daemon/src/parquet.ts";

const FIX = process.argv[2];
if (!FIX) throw new Error("usage: tsx verify-parquet.mts <fixtures-dir>");

// schema + first window
const basic = await readParquetWindow(`${FIX}/basic.parquet`);
assert.equal(basic.supported, true);
assert.equal(basic.rowCount, 5000);
assert.deepEqual(
  basic.columns.map((c) => c.name),
  ["id", "app_name", "score", "free", "created", "big", "tags"]
);
assert.equal(basic.columns[0].type, "INT64");
assert.equal(basic.columns[1].type, "STRING");
assert.equal(basic.columns[3].type, "BOOLEAN");
assert.equal(basic.columns[4].type, "TIMESTAMP");
assert.equal(basic.columns[6].type, "LIST");
assert.equal(basic.rows.length, 200);
assert.equal(basic.offset, 0);
assert.equal(basic.rows[0][0], 0);
assert.equal(typeof basic.rows[1][1], "string");
assert.equal(basic.rows[0][2], null); // 0 % 37 == 0 -> null score
assert.ok(String(basic.rows[0][4]).startsWith("2026-01-01T"), "timestamp serialized as ISO");
assert.equal(typeof basic.rows[0][5], "string"); // 2^60 -> beyond safe int -> string
assert.equal(typeof basic.rows[1][5], "number");
assert.equal(typeof basic.rows[0][6], "string"); // LIST -> JSON string preview

// offset paging + limit clamp at EOF
const win = await readParquetWindow(`${FIX}/basic.parquet`, { offset: 4900, limit: 1000 });
assert.equal(win.rows.length, 100);
assert.equal(win.offset, 4900);
assert.equal(win.rows[0][0], 4900);

// sort asc (nulls last -> first 200 are all numbers, ascending)
const sorted = await readParquetWindow(`${FIX}/basic.parquet`, { orderBy: "score" });
const scores = sorted.rows.map((r) => r[2]);
assert.ok(scores.every((s) => typeof s === "number"), "nulls sort last");
for (let i = 1; i < scores.length; i++) assert.ok((scores[i - 1] as number) <= (scores[i] as number));

// sorted window from the cache should be fast
const t0 = Date.now();
const sorted2 = await readParquetWindow(`${FIX}/basic.parquet`, { orderBy: "score", offset: 200 });
console.log("cached sorted window:", Date.now() - t0, "ms");
assert.equal(sorted2.rows.length, 200);

// sort desc
const desc = await readParquetWindow(`${FIX}/basic.parquet`, { orderBy: "score", desc: true });
assert.ok((desc.rows[0][2] as number) >= (desc.rows[1][2] as number));

// unknown sort column -> ParquetRequestError
await assert.rejects(readParquetWindow(`${FIX}/basic.parquet`, { orderBy: "nope" }), ParquetRequestError);

// zstd codec via hyparquet-compressors
const zstd = await readParquetWindow(`${FIX}/large_zstd.parquet`);
assert.equal(zstd.supported, true);
assert.equal(zstd.rowCount, 100000);

// deep window into the zstd file
const deep = await readParquetWindow(`${FIX}/large_zstd.parquet`, { offset: 99900 });
assert.equal(deep.rows.length, 100);
assert.equal(deep.rows[0][0], 99900);

// corrupt -> supported:false with a reason (no throw)
const corrupt = await readParquetWindow(`${FIX}/corrupt.parquet`);
assert.equal(corrupt.supported, false);
assert.ok(corrupt.reason);

// empty file
const empty = await readParquetWindow(`${FIX}/empty.parquet`);
assert.equal(empty.supported, true);
assert.equal(empty.rowCount, 0);
assert.equal(empty.rows.length, 0);

console.log("ALL PASS");
```

- [ ] **Step 6: Run it**

```bash
pnpm --filter @orquester/daemon exec tsx "$SCRATCH/verify-parquet.mts" "$SCRATCH/fixtures"
```

Expected: `cached sorted window: <n> ms` (single-digit-to-low-double-digit) then `ALL PASS`, exit 0. If an assertion fails, fix `parquet.ts` (or a wrong assumption about hyparquet's API from Step 2) and re-run until green.

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/package.json pnpm-lock.yaml apps/daemon/src/parquet.ts
git commit -m "feat(daemon): hyparquet-backed parquet schema/row-window reader"
```

---

### Task 3: `/api/fs/parquet` route + worktree daemon verification

**Files:**
- Modify: `apps/daemon/src/index.ts` (insert the route after `/api/fs/archive`, which ends at line 1357; add one import near the `listArchiveEntries` import)

**Interfaces:**
- Consumes: `readParquetWindow`, `ParquetRequestError` from `./parquet` (Task 2); existing `assertInsideFsRoot`, `FsSandboxError`, `stat`, `resolved.fsRoot` already in scope in `createServer()`.
- Produces: `GET /api/fs/parquet?path=&offset=&limit=&orderBy=&desc=1` → `FsParquetResponse` (200), `INVALID_REQUEST` (400, missing path), `FS_FORBIDDEN` (403, sandbox), `FS_ERROR` (400, bad request/not a file/missing file). Consumed by Task 4's `ApiClient.readParquet`.

- [ ] **Step 1: Add the import**

Next to the existing `listArchiveEntries` import at the top of `apps/daemon/src/index.ts` (match its exact path style — e.g. `from "./archive.js"` vs `from "./archive"` — and mirror it):

```ts
import { ParquetRequestError, readParquetWindow } from "./parquet.js";
```

- [ ] **Step 2: Register the route**

Insert after the `/api/fs/archive` route (after line 1357, before the `/api/fs/capabilities` comment block), following the file's exact `void reply…` style:

```ts
  // Read a parquet file's schema + a window of rows for the preview viewer.
  // Windowed server-side (hyparquet random-access) — no file-size cap; sort
  // (orderBy/desc) is served from a cached row order after the first scan.
  app.get<{
    Querystring: { path?: string; offset?: string; limit?: string; orderBy?: string; desc?: string };
  }>("/api/fs/parquet", async (request, reply) => {
    const { path, offset, limit, orderBy, desc } = request.query;
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, path);
      const info = await stat(safe);
      if (!info.isFile()) {
        void reply.code(400).send({ code: "FS_ERROR", message: "Not a file." });
        return;
      }
      void reply.send(
        await readParquetWindow(safe, {
          offset: offset === undefined ? undefined : Number(offset),
          limit: limit === undefined ? undefined : Number(limit),
          orderBy,
          desc: desc === "1"
        })
      );
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      if (error instanceof ParquetRequestError) {
        void reply.code(400).send({ code: "FS_ERROR", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot read parquet file."
      });
    }
  });
```

- [ ] **Step 3: Typecheck and commit**

```bash
pnpm check
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): GET /api/fs/parquet row-window route"
```

(Committed before the live check because the live check needs a separate checkout of this commit; any fix found below lands as a follow-up commit.)

- [ ] **Step 4: Stand up a worktree daemon (separate checkout, scratch appdir, unix socket only)**

```bash
git worktree add --detach "$SCRATCH/wt" HEAD
cd "$SCRATCH/wt" && pnpm install
export APP="$SCRATCH/appdir"
mkdir -p "$APP"
node --import tsx "$SCRATCH/wt/apps/daemon/src/cli.ts" --appdir "$APP" &   # run in background
```

A fresh appdir has the HTTP transport disabled (opt-in per AGENTS.md) — the daemon binds only `$APP/daemon/daemon.sock`. Confirm from its startup log that no HTTP port is bound (if it did bind one, stop it immediately and disable http in `$APP/daemon/daemon.json` before retrying). Then:

```bash
export SOCK="$APP/daemon/daemon.sock"
curl -sS --unix-socket "$SOCK" http://localhost/health
```

Expected: `{"ok":true}`.

- [ ] **Step 5: Seed fixtures into the daemon's fsRoot and exercise the route**

```bash
mkdir -p "$APP/workspaces/demo/data"
cp "$SCRATCH/fixtures/"*.parquet "$APP/workspaces/demo/data/"
export P="$APP/workspaces/demo/data"

# happy path: schema + first window
curl -sSG --unix-socket "$SOCK" http://localhost/api/fs/parquet \
  --data-urlencode "path=$P/basic.parquet" \
  | jq '{supported, rowCount, cols: (.columns | length), rows: (.rows | length), first: .rows[0][0]}'
# expect: {"supported":true,"rowCount":5000,"cols":7,"rows":200,"first":0}

# offset + limit clamp
curl -sSG --unix-socket "$SOCK" http://localhost/api/fs/parquet \
  --data-urlencode "path=$P/basic.parquet" --data-urlencode "offset=4900" --data-urlencode "limit=9999" \
  | jq '{rows: (.rows | length), first: .rows[0][0]}'
# expect: {"rows":100,"first":4900}

# sort desc on the 100k zstd file (first call pays the scan; re-run to see the cache)
time curl -sSG --unix-socket "$SOCK" http://localhost/api/fs/parquet \
  --data-urlencode "path=$P/large_zstd.parquet" --data-urlencode "orderBy=rank" --data-urlencode "desc=1" \
  | jq '.rows[0][1]'
# expect: a value near 1000000; second run markedly faster

# unknown column -> 400
curl -sS -o /dev/null -w '%{http_code}\n' -G --unix-socket "$SOCK" http://localhost/api/fs/parquet \
  --data-urlencode "path=$P/basic.parquet" --data-urlencode "orderBy=nope"
# expect: 400

# sandbox escape -> 403
curl -sS -o /dev/null -w '%{http_code}\n' -G --unix-socket "$SOCK" http://localhost/api/fs/parquet \
  --data-urlencode "path=/etc/passwd"
# expect: 403

# corrupt -> 200 supported:false
curl -sSG --unix-socket "$SOCK" http://localhost/api/fs/parquet \
  --data-urlencode "path=$P/corrupt.parquet" | jq '{supported, reason}'
# expect: supported false with a non-empty reason
```

- [ ] **Step 6: Stop the worktree daemon**

Kill the background daemon process started in Step 4 (only that one — never anything on 47831). Keep the worktree and appdir; Task 7 reuses them.

- [ ] **Step 7: Follow-up commit if fixes were needed**

If Steps 4–5 forced changes, `pnpm check` then commit them:

```bash
git add apps/daemon/src/parquet.ts apps/daemon/src/index.ts
git commit -m "fix(daemon): parquet route fixes from live verification"
```

---

### Task 4: Client plumbing — file kind + `ApiClient.readParquet`

**Files:**
- Modify: `packages/ui/src/lib/file-kind.ts`
- Modify: `packages/ui/src/lib/api-client.ts` (insert after `listArchive`, lines 281–283)

**Interfaces:**
- Consumes: `FsParquetResponse` from `@orquester/api` (Task 1).
- Produces (used by Task 5):
  - `FileKind` union gains `"parquet"`; `detectFileKind("x.parquet")` → `{ kind: "parquet", mime: "application/vnd.apache.parquet" }`; `PREVIEW_CAP_BY_KIND.parquet === Number.POSITIVE_INFINITY`.
  - `ApiClient.readParquet(path: string, opts?: { offset?: number; limit?: number; orderBy?: string; desc?: boolean }, signal?: AbortSignal): Promise<FsParquetResponse>`

- [ ] **Step 1: Extend `file-kind.ts`**

Three edits:

1. Line 7 — add the kind:

```ts
export type FileKind = "text" | "html" | "image" | "pdf" | "audio" | "video" | "archive" | "binary" | "parquet";
```

2. In `PREVIEW_CAP_BY_KIND` (lines 22–31), add:

```ts
  parquet: Number.POSITIVE_INFINITY, // windowed server-side, bytes never fetched
```

3. In `BY_EXT` (lines 34–66), add:

```ts
  parquet: ["parquet", "application/vnd.apache.parquet"],
```

- [ ] **Step 2: Add `readParquet` to `ApiClient`**

In `packages/ui/src/lib/api-client.ts`, add `FsParquetResponse` to the existing `@orquester/api` type-import list, then insert after `listArchive` (line 283):

```ts
  readParquet(
    path: string,
    opts: { offset?: number; limit?: number; orderBy?: string; desc?: boolean } = {},
    signal?: AbortSignal
  ): Promise<FsParquetResponse> {
    return this.send("GET", "/api/fs/parquet", {
      query: {
        path,
        offset: opts.offset,
        limit: opts.limit,
        orderBy: opts.orderBy,
        desc: opts.desc ? "1" : undefined
      },
      signal
    });
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: exits 0. (Interim behavior note: `.parquet` files now hit `FilePreview`'s final `else` and show the generic "Preview" card until Task 5 — that's fine and still compiles.)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/file-kind.ts packages/ui/src/lib/api-client.ts
git commit -m "feat(ui): parquet file kind + ApiClient.readParquet"
```

---

### Task 5: `ParquetViewer` — virtualized grid (view + scroll)

**Files:**
- Create: `packages/ui/src/components/files/viewers/ParquetViewer.tsx`
- Modify: `packages/ui/src/components/files/FilePreview.tsx` (import at line ~10; branch after the `html` branch, lines 56–58)

**Interfaces:**
- Consumes: `api.readParquet` and the `parquet` kind (Task 4); `BinaryCard`, `useApi` (existing).
- Produces: `ParquetViewer: React.FC<{ path: string; name: string; size: number; mime: string; fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer> }>` — same prop shape as `ArchiveViewer`. Task 6 modifies this same file to add sorting; the `sort`/`sortLoading` state and generation guard are already scaffolded here so Task 6 is a small delta.

- [ ] **Step 1: Write `ParquetViewer.tsx`**

Note: this task ships the component with sort **state present but no header click-handler** (headers are plain divs); Task 6 turns headers into sort buttons. Full file:

```tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FsParquetResponse } from "@orquester/api";
import { useApi } from "../../../context/orquester-context";
import { BinaryCard } from "./BinaryCard";

const CHUNK = 200; // rows per fetch — matches the server's default window
const ROW_H = 28; // px, fixed row height for virtualization
const OVERSCAN = 20; // extra rows rendered above/below the viewport
const GUTTER_W = 56; // px, sticky row-number gutter
const DOWNLOAD_MAX = 50 * 1024 * 1024;

const NUMERIC = /^(INT|DOUBLE|FLOAT|DECIMAL)/;

const fmtSize = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

export type ParquetSort = { column: string; desc: boolean } | null;

export const ParquetViewer: React.FC<{
  path: string;
  name: string;
  size: number;
  mime: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, name, size, mime, fetchBytes }) => {
  const api = useApi();
  const [meta, setMeta] = useState<FsParquetResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<ParquetSort>(null);
  const [sortLoading, setSortLoading] = useState(false);
  const [chunks, setChunks] = useState<ReadonlyMap<number, unknown[][]>>(new Map());
  const [widths, setWidths] = useState<number[] | null>(null);
  const [range, setRange] = useState({ top: 0, height: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevPathRef = useRef<string | null>(null);
  // Generation guard: bumped on every path/sort change so stale responses are dropped.
  const genRef = useRef(0);
  const inflightRef = useRef<Set<number>>(new Set());

  // First window (and re-fetch on sort change). On a sort change the previous
  // rows stay mounted until the new first window lands — no layout flash.
  useEffect(() => {
    const gen = ++genRef.current;
    inflightRef.current = new Set();
    const pathChanged = prevPathRef.current !== path;
    prevPathRef.current = path;
    if (pathChanged) {
      setMeta(null);
      setFailed(false);
      setChunks(new Map());
      setWidths(null);
      setSortLoading(false);
      if (sort !== null) {
        setSort(null); // effect re-runs with sort cleared
        return;
      }
    } else {
      setSortLoading(true);
    }
    const controller = new AbortController();
    api
      .readParquet(path, { offset: 0, limit: CHUNK, orderBy: sort?.column, desc: sort?.desc }, controller.signal)
      .then((data) => {
        if (gen !== genRef.current) return;
        setMeta(data);
        setSortLoading(false);
        setChunks(new Map([[0, data.rows]]));
        setWidths((w) => w ?? estimateWidths(data));
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch(() => {
        if (gen !== genRef.current || controller.signal.aborted) return;
        if (pathChanged) setFailed(true);
        else {
          // Sort request rejected (e.g. too many rows to sort) — revert to unsorted.
          setSortLoading(false);
          setSort(null);
        }
      });
    return () => controller.abort();
  }, [api, path, sort]);

  const loadChunk = useCallback(
    (index: number) => {
      if (inflightRef.current.has(index)) return;
      inflightRef.current.add(index);
      const gen = genRef.current;
      api
        .readParquet(path, { offset: index * CHUNK, limit: CHUNK, orderBy: sort?.column, desc: sort?.desc })
        .then((data) => {
          if (gen !== genRef.current) return;
          setChunks((prev) => new Map(prev).set(index, data.rows));
        })
        .catch(() => {
          if (gen === genRef.current) inflightRef.current.delete(index); // allow retry on next scroll
        });
    },
    [api, path, sort]
  );

  // Track viewport scroll + size for virtualization.
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el) setRange({ top: el.scrollTop, height: el.clientHeight });
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !meta?.supported) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta?.supported, measure]);

  const rowCount = meta?.supported ? meta.rowCount : 0;
  const first = Math.max(0, Math.floor(range.top / ROW_H) - OVERSCAN);
  const last = Math.min(rowCount - 1, Math.ceil((range.top + range.height) / ROW_H) + OVERSCAN);

  // Fetch any missing chunks covering the visible range.
  useEffect(() => {
    if (!meta?.supported || rowCount === 0) return;
    for (let c = Math.floor(first / CHUNK); c <= Math.floor(last / CHUNK); c++) {
      if (!chunks.has(c)) loadChunk(c);
    }
  }, [meta, rowCount, first, last, chunks, loadChunk]);

  if (failed) return <p className="p-3 text-xs text-red-400">Could not read parquet file.</p>;
  if (!meta) return <p className="p-3 text-xs text-neutral-600">Reading parquet…</p>;
  if (!meta.supported) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <BinaryCard
            path={path}
            name={name}
            size={size}
            mime={mime}
            downloadable={size <= DOWNLOAD_MAX}
            title="Parquet (no preview)"
            fetchBytes={fetchBytes}
          />
        </div>
        {meta.reason && <p className="px-3 pb-3 text-center text-[11px] text-neutral-600">{meta.reason}</p>}
      </div>
    );
  }

  const cols = meta.columns;
  const w = widths ?? cols.map(() => 120);
  const totalW = GUTTER_W + w.reduce((a, b) => a + b, 0);

  const visible: React.ReactNode[] = [];
  for (let r = first; r <= last; r++) {
    const row = chunks.get(Math.floor(r / CHUNK))?.[r % CHUNK];
    visible.push(
      <div
        key={r}
        className={`absolute flex ${r % 2 === 1 ? "bg-neutral-900/40" : ""}`}
        style={{ top: r * ROW_H, height: ROW_H, width: totalW }}
      >
        <div
          className="sticky left-0 z-[1] flex shrink-0 items-center justify-end border-r border-neutral-800 bg-neutral-950 px-2 text-[10px] text-neutral-600"
          style={{ width: GUTTER_W }}
        >
          {(r + 1).toLocaleString()}
        </div>
        {cols.map((col, i) => (
          <div
            key={col.name}
            className={`flex shrink-0 items-center overflow-hidden border-r border-neutral-800/40 px-2 ${
              NUMERIC.test(col.type) ? "justify-end" : ""
            }`}
            style={{ width: w[i] }}
          >
            {row === undefined ? (
              <span className="h-3 w-2/3 animate-pulse rounded bg-neutral-800/60" />
            ) : (
              <Cell value={row[i]} />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-[11px] text-neutral-500">
        <span>
          {meta.rowCount.toLocaleString()} rows × {cols.length} cols
        </span>
        <span>·</span>
        <span>{fmtSize(size)}</span>
      </div>
      <div ref={scrollRef} onScroll={measure} className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        <div style={{ width: totalW, minWidth: "100%" }}>
          <div className="sticky top-0 z-10 flex border-b border-neutral-800 bg-neutral-900" style={{ height: ROW_H }}>
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-neutral-800 bg-neutral-900"
              style={{ width: GUTTER_W }}
            />
            {cols.map((col, i) => (
              <HeaderCell
                key={col.name}
                name={col.name}
                type={col.type}
                width={w[i]}
                sort={sort}
                sortLoading={sortLoading}
                onSort={setSort}
              />
            ))}
          </div>
          {rowCount === 0 ? (
            <p className="p-3 text-xs text-neutral-600">No rows.</p>
          ) : (
            <div className="relative" style={{ height: rowCount * ROW_H }}>
              {visible}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** Column header. Task 5 renders it inert; Task 6 adds the sort interaction. */
const HeaderCell: React.FC<{
  name: string;
  type: string;
  width: number;
  sort: ParquetSort;
  sortLoading: boolean;
  onSort: (update: (prev: ParquetSort) => ParquetSort) => void;
}> = ({ name, type, width }) => (
  <div
    className="flex shrink-0 items-center gap-1 overflow-hidden border-r border-neutral-800/60 px-2"
    style={{ width }}
  >
    <span className="truncate font-semibold text-neutral-300">{name}</span>
    <span className="truncate text-[10px] text-neutral-600">{type}</span>
  </div>
);

const Cell: React.FC<{ value: unknown }> = ({ value }) => {
  if (value === null) return <span className="italic text-neutral-700">null</span>;
  if (typeof value === "boolean") return <span className="text-neutral-400">{String(value)}</span>;
  return <span className="truncate whitespace-pre text-neutral-300">{String(value)}</span>;
};

/** Column widths from the first window's content — computed once per file. */
function estimateWidths(data: FsParquetResponse): number[] {
  return data.columns.map((col, i) => {
    let chars = col.name.length + col.type.length + 3;
    for (const row of data.rows.slice(0, 50)) {
      const v = row[i];
      const len = v === null || v === undefined ? 4 : String(v).length;
      if (len > chars) chars = len;
    }
    return Math.min(340, Math.max(88, Math.round(chars * 7.2 + 18)));
  });
}
```

- [ ] **Step 2: Wire the dispatcher branch**

In `packages/ui/src/components/files/FilePreview.tsx`, add the import next to `ArchiveViewer` (line 8):

```tsx
import { ParquetViewer } from "./viewers/ParquetViewer";
```

Then insert after the `html` branch (after line 58), **before** the `overCeiling`/`overPreview` computation, so size caps never swallow a parquet file:

```tsx
  // Parquet is windowed from the daemon (no byte fetch) — size caps don't apply.
  if (kind === "parquet") {
    return (
      <>
        <PreviewHeader path={path} name={name} onBack={onBack} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ParquetViewer path={path} name={name} size={size} mime={mime} fetchBytes={fetchBytes} />
        </div>
      </>
    );
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: exits 0. (The `onSort`/`sort`/`sortLoading` props of `HeaderCell` are intentionally unused until Task 6 — destructure only `{ name, type, width }` as shown so no unused-variable diagnostics fire.)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/files/viewers/ParquetViewer.tsx packages/ui/src/components/files/FilePreview.tsx
git commit -m "feat(ui): parquet viewer — virtualized grid with windowed fetching"
```

---

### Task 6: Column sorting in the viewer

**Files:**
- Modify: `packages/ui/src/components/files/viewers/ParquetViewer.tsx` (the `HeaderCell` component only)

**Interfaces:**
- Consumes: `ParquetSort`, the `sort`/`sortLoading`/`onSort` props already threaded through `HeaderCell` in Task 5; server-side `orderBy`/`desc` (Task 3).
- Produces: header click cycles none → asc → desc → none per column; the sorted column shows an arrow (spinner while its first window loads).

- [ ] **Step 1: Replace `HeaderCell` with the interactive version**

Add to the imports at the top of `ParquetViewer.tsx`:

```tsx
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
```

Replace the entire `HeaderCell` component with:

```tsx
/** Column header: click cycles none -> asc -> desc -> none (server-side sort). */
const HeaderCell: React.FC<{
  name: string;
  type: string;
  width: number;
  sort: ParquetSort;
  sortLoading: boolean;
  onSort: (update: (prev: ParquetSort) => ParquetSort) => void;
}> = ({ name, type, width, sort, sortLoading, onSort }) => {
  const active = sort?.column === name;
  return (
    <button
      type="button"
      title={`Sort by ${name}`}
      onClick={() =>
        onSort((prev) => (prev?.column !== name ? { column: name, desc: false } : prev.desc ? null : { column: name, desc: true }))
      }
      className="flex shrink-0 items-center gap-1 overflow-hidden border-r border-neutral-800/60 px-2 text-left hover:bg-neutral-800"
      style={{ width }}
    >
      <span className="truncate font-semibold text-neutral-300">{name}</span>
      <span className="truncate text-[10px] text-neutral-600">{type}</span>
      {active &&
        (sortLoading ? (
          <Loader2 size={10} className="shrink-0 animate-spin text-neutral-400" />
        ) : sort.desc ? (
          <ArrowDown size={10} className="shrink-0 text-neutral-400" />
        ) : (
          <ArrowUp size={10} className="shrink-0 text-neutral-400" />
        ))}
    </button>
  );
};
```

(No other changes: the main component already re-fetches on `sort` change, keeps previous rows mounted until the new window lands, clears chunks via the generation guard, and reverts `sort` to `null` when the server rejects it, e.g. over the 2M-row sort cap.)

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/files/viewers/ParquetViewer.tsx
git commit -m "feat(ui): parquet viewer column sorting"
```

---

### Task 7: Full-stack browser verification (worktree daemon + web SPA)

**Files:** none in the repo (verification only; fixes found here land as follow-up commits).

**Interfaces:**
- Consumes: everything above; the Task 3 worktree at `$SCRATCH/wt` and appdir `$APP=$SCRATCH/appdir`; fixtures in `$APP/workspaces/demo/data/`.
- Produces: screenshots + a pass/fail verdict per check below.

- [ ] **Step 1: Update the worktree to the latest commit and enable HTTP on port 47899**

```bash
git -C "$SCRATCH/wt" checkout --detach "$(git rev-parse HEAD)"
cp .stage/daemon/daemon.json "$APP/daemon/daemon.json"
```

Then edit `$APP/daemon/daemon.json`: change the HTTP port value from `47831` to `47899`, leaving everything else (enabled flag, username, seeded bcrypt hash — the stage password is `123456`) untouched. **Never touch this checkout's own `.stage/` at runtime and never use port 47831.**

- [ ] **Step 2: Start the worktree daemon and the web dev server**

```bash
node --import tsx "$SCRATCH/wt/apps/daemon/src/cli.ts" --appdir "$APP" &   # background
curl -sS http://127.0.0.1:47899/health    # expect {"ok":true}
cd "$SCRATCH/wt" && VITE_ORQUESTER_API_URL=http://127.0.0.1:47899 pnpm --filter @orquester/web exec vite --port 5273 --strictPort &   # background
```

- [ ] **Step 3: Drive the SPA with the agent browser**

Using the `agent_browser_*` tools (load via ToolSearch if needed), open `http://127.0.0.1:5273` and authenticate (stage credentials from the copied daemon.json; password `123456`). If the `demo` workspace / `data` project don't appear in the UI (they were created as bare directories in Task 3), create workspace `demo` and project `data` through the UI, then re-copy the fixtures: `cp "$SCRATCH/fixtures/"*.parquet "$APP/workspaces/demo/data/"`. Open the project's Files tab. Verify each, with a screenshot per item:

1. **basic.parquet** — grid renders: 7 typed column headers (`id INT64` … `tags LIST`), `5,000 rows × 7 cols` info bar, first rows visible, `null` cells dimmed, `big` column shows a long decimal string on row 1 (2^60), `created` shows ISO timestamps.
2. **Scroll** — open `large_zstd.parquet` (100,000 rows), jump the scroll container to the bottom (`agent_browser_eval` setting `scrollTop = el.scrollHeight`); placeholder shimmer rows appear, then row `100,000` renders with data.
3. **Sort** — in `large_zstd.parquet`, click the `rank` header: arrow-up appears, first rows become the smallest ranks; click again: arrow-down, first cell near 1,000,000; click a third time: sort clears back to row 1 = `row-0` order.
4. **Wide file** — open `wide.parquet`: 40 columns, horizontal scroll works inside the pane (the page body does not scroll horizontally), row-number gutter stays pinned while scrolling right.
5. **Failure card** — open `corrupt.parquet`: "Parquet (no preview)" card with a reason line and a working-looking Download button.
6. **Empty file** — open `empty.parquet`: `0 rows × 7 cols` and "No rows."
7. **Console** — no uncaught page errors or console errors during any of the above.

- [ ] **Step 4: Tear down**

Kill the vite dev server and the worktree daemon started in Step 2 (only those). Then remove the worktree:

```bash
git worktree remove --force "$SCRATCH/wt"
```

- [ ] **Step 5: Follow-up fixes**

Any defect found: fix in this checkout, `pnpm check`, commit with a `fix(ui):`/`fix(daemon):` message, and re-run the affected check (repeat Steps 1–3 as needed for server-side fixes; pure-UI fixes only need the vite server restarted against the new code — note vite serves the MAIN checkout's UI only if run from it, so re-run vite from the updated worktree after `git -C "$SCRATCH/wt" checkout --detach $(git rev-parse HEAD)`).

- [ ] **Step 6: Real-world check (optional but recommended)**

If the user's `topcharts_parquet` files are reachable inside a served workspace of the LIVE instance, ask the user to click one after the next deploy — do NOT restart or redeploy the live daemon yourself.
