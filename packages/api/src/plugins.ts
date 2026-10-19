// Built-in plugins listed in Settings → Plugins: "Better TS Typecheck" (tsc-rs,
// see docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md) and the
// Excalidraw whiteboard (docs/superpowers/specs/2026-10-15-excalidraw-whiteboard-design.md).

export const TS_RUST_PLUGIN_ID = "ts-rust";
export const EXCALIDRAW_PLUGIN_ID = "excalidraw";
/** "Secret files" (docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md; contracts in `secret-files.ts`). */
export const SECRET_FILES_PLUGIN_ID = "secret-files";
/** "Ephemeral AI VMs" (docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md; contracts in `boxes.ts`). */
export const EPHEMERAL_VMS_PLUGIN_ID = "ephemeral-vms";
export type PluginId =
  | typeof TS_RUST_PLUGIN_ID
  | typeof EXCALIDRAW_PLUGIN_ID
  | typeof SECRET_FILES_PLUGIN_ID
  | typeof EPHEMERAL_VMS_PLUGIN_ID;
export const PLUGIN_IDS: readonly PluginId[] = [
  TS_RUST_PLUGIN_ID,
  EXCALIDRAW_PLUGIN_ID,
  SECRET_FILES_PLUGIN_ID,
  EPHEMERAL_VMS_PLUGIN_ID
];

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

/**
 * Which native TypeScript 7 port "Better TS Typecheck" runs in place of `tsc`:
 * tsrs (oxc-project/tsrs) or tsc-rs (pingdotgg/ts-rust). One is active at a time.
 */
export type TsCheckerEngine = "tsrs" | "tsc-rs";
export const TS_CHECKER_ENGINES: readonly TsCheckerEngine[] = ["tsrs", "tsc-rs"];

export function isTsCheckerEngine(value: unknown): value is TsCheckerEngine {
  return typeof value === "string" && (TS_CHECKER_ENGINES as readonly string[]).includes(value);
}

/** One engine the plugin can run, and whether the daemon's OS/CPU has a build of it. */
export interface PluginEngineInfo {
  id: TsCheckerEngine;
  label: string;
  description: string;
  source: PluginSource;
  platform: PluginPlatformSupport;
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
 * Where a plugin is turned on. Every built-in plugin is `"global"`: on or off
 * once for the whole server (`enabled`). `"workspace"` is what older daemons
 * sent for tsc-rs, when it was turned on per workspace.
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
  /** For a plugin with engines: supported when any engine has a build here. */
  platform: PluginPlatformSupport;
  /** On for the whole server. */
  enabled: boolean;
  /**
   * Always empty. Kept only so clients from before plugins were global still
   * parse the record (they require the array).
   */
  enabledWorkspaces: string[];
  current: PluginInstalledVersionInfo | null;
  previous: PluginInstalledVersionInfo | null;
  skippedVersion: string | null;
  lastCheckAt: string | null;
  lastError: PluginLastErrorInfo | null;
  job: PluginJobState;
  /**
   * ts-rust only: the engine in use. `current`, `previous`, `skippedVersion`,
   * `lastCheckAt`, `lastError` and `source` are this engine's. Absent from
   * daemons from before the engine choice (they ran tsc-rs).
   */
  engine?: TsCheckerEngine;
  /** ts-rust only: the engines to choose from, in display order. */
  engines?: PluginEngineInfo[];
  /**
   * boxes: plugins with per-session tooling only — how its install stands in
   * each box it was provisioned to since the daemon started (Ephemeral AI VMs
   * spec §10; the Status section shows a line for a box whose install failed).
   * Absent when no box has one, and from daemons without boxes.
   */
  boxes?: PluginBoxToolingStatus[];
}

/**
 * boxes: a plugin's tooling in one box.
 * - `installing` — being installed or updated in the box now.
 * - `ready` — installed and smoke-tested; new sessions in the box use it.
 * - `off` — the plugin is off; the box was told, and its sessions run the real tools.
 * - `unsupported` — the plugin has no build for the box's OS/CPU.
 * - `failed` — the last install failed (`message` names the step); the box keeps what it had.
 */
export type PluginBoxToolingState = "installing" | "ready" | "off" | "unsupported" | "failed";

export interface PluginBoxToolingStatus {
  boxId: string;
  state: PluginBoxToolingState;
  /** One line: what is installed ("tsrs 0.16.0"), or what failed and at which step. */
  message: string | null;
  updatedAt: string;
}

export interface PluginsResponse {
  plugins: PluginInfo[];
}

/**
 * Body for PUT /api/plugins/:id: at least one field. `engine` is for ts-rust
 * only, and must have a build on the daemon's platform.
 */
export interface SetPluginEnabledRequest {
  enabled?: boolean;
  engine?: TsCheckerEngine;
}

const pluginPath = (id: string): string => `/api/plugins/${encodeURIComponent(id)}`;

export const pluginRoutes = {
  list: "/api/plugins",
  plugin: (id: string): string => pluginPath(id),
  check: (id: string): string => `${pluginPath(id)}/check`,
  rollback: (id: string): string => `${pluginPath(id)}/rollback`,
  downloads: (id: string): string => `${pluginPath(id)}/downloads`
} as const;

/** The `/events` channel plugin state changes go out on. The payload is a `PluginsResponse`. */
export const PLUGINS_CHANNEL = "plugins";
export const PLUGINS_CHANGED_EVENT = "plugins.changed";
