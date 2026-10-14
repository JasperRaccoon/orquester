/**
 * Pure decisions behind Settings → Plugins (spec §6): which workspace the
 * section scopes to, what the search shows, when turning a plugin on needs a
 * confirmation, and which controls are usable. No React import.
 */

import type { PluginInfo } from "@orquester/api";

/** Shown before the first workspace turns a plugin on (spec §6, first-enable confirmation). */
export const FIRST_ENABLE_MESSAGE =
  "tsc-rs runs TypeScript 7. Projects whose tsconfig or code isn't TS 7-ready will fail their typecheck while this is on. Tabs, chats and workflow runs already open keep the normal tsc until reopened.";

/**
 * The workspace the section acts on: the one the user picked while it still
 * exists, else the active workspace (the open project's), else the first
 * workspace. Null when there are no workspaces.
 */
export function defaultPluginScope(
  workspaces: readonly string[],
  active: string | null,
  picked: string | null
): string | null {
  if (picked !== null && workspaces.includes(picked)) return picked;
  if (active !== null && workspaces.includes(active)) return active;
  return workspaces[0] ?? null;
}

/** Plugins whose name or description contains the query (case-insensitive). */
export function filterPlugins(plugins: readonly PluginInfo[], query: string): PluginInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...plugins];
  return plugins.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
}

/** The plugin the detail panel shows: the selected one while listed, else the first listed. */
export function selectedPlugin(listed: readonly PluginInfo[], selectedId: string | null): PluginInfo | null {
  return listed.find((p) => p.id === selectedId) ?? listed[0] ?? null;
}

export function pluginEnabledIn(plugin: PluginInfo, scope: string | null): boolean {
  return scope !== null && plugin.enabledWorkspaces.includes(scope);
}

/**
 * What flipping a plugin's toggle for `scope` to `enable` does: nothing
 * (`blocked`: unsupported platform or no workspace), ask first (`confirm`:
 * turning it on while it is on nowhere), or go ahead (`apply`).
 */
export type PluginToggleDecision = "blocked" | "confirm" | "apply";

export function pluginToggleDecision(
  plugin: PluginInfo,
  scope: string | null,
  enable: boolean
): PluginToggleDecision {
  if (plugin.platform !== "supported" || scope === null) return "blocked";
  if (enable && plugin.enabledWorkspaces.length === 0) return "confirm";
  return "apply";
}

export interface PluginControls {
  /** The per-workspace on/off toggle (row and detail panel). */
  toggle: boolean;
  checkForUpdates: boolean;
  /** Rendered only when a previous version exists. */
  showRollback: boolean;
  rollback: boolean;
  removeDownloads: boolean;
}

/**
 * Which controls are usable. `pending` is true while one of this section's
 * own requests for the plugin is in flight; a running daemon job (`job`)
 * blocks the version actions but not the toggle.
 */
export function pluginControls(plugin: PluginInfo, scope: string | null, pending: boolean): PluginControls {
  const supported = plugin.platform === "supported";
  const idle = plugin.job === "idle" && !pending;
  return {
    toggle: supported && scope !== null && !pending,
    checkForUpdates: supported && idle,
    showRollback: plugin.previous !== null,
    rollback: supported && idle && plugin.previous !== null,
    removeDownloads: idle && plugin.current !== null && plugin.enabledWorkspaces.length === 0
  };
}

/** The running job as a status label, or null when idle. */
export function pluginJobLabel(job: PluginInfo["job"]): string | null {
  if (job === "checking") return "Checking for updates…";
  if (job === "installing") return "Installing…";
  return null;
}

/** `lastError` as the warning notice shows it. */
export function pluginErrorText(error: NonNullable<PluginInfo["lastError"]>): string {
  return `${error.step}: ${error.message}`;
}

/** The source link's target when it is a web address; anything else renders as plain text. */
export function pluginSourceHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
