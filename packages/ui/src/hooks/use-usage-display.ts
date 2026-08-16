import { useSyncExternalStore } from "react";
import {
  getUsageNow,
  getUsageResetFormat,
  setUsageResetFormat,
  subscribeUsageResetFormat,
  subscribeUsageTick,
  type UsageResetFormat
} from "../lib/usage-display";

/**
 * The persisted reset-time display format, shared by every usage surface (the
 * top-bar panel and the settings overview stay in sync without round-tripping
 * through the daemon).
 */
export function useUsageResetFormat(): [UsageResetFormat, (format: UsageResetFormat) => void] {
  // Same getter for the server snapshot: the readers are localStorage-guarded,
  // so they answer with the default anywhere `localStorage` is absent.
  const format = useSyncExternalStore(
    subscribeUsageResetFormat,
    getUsageResetFormat,
    getUsageResetFormat
  );
  return [format, setUsageResetFormat];
}

/**
 * The shared minute-ticking "now" (ms epoch) relative reset times render
 * against. One process-wide interval drives every subscriber, so a panel with a
 * dozen bars still costs a single timer.
 */
export function useUsageNow(): number {
  return useSyncExternalStore(subscribeUsageTick, getUsageNow, getUsageNow);
}
