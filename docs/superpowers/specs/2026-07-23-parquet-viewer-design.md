# Parquet Viewer — Design

**Date:** 2026-07-23
**Status:** Approved design, pending implementation plan

## Summary

Add a fast, spreadsheet-like parquet viewer to the file browser preview pane. Today a
`.parquet` file falls through the extension map to the text path, trips the NUL-byte guard,
and renders the "Binary file" download card. Instead, the daemon reads the file with
**hyparquet** (pure-JS, random-access) and serves schema + row windows as JSON; the shared
UI renders them in a custom virtualized grid with server-side column sorting.

Architecture decision (from brainstorm): **daemon-side parsing**, not client-side, because:

- `/api/fs/raw` is whole-file, in-memory, capped at 50 MB, with no Range support on any
  transport — client-side parsing of large files would need new plumbing across three
  transports.
- The production Caddy CSP (`script-src 'self'`) blocks WebAssembly in the web client;
  daemon-side parsing needs no CSP change and behaves identically on web and desktop.
- A parsing dep in `packages/ui` would land eagerly in both clients' bundles (no lazy
  boundaries exist today). Daemon-side keeps both bundles unchanged.
- hyparquet in Node (`asyncBufferFromFile`) reads only the footer + touched row groups —
  bounded memory, no file-size cap, ~5–20 ms for a first window on small files.

V1 scope: **view + scroll + sort**. Not in v1: filters, SQL/DuckDB query mode, manual
column resize, multi-file views. The endpoint shape leaves room for these later.

## 1. Daemon

### Dependencies

Add to `apps/daemon/package.json`:

- `hyparquet` (^1.26) — pure ESM JS, zero deps, MIT. Runs under tsx as-is.
- `hyparquet-compressors` (^1.1) — codec map (ZSTD/gzip/brotli/LZ4; snappy fast path).
  Must be passed as `compressors` into every read call or non-snappy files fail.

No native addons, no build step, no deploy changes beyond `pnpm install`.

### New module `apps/daemon/src/parquet.ts`

Mirrors `archive.ts`'s contract: a single exported async function that never throws for
data-level problems — it returns `{ supported: false, reason }` for corrupt files,
unsupported codecs, or any parse error. Only sandbox violations and missing files are
handled by the route as HTTP errors.

Responsibilities:

- Open via `asyncBufferFromFile(path)` (random access; never loads the whole file).
- Read metadata once per request: row count, column names, human-readable types
  (e.g. `INT64`, `STRING`, `TIMESTAMP`, `LIST<…>`), derived from the parquet schema.
- Read one row window with `parquetReadObjects({ rowStart, rowEnd, compressors })`, or
  `parquetQuery({ orderBy, … })` when sorting.
- **Sort cache:** a module-level single-slot cache of the sorted row order keyed by
  `(realpath, mtimeMs, column, direction)`. First sorted request pays the column scan;
  subsequent windows under the same sort reuse the cached order. Any key mismatch
  (different file, file modified, different sort) evicts and recomputes. Unsorted
  requests bypass the cache entirely.
- **Cell serialization** (rows must be JSON-safe):
  - `bigint` → `Number(v)` when within `Number.MAX_SAFE_INTEGER`, else decimal string.
  - `Date` → ISO 8601 string.
  - Byte arrays → `0x…` hex preview, truncated.
  - Nested lists/structs/maps → compact `JSON.stringify` preview.
  - `null`/`undefined` → `null`.
  - All string forms capped at ~500 chars (`…` suffix) so one huge cell can't bloat
    the payload.

### Route `GET /api/fs/parquet`

Registered in `createServer()` next to `/api/fs/archive` (`apps/daemon/src/index.ts:1338`),
on both transports, standard bearer auth on remote (no `?token=` — it's fetched via normal
`ApiClient.send`).

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `path` | string | required | validated via `assertInsideFsRoot`; `FsSandboxError` → 403 `FS_FORBIDDEN` |
| `offset` | int ≥ 0 | 0 | first row of the window; clamped to `[0, rowCount]` |
| `limit` | int | 200 | clamped to `[1, 1000]` |
| `orderBy` | string | — | column name; unknown column → 400 `FS_ERROR` |
| `desc` | `"1"`/absent | absent | descending when present with `orderBy` |

Missing file / not a file → 404/400 as the sibling fs routes do. Everything data-level
→ 200 with `supported: false`.

