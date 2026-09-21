import React from "react";
import { cn } from "../../../lib/cn";
import { clampMeterPercent, isMeterOverloaded, meterDashOffset } from "./meter";

export interface MeterRingProps {
  /**
   * 0–100, or `null` when the provider does not report a context window. A
   * `null` ring draws its track only — never a guessed arc.
   */
  value: number | null;
  /** Outer box in px. 20 matches T3's meter inside a 28px trigger. */
  size?: number;
  label?: string;
  className?: string;
}

/** T3's ring geometry, in a 24-unit viewBox. */
const VIEW_BOX = 24;
const RADIUS = 9.75;
const STROKE = 3;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The context-window ring.
 *
 * A ring rather than a bar because it lives inline in the composer's control
 * row, where a bar would either be too short to read or steal the width the
 * controls need. Rotated -90° so it fills clockwise from twelve o'clock, and
 * `strokeLinecap="round"` so a 2% arc is still a visible mark rather than a
 * hairline.
 *
 * Over 90% the arc turns destructive — the one place in the chat UI where a
 * colour change is a *threshold*, not a state, so it must be abrupt.
 * *T3: apps/web/src/components/chat/ContextWindowMeter.tsx:26-80*
 *
 * The 500ms `ease-out` transition on `stroke-dashoffset` is deliberately the
 * slowest motion in the whole surface: the value arrives in jumps as usage is
 * reported, and a slow sweep reads as a measurement settling rather than as a
 * number flickering.
 */
export function MeterRing({
  value,
  size = 20,
  label,
  className
}: MeterRingProps): React.ReactElement {
  const overloaded = isMeterOverloaded(value);
  const offset = value === null ? CIRCUMFERENCE : meterDashOffset(value, CIRCUMFERENCE);
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
        className="absolute inset-0 h-full w-full -rotate-90 transform-gpu"
        aria-hidden
      >
        <circle
          cx={VIEW_BOX / 2}
          cy={VIEW_BOX / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-neutral-500/25"
        />
        <circle
          cx={VIEW_BOX / 2}
          cy={VIEW_BOX / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={cn(
            "transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none",
            overloaded ? "stroke-danger" : "stroke-neutral-400"
          )}
        />
      </svg>
      <span className="sr-only">
        {value === null ? "Context usage unavailable" : `${Math.round(clampMeterPercent(value))}%`}
      </span>
    </span>
  );
}
