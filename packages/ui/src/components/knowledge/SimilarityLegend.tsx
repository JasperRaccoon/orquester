// The similarity layer's corner panel: the "Colour by: cluster | collection" switch and the
// legend for it (each cluster with its label and size, or each collection). Picking a line
// marks its entries on the canvas; picking it again lets go. A cluster line lists its top
// concepts: picking one opens it in the Concepts layer. A line in the destructive colour stands
// for the pairs of entries that disagree, when any is drawn.

import React from "react";
import type { KnowledgeConceptRef } from "@orquester/api";

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
  /** A cluster's concept picked: show it in the Concepts layer (its concepts are not offered without it). */
  onConcept?: (concept: KnowledgeConceptRef) => void;
  /** Drawn pairs of entries that disagree. */
  contradictions?: number;
}> = ({ colorBy, onColorBy, legend, picked, onPick, onConcept, contradictions = 0 }) => (
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
            {onConcept && item.concepts && item.concepts.length > 0 && (
              <div role="group" aria-label={`Top concepts of ${item.label}`} className="mb-1 flex flex-wrap gap-1 pl-5 pr-1">
                {item.concepts.map((concept) => (
                  <button
                    key={concept.id}
                    type="button"
                    data-cluster-concept={concept.id}
                    title={`${concept.type}: show it in the Concepts layer`}
                    onClick={() => onConcept(concept)}
                    className="max-w-full truncate rounded-full border border-neutral-800 px-1.5 py-px text-[10.5px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
                  >
                    {concept.name}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    )}
    {legend.more > 0 && (
      <p className="px-1.5 text-[11px] text-neutral-500">
        and {legend.more.toLocaleString("en-US")} more {legend.more === 1 ? "cluster" : "clusters"}
      </p>
    )}
    {contradictions > 0 && (
      <p data-legend-contradictions className="flex items-center gap-2 px-1.5 text-[11px] text-neutral-400">
        <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 rounded-full bg-danger" />
        {contradictions.toLocaleString("en-US")} {contradictions === 1 ? "pair disagrees" : "pairs disagree"}
      </p>
    )}
  </div>
);
