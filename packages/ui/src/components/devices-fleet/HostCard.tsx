/**
 * A host's card above its devices: label, kind, status with detail, utilization, $/h and cost so
 * far, uptime and deadline, and its actions — Drain / Resume, Warm caches (pool hosts) and
 * Destroy (rented hosts, after a confirmation that names the cost).
 */

import React from "react";
import { Ban, Flame, HardDrive, Laptop, Loader2, Play, Server, Trash2 } from "lucide-react";

import type { DeviceHostSummary } from "@orquester/api";

import { formatCountdown, formatHourlyRate, formatUsd } from "../../lib/boxes/format";
import { cn } from "../../lib/cn";
import { Button, ConfirmDialog } from "../ui";
import { destroyHost, setHostDraining, warmHostCaches, type FleetApi } from "./actions";
import { canDestroy, canDrain, canWarmCaches, formatUptime, hostCost, hostKindLabel, hostStatusView, meterFill, msSince } from "./fleet.logic";
import { Meter, Stat, StatusPill, TONE_TEXT } from "./parts";

type Busy = "drain" | "destroy" | "warm" | null;

export interface HostCardProps {
  host: DeviceHostSummary;
  /** Leases on it now (the confirmation says how many end). */
  leaseCount: number;
  now: number;
  /** Null while not connected: the actions are off. */
  api: FleetApi | null;
}

function HostIcon({ host }: { host: DeviceHostSummary }): React.ReactElement {
  const Icon = host.kind === "local" ? HardDrive : host.kind === "byo" ? Laptop : Server;
  return <Icon size={16} aria-hidden className="shrink-0 text-neutral-400" />;
}

export const HostCard: React.FC<HostCardProps> = ({ host, leaseCount, now, api }) => {
  const [busy, setBusy] = React.useState<Busy>(null);
  const [confirming, setConfirming] = React.useState(false);
  const status = hostStatusView(host);
  const cost = hostCost(host, now);
  const draining = host.pool?.draining === true;
  const uptime = host.box ? formatUptime(msSince(host.box.startedAt, now)) : null;
  const deadline = host.box ? formatCountdown(host.box.deadlineAt, now) : null;
  const fill = meterFill(host.capacity.used, host.capacity.total);
  const pulse = status.key === "provisioning" || status.key === "stopping";

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 md:p-4" data-host-id={host.id}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2 gap-y-1">
          <HostIcon host={host} />
          <h3 className="max-w-full shrink-0 truncate text-sm font-medium text-neutral-100" title={host.label}>
            {host.label}
          </h3>
          <span className="shrink-0 rounded-md bg-neutral-800/70 px-1.5 py-0.5 text-[11px] text-neutral-400">{hostKindLabel(host)}</span>
          {host.pool?.warm ? <span className="shrink-0 text-[11px] text-neutral-500">· kept warm</span> : null}
          <StatusPill tone={status.tone} label={status.label} pulse={pulse} />
        </div>

        {api && (canDrain(host) || canWarmCaches(host) || canDestroy(host)) ? (
          <div className="-ml-2 flex w-full shrink-0 flex-wrap items-center gap-1 sm:ml-0 sm:w-auto">
            {canDrain(host) ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void run("drain", () => setHostDraining(api, host, !draining))}
                title={draining ? "Take new devices on this host again" : "Stop placing new devices here; it is destroyed once empty"}
              >
                {busy === "drain" ? <Loader2 size={13} aria-hidden className="animate-spin" /> : draining ? <Play size={13} aria-hidden /> : <Ban size={13} aria-hidden />}
                {draining ? "Resume" : "Drain"}
              </Button>
            ) : null}
            {canWarmCaches(host) ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void run("warm", () => warmHostCaches(api, host))}
                title="Build and save the caches new hosts of this kind start from"
              >
                {busy === "warm" ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <Flame size={13} aria-hidden />}
                Warm caches
              </Button>
            ) : null}
            {canDestroy(host) ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => setConfirming(true)}
                className="text-danger hover:bg-danger-soft/40 hover:text-danger"
              >
                {busy === "destroy" ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <Trash2 size={13} aria-hidden />}
                Destroy
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {status.detail ? <p className={cn("mt-1 text-xs", status.tone === "danger" ? TONE_TEXT.danger : "text-neutral-500")}>{status.detail}</p> : null}

      <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <Stat label="Devices" className="col-span-3 sm:col-span-1">
          <div className="flex items-center gap-2">
            <span>
              {host.capacity.used}
              <span className="text-neutral-500"> / {host.capacity.total}</span>
            </span>
            <Meter fill={fill} tone={fill >= 1 ? "warn" : "info"} label={`${host.label} utilization`} className="max-w-28 flex-1" />
          </div>
        </Stat>
        <Stat label="Rate">{cost ? formatHourlyRate(cost.hourlyUsd) : host.kind === "local" ? "Included" : host.kind === "byo" ? "Free" : "—"}</Stat>
        {cost ? <Stat label="Cost so far">{formatUsd(cost.spentUsd)}</Stat> : null}
        {uptime ? (
          <Stat label="Uptime">
            {uptime}
            {deadline ? <span className={cn("block text-[11px] sm:ml-1.5 sm:inline", deadline === "Time limit reached" ? "text-warn" : "text-neutral-500")}>{deadline}</span> : null}
          </Stat>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Destroy ${host.label}?`}
        confirmLabel="Destroy host"
        message={
          <div className="space-y-2">
            <p>
              {leaseCount > 0
                ? `Its ${leaseCount === 1 ? "device ends" : `${leaseCount} devices end`}; their agents are told the device was lost and can open another.`
                : "It has no devices now."}
            </p>
            {cost ? (
              <p className="text-neutral-400">
                It has cost about <span className="text-neutral-200">{formatUsd(cost.spentUsd)}</span> so far at {formatHourlyRate(cost.hourlyUsd)}; destroying it stops the charge.
              </p>
            ) : null}
          </div>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          if (api) void run("destroy", () => destroyHost(api, host));
        }}
      />
    </div>
  );
};

/** The header of a group whose host the list does not know (a lease that outlived it). */
export const UnknownHostCard: React.FC<{ hostId: string }> = ({ hostId }) => (
  <div className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-800 px-3 py-2.5 text-xs text-neutral-500">
    <Server size={14} aria-hidden className="shrink-0" />
    <span className="truncate">
      Host <span className="font-mono text-neutral-400">{hostId}</span> is no longer listed
    </span>
  </div>
);
