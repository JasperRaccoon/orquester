import React from "react";
import { Clock } from "lucide-react";
import { cn } from "../../lib/cn";
import type { AgentUsage } from "@orquester/api";
import type { UsageResetFormat } from "../../lib/usage-display";
import { barClass, formatReset, formatUsageCapacity, normalizeUsageWindows, type NormalizedUsageWindow } from "./usage-format";

/**
 * Side-by-side columns per window count, from `sm` up (stacked below). Static
 * strings so Tailwind sees every class; four or more windows wrap at three.
 * The `nth-child` rule drops the divider on the first cell of each row.
 */
const GRID_COLS: Record<number, string> = {
  2: "sm:grid-cols-2 sm:[&>*:nth-child(2n+1)]:border-l-0 sm:[&>*:nth-child(2n+1)]:pl-0",
  3: "sm:grid-cols-3 sm:[&>*:nth-child(3n+1)]:border-l-0 sm:[&>*:nth-child(3n+1)]:pl-0"
};

/** The most windows any one card of this agent lays side by side (1–3). */
export function maxWindowCount(agent: AgentUsage): number {
  const sources = [agent, ...(agent.accounts ?? []), ...(agent.system ? [agent.system] : [])];
  return Math.max(1, ...sources.map((s) => Math.min(3, normalizeUsageWindows(agent.id, s).length)));
}

const Meter: React.FC<{ pct: number; muted: boolean; className?: string }> = ({ pct, muted, className }) => (
  <div className={cn("h-1.5 overflow-hidden rounded-full bg-neutral-800", className)}>
    <div
      className={cn("h-full rounded-full transition-[width] duration-500", muted ? "bg-neutral-600" : barClass(pct))}
      style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
    />
  </div>
);

/**
 * One window. In a multi-window row the percent sits beside the bar so each
 * narrow column reads label → bar → reset; a lone window spans the card and
 * puts the percent on the label line instead.
 */
const WindowCell: React.FC<{
  window: NormalizedUsageWindow;
  long: boolean;
  lone: boolean;
  muted: boolean;
  resetFormat: UsageResetFormat;
  now: number;
}> = ({ window, long, lone, muted, resetFormat, now }) => {
  const label = long ? window.longLabel : window.label;
  const pct = (
    <span
      className={cn(
        "shrink-0 text-right text-xs font-medium tabular-nums",
        muted ? "text-neutral-500" : "text-neutral-100"
      )}
    >
      {Math.round(window.percent)}%
    </span>
  );
  const capacity = formatUsageCapacity(window);
  const reset = formatReset(window.resetsAt, resetFormat, now);
  return (
    <div className="min-w-0 border-neutral-800/70 sm:border-l sm:pl-3">
      {lone ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-neutral-300">{label}</span>
            {pct}
          </div>
          <Meter pct={window.percent} muted={muted} className="mt-1.5" />
        </>
      ) : (
        <>
          <p className="truncate text-xs text-neutral-300">{label}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <Meter pct={window.percent} muted={muted} className="flex-1" />
            {pct}
          </div>
        </>
      )}
      {/* Both lines are omitted rather than rendered empty — a window with no
          absolute numbers and no reset time must not leave a gap under its bar. */}
      {capacity && <p className="mt-1 truncate text-[11px] tabular-nums text-neutral-400">{capacity}</p>}
      {reset && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-4 text-neutral-500">
          <Clock size={11} className="mt-[2.5px] shrink-0" aria-hidden />
          <span className="min-w-0 tabular-nums">{reset}</span>
        </p>
      )}
    </div>
  );
};

/** A row of windows side by side, divided by hairlines. */
export const UsageWindowGrid: React.FC<{
  windows: NormalizedUsageWindow[];
  muted: boolean;
  resetFormat: UsageResetFormat;
  now: number;
  /** Spelled-out labels ("Session (5h)") instead of the compact "5h". */
  long?: boolean;
}> = ({ windows, muted, resetFormat, now, long = false }) => (
  <div
    className={cn(
      "grid grid-cols-1 gap-x-3 gap-y-3 [&>*:first-child]:border-l-0 [&>*:first-child]:pl-0",
      GRID_COLS[Math.min(windows.length, 3)]
    )}
  >
    {windows.map((w) => (
      <WindowCell
        key={w.id}
        window={w}
        long={long}
        lone={windows.length === 1}
        muted={muted}
        resetFormat={resetFormat}
        now={now}
      />
    ))}
  </div>
);

/**
 * One login's quota card, shared by the top-bar panel and Settings → Usage:
 * name and plan over a hairline, then its windows side by side. `name` is
 * optional so a pooled agent without per-account rows uses the same chrome.
 */
export const UsageAccountCard: React.FC<{
  name?: React.ReactNode;
  /** Right side of the name row: plan, Stale badge. */
  meta?: React.ReactNode;
  windows: NormalizedUsageWindow[];
  muted: boolean;
  resetFormat: UsageResetFormat;
  now: number;
  long?: boolean;
}> = ({ name, meta, windows, muted, resetFormat, now, long }) => (
  <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
    {name != null && (
      <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-neutral-800/70 pb-2">
        <p className="min-w-0 truncate text-[13px] font-medium text-neutral-100">{name}</p>
        {meta && <div className="flex shrink-0 items-center gap-1">{meta}</div>}
      </div>
    )}
    {windows.length > 0 ? (
      <UsageWindowGrid windows={windows} muted={muted} resetFormat={resetFormat} now={now} long={long} />
    ) : (
      <p className="text-[11px] text-neutral-500">No reading yet.</p>
    )}
  </div>
);
