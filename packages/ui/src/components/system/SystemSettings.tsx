import React, { useEffect, useState } from "react";
import { Loader2, RefreshCw, ServerOff } from "lucide-react";
import type { SystemPortsResponse, SystemProcessesResponse, SystemResourcesResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Badge, EmptyState, Notice, SettingsSection } from "../settings/primitives";
import { HostResourceCards } from "./HostResourceCards";
import { OrquesterCore } from "./OrquesterCore";
import { PortsTable } from "./PortsTable";
import { SystemUnsupported } from "./SystemResources";
import { TaskManager } from "./TaskManager";
import { formatDuration } from "./system-format";
import {
  SYSTEM_POLL_MS,
  useSystemPollEnabled,
  useSystemPorts,
  useSystemProcesses,
  useSystemResources,
  type SystemPoll
} from "./use-system-status";

export interface HostStatus {
  /** False while the daemon is unreachable — nothing polls then. */
  live: boolean;
  resources: SystemPoll<SystemResourcesResponse>;
  processes: SystemPoll<SystemProcessesResponse>;
  ports: SystemPoll<SystemPortsResponse>;
  refreshing: boolean;
  refreshAll: () => void;
  /** When the latest resources or process payload arrived. */
  updatedAt: Date | null;
}

/**
 * The three host polls, owned by whichever surface shows them. Everything here
 * is polled (there are no push events for it) and only while that surface is
 * mounted — SettingsModal renders one page at a time, so leaving the page or
 * closing the modal stops the polling.
 */
export function useHostStatus(): HostStatus {
  const live = useSystemPollEnabled(true);
  const resources = useSystemResources(live);
  const processes = useSystemProcesses(live);
  const ports = useSystemPorts(live);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (resources.data || processes.data) setUpdatedAt(new Date());
  }, [resources.data, processes.data]);
  return {
    live,
    resources,
    processes,
    ports,
    refreshing: resources.loading || processes.loading || ports.loading,
    refreshAll: () => {
      resources.refresh();
      processes.refresh();
      ports.refresh();
    },
    updatedAt
  };
}

/** "Live · 3s", the last update time and a manual refresh, for the page header. */
export const HostStatusControls: React.FC<{ status: HostStatus }> = ({ status }) => (
  <>
    {status.updatedAt && (
      <span className="hidden text-[11px] tabular-nums text-neutral-500 sm:inline">
        Updated {status.updatedAt.toLocaleTimeString()}
      </span>
    )}
    {status.live ? (
      <Badge
        tone="ok"
        title={`Refreshed every ${Math.round(SYSTEM_POLL_MS / 1000)}s while this page is open`}
        icon={<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none" />}
      >
        Live · {Math.round(SYSTEM_POLL_MS / 1000)}s
      </Badge>
    ) : (
      <Badge title="Not connected to the daemon — polling is paused">Paused</Badge>
    )}
    <button
      type="button"
      disabled={status.refreshing}
      onClick={status.refreshAll}
      aria-label="Refresh host status"
      title="Refresh now"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50"
    >
      {status.refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
    </button>
  </>
);

const Failed: React.FC<{ what: string; message: string }> = ({ what, message }) => (
  <Notice tone="danger" title={`Could not read ${what}`}>
    <p className="break-words">{message}</p>
  </Notice>
);

const Pending: React.FC<{ what: string }> = ({ what }) => (
  <div className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-6 text-xs text-neutral-500">
    <Loader2 size={13} className="animate-spin" />
    Reading {what}…
  </div>
);

/** Placeholder tiles shaped like the loaded card grid. */
const CardsSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div role="status" aria-label={label} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
    {[0, 1, 2, 3].map((i) => (
      <div key={i} className="space-y-2.5 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-3">
        <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-800" />
        <div className="h-6 w-1/2 animate-pulse rounded bg-neutral-800" />
        <div className="h-2.5 w-2/3 animate-pulse rounded bg-neutral-800" />
      </div>
    ))}
  </div>
);

type HostTab = "processes" | "ports";

const TabButton: React.FC<{
  id: HostTab;
  active: boolean;
  count?: number;
  onSelect: (tab: HostTab) => void;
  children: React.ReactNode;
}> = ({ id, active, count, onSelect, children }) => (
  <button
    type="button"
    role="tab"
    id={`host-tab-${id}`}
    aria-selected={active}
    aria-controls={`host-panel-${id}`}
    onClick={() => onSelect(id)}
    className={cn(
      "relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm transition-colors",
      "focus:outline-none focus-visible:text-neutral-100",
      active ? "border-neutral-200 text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
    )}
  >
    {children}
    {count !== undefined && <span className="text-xs tabular-nums text-neutral-500">{count}</span>}
  </button>
);

/** The status line under the table: counts, load, uptime and who/where the daemon runs. */
const HostFooter: React.FC<{
  resources: SystemResourcesResponse | null;
  processes: SystemProcessesResponse | null;
}> = ({ resources, processes }) => {
  const list = processes?.processes ?? [];
  const running = list.filter((proc) => proc.state === "running").length;
  const host = resources?.host;
  const items: React.ReactNode[] = [];
  if (processes) {
    items.push(`${list.length} processes`, `${running} running`);
  }
  if (resources?.loadAverage) {
    items.push(<span title="Load average over 1, 5 and 15 minutes">Load {resources.loadAverage.map((n) => n.toFixed(2)).join("  ")}</span>);
  }
  if (resources?.uptimeSeconds !== undefined) {
    items.push(`Up ${formatDuration(resources.uptimeSeconds)}`);
  }
  if (host) {
    items.push(host.user ? `${host.user}@${host.hostname}` : host.hostname, `Linux ${host.kernel} ${host.arch}`);
  }
  if (items.length === 0) return null;
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-800 pt-3 text-[11px] tabular-nums text-neutral-500">
      {items.map((item, index) => (
        <span key={index} className="whitespace-pre">
          {item}
        </span>
      ))}
    </footer>
  );
};

