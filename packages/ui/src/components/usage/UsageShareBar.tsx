import React from "react";

import type { UsageTokenTotals } from "@orquester/api";

import { formatPercent } from "../../lib/usage-history-format";
import type { UsageCostBySpeed, UsageCostByType } from "./usage-view.logic";

export interface ShareSegment {
  label: string;
  value: number;
  color: string;
}

/**
 * Monochrome ink: the foreground mixed into the page at `percent`. Types and speeds stay
 * grey so hue is left to the agents, and the neutral scale flips with the mode.
 */
const ink = (percent: number) => `color-mix(in oklab, rgb(var(--n-50)) ${percent}%, rgb(var(--n-950)))`;

const TYPE_COLORS = { input: ink(62), cacheRead: ink(28), cacheWrite: ink(76), output: ink(100), other: ink(45) };

export function tokenTypeSegments(t: UsageTokenTotals): ShareSegment[] {
  return [
    { label: "Input", value: t.input, color: TYPE_COLORS.input },
    { label: "Cache read", value: t.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: t.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: t.output, color: TYPE_COLORS.output }
  ];
}

export function costTypeSegments(c: UsageCostByType): ShareSegment[] {
  return [
    { label: "Input", value: c.input, color: TYPE_COLORS.input },
    { label: "Cache read", value: c.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: c.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: c.output, color: TYPE_COLORS.output },
    { label: "Other", value: c.other, color: TYPE_COLORS.other }
  ];
}

export function speedCostSegments(c: UsageCostBySpeed): ShareSegment[] {
  return [
    { label: "Standard", value: c.standard, color: ink(34) },
    { label: "Fast", value: c.fast, color: ink(68) },
    { label: "Ultrafast", value: c.ultrafast, color: ink(100) }
  ];
}

/** A labelled, segmented proportion bar with a legend; nothing when every segment is zero. */
export const UsageShareBar: React.FC<{
  label: string;
  segments: readonly ShareSegment[];
  format: (value: number) => string;
  aside?: React.ReactNode;
}> = ({ label, segments, format, aside }) => {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-neutral-100">{label}</h3>
        {aside}
      </div>
      <div
        role="img"
        aria-label={`${label}: ${visible.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`}
        className="flex h-2 gap-0.5"
      >
        {visible.map((s) => (
          <div
            key={s.label}
            title={`${s.label} · ${format(s.value)} · ${formatPercent(s.value / total)}`}
            className="h-full min-w-1 rounded-[2px] first:rounded-l-full last:rounded-r-full"
            style={{ flex: `${s.value} 1 0`, backgroundColor: s.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {visible.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: s.color }} />
            <span className="text-neutral-400">{s.label}</span>
            <span className="tabular-nums text-neutral-200">{format(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
};
