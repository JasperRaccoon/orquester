/**
 * What the fleet view's buttons do: open a lease in its chat's Device panel, and a host's Drain,
 * Destroy and Warm caches. Host changes come back as `devices.hosts` / `devices.pool` events;
 * these only start them and say when the daemon refused.
 */

import { DEVICE_PLATFORM_LABELS, type DeviceHostSummary, type DeviceLeaseSummary } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";
import { boxesErrorText } from "../../lib/boxes/errors";
import { showDeviceInPanel } from "../../lib/devices/panel-focus";
import { requestSessionDeepLink } from "../../lib/session-deep-link";
import { useAppStore } from "../../store/app";

/** The calls the host actions make — `ApiClient` satisfies it; tests pass a fake. */
export type FleetApi = Pick<ApiClient, "setDeviceHostDraining" | "destroyDeviceHost" | "warmDeviceCaches">;

/**
 * Open the chat that holds `lease` with its Device panel on that lease. The chat opens through
 * the session deep link (the daemon says which project it is in), which leaves the fleet view.
 */
export function openLeaseInChat(lease: Pick<DeviceLeaseSummary, "id" | "threadId">, options: { phone?: boolean } = {}): void {
  showDeviceInPanel({ threadId: lease.threadId, leaseId: lease.id }, options);
  requestSessionDeepLink({ sessionId: lease.threadId });
}

function notice(message: string): void {
  useAppStore.getState().setNotice({ title: "Devices", message });
}

/** Drain (no new leases; destroyed once empty) or take a host back. Resolves false when refused. */
export async function setHostDraining(api: FleetApi, host: Pick<DeviceHostSummary, "id" | "label">, draining: boolean): Promise<boolean> {
  try {
    await api.setDeviceHostDraining(host.id, draining);
    return true;
  } catch (error) {
    notice(`Could not ${draining ? "drain" : "resume"} ${host.label}: ${boxesErrorText(error)}`);
    return false;
  }
}

/** Destroy a rented host (its leases end; their agents get DEVICE_LOST). Resolves false when refused. */
export async function destroyHost(api: FleetApi, host: Pick<DeviceHostSummary, "id" | "label">): Promise<boolean> {
  try {
    await api.destroyDeviceHost(host.id);
    return true;
  } catch (error) {
    notice(`Could not destroy ${host.label}: ${boxesErrorText(error)}`);
    return false;
  }
}

/** Dispatch the cache-warming run for each of the host's platforms, and say what happened. */
export async function warmHostCaches(api: FleetApi, host: Pick<DeviceHostSummary, "platforms">): Promise<void> {
  const lines: string[] = [];
  for (const platform of host.platforms) {
    const name = DEVICE_PLATFORM_LABELS[platform];
    try {
      const answer = await api.warmDeviceCaches(platform);
      lines.push(answer.message ?? (answer.started ? `Warming the ${name} caches: new hosts start from them once the run saves them.` : `The ${name} caches are already being warmed.`));
    } catch (error) {
      lines.push(`Could not warm the ${name} caches: ${boxesErrorText(error)}`);
    }
  }
  if (lines.length > 0) notice(lines.join(" "));
}
