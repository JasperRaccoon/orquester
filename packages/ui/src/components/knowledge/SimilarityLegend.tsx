// The similarity layer's corner panel: the "Colour by: cluster | collection" switch and the
// legend for it (each cluster with its label and size, or each collection). Picking a line
// marks its entries on the canvas; picking it again lets go.

import React from "react";

import { cn } from "../../lib/cn";
import { SegmentedControl } from "../settings/primitives";
import { CollectionDot } from "./parts";
import type { Legend, SimilarityColorBy } from "./graph.logic";

const COLOR_BY_OPTIONS = [
  { value: "cluster" as const, label: "Cluster" },
  { value: "collection" as const, label: "Collection" }
];

export const SimilarityLegend: React.FC<{
  colorBy: SimilarityColorBy;
  onColorBy: (colorBy: SimilarityColorBy) => void;
  legend: Legend;
  /** The picked line's key, or null. */
  picked: string | null;
  onPick: (key: string | null) => void;
}> = ({ colorBy, onColorBy, legend, picked, onPick }) => (
  <div className="pointer-events-auto flex max-h-full w-56 flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/90 p-2 shadow-sm">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-neutral-500">Colour by</span>
      <SegmentedControl value={colorBy} options={COLOR_BY_OPTIONS} onChange={onColorBy} size="xs" ariaLabel="Colour by" />
    </div>
    {legend.items.length > 0 && (
      <ul aria-label={colorBy === "cluster" ? "Clusters" : "Collections"} className="min-h-0 overflow-y-auto">
        {legend.items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              aria-pressed={picked === item.key}
              title={picked === item.key ? "Stop marking these entries" : "Mark these entries"}
              onClick={() => onPick(picked === item.key ? null : item.key)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-[11.5px]",
                picked === item.key ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
              )}
            >
              <CollectionDot color={item.color} />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="shrink-0 tabular-nums text-neutral-500">{item.size.toLocaleString("en-US")}</span>
            </button>
          </li>
        ))}
      </ul>
    )}
    {legend.more > 0 && (
      <p className="px-1.5 text-[11px] text-neutral-500">
        and {legend.more.toLocaleString("en-US")} more {legend.more === 1 ? "cluster" : "clusters"}
      </p>
    )}
  </div>
);
