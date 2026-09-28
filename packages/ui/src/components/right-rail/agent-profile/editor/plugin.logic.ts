/**
 * The plugin installer's rules (agent profile spec §7.4): Claude, Codex and
 * Grok install a plugin from one of their marketplaces; OpenCode takes an npm
 * spec or a file path.
 */

import type {
  AgentProfileAgentId,
  AgentProfileSnapshot,
  MarketplacePluginEntry,
  PluginInstallDraft
} from "@orquester/api";

export type PluginInstallMode = "marketplace" | "spec";

export function pluginInstallMode(agent: AgentProfileAgentId): PluginInstallMode {
  return agent === "opencode" ? "spec" : "marketplace";
}

/** The agent's marketplaces by name, as its snapshot lists them. */
export function marketplaceNames(snapshot: AgentProfileSnapshot | null): string[] {
  if (!snapshot) return [];
  const names = snapshot.items.filter((item) => item.kind === "marketplace").map((item) => item.name);
  return [...new Set(names)];
}

/** Plugins whose name or description contains every word of the query; installed ones last. */
export function filterMarketplacePlugins(plugins: readonly MarketplacePluginEntry[], query: string): MarketplacePluginEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const matches = plugins.filter((plugin) => {
    const haystack = `${plugin.name} ${plugin.description ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return [...matches.filter((plugin) => !plugin.installed), ...matches.filter((plugin) => plugin.installed)];
}

export function marketplacePluginDraft(plugin: string, marketplace: string): PluginInstallDraft {
  return { plugin, marketplace };
}

export function pluginSpecError(spec: string): string | undefined {
  const trimmed = spec.trim();
  if (trimmed === "") return "Enter an npm package or a file path";
  if (/\s/.test(trimmed)) return "One package or path, without spaces";
  return undefined;
}

export function specPluginDraft(spec: string): PluginInstallDraft {
  return { spec: spec.trim() };
}

export const OPENCODE_PLUGIN_EXAMPLES = ["opencode-wakatime", "@my-org/opencode-plugin@1.2.0", "~/.config/opencode/plugin/notify.ts"];
