// Built-in plugins listed in Settings → Plugins: "Better TS Typecheck" (tsc-rs,
// see docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md) and the
// Excalidraw whiteboard (docs/superpowers/specs/2026-10-15-excalidraw-whiteboard-design.md).

export const TS_RUST_PLUGIN_ID = "ts-rust";
export const EXCALIDRAW_PLUGIN_ID = "excalidraw";
export type PluginId = typeof TS_RUST_PLUGIN_ID | typeof EXCALIDRAW_PLUGIN_ID;
export const PLUGIN_IDS: readonly PluginId[] = [TS_RUST_PLUGIN_ID, EXCALIDRAW_PLUGIN_ID];

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

/**
 * Where a plugin is turned on: per workspace (`enabledWorkspaces`), or once for
 * the whole server (`enabled`).
 */
export type PluginScope = "workspace" | "global";

export interface PluginInfo {
  id: PluginId;
  name: string;
  description: string;
  source: PluginSource;
  provider: string;
  scope: PluginScope;
  /**
   * Whether the daemon downloads the plugin and keeps it up to date. When false
   * the plugin ships with the app: `current`, `previous`, `skippedVersion`,
   * `lastCheckAt` and `lastError` stay null, `job` stays idle, and the version
   * routes refuse it.
   */
  updates: boolean;
  platform: PluginPlatformSupport;
  /** On for the whole server (`scope: "global"`); for a workspace plugin, on in any existing workspace. */
  enabled: boolean;
  /** Names of existing workspaces the plugin is on for (stale names are hidden); empty for a global plugin. */
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

/** Body for PUT /api/plugins/:id (a `scope: "global"` plugin). */
export interface SetPluginEnabledRequest {
  enabled: boolean;
}

const pluginPath = (id: string): string => `/api/plugins/${encodeURIComponent(id)}`;

export const pluginRoutes = {
  list: "/api/plugins",
  plugin: (id: string): string => pluginPath(id),
  workspace: (id: string, workspace: string): string =>
    `${pluginPath(id)}/workspaces/${encodeURIComponent(workspace)}`,
  check: (id: string): string => `${pluginPath(id)}/check`,
  rollback: (id: string): string => `${pluginPath(id)}/rollback`,
  downloads: (id: string): string => `${pluginPath(id)}/downloads`
} as const;

/** The `/events` channel plugin state changes go out on. The payload is a `PluginsResponse`. */
export const PLUGINS_CHANNEL = "plugins";
export const PLUGINS_CHANGED_EVENT = "plugins.changed";
