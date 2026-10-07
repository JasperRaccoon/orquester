import React, { useEffect, useState } from "react";
import type { SystemResourcesResponse } from "@orquester/api";
import { cn } from "../../lib/cn";

/** Two minutes of history at the 3 s poll. */
export const HISTORY_LENGTH = 40;

export interface ResourceSample {
  cpu: number;
  memory: number | null;
  diskIo: number | null;
  network: number | null;
}

/**
 * The last {@link HISTORY_LENGTH} resource readings, appended once per new
 * payload. Kept on the client, by whichever surface polls: history only
 * matters while someone is watching, and only the surface knows that. Null
 * (nothing read yet) appends nothing.
 */
export function useResourceHistory(resources: SystemResourcesResponse | null): ResourceSample[] {
  const [history, setHistory] = useState<ResourceSample[]>([]);
  useEffect(() => {
    if (!resources) return;
    const sample: ResourceSample = {
      cpu: resources.cpu.percent,
      memory: resources.memory.totalBytes > 0 ? resources.memory.usedPercent : null,
      diskIo: resources.diskIo ? resources.diskIo.readBps + resources.diskIo.writeBps : null,
      network: resources.network ? resources.network.rxBps + resources.network.txBps : null
    };
    setHistory((previous) => [...previous, sample].slice(-HISTORY_LENGTH));
  }, [resources]);
  return history;
}

/**
 * A filled line of recent values, scaled to `max` (or to the series' own peak
 * for unbounded rates). Unknown points break nothing: they draw as zero.
 */
export const Sparkline: React.FC<{ values: ReadonlyArray<number | null>; max?: number; className?: string }> = ({
  values,
  max,
  className
}) => {
  const points = values.map((value) => value ?? 0);
  const peak = max ?? Math.max(1, ...points) * 1.15;
  const step = 100 / (HISTORY_LENGTH - 1);
  // Right-aligned: the newest point is always at the right edge, so a short
  // history grows in from the right like a strip chart.
  const offset = (HISTORY_LENGTH - points.length) * step;
  const coords = points.map((value, index) => {
    const x = offset + index * step;
    const y = 30 - (Math.min(value, peak) / peak) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden className={cn("h-9 w-full", className)}>
      {coords.length > 1 && (
        <>
          <polygon points={`${offset},32 ${coords.join(" ")} 100,32`} fill="currentColor" opacity={0.14} />
          <polyline
            points={coords.join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
      <line x1="0" y1="31.5" x2="100" y2="31.5" stroke="currentColor" opacity={0.15} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};
