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

/** Single-slot cache of one decompressed row group. A sort permutation scatters
 *  indices, but they still land in a handful of row groups; caching the last one
 *  we decompressed means scrolling/paging under a warm sort reuses it instead of
 *  re-decompressing per scattered index. Keyed by (path, mtime, rowGroupIndex). */
interface RowGroupSlot {
  path: string;
  mtimeMs: number;
  groupIndex: number;
  rows: Record<string, unknown>[];
}
let rowGroupSlot: RowGroupSlot | null = null;

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
      const { mtimeMs } = await stat(absPath);
      const order = await sortedOrder(absPath, mtimeMs, file, metadata, rowCount, orderBy, opts.desc ?? false);
      const indices = Array.from(order.subarray(offset, Math.min(offset + limit, rowCount)));
      raw = await readRowsByIndex(absPath, mtimeMs, file, metadata, indices);
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
  mtimeMs: number,
  file: Parameters<typeof parquetReadObjects>[0]["file"],
  metadata: Parameters<typeof parquetReadObjects>[0]["metadata"],
  rowCount: number,
  column: string,
  desc: boolean
): Promise<Uint32Array> {
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

/** Fetch scattered row indices by decompressing whole row groups.
 *
 *  A sort permutation scatters indices across a row group, so the naive
 *  "one read per contiguous run" approach issues ~limit separate reads that
 *  each re-decompress the *entire* row group — catastrophic on the common
 *  single-row-group file (a windowed sorted fetch took ~40s and never cached).
 *  Instead we bucket the window's indices by row group and decompress each
 *  touched group at most once, extract only the ~limit rows we actually need
 *  out of it, then drop the group before moving to the next — so peak memory is
 *  O(one row group + limit rows), never O(all touched groups) even when a
 *  scattered window touches every group of a multi-GB file. The last group
 *  decompressed is retained across calls (single-slot cache keyed by
 *  path/mtime/group), so scrolling/paging a contiguous sorted window — which
 *  lands mostly in one group — reuses it and is near-free. */
async function readRowsByIndex(
  absPath: string,
  mtimeMs: number,
  file: Parameters<typeof parquetReadObjects>[0]["file"],
  metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>,
  indices: number[]
): Promise<Record<string, unknown>[]> {
  // Cumulative row offsets so a row index maps to its row group.
  const bounds: { start: number; end: number }[] = [];
  let acc = 0;
  for (const g of metadata.row_groups) {
    const n = Number(g.num_rows);
    bounds.push({ start: acc, end: acc + n });
    acc += n;
  }
  const groupOf = (row: number): number => {
    for (let gi = 0; gi < bounds.length; gi++) if (row < bounds[gi].end) return gi;
    return bounds.length - 1;
  };
  // Bucket the requested indices by their row group so each group is
  // decompressed exactly once regardless of how the sort scattered them.
  const byGroup = new Map<number, number[]>();
  for (const row of indices) {
    const gi = groupOf(row);
    const list = byGroup.get(gi);
    if (list) list.push(row);
    else byGroup.set(gi, [row]);
  }
  // At most one full group in flight at a time, plus the cross-call cached group
  // seeded here (reused without decompressing when it's one we need).
  const seed =
    rowGroupSlot && rowGroupSlot.path === absPath && rowGroupSlot.mtimeMs === mtimeMs ? rowGroupSlot : null;
  const result = new Map<number, Record<string, unknown>>();
  let lastRows: Record<string, unknown>[] | null = null;
  let lastGi = -1;
  for (const [gi, rows] of byGroup) {
    const groupRows =
      seed && seed.groupIndex === gi
        ? seed.rows
        : await parquetReadObjects({
            file,
            metadata,
            rowStart: bounds[gi].start,
            rowEnd: bounds[gi].end,
            compressors
          });
    // Keep only the rows we need; the rest of `groupRows` becomes collectable
    // once it goes out of scope on the next iteration (except the cached one).
    for (const row of rows) result.set(row, groupRows[row - bounds[gi].start]);
    lastRows = groupRows;
    lastGi = gi;
  }
  if (lastGi >= 0 && lastRows) {
    rowGroupSlot = { path: absPath, mtimeMs, groupIndex: lastGi, rows: lastRows };
  }
  return indices.map((row) => result.get(row)!);
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
