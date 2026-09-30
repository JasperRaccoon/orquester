import React from "react";
import { Loader2, RefreshCw, ServerOff } from "lucide-react";
import type { SystemPortsResponse, SystemProcessesResponse, SystemResourcesResponse } from "@orquester/api";
import { Badge, EmptyState, Notice, SettingsSection } from "../settings/primitives";
import { PortsTable } from "./PortsTable";
import { ProcessTreeView } from "./ProcessTree";
import { SystemResourcePanel, SystemUnsupported } from "./SystemResources";
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
    }
  };
}

/** "Live · 3s" + manual refresh, for the page header. */
export const HostStatusControls: React.FC<{ status: HostStatus }> = ({ status }) => (
  <>
    {status.live ? (
      <Badge
        tone="ok"
        title={`Refreshed every ${Math.round(SYSTEM_POLL_MS / 1000)}s while this page is open`}
        icon={<span className="h-1.5 w-1.5 rounded-full bg-ok" />}
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

/** Three placeholder tiles shaped like the loaded resource grid. */
const ResourcesSkeleton: React.FC = () => (
  <div role="status" aria-label="Reading resources…" className="grid gap-2 sm:grid-cols-3">
    {[0, 1, 2].map((i) => (
      <div key={i} className="space-y-2.5 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3.5 py-3">
        <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-800" />
        <div className="h-1.5 w-full animate-pulse rounded-full bg-neutral-800" />
        <div className="h-2.5 w-2/3 animate-pulse rounded bg-neutral-800" />
      </div>
    ))}
  </div>
);

/** Resources, processes and listening ports of the host the daemon runs on. */
export const HostStatusView: React.FC<{ status: HostStatus }> = ({ status }) => {
  const { resources, processes, ports } = status;

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

  return (
    <>
      <SettingsSection bare title="Resources" description="CPU load, memory, and the volume your workspaces live on.">
        {resources.data ? (
          <SystemResourcePanel resources={resources.data} layout="grid" />
        ) : resources.error ? (
          <Failed what="resources" message={resources.error} />
        ) : (
          <ResourcesSkeleton />
        )}
      </SettingsSection>

      <SettingsSection
        bare
        title="Processes"
        description="The daemon and everything running inside its sessions. Stopping a row SIGTERMs it and everything under it."
      >
        {processes.data ? (
          <ProcessTreeView snapshot={processes.data} onChanged={processes.refresh} />
        ) : processes.error ? (
          <Failed what="the process tree" message={processes.error} />
        ) : (
          <Pending what="the process tree" />
        )}
      </SettingsSection>

      <SettingsSection
        bare
        title="Listening ports"
        description="TCP sockets opened by those processes. Only 443 is reachable from outside the VPS, so these are copy targets, not links."
      >
        {ports.data ? (
          <PortsTable snapshot={ports.data} />
        ) : ports.error ? (
          <Failed what="listening ports" message={ports.error} />
        ) : (
          <Pending what="listening ports" />
        )}
      </SettingsSection>
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
