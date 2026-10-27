/**
 * The Device panel (right rail, devices spec §10.1): the visible chat's devices. This first
 * version lists the chat's leases — name, platform, state and who controls it — with an empty
 * state; the live stream view, input, toolbar, controller pill, overlay and action log drawer
 * build on it (`components/device/`). The rail mounts it only while the Device simulators
 * plugin is on.
 */

import React from "react";
import { Smartphone, TabletSmartphone } from "lucide-react";

import { cn } from "../../lib/cn";
import { useDevicesLoaded, useThreadDeviceLeases } from "../../lib/devices/hooks";
import { RailEmptyState } from "../right-rail/primitives";
import type { RightRailPanelProps } from "../right-rail/types";
import { controllerLabel, leaseStateLabel, leaseSubtitle } from "./device-panel.logic";

const NO_CHAT_TITLE = "Open an agent chat to see its devices";

export const DevicePanel: React.FC<RightRailPanelProps> = ({ sessionId }) => {
  const loaded = useDevicesLoaded();
  const leases = useThreadDeviceLeases(sessionId);

  if (sessionId === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-device-panel="">
        <RailEmptyState title={NO_CHAT_TITLE} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-device-panel="">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!loaded ? (
          <RailEmptyState title="Loading devices…" />
        ) : leases.length === 0 ? (
          <RailEmptyState
            title="No device in this chat"
            hint="When the agent opens an iOS simulator or Android emulator, it shows up here."
          />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="This chat's devices">
            {leases.map((lease) => {
              const Icon = lease.platform === "ios" ? TabletSmartphone : Smartphone;
              const controller = controllerLabel(lease);
              return (
                <li
                  key={lease.id}
                  className="flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2"
                  data-lease-id={lease.id}
                >
                  <Icon size={16} aria-hidden className="mt-0.5 shrink-0 text-neutral-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-neutral-100">{lease.name || lease.profile}</div>
                    <div className="truncate text-xs text-neutral-500">{leaseSubtitle(lease)}</div>
                    <div className={cn("text-xs", lease.state === "lost" ? "text-red-400" : "text-neutral-400")}>{leaseStateLabel(lease)}</div>
                    {controller ? (
                      <div className={cn("text-xs", lease.controller === "user" ? "text-sky-300" : "text-amber-300")}>{controller}</div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
