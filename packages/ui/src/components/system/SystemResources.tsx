import React from "react";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import type { SystemResourcesResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { barClass, gaugeClass, usageLevel, type UsageLevel } from "../topbar/usage-format";
import { Sparkline, type ResourceSample } from "./sparkline";
import { barWidth, formatBytes, formatPercent } from "./system-format";

const USAGE_VAR: Record<UsageLevel, string> = {
  ok: "var(--usage-ok)",
  moderate: "var(--usage-med)",
  high: "var(--usage-high)",
  critical: "var(--usage-crit)"
};

/**
 * One resource: a tile tinted with the usage ramp, label and detail, a two
 * minute sparkline, the percent, and a bar. `percent === null` is *unknown* —
 * an untinted tile, an empty bar and an em-dash, which must read differently
 * from a genuine 0%.
 */
const ResourceRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  percent: number | null;
  detail: string;
  /** The full reading, for the tooltip — `detail` drops the total to fit the row. */
  detailTitle?: string;
  history: ReadonlyArray<number | null>;
  historyMax?: number;
  historyTitle: string;
}> = ({ icon, label, percent, detail, detailTitle, history, historyMax, historyTitle }) => {
  const known = percent != null;
  const tone = known ? gaugeClass(percent) : "text-neutral-500";
  return (
    <div className="space-y-2.5 rounded-lg bg-neutral-950/40 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", tone, !known && "bg-neutral-800")}
          style={known ? { backgroundColor: `color-mix(in srgb, ${USAGE_VAR[usageLevel(percent)]} 16%, transparent)` } : undefined}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1" title={detailTitle}>
          <p className="truncate text-sm text-neutral-100">{label}</p>
          <p className="truncate text-[11px] tabular-nums text-neutral-500">{detail}</p>
        </div>
        <div className="w-14 shrink-0" title={historyTitle}>
          <Sparkline values={history} max={historyMax} className={cn("h-7", tone)} />
        </div>
        <span
          className={cn(
            "w-12 shrink-0 text-right text-lg font-semibold tabular-nums",
            known ? "text-neutral-100" : "text-neutral-500"
          )}
        >
          {formatPercent(percent)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none",
            known ? barClass(percent) : "bg-neutral-700"
          )}
          style={{ width: barWidth(percent) }}
        />
      </div>
    </div>
  );
};

/**
 * CPU / memory / workspaces-disk readings for the top-bar chip's popover, each
 * with the history the chip has collected. Settings → Host status has its own
 * wider cards ({@link HostResourceCards}); both read the same payload.
 */
export const SystemResourcePanel: React.FC<{
  resources: SystemResourcesResponse;
  history: readonly ResourceSample[];
}> = ({ resources, history }) => {
  const { cpu, memory, workspacesDisk: disk } = resources;
  const memUsed = Math.max(0, memory.totalBytes - memory.availableBytes);
  const diskUsed =
    disk.totalBytes == null || disk.freeBytes == null ? null : Math.max(0, disk.totalBytes - disk.freeBytes);

  return (
    <div className="space-y-1.5">
      <ResourceRow
        icon={<Cpu size={17} />}
        label="CPU"
        percent={cpu.percent}
        detail={`${cpu.cores} logical core${cpu.cores === 1 ? "" : "s"}`}
        history={history.map((sample) => sample.cpu)}
        historyMax={100}
        historyTitle="CPU load, last two minutes"
      />
      <ResourceRow
        icon={<MemoryStick size={17} />}
        label="Memory"
        percent={memory.totalBytes > 0 ? memory.usedPercent : null}
        detail={
          memory.totalBytes > 0
            ? `${formatBytes(memUsed)} used · ${formatBytes(memory.availableBytes)} free`
            : "Size unknown"
        }
        detailTitle={
          memory.totalBytes > 0
            ? `${formatBytes(memUsed)} used, ${formatBytes(memory.availableBytes)} available of ${formatBytes(memory.totalBytes)}`
            : undefined
        }
        history={history.map((sample) => sample.memory)}
        historyMax={100}
        historyTitle="Memory in use, last two minutes"
      />
      <ResourceRow
        icon={<HardDrive size={17} />}
        label="Workspaces disk"
        percent={disk.usedPercent}
        detail={
          disk.totalBytes == null ? "Size unknown" : `${formatBytes(diskUsed)} used · ${formatBytes(disk.freeBytes)} free`
        }
        detailTitle={
          disk.totalBytes == null
            ? `${disk.path} could not be measured`
            : `${formatBytes(diskUsed)} used, ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} on ${disk.path}`
        }
        history={history.map((sample) => sample.diskIo)}
        historyTitle="Disk activity (reads + writes), last two minutes"
      />
    </div>
  );
};

/** The one "this host can't report it" line, worded the same everywhere. */
export const SystemUnsupported: React.FC<{ what: string }> = ({ what }) => (
  <p className="rounded-xl border border-dashed border-neutral-800 px-3 py-4 text-xs text-neutral-500">
    {what} is not available on this host — the daemon reads it from <code className="text-neutral-400">/proc</code>,
    which only Linux provides.
  </p>
);
