/**
 * Pure decisions behind Settings → Plugins (spec §6): what the search shows,
 * when turning a plugin on needs a confirmation, and which controls are
 * usable. Every plugin is turned on once for the whole server. No React import.
 */

import {
  type PluginEngineInfo,
  type PluginInfo,
  type SecretVaultSummary,
  TS_RUST_PLUGIN_ID,
  type TsCheckerEngine
} from "@orquester/api";

/** Shown before Better TS Typecheck is turned on (spec §6, first-enable confirmation). */
export const FIRST_ENABLE_MESSAGE =
  "Both engines, tsrs and tsc-rs, run TypeScript 7. Projects whose tsconfig or code isn't TS 7-ready will fail their typecheck while this is on. Tabs, chats and workflow runs already open keep the normal tsc until reopened.";

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

/**
 * What flipping a plugin's toggle to `enable` does: nothing (`blocked`:
 * turning it on where the server has no build of it), ask first (`confirm`:
 * turning Better TS Typecheck on while it is off), or go ahead (`apply`). Turning a plugin
 * off is always allowed.
 */
export type PluginToggleDecision = "blocked" | "confirm" | "apply";

export function pluginToggleDecision(plugin: PluginInfo, enable: boolean): PluginToggleDecision {
  if (!enable) return "apply";
  if (plugin.platform !== "supported") return "blocked";
  if (plugin.id === TS_RUST_PLUGIN_ID && !plugin.enabled) return "confirm";
  return "apply";
}

export interface PluginControls {
  /** The server-wide on/off toggle (row and detail panel). */
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
 * blocks the version actions but not the toggle. A plugin with no updates
 * (it ships with the app) has no version actions at all.
 */
export function pluginControls(plugin: PluginInfo, pending: boolean): PluginControls {
  const supported = plugin.platform === "supported";
  const idle = plugin.job === "idle" && !pending;
  const versions = plugin.updates;
  return {
    // On where there is no build only through a plugins.json carried over: it can still be turned off.
    toggle: (supported || plugin.enabled) && !pending,
    checkForUpdates: versions && supported && idle,
    showRollback: versions && plugin.previous !== null,
    rollback: versions && supported && idle && plugin.previous !== null,
    removeDownloads: versions && idle && plugin.current !== null && !plugin.enabled
  };
}

/** One choice in the Engine control. */
export interface PluginEngineOption extends PluginEngineInfo {
  selected: boolean;
  /** Not choosable: no build here, or one of this section's requests is in flight. */
  disabled: boolean;
  /** Why it can't be chosen here, or null. */
  hint: string | null;
}

/**
 * The Engine control's choices, or none for a plugin without engines (or a
 * daemon from before the choice). Choosing the selected one does nothing.
 */
export function pluginEngineOptions(plugin: PluginInfo, pending: boolean): PluginEngineOption[] {
  if (!plugin.engine || !plugin.engines) return [];
  return plugin.engines.map((engine) => {
    const supported = engine.platform === "supported";
    return {
      ...engine,
      selected: engine.id === plugin.engine,
      disabled: pending || !supported,
      hint: supported ? null : "No build for this server's operating system and processor."
    };
  });
}

/** The active engine's display name, or null when the plugin has no engines. */
export function pluginEngineLabel(plugin: PluginInfo): string | null {
  return plugin.engines?.find((engine) => engine.id === plugin.engine)?.label ?? null;
}

/** Whether choosing `engine` sends anything: another engine than the active one, choosable here. */
export function pluginEngineChange(plugin: PluginInfo, engine: TsCheckerEngine, pending: boolean): boolean {
  const option = pluginEngineOptions(plugin, pending).find((candidate) => candidate.id === engine);
  return option !== undefined && !option.selected && !option.disabled;
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

/** One vault in the Secret files plugin's detail panel. */
export interface SecretVaultRow {
  workspace: string;
  repoKey: string;
  /** The repo's custom label, else its key without the host. */
  label: string;
  fileCount: number;
  clonesNeedingAttention: number;
}

/** `host/owner/repo` → `owner/repo`. */
const repoKeyWithoutHost = (repoKey: string): string => {
  const slash = repoKey.indexOf("/");
  return slash === -1 ? repoKey : repoKey.slice(slash + 1);
};

const naturally = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The Secret files plugin's vaults as listed: by workspace, then label. */
export function secretVaultRows(
  vaults: Iterable<Pick<SecretVaultSummary, "workspace" | "repoKey" | "fileCount" | "clonesNeedingAttention">>,
  identities: ReadonlyMap<string, { label?: string }>
): SecretVaultRow[] {
  return [...vaults]
    .map((vault) => ({
      workspace: vault.workspace,
      repoKey: vault.repoKey,
      label: identities.get(vault.repoKey)?.label ?? repoKeyWithoutHost(vault.repoKey),
      fileCount: vault.fileCount,
      clonesNeedingAttention: vault.clonesNeedingAttention
    }))
    .sort((a, b) => naturally(a.workspace, b.workspace) || naturally(a.label, b.label) || naturally(a.repoKey, b.repoKey));
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