/** Orquester's core processes, host resources, every process, and listening ports. */
export const HostStatusView: React.FC<{ status: HostStatus }> = ({ status }) => {
  const { resources, processes, ports } = status;
  const [tab, setTab] = useState<HostTab>("processes");
  const [selectedPid, setSelectedPid] = useState<number | null>(null);

  // The three routes share one host gate, so any settled response answers it.
  const settled = resources.data ?? processes.data ?? ports.data;
  const unavailable = resources.unavailable && processes.unavailable && ports.unavailable;

  if (unavailable) {
    return (
      <EmptyState
        className="rounded-xl border border-dashed border-neutral-800"
        icon={<ServerOff size={18} />}
        title="This daemon does not report host status"
        description={
          <>
            It predates the <code className="text-neutral-400">/api/system</code> routes — update it to see CPU,
            memory, processes and ports here.
          </>
        }
      />
    );
  }

  if (settled && !settled.supported) {
    return <SystemUnsupported what="Host status" />;
  }

  const selectFromCore = (pid: number) => {
    setTab("processes");
    setSelectedPid(pid);
  };

  return (
    <>
      <SettingsSection bare title="Orquester" description="The processes Orquester can't run without, pinned whatever the table is sorted by.">
        {processes.data ? (
          <OrquesterCore snapshot={processes.data} selectedPid={selectedPid} onSelect={selectFromCore} />
        ) : processes.error ? (
          <Failed what="the process list" message={processes.error} />
        ) : (
          <CardsSkeleton label="Reading Orquester's processes…" />
        )}
      </SettingsSection>

      <SettingsSection bare title="Resources" description="CPU, memory, the volume your workspaces live on, and network traffic.">
        {resources.data ? (
          <HostResourceCards resources={resources.data} />
        ) : resources.error ? (
          <Failed what="resources" message={resources.error} />
        ) : (
          <CardsSkeleton label="Reading resources…" />
        )}
      </SettingsSection>

      <section className="space-y-3">
        <div role="tablist" aria-label="Host details" className="flex items-end gap-5 border-b border-neutral-800">
          <TabButton id="processes" active={tab === "processes"} count={processes.data?.processes.length} onSelect={setTab}>
            Processes
          </TabButton>
          <TabButton id="ports" active={tab === "ports"} count={ports.data?.ports.length} onSelect={setTab}>
            Listening ports
          </TabButton>
        </div>

        <div role="tabpanel" id={`host-panel-${tab}`} aria-labelledby={`host-tab-${tab}`} className="space-y-2">
          {tab === "processes" ? (
            <>
              <p className="text-xs text-neutral-500">
                Every process on the host. Orquester's own are bright; only those can be stopped (SIGTERM) or force
                killed (SIGKILL), which signals the process and everything under it. Click a row to expand its details,
                right-click for actions.
              </p>
              {processes.data ? (
                <TaskManager
                  snapshot={processes.data}
                  ports={ports.data}
                  memoryTotal={resources.data?.memory.totalBytes ?? 0}
                  selectedPid={selectedPid}
                  onSelect={setSelectedPid}
                  onChanged={processes.refresh}
                />
              ) : processes.error ? (
                <Failed what="the process list" message={processes.error} />
              ) : (
                <Pending what="the process list" />
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-neutral-500">
                TCP sockets opened by Orquester's processes. Only 443 is reachable from outside the VPS, so these are copy
                targets, not links.
              </p>
              {ports.data ? (
                <PortsTable snapshot={ports.data} />
              ) : ports.error ? (
                <Failed what="listening ports" message={ports.error} />
              ) : (
                <Pending what="listening ports" />
              )}
            </>
          )}
        </div>
      </section>

      <HostFooter resources={resources.data} processes={processes.data} />
    </>
  );
};

/**
 * Standalone host-status view (header + sections), kept for the package's
 * public export. Settings → Host status composes {@link useHostStatus} and
 * {@link HostStatusView} into its own page instead.
 */
export const SystemSettings: React.FC = () => {
  const status = useHostStatus();
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-neutral-200">Host status</p>
          <p className="text-xs text-neutral-500">
            Read live from the active daemon, refreshed every {Math.round(SYSTEM_POLL_MS / 1000)}s while this section is
            open.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <HostStatusControls status={status} />
        </div>
      </div>
      <HostStatusView status={status} />
    </div>
  );
};
