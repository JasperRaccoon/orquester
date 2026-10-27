/**
 * The Devices fleet view's ways in and out: its header in the top bar (in the project's place
 * while it shows), and the phone drawer's row (a phone has no activity bar). Both show only
 * while the Device simulators plugin is on.
 */

import React from "react";
import { TabletSmartphone, X } from "lucide-react";

import { isActiveDeviceLease } from "@orquester/api";

import { cn } from "../../lib/cn";
import { useDevicesEnabled, useDevicesState } from "../../lib/devices/hooks";
import { useAppStore } from "../../store/app";
import { IconButton } from "../ui";

/** How many devices are leased now (the header's count). */
function useActiveLeaseCount(): number {
  return useDevicesState((state) => state.leases?.filter(isActiveDeviceLease).length ?? 0);
}

/** The top bar's header while the fleet view shows: its title and count, and the way back. */
export const DevicesFleetHeader: React.FC = () => {
  const close = useAppStore((s) => s.closeDevicesFleet);
  const count = useActiveLeaseCount();
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="flex min-w-0 items-center gap-2 px-1 text-sm font-medium text-neutral-200">
        <TabletSmartphone size={15} aria-hidden className="shrink-0 text-neutral-400" />
        Devices
        {count > 0 ? (
          <span className="rounded-full bg-neutral-800 px-1.5 py-px text-[11px] font-normal tabular-nums text-neutral-400" aria-label={`${count} leased`}>
            {count}
          </span>
        ) : null}
      </span>
      <div className="app-no-drag">
        <IconButton label="Close Devices" onClick={close}>
          <X size={15} />
        </IconButton>
      </div>
    </div>
  );
};

/** The phone drawer's row to the fleet view (opening it closes the drawer). */
export const DevicesDrawerEntry: React.FC = () => {
  const on = useDevicesEnabled();
  const open = useAppStore((s) => s.devicesFleetOpen);
  const openFleet = useAppStore((s) => s.openDevicesFleet);
  if (!on) return null;
  return (
    <div className="shrink-0 border-t border-neutral-800 px-2 py-1.5">
      <button
        type="button"
        aria-pressed={open}
        onClick={openFleet}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          open ? "bg-neutral-800 text-neutral-50" : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
        )}
      >
        <TabletSmartphone size={16} aria-hidden className="shrink-0 text-neutral-400" />
        Devices
      </button>
    </div>
  );
};
