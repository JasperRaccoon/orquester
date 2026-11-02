import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getRegistryIcon } from "../../icons/registry-icons";
import { cn } from "../../lib/cn";
import { agentColor, formatPeriod, formatPeriodLong } from "../../lib/usage-history-format";
import { labelForAgent } from "../topbar/usage-format";
import {
  buildChart,
  CHART_HEIGHT,
  CHART_TOP,
  CHART_WIDTH,
  nearestPeriod,
  tooltipPosition,
  valueToY
} from "./usage-chart.logic";
import type { UsageSeries } from "./usage-view.logic";

export interface UsageChartProps {
  periods: readonly string[];
  resolution: "hour" | "day";
  timeZone: string;
  /** One per agent, in the order the tooltip lists them. */
  series: readonly UsageSeries[];
  format: (value: number) => string;
  /** A y-axis label given the tick step (its decimals follow the step); `format` when absent. */
  formatTick?: (value: number, step: number) => string;
  ariaLabel: string;
  /** The plot's height class (the y gutter follows it). */
  heightClass?: string;
}

/**
 * Overlaid per-agent trend: a monotone curve with a faint fill per agent, horizontal
 * gridlines on a nice scale, and a hover readout that snaps to the nearest period.
 */
export const UsageChart: React.FC<UsageChartProps> = ({
  periods,
  resolution,
  timeZone,
  series,
  format,
  formatTick,
  ariaLabel,
  heightClass = "h-56"
}) => {
  const chart = useMemo(
    () => buildChart(series.map((s) => ({ id: s.agent, values: s.values })), periods.length),
    [series, periods.length]
  );
  const { scale, stepX, paths } = chart;
  const middle = Math.floor(periods.length / 2);
  const xLabels =
    periods.length === 0
      ? []
      : periods.length < 3
        ? [...periods]
        : [periods[0]!, periods[middle]!, periods[periods.length - 1]!];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex gap-2">
        <div aria-hidden className={cn("relative w-12 shrink-0 sm:w-14", heightClass)}>
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 whitespace-nowrap text-[10px] tabular-nums text-neutral-500"
              style={{ top: `${(valueToY(tick, scale.max) / CHART_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : formatTick ? formatTick(tick, scale.step) : format(tick)}
            </span>
          ))}
        </div>
        <ChartPlot
          periods={periods}
          resolution={resolution}
          timeZone={timeZone}
          series={series}
          stepX={stepX}
          format={format}
          ariaLabel={ariaLabel}
          heightClass={heightClass}
        >
          {scale.ticks.map((tick) => {
            const y = valueToY(tick, scale.max);
            return (
              <line
                key={tick}
                x1={0}
                x2={CHART_WIDTH}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-neutral-800"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {paths.map((p) => (
            <path key={`area:${p.id}`} d={p.area} fill={agentColor(p.id)} fillOpacity={0.12} />
          ))}
          {paths.map((p) => (
            <path
              key={`line:${p.id}`}
              d={p.line}
              fill="none"
              stroke={agentColor(p.id)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </ChartPlot>
      </div>
      <div
        aria-hidden
        className="flex justify-between pl-14 text-[10px] uppercase tracking-wide tabular-nums text-neutral-500 sm:pl-16"
      >
        {xLabels.map((p, i) => (
          <span key={`${i}:${p}`}>{formatPeriod(p, resolution, timeZone)}</span>
        ))}
      </div>
    </div>
  );
};

const ChartPlot: React.FC<{
  periods: readonly string[];
  resolution: "hour" | "day";
  timeZone: string;
  series: readonly UsageSeries[];
  stepX: number;
  format: (value: number) => string;
  ariaLabel: string;
  heightClass: string;
  children: React.ReactNode;
}> = ({ periods, resolution, timeZone, series, stepX, format, ariaLabel, heightClass, children }) => {
  // The hovered period only changes when the pointer crosses into another one; the
  // tooltip's position follows the pointer through CSS variables, without a render.
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const place = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const pointer = pointerRef.current;
    if (!plot || !tooltip || !pointer) return;
    const at = tooltipPosition(
      pointer,
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      { width: plot.clientWidth, height: plot.clientHeight }
    );
    plot.style.setProperty("--usage-tip-x", `${at.x}px`);
    plot.style.setProperty("--usage-tip-y", `${at.y}px`);
  }, []);

  useLayoutEffect(() => {
    if (hover === null) return undefined;
    place();
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (!plot || !tooltip || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hover, place]);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (!plot || periods.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const y = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    pointerRef.current = { x, y };
    place();
    setHover(nearestPeriod(x / bounds.width, periods.length));
  };
  const onPointerLeave = () => {
    pointerRef.current = null;
    setHover(null);
  };

  const hovered = hover === null ? undefined : periods[hover];
  const hoverX = hover === null ? 0 : periods.length < 2 ? CHART_WIDTH / 2 : hover * stepX;
  const total = hover === null ? 0 : series.reduce((sum, s) => sum + (s.values[hover] ?? 0), 0);

  return (
    <div
      ref={plotRef}
      className={cn("relative min-w-0 flex-1 touch-pan-y", heightClass)}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <svg
        className="h-full w-full overflow-visible"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        {children}
        {hover === null ? null : (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={CHART_TOP}
            y2={CHART_HEIGHT}
            stroke="currentColor"
            strokeWidth={1}
            className="text-neutral-500"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hover === null || hovered === undefined ? null : (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute left-0 top-0 z-10 min-w-[9.5rem] max-w-full rounded-lg border border-neutral-700/70 bg-neutral-900/95 px-2.5 py-2 text-xs shadow-lg backdrop-blur"
          style={{ transform: "translate(var(--usage-tip-x, 0px), var(--usage-tip-y, 0px))" }}
        >
          <div className="mb-1 text-neutral-400">{formatPeriodLong(hovered, resolution, timeZone)}</div>
          {series.map((s) => (
            <div key={s.agent} className="flex items-center justify-between gap-4">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-neutral-400">
                <span className="shrink-0">{getRegistryIcon("agent", s.agent, 12)}</span>
                <span className="truncate">{labelForAgent(s.agent)}</span>
              </span>
              <span className="tabular-nums text-neutral-100">{format(s.values[hover] ?? 0)}</span>
            </div>
          ))}
          {series.length > 1 ? (
            <div className="mt-1 flex items-center justify-between gap-4 border-t border-neutral-800 pt-1">
              <span className="text-neutral-400">Total</span>
              <span className="tabular-nums text-neutral-100">{format(total)}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
