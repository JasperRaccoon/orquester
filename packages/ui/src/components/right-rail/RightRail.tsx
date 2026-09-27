import React from "react";

import { cn } from "../../lib/cn";
import {
  RIGHT_RAIL_DOCK_ID,
  RIGHT_RAIL_PANEL_ORDER,
  RIGHT_RAIL_PANEL_REGISTRY,
  type RightRailPanelRegistry
} from "./panels";
import type { RightRailPanelId } from "./types";

export interface RightRailProps {
  /** The docked panel, or `null` with the dock closed. */
  open: RightRailPanelId | null;
  /** A button was clicked: open its panel, switch to it, or close it when it is the open one. */
  onToggle: (id: RightRailPanelId) => void;
  /** The panels by id (the real ones unless a check passes fakes). */
  panels?: RightRailPanelRegistry;
}

/**
 * The thin icon column at the right edge, below the top bar (desktop, with a
 * project open): one square toggle per panel. The active one reads as pressed
 * — a raised square with a ring — and the others stay muted until hovered.
 * Same surface as the left sidebar.
 */
export const RightRail: React.FC<RightRailProps> = ({
  open,
  onToggle,
  panels = RIGHT_RAIL_PANEL_REGISTRY
}) => (
  <div
    role="group"
    aria-label="Side panels"
    className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-neutral-800 bg-neutral-900/40 py-2"
  >
    {RIGHT_RAIL_PANEL_ORDER.map((id) => {
      const { title, Icon } = panels[id];
      const active = open === id;
      return (
        <button
          key={id}
          type="button"
          aria-label={title}
          title={title}
          aria-pressed={active}
          aria-controls={active ? RIGHT_RAIL_DOCK_ID : undefined}
          onClick={() => onToggle(id)}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            active
              ? "bg-neutral-800 text-neutral-100 ring-1 ring-neutral-700"
              : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-200"
          )}
        >
          <Icon size={17} aria-hidden />
        </button>
      );
    })}
  </div>
);
