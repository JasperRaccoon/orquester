import React from "react";
import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import type { SystemResourcesResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { barClass, gaugeClass } from "../topbar/usage-format";
import { Sparkline, useResourceHistory } from "./sparkline";
import { barWidth, formatBitRate, formatByteRate, formatBytes, formatPercent } from "./system-format";

const Card: React.FC<{
  icon: React.ReactNode;
  label: string;
  title?: string;
  value: string;
  muted?: boolean;
  spark: React.ReactNode;
  detail: React.ReactNode;
  bar?: { percent: number | null };
  footer?: React.ReactNode;
}> = ({ icon, label, title, value, muted, spark, detail, bar, footer }) => (
  <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-3" title={title}>
    <div className="flex items-center gap-1.5 text-xs text-neutral-400">
      <span className="shrink-0 text-neutral-500">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
    <div className="flex items-end gap-3">
      <span
        className={cn(
          "shrink-0 text-2xl font-semibold leading-none tracking-tight tabular-nums",
          muted ? "text-neutral-500" : "text-neutral-100"
        )}
      >
        {value}
      </span>
      <div className="min-w-0 flex-1">{spark}</div>
    </div>
    <p className="truncate text-[11px] tabular-nums text-neutral-500">{detail}</p>
    {bar && (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none",
            bar.percent == null ? "bg-neutral-700" : barClass(bar.percent)
          )}
          style={{ width: barWidth(bar.percent) }}
        />
      </div>
    )}
    {footer && <div className="flex items-center gap-3 text-[11px] tabular-nums text-neutral-400">{footer}</div>}
  </div>
);

/**
 * CPU, memory, workspaces disk and network as four live cards with a two
 * minute sparkline each. Bars and the CPU/memory lines take the usage ramp
 * (green → red as it fills); the rate lines (disk I/O, network) have no limit
 * to be close to, so they stay one neutral information colour.
 */
export const HostResourceCards: React.FC<{ resources: SystemResourcesResponse }> = ({ resources }) => {
  const history = useResourceHistory(resources);
  const { cpu, memory, workspacesDisk: disk, diskIo, network } = resources;
  const memUsed = Math.max(0, memory.totalBytes - memory.availableBytes);
  const memPercent = memory.totalBytes > 0 ? memory.usedPercent : null;
  const diskUsed =
    disk.totalBytes == null || disk.freeBytes == null ? null : Math.max(0, disk.totalBytes - disk.freeBytes);

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <Card
        icon={<Cpu size={13} />}
        label="CPU"
        value={formatPercent(cpu.percent)}
        spark={<Sparkline values={history.map((s) => s.cpu)} max={100} className={gaugeClass(cpu.percent)} />}
        detail={`${cpu.cores} logical core${cpu.cores === 1 ? "" : "s"}${
          resources.loadAverage ? ` · load ${resources.loadAverage[0].toFixed(2)}` : ""
        }`}
        bar={{ percent: cpu.percent }}
      />
      <Card
        icon={<MemoryStick size={13} />}
        label="Memory"
        value={formatPercent(memPercent)}
        muted={memPercent == null}
        spark={
          <Sparkline
            values={history.map((s) => s.memory)}
            max={100}
            className={memPercent == null ? "text-neutral-600" : gaugeClass(memPercent)}
          />
        }
        detail={
          memory.totalBytes > 0
            ? `${formatBytes(memUsed)} of ${formatBytes(memory.totalBytes)} · ${formatBytes(memory.availableBytes)} available`
            : "Size unknown"
        }
        bar={{ percent: memPercent }}
      />
      <Card
        icon={<HardDrive size={13} />}
        label="Workspaces disk"
        title={disk.path}
        value={formatPercent(disk.usedPercent)}
        muted={disk.usedPercent == null}
        spark={<Sparkline values={history.map((s) => s.diskIo)} className="text-info" />}
        detail={
          disk.totalBytes == null
            ? "Size unknown — this volume could not be measured"
            : `${formatBytes(diskUsed)} of ${formatBytes(disk.totalBytes)} · ${formatBytes(disk.freeBytes)} free`
        }
        bar={{ percent: disk.usedPercent }}
        footer={
          diskIo !== undefined && (
            <>
              <span title="Read from disk">R {formatByteRate(diskIo?.readBps)}</span>
              <span title="Written to disk">W {formatByteRate(diskIo?.writeBps)}</span>
            </>
          )
        }
      />
      <Card
        icon={<Network size={13} />}
        label="Network"
        value={network ? formatBitRate(network.rxBps + network.txBps) : "—"}
        muted={!network}
        spark={<Sparkline values={history.map((s) => s.network)} className="text-info" />}
        detail={
          network === undefined
            ? "This daemon does not report network traffic"
            : "All physical interfaces, both directions"
        }
        footer={
          network !== undefined && (
            <>
              <span className="inline-flex items-center gap-0.5" title="Received">
                <ArrowDown size={11} className="text-ok" /> {formatBitRate(network?.rxBps)}
              </span>
              <span className="inline-flex items-center gap-0.5" title="Sent">
                <ArrowUp size={11} className="text-info" /> {formatBitRate(network?.txBps)}
              </span>
            </>
          )
        }
      />
    </div>
  );
};
