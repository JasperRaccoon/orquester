import React from "react";
import { Cpu, MemoryStick } from "lucide-react";
import { useMediaQuery } from "../../hooks";
import { AdaptiveMenu } from "../ui";
import { gaugeClass } from "../topbar/usage-format";
import { SystemResourcePanel } from "./SystemResources";
import { formatPercent } from "./system-format";
import { useSystemPollEnabled, useSystemResources } from "./use-system-status";

/**
 * Sidebar-footer host chip: CPU% and memory% of the machine the daemon runs
 * on, with the full resource breakdown in a popover.
 *
 * Hidden entirely below `sm` — the mobile drawer stays mounted off-canvas, so
 * showing it there would poll while invisible, and Settings → System is the
 * phone-side surface for this. Hidden too when the host can't report
 * (`supported: false`, i.e. anything but Linux) or when nothing has been read
 * yet, following the UsageWidget convention of staying out of the chrome
 * rather than showing a placeholder.
 */
export const SystemStatusChip: React.FC = () => {
  // Not `useIsDesktop()`: the chip fits the wide-phone/tablet header too, and
  // only the genuinely narrow layout has to give it up.
  const roomForChip = useMediaQuery("(min-width: 640px)");
  const active = useSystemPollEnabled(roomForChip);
  const { data } = useSystemResources(active);

  if (!roomForChip || !data || !data.supported) {
    return null;
  }

  const cpu = data.cpu.percent;
  const mem = data.memory.usedPercent;
  const label = `Host: CPU ${formatPercent(cpu)}, memory ${formatPercent(mem)}`;
  const trigger = (
    <span
      title={label}
      aria-label={label}
      className="flex h-6 shrink-0 items-center gap-2 rounded-md px-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
    >
      <span className="flex items-center gap-1 tabular-nums">
        <Cpu size={13} className={gaugeClass(cpu)} />
        {formatPercent(cpu)}
      </span>
      <span className="flex items-center gap-1 tabular-nums">
        <MemoryStick size={13} className={gaugeClass(mem)} />
        {formatPercent(mem)}
      </span>
    </span>
  );

  return (
    // Left-aligned: the panel (w-72) is wider than the sidebar can be, so it
    // must open rightward into the content area; Dropdown flips it upward from
    // the footer on its own.
    <AdaptiveMenu title="Host" trigger={trigger} align="left" width="w-72">
      <div className="space-y-2 p-2">
        <p className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">Host resources</p>
        <SystemResourcePanel resources={data} />
        <p className="px-0.5 text-[10px] text-neutral-600">
          Processes and listening ports live in Settings → System.
        </p>
      </div>
    </AdaptiveMenu>
  );
};
