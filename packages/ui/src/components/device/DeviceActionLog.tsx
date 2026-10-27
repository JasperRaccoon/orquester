/**
 * The action log drawer under the device (spec §10.1): timestamped agent and user actions, failures
 * in red, collapsible (its open state persists per browser), and windowed once it is long.
 */

import React from "react";
import { ChevronUp, ListTree } from "lucide-react";

import { cn } from "../../lib/cn";
import { actionLogHeadline, visibleRange, type ActionLogRow } from "./action-log.logic";

const ROW_HEIGHT = 26;
/** Below this many rows the list renders whole. */
const WINDOW_FROM = 60;

function Row({ row, style }: { row: ActionLogRow; style?: React.CSSProperties }) {
  return (
    <li
      style={style}
      className="flex h-[26px] items-center gap-2 px-3 text-[12px] leading-5"
      title={row.error ? `${row.text} — ${row.error}` : row.text}
      data-actor={row.actor}
      data-failed={row.failed || undefined}
    >
      <span className="w-[52px] shrink-0 font-mono text-[10.5px] tabular-nums text-neutral-500">{row.time}</span>
      <span
        className={cn(
          "w-12 shrink-0 truncate text-[11px]",
          row.actor === "agent" ? "text-warn" : "text-info"
        )}
      >
        {row.who}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", row.failed ? "text-danger" : "text-neutral-300")}>{row.text}</span>
      {row.failed ? <span className="max-w-[40%] shrink-0 truncate text-[11px] text-danger/80">{row.error}</span> : null}
    </li>
  );
}

export function DeviceActionLog(props: {
  rows: readonly ActionLogRow[];
  open: boolean;
  onToggle: () => void;
  loading?: boolean;
  error?: string | null;
  /** Taller on a phone section. */
  maxHeight?: number;
}): React.ReactElement {
  const { rows, open } = props;
  const { count, last } = actionLogHeadline(rows);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = React.useState({ top: 0, height: 180 });
  const stick = React.useRef(true);
  const maxHeight = props.maxHeight ?? 184;

  // New rows keep the list pinned to the bottom unless the user scrolled up.
  React.useLayoutEffect(() => {
    const node = listRef.current;
    if (!open || !node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
    setScroll({ top: node.scrollTop, height: node.clientHeight });
  }, [rows.length, open]);

  const windowed = rows.length > WINDOW_FROM;
  const range = windowed ? visibleRange(scroll.top, scroll.height, ROW_HEIGHT, rows.length) : { start: 0, end: rows.length };

  return (
    <section className="shrink-0 border-t border-neutral-800/80 bg-neutral-950/60" aria-label="Device actions">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] text-neutral-400 transition-colors hover:bg-neutral-900/70 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        <ListTree size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
        <span className="shrink-0 font-medium text-neutral-300">Activity</span>
        <span className="shrink-0 text-neutral-600">·</span>
        <span className="shrink-0 tabular-nums text-neutral-500">{count}</span>
        {last && !open ? (
          <span className={cn("min-w-0 flex-1 truncate", last.failed ? "text-danger" : "text-neutral-500")}>
            — {last.who === "You" ? "You: " : ""}
            {last.text}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronUp size={14} strokeWidth={1.8} aria-hidden className={cn("shrink-0 transition-transform motion-reduce:transition-none", !open && "rotate-180")} />
      </button>
      {open ? (
        <div
          ref={listRef}
          className="ac-scroll-thin overflow-y-auto pb-1"
          style={{ maxHeight: `min(${maxHeight}px, 28vh)` }}
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
            if (windowed) setScroll({ top: node.scrollTop, height: node.clientHeight });
          }}
        >
          {rows.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-neutral-500">
              {props.loading ? "Loading…" : props.error ? props.error : "Nothing yet. The agent's taps, typing and screenshots show here, and so do yours."}
            </p>
          ) : windowed ? (
            <ul className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
              {rows.slice(range.start, range.end).map((row, index) => (
                <Row key={row.id} row={row} style={{ position: "absolute", left: 0, right: 0, top: (range.start + index) * ROW_HEIGHT }} />
              ))}
            </ul>
          ) : (
            <ul>
              {rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
