import React from "react";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import type { SystemResourcesResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { barClass } from "../topbar/usage-format";
import { barWidth, formatBytes, formatPercent } from "./system-format";

/**
 * One resource row: label, percent, bar, and a detail line. `percent === null`
 * is *unknown* — the bar stays empty and the number is an em-dash, which must
 * read differently from a genuine 0%.
 */
export const ResourceRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  percent: number | null;
  detail: React.ReactNode;
  className?: string;
}> = ({ icon, label, percent, detail, className }) => (
  <div className={cn("rounded-md bg-neutral-950/40 px-2.5 py-2", className)}>
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-baseline gap-1.5 truncate text-xs text-neutral-300">
        <span className="shrink-0 self-center text-neutral-500">{icon}</span>
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 text-sm font-medium tabular-nums",
          percent == null ? "text-neutral-500" : "text-neutral-100"
        )}
      >
        {formatPercent(percent)}
      </span>
    </div>
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          percent == null ? "bg-neutral-700" : barClass(percent)
        )}
        style={{ width: barWidth(percent) }}
      />
    </div>
    <p className="mt-1.5 truncate text-[11px] tabular-nums text-neutral-500">{detail}</p>
  </div>
);

/**
 * CPU / memory / workspaces-disk readings. Shared by the top-bar chip popover
 * and Settings → Host status so both always tell the same story. `stack` (the
 * default) is the narrow popover column; `grid` lays the three out side by side
 * as tiles once the settings page is wide enough, and stacks them again on a
 * phone.
 */
export const SystemResourcePanel: React.FC<{
  resources: SystemResourcesResponse;
  layout?: "stack" | "grid";
}> = ({ resources, layout = "stack" }) => {
  const { cpu, memory, workspacesDisk: disk } = resources;
  const memUsed = Math.max(0, memory.totalBytes - memory.availableBytes);
  const diskUsed =
    disk.totalBytes == null || disk.freeBytes == null ? null : Math.max(0, disk.totalBytes - disk.freeBytes);

  const grid = layout === "grid";
  const tile = grid ? "rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-3" : undefined;

  return (
    <div className={grid ? "grid gap-2 sm:grid-cols-3" : "space-y-2"}>
      <ResourceRow
        className={tile}
        icon={<Cpu size={13} />}
        label="CPU"
        percent={cpu.percent}
        detail={`${cpu.cores} logical core${cpu.cores === 1 ? "" : "s"}`}
      />
      <ResourceRow
        className={tile}
        icon={<MemoryStick size={13} />}
        label="Memory"
        percent={memory.totalBytes > 0 ? memory.usedPercent : null}
        detail={
          memory.totalBytes > 0
            ? `${formatBytes(memUsed)} used · ${formatBytes(memory.availableBytes)} available of ${formatBytes(memory.totalBytes)}`
            : "Size unknown"
        }
      />
      <ResourceRow
        className={tile}
        icon={<HardDrive size={13} />}
        label="Workspaces disk"
        percent={disk.usedPercent}
        detail={
          disk.totalBytes == null
            ? "Size unknown — this volume could not be measured"
            : `${formatBytes(diskUsed)} used · ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`
        }
      />
      <p
        className={cn("truncate px-0.5 text-[10px] text-neutral-600", grid && "font-mono sm:col-span-3")}
        title={disk.path}
      >
        {disk.path}
      </p>
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
