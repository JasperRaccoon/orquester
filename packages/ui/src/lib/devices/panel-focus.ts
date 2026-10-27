/**
 * Devices — which lease the Device panel shows for each chat, and the one way every other surface
 * (a chat row's "Show device", following the agent) brings the panel up on a device.
 *
 * In memory only, like `right-rail/mobile-section.ts`: a reload shows each chat's first device. A
 * tiny module store read through `useSyncExternalStore`.
 */

import { useSyncExternalStore } from "react";

import { setMobileSection } from "../../components/right-rail/mobile-section";
import { setRightRailOpen } from "../../components/right-rail/right-rail-state";

/** The selected lease id by chat (session) id. */
let selected: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeSelectedDeviceLeases(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The lease the panel shows for `threadId`, when one was picked (it may have ended since). */
export function selectedDeviceLease(threadId: string | null | undefined): string | undefined {
  return threadId ? selected[threadId] : undefined;
}

export function selectDeviceLease(threadId: string, leaseId: string): void {
  if (selected[threadId] === leaseId) return;
  selected = { ...selected, [threadId]: leaseId };
  emit();
}

export function useSelectedDeviceLease(threadId: string | null | undefined): string | undefined {
  const snapshot = () => selectedDeviceLease(threadId);
  return useSyncExternalStore(subscribeSelectedDeviceLeases, snapshot, snapshot);
}

/** Forget every selection (a connection switch; tests). */
export function resetDevicePanelFocus(): void {
  selected = {};
  emit();
}

function phoneViewport(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && !window.matchMedia("(min-width: 768px)").matches;
  } catch {
    return false;
  }
}

/**
 * Bring the Device panel up on a lease: the docked rail on a desktop viewport, the full-screen
 * section on a phone; the desktop-only auto-follow caller explicitly keeps the docked rail.
 */
export function showDeviceInPanel(target: { threadId: string; leaseId: string }, options: { phone?: boolean } = {}): void {
  selectDeviceLease(target.threadId, target.leaseId);
  if (options.phone ?? phoneViewport()) setMobileSection("device");
  else setRightRailOpen("device");
}