## 2. Wire contract (`packages/api/src/index.ts`)

Next to `FsArchiveResponse`:

```ts
export interface ParquetColumn {
  name: string;
  type: string; // human-readable physical/logical type, e.g. "INT64", "STRING"
}

export interface FsParquetResponse {
  supported: boolean;
  rowCount: number;
  columns: ParquetColumn[];
  rows: unknown[][]; // window of rows, positional per `columns`
  offset: number;    // echo of the effective (clamped) offset
  reason?: string;   // why unsupported, when supported is false
}
```

`packages/ui/src/lib/api-client.ts` gains, beside `listArchive`:

```ts
readParquet(path, opts?: { offset?; limit?; orderBy?; desc? }, signal?): Promise<FsParquetResponse>
```

## 3. UI wiring

- `packages/ui/src/lib/file-kind.ts`: add `parquet: { kind: "parquet", mime: "application/vnd.apache.parquet" }`
  to `BY_EXT`, extend the `FileKind` union, and set `PREVIEW_CAP_BY_KIND.parquet` to
  `Infinity` — the viewer never fetches the file's bytes, so size is no barrier.
  In `FilePreview.tsx`, route the `parquet` kind **before** the `overCeiling`
  (`DOWNLOAD_MAX_BYTES`) and `overPreview` checks so a large parquet file isn't
  swallowed by the "Too large to preview" card.
- `packages/ui/src/components/files/FilePreview.tsx`: new branch → `ParquetViewer`.
- No new dependencies in `packages/ui`; both client bundles unchanged.

## 4. `ParquetViewer` (`packages/ui/src/components/files/viewers/ParquetViewer.tsx`)

Custom hand-rolled virtualized grid, Tailwind-styled to match the file browser's dark
theme. No external table library.

- **Header bar:** filename, `N rows × M cols`, human file size.
- **Column header row (sticky):** column name + dimmed type label. Click cycles sort
  none → asc → desc → none (server-side). While the first window of a new sort loads,
  the header shows a small spinner; the previous rows stay visible (no layout flash).
- **Virtualized body:** fixed row height (~28 px), top/bottom spacer technique, renders
  only visible rows + overscan (~20). Horizontal scroll inside the pane for wide
  schemas. Numbered row-index gutter (sticky left).
- **Data flow:** initial mount fires one `readParquet(path, { offset: 0, limit: 200 })`
  — schema + first rows in a single round-trip. Scrolling computes the visible row
  range and fetches missing 200-row chunks on demand into a sparse client-side cache
  (`Map<chunkIndex, rows>`), with in-flight dedup and `AbortController` cleanup on
  unmount/path change. Sort change clears the cache and refetches from the top.
  Unfetched visible rows render as dimmed placeholder cells.
- **Cells:** monospace, right-aligned for numeric column types, dimmed italic `null`,
  single-line with ellipsis overflow. Column widths estimated once from the first
  window's content (clamped min/max); no manual resize in v1.
- **Failure card:** `supported: false` → the existing `BinaryCard` with
  `title="Parquet (no preview)"`, the `reason`, and the Download button — same pattern
  as archives without a host tool. Fetch errors show the standard error text with retry
  on remount.

## 5. Verification

No test runner exists in this repo; done means:

1. `pnpm check` clean.
2. Generate parquet fixtures (snappy + zstd codecs; columns covering INT64, DOUBLE,
   STRING, TIMESTAMP, BOOLEAN, nulls, and a nested LIST) and exercise
   `GET /api/fs/parquet` directly: schema correctness, window clamping, offset paging,
   `orderBy` asc/desc, unknown-column 400, corrupt-file `supported:false`.
3. Drive the SPA with the agent browser against a **separate dev daemon checkout**
   (never the live daemon serving this workspace): open a `.parquet`, verify first
   paint, scroll to the bottom of a many-row file, toggle sorts, check a wide file's
   horizontal scroll.
4. Real-world check against the user's `topcharts_parquet` files.

## Future (explicitly deferred)

- Per-column filters (endpoint grows `filter` params; hyparquet `parquetQuery` supports it).
- SQL query mode via `@duckdb/node-api` (prebuilt linux-x64 binary, warm instance) if
  sort/filter ever needs real pushdown or aggregates.
- Manual column resize, column show/hide for very wide schemas.
- Arrow IPC on the wire if windows ever grow far beyond 1000 rows.
