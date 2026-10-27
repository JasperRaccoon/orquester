/**
 * A device tool's chat row extras (devices spec §10.3): **Show device**, which brings the Device
 * panel up on the lease the call used, and the thumbnail of a screenshot the daemon kept (loaded
 * from the authenticated screenshot route with a query token, like a desktop socket).
 */

import React from "react";
import { ImageOff, Smartphone } from "lucide-react";

import { Modal, ModalCloseButton } from "../../../ui/modal";

import { deviceRoutes, type DeviceLeaseSummary, type DeviceToolReference } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import { useDevicesEnabled, useDevicesState } from "../../../../lib/devices/hooks";
import { showDeviceInPanel } from "../../../../lib/devices/panel-focus";
import { useAppStore } from "../../../../store/app";

/** The live lease a reference names (by lease id, else by device key), or undefined once released. */
function leaseOf(leases: readonly DeviceLeaseSummary[] | null, link: DeviceToolReference): DeviceLeaseSummary | undefined {
  if (!leases) return undefined;
  return (link.leaseId ? leases.find((lease) => lease.id === link.leaseId) : undefined) ?? leases.find((lease) => lease.key === link.device);
}

/** The device's name as the devices store knows it (a primitive, so a row re-renders only when it changes). */
export function useDeviceLinkName(link: DeviceToolReference | undefined): string | undefined {
  return useDevicesState((state) => {
    if (!link || link.name) return undefined;
    const lease = leaseOf(state.leases, link);
    return lease ? lease.name || undefined : undefined;
  });
}

/** "Show device": the Device panel on that lease; disabled once the lease ended. */
export function DeviceShowButton({ link, sessionId }: { link: DeviceToolReference; sessionId: string | undefined }): React.ReactElement | null {
  const enabled = useDevicesEnabled();
  const lease = useDevicesState((state) => leaseOf(state.leases, link));
  if (!enabled) return null;
  const threadId = lease?.threadId ?? sessionId;
  const live = lease !== undefined && threadId !== undefined;
  return (
    <button
      type="button"
      data-device-link={link.device}
      disabled={!live}
      onClick={(event) => {
        event.stopPropagation();
        if (lease && threadId) showDeviceInPanel({ threadId, leaseId: lease.id });
      }}
      onKeyDown={(event) => event.stopPropagation()}
      title={live ? `Show ${lease.name || "the device"} in the Device panel` : "That device was released"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1 text-[11px] text-neutral-400 transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        live ? "hover:bg-neutral-800/60 hover:text-neutral-100" : "cursor-default text-neutral-600"
      )}
    >
      <Smartphone size={11} strokeWidth={1.8} aria-hidden className="shrink-0" />
      <span>Show device</span>
    </button>
  );
}

/** A kept screenshot's thumbnail under the row; nothing off HTTP (no media URL). */
export function DeviceScreenshotThumb({ link, name }: { link: DeviceToolReference; name: string | undefined }): React.ReactElement | null {
  const api = useAppStore((state) => state.api);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const { leaseId, screenshotId } = link;
  const url = React.useMemo(
    () => (api && leaseId && screenshotId ? api.deviceImageUrl(deviceRoutes.screenshot(leaseId, screenshotId)) : null),
    [api, leaseId, screenshotId]
  );
  React.useEffect(() => setFailed(false), [url]);
  if (!url) return null;
  const label = `Screenshot of ${name ?? link.name ?? "the device"}`;
  if (failed) {
    return (
      <div className="ms-7 mt-1 inline-flex items-center gap-1 text-[11px] text-neutral-600" data-device-screenshot="unavailable">
        <ImageOff size={11} aria-hidden />
        Screenshot unavailable
      </div>
    );
  }
  // The full image opens in the app (a modal), never in a tab: the URL carries the bearer.
  return (
    <>
      <button
        type="button"
        title={`${label} — view full size`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="ms-7 mt-1 block w-fit rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        data-device-screenshot={screenshotId}
      >
        <img
          src={url}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="max-h-40 max-w-[min(100%,20rem)] rounded-md border border-neutral-800 bg-neutral-900 object-contain"
        />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} className="w-auto max-w-[min(92vw,56rem)] p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="truncate text-sm text-neutral-300">{label}</p>
          <ModalCloseButton onClose={() => setOpen(false)} />
        </div>
        <img src={url} alt={label} className="max-h-[80vh] max-w-full rounded-md object-contain" />
      </Modal>
    </>
  );
}
