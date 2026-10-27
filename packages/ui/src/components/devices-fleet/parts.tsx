/** Small pieces the fleet view's cards share: tones, a meter, a status pill, a stat, the device glyph. */

import React from "react";

import type { DeviceFormFactor, DevicePlatform } from "@orquester/api";

import { cn } from "../../lib/cn";
import type { FleetTone } from "./fleet.logic";

export const TONE_TEXT: Readonly<Record<FleetTone, string>> = {
  ok: "text-ok",
  info: "text-info",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-neutral-500"
};

export const TONE_DOT: Readonly<Record<FleetTone, string>> = {
  ok: "bg-ok",
  info: "bg-info",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-neutral-500"
};

const TONE_PILL: Readonly<Record<FleetTone, string>> = {
  ok: "bg-ok-soft/40 text-ok ring-ok/25",
  info: "bg-info-soft/40 text-info ring-info/25",
  warn: "bg-warn-soft/50 text-warn ring-warn/25",
  danger: "bg-danger-soft/50 text-danger ring-danger/25",
  muted: "bg-neutral-800/60 text-neutral-400 ring-neutral-700/60"
};

/** A filled bar: `fill` 0–1 in the tone's colour. */
export const Meter: React.FC<{ fill: number; tone: FleetTone; label: string; className?: string }> = ({ fill, tone, label, className }) => (
  <div
    role="meter"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(fill * 100)}
    className={cn("h-1.5 w-full overflow-hidden rounded-full bg-neutral-800", className)}
  >
    <div className={cn("h-full rounded-full transition-[width] duration-500", TONE_DOT[tone])} style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%` }} />
  </div>
);

/** A status in a soft pill with a dot (pulsing while something is under way). */
export const StatusPill: React.FC<{ tone: FleetTone; label: string; pulse?: boolean; className?: string }> = ({ tone, label, pulse = false, className }) => (
  <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONE_PILL[tone], className)}>
    <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone], pulse && "animate-pulse")} />
    {label}
  </span>
);

/** A label over a value, the header and host cards' unit. */
export const Stat: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({ label, children, className }) => (
  <div className={cn("min-w-0", className)}>
    <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">{label}</div>
    <div className="mt-0.5 truncate text-[13px] tabular-nums text-neutral-200">{children}</div>
  </div>
);

/**
 * The device's outline at icon size: a phone (an island on iOS, a punch hole on Android), a
 * tablet, or an open foldable. Drawn with the current colour.
 */
export const DeviceGlyph: React.FC<{ platform: DevicePlatform; formFactor: DeviceFormFactor; size?: number; className?: string }> = ({
  platform,
  formFactor,
  size = 16,
  className
}) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden className={cn("shrink-0", className)}>
    {formFactor === "tablet" ? (
      <>
        <rect x={2.5} y={1.5} width={11} height={13} rx={1.6} />
        <circle cx={8} cy={3.4} r={0.45} fill="currentColor" stroke="none" />
      </>
    ) : formFactor === "foldable" ? (
      <>
        <rect x={1.5} y={2.5} width={13} height={11} rx={1.5} />
        <path d="M8 2.5v11" strokeDasharray="1.2 1.1" />
      </>
    ) : (
      <>
        <rect x={4.25} y={1} width={7.5} height={14} rx={1.8} />
        {platform === "ios" ? (
          <rect x={6.6} y={2.3} width={2.8} height={0.9} rx={0.45} fill="currentColor" stroke="none" />
        ) : (
          <circle cx={8} cy={2.8} r={0.5} fill="currentColor" stroke="none" />
        )}
      </>
    )}
  </svg>
);

/** "iOS 26" / "Android 15" — or the platform's name when the OS is unknown. */
export function platformText(platform: DevicePlatform, osVersion: string): string {
  return osVersion.trim() || (platform === "ios" ? "iOS" : "Android");
}
