import React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { PortsTable } from "./PortsTable";
import { ProcessTreeView } from "./ProcessTree";
import { SystemResourcePanel, SystemUnsupported } from "./SystemResources";
import { SYSTEM_POLL_MS, useSystemPollEnabled, useSystemPorts, useSystemProcesses, useSystemResources } from "./use-system-status";

const Block: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <section className="space-y-2">
    <div className="min-w-0">
      <p className="text-sm text-neutral-200">{title}</p>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
    </div>
    {children}
  </section>
);

const Failed: React.FC<{ what: string; message: string }> = ({ what, message }) => (
  <p className="rounded-md border border-neutral-800 px-3 py-3 text-xs text-neutral-500">
    Could not read {what} — {message}
  </p>
);

const Pending: React.FC<{ what: string }> = ({ what }) => (
  <p className="rounded-md border border-neutral-800 px-3 py-3 text-xs text-neutral-500">Reading {what}…</p>
);

/**
 * Settings → System: the host the daemon runs on. Everything here is polled
 * (there are no push events for it) and only while this section is mounted —
 * SettingsModal renders one section at a time, so closing it stops the polling.
 */
export const SystemSettings: React.FC = () => {
  const active = useSystemPollEnabled(true);
  const resources = useSystemResources(active);
  const processes = useSystemProcesses(active);
  const ports = useSystemPorts(active);

  const refreshing = resources.loading || processes.loading || ports.loading;
  const refreshAll = () => {
    resources.refresh();
    processes.refresh();
    ports.refresh();
  };

  // The three routes share one host gate, so any settled response answers it.
  const settled = resources.data ?? processes.data ?? ports.data;
  const unavailable = resources.unavailable && processes.unavailable && ports.unavailable;

  if (unavailable) {
    return (
      <p className="rounded-lg border border-neutral-800 px-3 py-4 text-sm text-neutral-500">
        This daemon does not report host status. It predates the <code className="text-neutral-400">/api/system</code>{" "}
        routes — update it to see CPU, memory, processes and ports here.
      </p>
    );
  }

  if (settled && !settled.supported) {
    return <SystemUnsupported what="Host status" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-neutral-200">Host status</p>
          <p className="text-xs text-neutral-500">
            Read live from the active daemon, refreshed every {Math.round(SYSTEM_POLL_MS / 1000)}s while this section is
            open.
          </p>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={refreshAll}
          aria-label="Refresh host status"
          className="shrink-0 rounded-md p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <Block title="Resources" hint="CPU load, memory, and the volume your workspaces live on.">
        {resources.data ? (
          <SystemResourcePanel resources={resources.data} />
        ) : resources.error ? (
          <Failed what="resources" message={resources.error} />
        ) : (
          <Pending what="resources" />
        )}
      </Block>

      <Block
        title="Processes"
        hint="The daemon and everything running inside its sessions. Stopping a row SIGTERMs it and everything under it."
      >
        {processes.data ? (
          <ProcessTreeView snapshot={processes.data} onChanged={processes.refresh} />
        ) : processes.error ? (
          <Failed what="the process tree" message={processes.error} />
        ) : (
          <Pending what="the process tree" />
        )}
      </Block>

      <Block
        title="Listening ports"
        hint="TCP sockets opened by those processes. Only 443 is reachable from outside the VPS, so these are copy targets, not links."
      >
        {ports.data ? (
          <PortsTable snapshot={ports.data} />
        ) : ports.error ? (
          <Failed what="listening ports" message={ports.error} />
        ) : (
          <Pending what="listening ports" />
        )}
      </Block>
    </div>
  );
};
