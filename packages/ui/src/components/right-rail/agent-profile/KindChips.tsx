/**
 * The kind filter: "All" and the agent's kinds, each with its count, as ONE
 * horizontally scrolling row that never wraps. It runs edge to edge of the
 * panel (`-mx-3 px-3`), and a mask fades both edges — the fade lies over the
 * padding at rest and over the chips while they scroll under it, whatever the
 * colour scheme (a mask, not a painted gradient).
 */

import React from "react";

import { cn } from "../../../lib/cn";
import type { ProfileKindChip, ProfileKindFilter } from "./list.logic";

const EDGE_FADE =
  "[mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)] " +
  "[-webkit-mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)]";

export const KindChips: React.FC<{
  chips: readonly ProfileKindChip[];
  value: ProfileKindFilter;
  onChange: (kind: ProfileKindFilter) => void;
  sheet: boolean;
}> = ({ chips, value, onChange, sheet }) => (
  <div
    role="group"
    aria-label="Filter by kind"
    className={cn(
      "-mx-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-3",
      "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      EDGE_FADE
    )}
  >
    {chips.map((chip) => {
      const active = chip.id === value;
      return (
        <button
          key={chip.id}
          type="button"
          aria-pressed={active}
          onClick={() => onChange(chip.id)}
          className={cn(
            // A 40 px target on a phone around the same pill.
            "group inline-flex shrink-0 items-center rounded-full",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            sheet ? "h-10" : "h-7"
          )}
        >
          <span
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-colors",
              active
                ? "border-neutral-600 bg-neutral-700/70 text-neutral-50"
                : "border-neutral-800 bg-neutral-900/40 text-neutral-400 group-hover:border-neutral-700 group-hover:text-neutral-200"
            )}
          >
            {chip.label}
            <span className={cn("tabular-nums", active ? "text-neutral-300" : "text-neutral-500")}>{chip.count}</span>
          </span>
        </button>
      );
    })}
  </div>
);
