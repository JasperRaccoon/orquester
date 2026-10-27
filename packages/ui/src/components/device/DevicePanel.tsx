/**
 * The Device panel (right rail, devices spec §10): the visible chat's devices.
 *
 * - Tabs over the chat's leases (name, platform glyph, controller dot; middle-click or × releases)
 *   and "+" for the picker.
 * - The picker (empty state): profiles grouped Android / iPhone & iPad with each host's readiness;
 *   rows that can't open say why and link to Settings → Devices.
 * - A booting device's steps with elapsed time, a failed boot or a lost device with Retry.
 * - A ready device live (`DeviceLiveView`): stream, input, toolbar, controller pill, agent overlay
 *   and the action log; streams connect only while the panel is on screen, and need the HTTP
 *   transport ("Live devices need a server connection" on the desktop app's unix socket).
 * - Docked, the toolbar is a rail beside the device; on a phone it is a bar under it and Back
 *   closes the picker first.
 *
 * The rail mounts it only while the Device simulators plugin is on.
 */

import React from "react";
import { AlertTriangle, Info, Link2Off, X } from "lucide-react";

import { DEVICE_PROFILES, deviceRoutes, isActiveDeviceLease, type DeviceLeaseSummary, type DeviceProfile } from "@orquester/api";

import { useBackClose } from "../../hooks/use-back-close";
import { useIsDesktop } from "../../hooks/use-media-query";
import { loadBoxOffers } from "../../lib/boxes/store";
import { cn } from "../../lib/cn";
import { readDevicePanelPrefs, writeDevicePanelPrefs } from "../../lib/devices/device-view-prefs";
import { useDeviceActions, useDeviceHosts, useDevicesLoaded, useDevicesSettings, useDevicesState, useThreadDeviceLeases } from "../../lib/devices/hooks";
import { useLocalDeviceActions } from "../../lib/devices/local-actions";
import { selectDeviceLease, useSelectedDeviceLease } from "../../lib/devices/panel-focus";
import { loadDeviceActions, openDevice, releaseDevice } from "../../lib/devices/store";
import { useAppStore } from "../../store/app";
import type { RightRailPanelProps } from "../right-rail/types";
import { actionLogRows } from "./action-log.logic";
import { activeLeaseOf, bootElapsed, bootSteps, devicePanelView, leaseName, pickerGroups } from "./device-panel.logic";
import { DeviceActionLog } from "./DeviceActionLog";
import { DeviceLiveView } from "./DeviceLiveView";
import { DeviceBooting, DeviceGone, DevicePicker, DeviceTabs, PanelMessage } from "./DeviceStates";

function errorText(err: unknown): string {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
}

/** A display tick for elapsed times (not a wait). */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** The Mac host's $/h for the configured size, from the boxes quote (null when unknown or the plugin is off). */
function useMacHourlyUsd(provider: string | undefined, size: string | undefined, wanted: boolean): number | null {
  const api = useAppStore((s) => s.api);
  const [hourly, setHourly] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!api || !provider || !size || !wanted) return undefined;
    const abort = new AbortController();
    loadBoxOffers(api, provider as Parameters<typeof loadBoxOffers>[1], "macos", { signal: abort.signal }).then(
      (offers) => setHourly(offers.sizes.find((offer) => offer.id === size)?.hourlyUsd ?? null),
      () => setHourly(null)
    );
    return () => abort.abort();
  }, [api, provider, size, wanted]);
  return hourly;
}

/** The chat's agent, as the registry names it ("Claude"). */
function useAgentName(threadId: string | null): string {
  return useAppStore((s) => {
    const session = threadId ? s.sessions.find((entry) => entry.id === threadId) : undefined;
    if (!session) return "The agent";
    return s.registry.agents.find((agent) => agent.id === session.refId)?.name ?? "The agent";
  });
}

