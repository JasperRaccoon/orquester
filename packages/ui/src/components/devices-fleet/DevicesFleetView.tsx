/**
 * The Devices fleet view (devices phase 2 §2.9): a server-level view, beside Knowledge, of every
 * leased device — grouped under its host's card, each with a ~1 fps thumbnail polled only while
 * on screen — and the pool's header. It reads the devices store (hosts, leases, the pool summary
 * from `devices.pool`, settings, action logs) and loads it once more when it opens before the
 * store did, so a failed load shows here with a retry.
 *
 * The main view mounts it lazily, only while it is open (`MainView.tsx`).
 */

import React from "react";
import { AlertTriangle, Loader2, RotateCw, TabletSmartphone } from "lucide-react";

import type { DeviceLeaseSummary } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";
import { boxesErrorText } from "../../lib/boxes/errors";
import { useNow } from "../../lib/boxes/hooks";
import { useDevicesLoaded, useDevicesState } from "../../lib/devices/hooks";
import { devicesStore, loadDeviceActions, loadDevices } from "../../lib/devices/store";
import { useAppStore } from "../../store/app";
import { Button } from "../ui";
import { HostCard, UnknownHostCard } from "./HostCard";
import { LeaseCard } from "./LeaseCard";
import { PoolHeader } from "./PoolHeader";
import { chatRef, costSharers, countFleetLeases, groupFleet, lastAction, poolView, thumbnailPath } from "./fleet.logic";
import type { ThumbnailDeps } from "./thumbnail-poller";

/** How often uptimes, costs and "ago" times move. */
const CLOCK_MS = 15_000;

export interface DevicesFleetViewProps {
  /** Tests and the dev harness: the thumbnails' clock and fetch. */
  thumbnailDeps?: ThumbnailDeps;
}

type ThumbnailApi = Pick<ApiClient, "deviceMediaUrl">;

/** The thumbnail URL of a lease, or why there is none although it streams. */
function thumbnailOf(api: ThumbnailApi | null, lease: DeviceLeaseSummary): { url: string | null; unavailable: string | null } {
  const path = thumbnailPath(lease);
  if (path === null) return { url: null, unavailable: null };
  const url = api ? api.deviceMediaUrl(path) : null;
  return url ? { url, unavailable: null } : { url: null, unavailable: "Thumbnails need a server connection" };
}

const EmptyFleet: React.FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => (
  <div className="flex flex-col items-center rounded-2xl border border-dashed border-neutral-800 px-6 py-10 text-center" data-fleet-empty="">
    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-900 ring-1 ring-neutral-800">
      <TabletSmartphone size={20} aria-hidden className="text-neutral-400" />
    </div>
    <h2 className="mt-3 text-sm font-medium text-neutral-100">No devices are leased</h2>
    <p className="mt-1.5 max-w-md text-xs leading-relaxed text-neutral-400">
      An agent gets an iOS simulator or Android emulator by calling <code className="rounded bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-300">open_device</code> in its chat, and you can open one
      from a chat's Device panel. Each leased device shows up here with a live thumbnail, under the host it runs on — this host first, then rented pool hosts as demand grows.
    </p>
    <Button variant="outline" size="sm" className="mt-4" onClick={onOpenSettings}>
      Device settings
    </Button>
  </div>
);

const LoadingFleet: React.FC = () => (
  <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-neutral-500" data-fleet-loading="">
    <Loader2 size={15} aria-hidden className="animate-spin" />
    Loading the fleet…
  </div>
);

const FleetError: React.FC<{ message: string; onRetry: () => void; retrying: boolean }> = ({ message, onRetry, retrying }) => (
  <div className="mx-auto mt-12 flex max-w-md flex-col items-center px-6 text-center" role="alert" data-fleet-error="">
    <AlertTriangle size={20} aria-hidden className="text-warn" />
    <h2 className="mt-2 text-sm font-medium text-neutral-100">Couldn't load the devices</h2>
    <p className="mt-1 text-xs text-neutral-400">{message}</p>
    <Button variant="outline" size="sm" className="mt-4" onClick={onRetry} disabled={retrying}>
      {retrying ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <RotateCw size={13} aria-hidden />}
      Try again
    </Button>
  </div>
);

export const DevicesFleetView: React.FC<DevicesFleetViewProps> = ({ thumbnailDeps }) => {
  const api = useAppStore((s) => s.api);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useAppStore((s) => s.registry.agents);
  const openSettings = useAppStore((s) => s.openSettings);
  const loaded = useDevicesLoaded();
  const hosts = useDevicesState((s) => s.hosts);
  const leases = useDevicesState((s) => s.leases);
  const pool = useDevicesState((s) => s.pool);
  const settings = useDevicesState((s) => s.settings);
  const actions = useDevicesState((s) => s.actions);
  const now = useNow(CLOCK_MS);

  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const load = React.useCallback(() => {
    if (!api) return;
    setRetrying(true);
    loadDevices(api)
      .then(() => setLoadError(null))
      .catch((error: unknown) => setLoadError(boxesErrorText(error, "The daemon did not answer.")))
      .finally(() => setRetrying(false));
  }, [api]);
  // The store loads with the plugin; one more try when the view opens before it has.
  React.useEffect(() => {
    if (!devicesStore.getState().leases) load();
  }, [load]);

  // Each card's action log loads once, when it first comes on screen; events extend it after.
  const askedActions = React.useRef(new Set<string>());
  const onVisible = React.useCallback(
    (leaseId: string) => {
      if (!api || askedActions.current.has(leaseId) || devicesStore.getState().actions[leaseId]) return;
      askedActions.current.add(leaseId);
      void loadDeviceActions(api, leaseId).catch(() => undefined);
    },
    [api]
  );

  const groups = React.useMemo(() => groupFleet(hosts, leases), [hosts, leases]);
  const header = React.useMemo(() => poolView(pool, settings, hosts, now), [pool, settings, hosts, now]);
  const openDeviceSettings = React.useCallback(() => openSettings("devices"), [openSettings]);

  if (!loaded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-devices-fleet="">
        {loadError ? <FleetError message={loadError} onRetry={load} retrying={retrying} /> : <LoadingFleet />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-devices-fleet="">
      <PoolHeader view={header} onOpenSettings={openDeviceSettings} />
      <div className="mx-auto w-full max-w-[1400px] space-y-7 px-3 py-4 md:px-6 md:py-6">
        {countFleetLeases(groups) === 0 ? <EmptyFleet onOpenSettings={openDeviceSettings} /> : null}
        {groups.map((group) => {
          const sharers = costSharers(group.leases);
          return (
            <section key={group.hostId} aria-label={group.host?.label ?? group.hostId} data-fleet-group={group.hostId}>
              {group.host ? <HostCard host={group.host} leaseCount={sharers} now={now} api={api} /> : <UnknownHostCard hostId={group.hostId} />}
              {group.leases.length > 0 ? (
                <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]" aria-label="Devices">
                  {group.leases.map((lease) => {
                    const thumb = thumbnailOf(api, lease);
                    return (
                      <LeaseCard
                        key={lease.id}
                        lease={lease}
                        host={group.host}
                        sharers={sharers}
                        chat={chatRef(lease.threadId, sessions, agents)}
                        lastAction={lastAction(actions[lease.id])}
                        thumbnailUrl={thumb.url}
                        thumbnailUnavailable={thumb.unavailable}
                        now={now}
                        onVisible={onVisible}
                        thumbnailDeps={thumbnailDeps}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-2 px-1 text-xs text-neutral-600">No devices on this host.</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default DevicesFleetView;
