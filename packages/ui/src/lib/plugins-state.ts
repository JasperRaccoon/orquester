/**
 * Shape checks for what the daemon sends about built-in plugins: the
 * `GET /api/plugins` answer, the `plugins.changed` broadcast and the plugin
 * routes' answers. A payload that fails its check is dropped rather than
 * allowed to reach shared UI state.
 */

import {
  isPluginId,
  type PluginInfo,
  type PluginInstalledVersionInfo,
  type PluginLastErrorInfo,
  type PluginsResponse
} from "@orquester/api";

const PLATFORMS = new Set(["supported", "unsupported"]);
const SCOPES = new Set(["workspace", "global"]);
const JOBS = new Set(["idle", "checking", "installing"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string, or null for null/absent (a daemon may drop an empty optional field). */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseInstalledVersion(value: unknown): PluginInstalledVersionInfo | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    value.version === "" ||
    typeof value.integrity !== "string" ||
    typeof value.installedAt !== "string"
  ) {
    return undefined;
  }
  return { version: value.version, integrity: value.integrity, installedAt: value.installedAt };
}

function parseLastError(value: unknown): PluginLastErrorInfo | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.at !== "string" ||
    typeof value.step !== "string" ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  return { at: value.at, step: value.step, message: value.message };
}

/**
 * A `PluginInfo` the Plugins section can render, or null. Every field the
 * section reads is checked; nullable fields may also be absent. `scope`,
 * `updates` and `enabled` may be absent too (a daemon from before global
 * plugins): such a plugin is a per-workspace one the daemon keeps up to date.
 */
export function parsePluginInfo(value: unknown): PluginInfo | null {
  if (
    !isRecord(value) ||
    !isPluginId(value.id) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !isRecord(value.source) ||
    typeof value.source.label !== "string" ||
    typeof value.source.url !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.platform !== "string" ||
    !PLATFORMS.has(value.platform) ||
    !Array.isArray(value.enabledWorkspaces) ||
    !value.enabledWorkspaces.every((w) => typeof w === "string") ||
    typeof value.job !== "string" ||
    !JOBS.has(value.job) ||
    (value.scope !== undefined && (typeof value.scope !== "string" || !SCOPES.has(value.scope))) ||
    (value.updates !== undefined && typeof value.updates !== "boolean") ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean")
  ) {
    return null;
  }
  const enabledWorkspaces = value.enabledWorkspaces as string[];
  const current = parseInstalledVersion(value.current);
  const previous = parseInstalledVersion(value.previous);
  const skippedVersion = optionalString(value.skippedVersion);
  const lastCheckAt = optionalString(value.lastCheckAt);
  const lastError = parseLastError(value.lastError);
  if (
    current === undefined ||
    previous === undefined ||
    skippedVersion === undefined ||
    lastCheckAt === undefined ||
    lastError === undefined
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    source: { label: value.source.label, url: value.source.url },
    provider: value.provider,
    scope: (value.scope as PluginInfo["scope"] | undefined) ?? "workspace",
    updates: (value.updates as boolean | undefined) ?? true,
    platform: value.platform as PluginInfo["platform"],
    enabled: (value.enabled as boolean | undefined) ?? enabledWorkspaces.length > 0,
    enabledWorkspaces,
    current,
    previous,
    skippedVersion,
    lastCheckAt,
    lastError,
    job: value.job as PluginInfo["job"]
  };
}

/**
 * A `PluginsResponse`, or null when it is not one. Entries for a plugin id
 * this client does not know (a newer daemon's plugin) are left out; a known
 * plugin with a malformed entry rejects the whole response, so a bad payload
 * never makes a plugin vanish from the list.
 */
export function parsePluginsResponse(value: unknown): PluginsResponse | null {
  if (!isRecord(value) || !Array.isArray(value.plugins)) {
    return null;
  }
  const plugins: PluginInfo[] = [];
  for (const entry of value.plugins) {
    if (isRecord(entry) && typeof entry.id === "string" && !isPluginId(entry.id)) {
      continue;
    }
    const plugin = parsePluginInfo(entry);
    if (!plugin) {
      return null;
    }
    plugins.push(plugin);
  }
  return { plugins };
}

/**
 * The state of plugin `id` in a plugin route's answer, or null when the answer
 * carries none. Accepts the plugin's own `PluginInfo` and a whole
 * `PluginsResponse`, so the caller does not depend on which one a route sends.
 */
export function parsePluginActionResult(value: unknown, id: string): PluginInfo | null {
  if (isRecord(value) && Array.isArray(value.plugins)) {
    return parsePluginsResponse(value)?.plugins.find((p) => p.id === id) ?? null;
  }
  const plugin = parsePluginInfo(value);
  return plugin && plugin.id === id ? plugin : null;
}

/** Whether built-in plugin `id` is turned on for the whole server (a global plugin). */
export function isGlobalPluginEnabled(plugins: readonly PluginInfo[] | null, id: string): boolean {
  const plugin = plugins?.find((p) => p.id === id);
  return plugin !== undefined && plugin.scope === "global" && plugin.enabled;
}

/** Replace a plugin by id, or append it. */
export function upsertPluginIn(plugins: PluginInfo[] | null, plugin: PluginInfo): PluginInfo[] {
  if (!plugins) return [plugin];
  const at = plugins.findIndex((p) => p.id === plugin.id);
  if (at === -1) return [...plugins, plugin];
  const next = plugins.slice();
  next[at] = plugin;
  return next;
}