export const DevicePanel: React.FC<RightRailPanelProps> = ({ sessionId, variant }) => {
  const api = useAppStore((s) => s.api);
  const openSettings = useAppStore((s) => s.openSettings);
  const isDesktop = useIsDesktop();
  const loaded = useDevicesLoaded();
  const leases = useThreadDeviceLeases(sessionId);
  const hosts = useDeviceHosts();
  const settings = useDevicesSettings();
  const storeProfiles = useDevicesState((state) => state.profiles);
  const profiles = storeProfiles.length > 0 ? storeProfiles : DEVICE_PROFILES;
  const selectedId = useSelectedDeviceLease(sessionId);
  const [picking, setPicking] = React.useState(false);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [logOpen, setLogOpen] = React.useState(() => readDevicePanelPrefs().logOpen);
  const agentName = useAgentName(sessionId);

  // Streams need the HTTP transport (the desktop app's unix socket has none).
  const streamsAvailable = React.useMemo(() => (api ? api.deviceSocketUrl(deviceRoutes.socket("local", "probe")) !== null : false), [api]);

  const view = devicePanelView({ sessionId, loaded, leases, selectedLeaseId: selectedId, picking, streamsAvailable });
  const active = activeLeaseOf(leases, selectedId);
  const liveCount = leases.filter((lease) => isActiveDeviceLease(lease)).length;
  const maxPerChat = settings?.maxLeasesPerChat ?? 3;

  // A chat switch drops the picker.
  React.useEffect(() => {
    setPicking(false);
    setPickError(null);
  }, [sessionId]);
  // The notice line clears itself.
  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), notice.tone === "danger" ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  // Phone: Back closes the picker (over the chat's devices) before leaving the section.
  useBackClose(picking && leases.length > 0, () => setPicking(false));

  // The action log of the device on screen: loaded once per lease, followed by events after.
  const activeId = view.kind === "live" || view.kind === "suspended" ? view.lease.id : null;
  const [logState, setLogState] = React.useState<{ leaseId: string | null; loading: boolean; error: string | null }>({ leaseId: null, loading: false, error: null });
  React.useEffect(() => {
    if (!api || !activeId) return undefined;
    const abort = new AbortController();
    setLogState({ leaseId: activeId, loading: true, error: null });
    loadDeviceActions(api, activeId, abort.signal).then(
      () => setLogState({ leaseId: activeId, loading: false, error: null }),
      (err) => {
        if (!abort.signal.aborted) setLogState({ leaseId: activeId, loading: false, error: errorText(err) });
      }
    );
    return () => abort.abort();
  }, [api, activeId]);
  const actions = useDeviceActions(activeId);
  const local = useLocalDeviceActions(activeId);
  const logRows = React.useMemo(() => actionLogRows(actions, local, agentName), [actions, local, agentName]);

  const toggleLog = () => {
    const next = !logOpen;
    setLogOpen(next);
    writeDevicePanelPrefs({ logOpen: next });
  };

  const iosWanted = view.kind === "picker" || view.kind === "booting";
  const macHourly = useMacHourlyUsd(settings?.ios.provider, settings?.ios.size, iosWanted && (settings?.ios.enabled ?? false));
  const now = useNow(view.kind === "booting");

  const open = (profile: Pick<DeviceProfile, "id" | "platform">, replacing?: DeviceLeaseSummary) => {
    if (!api || !sessionId) return;
    setOpening(profile.id);
    setPickError(null);
    setBusy(true);
    openDevice(api, { threadId: sessionId, platform: profile.platform, profile: profile.id, ...(replacing ? { fresh: true } : {}) })
      .then((lease) => {
        selectDeviceLease(sessionId, lease.id);
        setPicking(false);
        if (replacing) void releaseDevice(api, replacing.id).catch(() => undefined);
      })
      .catch((err) => {
        const text = errorText(err);
        if (replacing) setNotice({ text, tone: "danger" });
        else setPickError(text);
      })
      .finally(() => {
        setOpening(null);
        setBusy(false);
      });
  };

  const release = (leaseId: string, shutdown = false) => {
    if (!api) return;
    setBusy(true);
    releaseDevice(api, leaseId, shutdown)
      .then(() => setNotice({ text: shutdown ? "Device powered off and released" : "Device released", tone: "info" }))
      .catch((err) => setNotice({ text: errorText(err), tone: "danger" }))
      .finally(() => setBusy(false));
  };

  const goSettings = () => openSettings("devices");
  const layout = variant === "sheet" || !isDesktop ? "bar" : "rail";
  const nameOf = (lease: DeviceLeaseSummary) => leaseName(lease, profiles);
  const formFactorOf = (lease: DeviceLeaseSummary) => profiles.find((profile) => profile.id === lease.profile)?.formFactor ?? "phone";

  let body: React.ReactNode;
  switch (view.kind) {
    case "no-chat":
      body = <PanelMessage title="Open an agent chat to see its devices" hint="Each chat has its own simulators and emulators; the agent drives them and you watch here." />;
      break;
    case "loading":
      body = <PanelMessage title="Loading devices…" />;
      break;
    case "picker":
      body = (
        <DevicePicker
          groups={pickerGroups({ profiles, hosts, settings, chatLeases: liveCount, macHourlyUsd: macHourly })}
          opening={opening}
          error={pickError}
          adding={leases.length > 0}
          onOpen={(profile) => open(profile)}
          onSettings={goSettings}
          {...(leases.length > 0 ? { onCancel: () => setPicking(false) } : {})}
        />
      );
      break;
    case "booting": {
      const hasMac = hosts.some((host) => host.kind !== "local" && host.platforms.includes("ios") && host.status === "ready");
      body = (
        <DeviceBooting
          lease={view.lease}
          name={nameOf(view.lease)}
          formFactor={formFactorOf(view.lease)}
          steps={bootSteps(view.lease, now, { hourlyUsd: macHourly, rentingNeeded: !hasMac || view.lease.progress?.step === "rent-host" })}
          elapsed={bootElapsed(view.lease, now)}
          failed={view.failed}
          busy={busy}
          onRetry={() => open({ id: view.lease.profile, platform: view.lease.platform }, view.lease)}
          onRelease={() => release(view.lease.id)}
        />
      );
      break;
    }
    case "lost":
    case "suspended":
      body = (
        <DeviceGone
          lease={view.lease}
          name={nameOf(view.lease)}
          formFactor={formFactorOf(view.lease)}
          kind={view.kind}
          busy={busy}
          onRetry={() => open({ id: view.lease.profile, platform: view.lease.platform }, view.lease)}
          onRelease={() => release(view.lease.id)}
        />
      );
      break;
    case "live":
      body = view.stream.ok ? (
        <DeviceLiveView
          key={view.lease.id}
          api={api}
          lease={view.lease}
          name={nameOf(view.lease)}
          agentName={agentName}
          sessionId={sessionId!}
          visible
          layout={layout}
          actions={actions}
          logRows={logRows}
          logOpen={logOpen}
          onToggleLog={toggleLog}
          logLoading={logState.leaseId === view.lease.id && logState.loading}
          logError={logState.leaseId === view.lease.id ? logState.error : null}
          releasing={busy}
          onRelease={(shutdown) => release(view.lease.id, shutdown)}
          onNotice={(text, tone = "info") => setNotice({ text, tone })}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelMessage title={view.stream.message} hint={view.stream.reason === "transport" ? "Connect to this server over HTTP (the web app, or a remote connection in the desktop app) to watch and drive it. Its actions still show below." : undefined}>
            {view.stream.reason === "transport" ? <Link2Off size={18} aria-hidden className="mt-2 text-neutral-600" /> : null}
          </PanelMessage>
          <div className="shrink-0">
            <DeviceActionLog rows={logRows} open={logOpen} onToggle={toggleLog} loading={logState.loading} error={logState.error} />
          </div>
        </div>
      );
      break;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-device-panel="" data-view={view.kind}>
      {sessionId !== null && loaded && leases.length > 0 ? (
        <DeviceTabs
          tabs={leases.map((lease) => ({ lease, name: nameOf(lease) }))}
          selectedId={active?.id ?? null}
          picking={picking}
          canAdd={liveCount < maxPerChat}
          onSelect={(leaseId) => {
            setPicking(false);
            selectDeviceLease(sessionId, leaseId);
          }}
          onRelease={(leaseId) => release(leaseId)}
          onAdd={() => setPicking((value) => !value)}
        />
      ) : null}
      {notice ? (
        <div
          role={notice.tone === "danger" ? "alert" : "status"}
          className={cn(
            "absolute left-1/2 top-12 z-30 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1 text-[11.5px] shadow-lg ring-1",
            notice.tone === "danger" ? "bg-danger-soft text-danger ring-danger/40" : "bg-neutral-900 text-neutral-200 ring-neutral-700"
          )}
        >
          {notice.tone === "danger" ? <AlertTriangle size={12} aria-hidden className="shrink-0" /> : <Info size={12} aria-hidden className="shrink-0 text-neutral-400" />}
          <span className="min-w-0 truncate">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="-mr-1 rounded-full p-0.5 opacity-70 hover:opacity-100">
            <X size={11} aria-hidden />
          </button>
        </div>
      ) : null}
      {body}
    </div>
  );
};
