import React from "react";
import { LayoutGrid, Square } from "lucide-react";
import { cn } from "../../lib/cn";
import { useAppStore, useViewMode } from "../../store/app";
import type { ViewMode } from "../../lib/view-mode";

const MODES: { mode: ViewMode; label: string; icon: React.ReactNode }[] = [
  { mode: "tabs", label: "Tab view", icon: <Square size={14} /> },
  { mode: "grid", label: "Grid view", icon: <LayoutGrid size={14} /> }
];

/**
 * Segmented control that switches the current project's main panel between the
 * one-tab-at-a-time view and the all-tabs-at-once grid. Desktop-only; the choice
 * is per-project and persisted client-side.
 */
export const ViewModeToggle: React.FC = () => {
  const viewMode = useViewMode();
  const setViewMode = useAppStore((s) => s.setViewMode);
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800">
      {MODES.map(({ mode, label, icon }) => {
        const active = viewMode === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => setViewMode(mode)}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              active
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-500 hover:text-neutral-200"
            )}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
};
