/**
 * The fleet view's sticky header: placement mode, capacity used of total, the wait queue, the
 * pool's $/h against the `maxHourlyUsd` cap, the "Rent device hosts without asking" switch's
 * state, and the way to Settings → Devices (where the Fleet settings live). A phone gets the two
 * meters and one line of the rest, so the sticky band stays short.
 */

import React from "react";
import { Settings2 } from "lucide-react";

import { formatHourlyRate, formatUsd } from "../../lib/boxes/format";
import { cn } from "../../lib/cn";
import { meterFill, type PoolView } from "./fleet.logic";
import { Meter, Stat, TONE_TEXT } from "./parts";

function queueText(queue: number): string {
  return queue === 0 ? "None waiting" : `${queue} waiting`;
}

function rentText(rent: boolean | null): string {
  return rent === null ? "—" : rent ? "On, within the cap" : "Off — asks each time";
}

const CapacityMeter: React.FC<{ view: PoolView }> = ({ view }) => {
  const fill = meterFill(view.used, view.total);
  return (
    <div className="flex items-center gap-2">
      <span>
        {view.used}
        <span className="text-neutral-500"> / {view.total}</span>
      </span>
      <Meter fill={fill} tone={fill >= 1 ? "warn" : "info"} label="Fleet capacity used" className="min-w-10 flex-1" />
    </div>
  );
};

const SpendMeter: React.FC<{ view: PoolView }> = ({ view }) => (
  <div className="flex items-center gap-2">
    <span className={cn(view.spendTone !== "ok" && TONE_TEXT[view.spendTone])}>{formatHourlyRate(view.hourlyUsd)}</span>
    {view.capUsd !== null ? (
      <>
        <Meter fill={Math.min(1, view.spendRatio)} tone={view.spendTone} label="Hourly spend against the cap" className="min-w-10 flex-1" />
        <span className="shrink-0 text-[11px] text-neutral-500">of {formatHourlyRate(view.capUsd)}</span>
      </>
    ) : null}
  </div>
);

const SettingsLink: React.FC<{ onClick: () => void; compact?: boolean }> = ({ onClick, compact = false }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Fleet settings"
    className={cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-md text-xs text-neutral-400 transition-colors",
      "hover:bg-neutral-800/70 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
      compact ? "h-7 w-7 justify-center" : "px-2 py-1"
    )}
  >
    <Settings2 size={13} aria-hidden />
    {compact ? null : "Fleet settings"}
  </button>
);

export const PoolHeader: React.FC<{ view: PoolView; onOpenSettings: () => void }> = ({ view, onOpenSettings }) => (
  <div className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/75" data-pool-header="">
    {/* Phone: the two meters, then one line. */}
    <div className="px-3 py-2.5 md:hidden">
      <div className="grid grid-cols-2 gap-x-4">
        <Stat label="Capacity">
          <CapacityMeter view={view} />
        </Stat>
        <Stat label="Hourly spend">
          <SpendMeter view={view} />
        </Stat>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="min-w-0 flex-1 truncate">
          {view.placementLabel} · <span className={view.queue > 0 ? TONE_TEXT.warn : undefined}>{queueText(view.queue)}</span> · Rent without asking{" "}
          {view.rentWithoutAsking === null ? "—" : view.rentWithoutAsking ? "on" : "off"}
        </span>
        <SettingsLink onClick={onOpenSettings} compact />
      </div>
    </div>

    {/* Desktop: every number in one row. */}
    <div className="mx-auto hidden max-w-[1400px] flex-wrap items-end gap-x-8 gap-y-2.5 px-6 py-3 md:flex">
      <Stat label="Placement">{view.placementLabel}</Stat>
      <Stat label="Capacity" className="w-40">
        <CapacityMeter view={view} />
      </Stat>
      <Stat label="Queue">
        <span className={view.queue > 0 ? TONE_TEXT.warn : undefined}>{queueText(view.queue)}</span>
      </Stat>
      <Stat label="Pool hosts">{view.poolHosts}</Stat>
      <Stat label="Hourly spend" className="w-64">
        <SpendMeter view={view} />
      </Stat>
      <Stat label="Spent so far">{formatUsd(view.spentUsd)}</Stat>
      <Stat label="Rent without asking">
        <span className={view.rentWithoutAsking ? "text-ok" : undefined}>{rentText(view.rentWithoutAsking)}</span>
      </Stat>
      <div className="ml-auto">
        <SettingsLink onClick={onOpenSettings} />
      </div>
    </div>
  </div>
);
