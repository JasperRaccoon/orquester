import React from "react";
import { ChevronRight, Cpu, ExternalLink, Folder, MemoryStick } from "lucide-react";
import { useMediaQuery } from "../../hooks";
import { useAppStore } from "../../store/app";
import { AdaptiveMenu, DropdownContext } from "../ui";
import { gaugeClass } from "../topbar/usage-format";
import { useResourceHistory } from "./sparkline";
import { SystemResourcePanel } from "./SystemResources";
import { formatPercent } from "./system-format";
import { SYSTEM_POLL_MS, useSystemPollEnabled, useSystemResources } from "./use-system-status";

/** Settings → Host status, closing the popover first so it does not float over the modal. */
function useOpenHostStatus(): () => void {
  const openSettings = useAppStore((s) => s.openSettings);
  const { close } = React.useContext(DropdownContext);
  return () => {
    close();
    openSettings("system");
  };
}

const PopoverHeader: React.FC = () => {
  const openHostStatus = useOpenHostStatus();
  return (
    <div className="flex items-center gap-2 px-1">
      <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">Host resources</p>
      <span
        className="inline-flex items-center gap-1 rounded-full bg-ok-soft/40 px-2 py-0.5 text-[10px] font-medium text-ok"
        title={`Refreshed every ${Math.round(SYSTEM_POLL_MS / 1000)}s`}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none" />
        Live
      </span>
      <button
        type="button"
        onClick={openHostStatus}
        aria-label="Open Host status in Settings"
        title="Open Host status"
        className="ml-auto rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
};

const PopoverFooter: React.FC<{ path: string }> = ({ path }) => {
  const openHostStatus = useOpenHostStatus();
  return (
    <div className="space-y-1 border-t border-neutral-800 px-1 pt-2.5">
      <p className="flex min-w-0 items-center gap-2 text-[11px] text-neutral-500" title={path}>
        <Folder size={13} className="shrink-0" />
        <span className="truncate font-mono">{path}</span>
      </p>
      <button
        type="button"
        onClick={openHostStatus}
        className="group flex w-full items-center gap-2 rounded-md py-1 text-left text-[11px] text-neutral-400 transition-colors hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      >
        <span className="flex-1">Processes and listening ports in Settings → Host status</span>
        <ChevronRight size={14} className="shrink-0 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </button>
    </div>
  );
};

/**
 * Sidebar-footer host chip: CPU% and memory% of the machine the daemon runs
 * on, with the full resource breakdown in a popover.
 *
 * Hidden entirely below `sm` — the mobile drawer stays mounted off-canvas, so
 * showing it there would poll while invisible, and Settings → Host status is the
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
  // Collected by the chip, which stays mounted, so the popover opens onto two
  // minutes of history instead of an empty chart.
  const history = useResourceHistory(data);

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
    // Left-aligned: the panel is wider than the sidebar can be, so it must open
    // rightward into the content area; Dropdown flips it upward from the footer
    // on its own.
    <AdaptiveMenu title="Host" trigger={trigger} align="left" width="w-[26rem]">
      <div className="space-y-2.5 p-2.5">
        <PopoverHeader />
        <SystemResourcePanel resources={data} history={history} />
        <PopoverFooter path={data.workspacesDisk.path} />
      </div>
    </AdaptiveMenu>
  );
};
