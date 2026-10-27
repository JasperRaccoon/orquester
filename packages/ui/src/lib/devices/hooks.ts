/**
 * Devices — React hooks over `store.ts` (kept apart from it: `useDevicesEnabled` reads the app
 * store, which itself imports `store.ts`).
 */

import { useMemo, useSyncExternalStore } from "react";

import { DEVICES_PLUGIN_ID, type DeviceActionEntry, type DeviceHostSummary, type DeviceLeaseSummary, type DevicePlatform, type DeviceSetupJob, type DevicesSettings } from "@orquester/api";

import { isGlobalPluginEnabled } from "../plugins-state";
import { useAppStore } from "../../store/app";
import { devicesStore, leasesOfThread, type DevicesState } from "./store";

/** Whether the "Device simulators" plugin is on for this server (every entry point hides when it's off). */
export function useDevicesEnabled(): boolean {
  return useAppStore((s) => isGlobalPluginEnabled(s.plugins, DEVICES_PLUGIN_ID));
}

const subscribe = (listener: () => void) => devicesStore.subscribe(listener);

/** A slot of the store; the selector must return a value stable between changes. */
export function useDevicesState<T>(select: (state: DevicesState) => T): T {
  const snapshot = () => select(devicesStore.getState());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const EMPTY_HOSTS: readonly DeviceHostSummary[] = [];
const EMPTY_ACTIONS: readonly DeviceActionEntry[] = [];

/** Whether the devices state has loaded on this connection. */
export function useDevicesLoaded(): boolean {
  return useDevicesState((state) => state.leases !== null);
}

export function useDeviceHosts(): readonly DeviceHostSummary[] {
  return useDevicesState((state) => state.hosts ?? EMPTY_HOSTS);
}

/** One chat's leases, oldest first. */
export function useThreadDeviceLeases(threadId: string | null | undefined): readonly DeviceLeaseSummary[] {
  const leases = useDevicesState((state) => state.leases);
  return useMemo(() => leasesOfThread(leases, threadId), [leases, threadId]);
}

/** A lease's action log as loaded and followed (empty until `loadDeviceActions`). */
export function useDeviceActions(leaseId: string | null | undefined): readonly DeviceActionEntry[] {
  return useDevicesState((state) => (leaseId ? (state.actions[leaseId] ?? EMPTY_ACTIONS) : EMPTY_ACTIONS));
}

export function useDevicesSettings(): DevicesSettings | null {
  return useDevicesState((state) => state.settings);
}

export function useDeviceSetupJob(platform: DevicePlatform): DeviceSetupJob | undefined {
  return useDevicesState((state) => state.setupJobs[platform]);
}
