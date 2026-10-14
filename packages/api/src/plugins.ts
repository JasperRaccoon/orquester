// Built-in plugins listed in Settings → Plugins. The first is "Better TS
// Typecheck" (tsc-rs). See docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md.

export const TS_RUST_PLUGIN_ID = "ts-rust";
export type PluginId = typeof TS_RUST_PLUGIN_ID;
export const PLUGIN_IDS: readonly PluginId[] = [TS_RUST_PLUGIN_ID];

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === "string" && (PLUGIN_IDS as readonly string[]).includes(value);
}

/** Whether the daemon's OS/CPU has a build of the plugin's tool. */
export type PluginPlatformSupport = "supported" | "unsupported";

/** The plugin's background job, if one is running. */
export type PluginJobState = "idle" | "checking" | "installing";

export interface PluginSource {
  label: string;
  url: string;
}

export interface PluginInstalledVersionInfo {
  version: string;
  integrity: string;
  installedAt: string;
}

export interface PluginLastErrorInfo {
  at: string;
  step: string;
  message: string;
}

export interface PluginInfo {
  id: PluginId;
  name: string;
  description: string;
  source: PluginSource;
  provider: string;
  platform: PluginPlatformSupport;
  /** Names of existing workspaces the plugin is on for (stale names are hidden). */
  enabledWorkspaces: string[];
  current: PluginInstalledVersionInfo | null;
  previous: PluginInstalledVersionInfo | null;
  skippedVersion: string | null;
  lastCheckAt: string | null;
  lastError: PluginLastErrorInfo | null;
  job: PluginJobState;
}

export interface PluginsResponse {
  plugins: PluginInfo[];
}

/** Body for PUT /api/plugins/:id/workspaces/:workspace. */
export interface SetPluginWorkspaceRequest {
  enabled: boolean;
}

const pluginPath = (id: string): string => `/api/plugins/${encodeURIComponent(id)}`;

export const pluginRoutes = {
  list: "/api/plugins",
  workspace: (id: string, workspace: string): string =>
    `${pluginPath(id)}/workspaces/${encodeURIComponent(workspace)}`,
  check: (id: string): string => `${pluginPath(id)}/check`,
  rollback: (id: string): string => `${pluginPath(id)}/rollback`,
  downloads: (id: string): string => `${pluginPath(id)}/downloads`
} as const;

/** The `/events` channel plugin state changes go out on. The payload is a `PluginsResponse`. */
export const PLUGINS_CHANNEL = "plugins";
export const PLUGINS_CHANGED_EVENT = "plugins.changed";
