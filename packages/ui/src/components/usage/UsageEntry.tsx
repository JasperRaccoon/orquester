/**
 * The Usage view's ways in and out: its header in the top bar (in the project's place while it
 * shows), and the phone drawer's row (a phone has no activity bar). Always offered: the view does
 * not follow the top-bar chip's toggle.
 */

import React from "react";
import { ChartNoAxesColumn, Gauge, X } from "lucide-react";

import { cn } from "../../lib/cn";
import { useAppStore } from "../../store/app";
import { IconButton } from "../ui";

/** The top bar's header while the Usage view shows: its title, and the way back. */
export const UsageHeader: React.FC = () => {
  const close = useAppStore((s) => s.closeUsageView);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="flex min-w-0 items-center gap-2 px-1 text-sm font-medium text-neutral-200">
        <Gauge size={15} aria-hidden className="shrink-0 text-neutral-400" />
        Usage
      </span>
      <div className="app-no-drag">
        <IconButton label="Close Usage" onClick={close}>
          <X size={15} />
        </IconButton>
      </div>
    </div>
  );
};

/** The phone drawer's row to the Usage view (opening it closes the drawer). */
export const UsageDrawerEntry: React.FC = () => {
  const open = useAppStore((s) => s.usageViewOpen);
  const openUsageView = useAppStore((s) => s.openUsageView);
  return (
    <div className="shrink-0 border-t border-neutral-800 px-2 py-1.5">
      <button
        type="button"
        aria-pressed={open}
        onClick={() => openUsageView()}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          open ? "bg-neutral-800 text-neutral-50" : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
        )}
      >
        <ChartNoAxesColumn size={16} aria-hidden className="shrink-0 text-neutral-400" />
        Usage
      </button>
    </div>
  );
};
