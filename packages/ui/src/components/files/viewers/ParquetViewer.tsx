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
