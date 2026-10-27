/**
 * Devices — what the Device panel itself did on each lease (buttons, gestures, screenshots, control
 * changes), for the action log beside the daemon's rows. In memory only, capped per lease, and
 * cleared on a connection switch with the rest of the devices state.
 */

import { useSyncExternalStore } from "react";

import type { LocalDeviceAction } from "../../components/device/action-log.logic";

const LIMIT = 100;
let byLease: Readonly<Record<string, readonly LocalDeviceAction[]>> = {};
const listeners = new Set<() => void>();
let counter = 0;
const EMPTY: readonly LocalDeviceAction[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

/** Log one panel action; `at` defaults to now. */
export function logLocalDeviceAction(leaseId: string, summary: string, options: { ok?: boolean; error?: string; at?: string } = {}): void {
  counter += 1;
  const entry: LocalDeviceAction = {
    id: `${Date.now().toString(36)}-${counter}`,
    leaseId,
    at: options.at ?? new Date().toISOString(),
    summary,
    ok: options.ok ?? true,
    ...(options.error ? { error: options.error } : {})
  };
  byLease = { ...byLease, [leaseId]: [...(byLease[leaseId] ?? EMPTY), entry].slice(-LIMIT) };
  emit();
}

export function localDeviceActions(leaseId: string): readonly LocalDeviceAction[] {
  return byLease[leaseId] ?? EMPTY;
}

export function resetLocalDeviceActions(): void {
  byLease = {};
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocalDeviceActions(leaseId: string | null | undefined): readonly LocalDeviceAction[] {
  const snapshot = () => (leaseId ? localDeviceActions(leaseId) : EMPTY);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
