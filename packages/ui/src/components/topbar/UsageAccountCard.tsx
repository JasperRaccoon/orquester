import React from "react";
import { Clock, Gauge, TrendingDown, TrendingUp } from "lucide-react";
import { useElementWidth } from "../../hooks/use-element-width";
import { cn } from "../../lib/cn";
import type { AgentUsage } from "@orquester/api";
import type { UsageResetFormat } from "../../lib/usage-display";
import { LoginExpiryWarning } from "../auth/LoginExpiryWarning";
import type { LoginStatus } from "../../lib/login-expiry";
import { barClass, formatAgo, formatReset, formatUsageCapacity, normalizeUsageWindows, type NormalizedUsageWindow } from "./usage-format";
import { usagePace, type UsagePace, type UsagePaceStatus } from "./usage-pace";

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
  return Math.max(1, ...sources.map((s) => Math.min(3, normalizeUsageWindows(agent.id, s.lastKnown ?? s).length)));
}

/** A bar narrower than this (px) has no room for a readable pace tick. */
const fitsPaceTick = (width: number) => width >= 24;

/** The even-spend mark: a 2px stroke over the bar where the window's elapsed time sits. */
const PaceTick: React.FC<{ elapsed: number }> = ({ elapsed }) => {
  const [ref, fits] = useElementWidth<HTMLSpanElement, boolean>(fitsPaceTick);
  return (
    <span ref={ref} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1.5">
      {fits !== false && (
        <span
          className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-neutral-100 ring-1 ring-neutral-900"
          style={{ left: `clamp(1px, ${(elapsed * 100).toFixed(2)}%, calc(100% - 1px))` }}
        />
      )}
    </span>
  );
};

const Meter: React.FC<{ pct: number; muted: boolean; className?: string; pace?: UsagePace | null }> = ({
  pct,
  muted,
  className,
  pace
}) => (
  <div
    className={cn("relative", className)}
    title={pace ? `${Math.round(pct)}% used, ${Math.round(pace.elapsed * 100)}% of the window passed: ${pace.label}` : undefined}
  >
    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", muted ? "bg-neutral-600" : barClass(pct))}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
    {pace && <PaceTick elapsed={pace.elapsed} />}
  </div>
);

const PACE_ICON: Record<UsagePaceStatus, typeof Gauge> = { ahead: TrendingUp, on: Gauge, under: TrendingDown };

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
  historical?: boolean;
  showPace?: boolean;
}> = ({ window, long, lone, muted, resetFormat, now, historical, showPace }) => {
  // A muted or last-known reading is old or empty: its pace against the clock would be fiction.
  const pace = showPace && !muted && !historical ? usagePace(window, now) : null;
  const PaceIcon = pace ? PACE_ICON[pace.status] : null;
  const label = long ? (historical && window.id === "weekly" ? "Weekly" : window.longLabel) : window.label;
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
  const reset = historical && window.resetsAt && Date.parse(window.resetsAt) <= now
    ? `Reset ${new Date(window.resetsAt).toLocaleString()}`
    : formatReset(window.resetsAt, resetFormat, now);
  return (
    <div className="min-w-0 border-neutral-800/70 sm:border-l sm:pl-3">
      {lone ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-neutral-300">{label}</span>
            {pct}
          </div>
          <Meter pct={window.percent} muted={muted} className="mt-1.5" pace={pace} />
        </>
      ) : (
        <>
          <p className="truncate text-xs text-neutral-300">{label}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <Meter pct={window.percent} muted={muted} className="flex-1" pace={pace} />
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
      {pace && PaceIcon && (
        <p
          className={cn(
            "mt-1 flex items-center gap-1 text-[11px] leading-4",
            pace.status === "ahead" ? "text-warn" : "text-neutral-500"
          )}
        >
          <PaceIcon size={11} className="shrink-0" aria-hidden />
          <span className="min-w-0">{pace.label}</span>
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
  historical?: boolean;
  /** Mark each bar's even-spend position and label the pace (the Usage view's Limits tab). */
  showPace?: boolean;
}> = ({ windows, muted, resetFormat, now, long = false, historical, showPace }) => (
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
        historical={historical}
        showPace={showPace}
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
  login?: LoginStatus;
  lastKnown?: boolean;
  asOf?: string;
  showPace?: boolean;
}> = ({ name, meta, windows, muted, resetFormat, now, long, login, lastKnown, asOf, showPace }) => (
  <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
    {name != null && (
      <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-neutral-800/70 pb-2">
        <p className="min-w-0 truncate text-[13px] font-medium text-neutral-100">{name}</p>
        {meta && <div className="flex shrink-0 items-center gap-1">{meta}</div>}
      </div>
    )}
    {login && <LoginExpiryWarning login={login} now={now} className="mb-2" />}
    {lastKnown && windows.length > 0 && (
      <p className="mb-2 text-[11px] text-warn" title={asOf ? new Date(asOf).toLocaleString() : undefined}>
        Last known usage{asOf ? ` · ${formatAgo(asOf, now)}` : ""}
      </p>
    )}
    {windows.length > 0 ? (
      <UsageWindowGrid
        windows={windows}
        muted={muted}
        resetFormat={resetFormat}
        now={now}
        long={long}
        historical={lastKnown}
        showPace={showPace}
      />
    ) : (
      <p className="text-[11px] text-neutral-500">No reading yet.</p>
    )}
  </div>
);
