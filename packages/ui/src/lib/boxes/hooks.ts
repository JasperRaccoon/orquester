/**
 * Ephemeral AI VMs — the hooks that need the app store (kept out of `store.ts`,
 * which the app store itself imports).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

import { EPHEMERAL_VMS_PLUGIN_ID } from "@orquester/api";

import { isGlobalPluginEnabled } from "../plugins-state";
import { useAppStore } from "../../store/app";

/** Whether the "Ephemeral AI VMs" plugin is on for this server (every entry point hides when it's off). */
export function useBoxesEnabled(): boolean {
  return useAppStore((s) => isGlobalPluginEnabled(s.plugins, EPHEMERAL_VMS_PLUGIN_ID));
}

/**
 * A request to show the plugin in Settings → Plugins (the Runs on row's "Set
 * up more…"), held until the plugins page takes it — whether that page is
 * already mounted or mounts with the opening modal.
 */
const focusStore = createStore<{ pending: boolean }>(() => ({ pending: false }));
const subscribeFocus = (listener: () => void) => focusStore.subscribe(listener);
const focusSnapshot = () => focusStore.getState().pending;

/** Whether the plugin was asked for and not yet shown; `PluginsSettings` selects it and calls {@link takeBoxesSettingsFocus}. */
export function useBoxesSettingsFocus(): boolean {
  return useSyncExternalStore(subscribeFocus, focusSnapshot, focusSnapshot);
}

/** The plugins page showed the plugin: the request is done. */
export function takeBoxesSettingsFocus(): void {
  if (focusStore.getState().pending) focusStore.setState({ pending: false });
}

/**
 * The clock countdowns and "so far" costs render from, moving every
 * `intervalMs` while `active` (a display tick, not a wait).
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

/** Open Settings → Plugins on the Ephemeral AI VMs plugin. */
export function useOpenBoxesSettings(): () => void {
  const openSettings = useAppStore((s) => s.openSettings);
  return useCallback(() => {
    focusStore.setState({ pending: true });
    openSettings("plugins");
  }, [openSettings]);
}
