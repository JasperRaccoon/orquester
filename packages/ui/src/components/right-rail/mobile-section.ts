/**
 * Which section a phone shows under the top bar: the tab content (`null`) or
 * one of the right rail's panels, full screen, picked in the bottom section
 * bar (`MobileSections.tsx`).
 *
 * Kept in memory only, never persisted: a reload opens on the tab content,
 * which is what a phone is showing the user almost every time. A tiny module
 * store read through `useSyncExternalStore`, like `right-rail-state.ts`.
 */

import React from "react";

import type { RightRailPanelId } from "./types";

let section: RightRailPanelId | null = null;
const listeners = new Set<() => void>();

export function mobileSection(): RightRailPanelId | null {
  return section;
}

/** Show a panel full screen, or `null` to go back to the tab content. */
export function setMobileSection(next: RightRailPanelId | null): void {
  if (next === section) return;
  section = next;
  for (const listener of listeners) listener();
}

export function subscribeMobileSection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMobileSection(): RightRailPanelId | null {
  return React.useSyncExternalStore(subscribeMobileSection, mobileSection, mobileSection);
}
