// The built-in plugins Settings → Plugins lists (spec §5.2). Static on purpose:
// a later built-in plugin needs an entry here and its own service handler, and
// there is no generic plugin runtime.

import { type PluginId, type PluginInfo, TS_RUST_PLUGIN_ID } from "@orquester/api";

/** A plugin's display fields, as `PluginInfo` carries them. */
export type PluginCatalogEntry = Pick<PluginInfo, "id" | "name" | "description" | "source" | "provider">;

export const BUILT_IN_PLUGINS: readonly PluginCatalogEntry[] = [
  {
    id: TS_RUST_PLUGIN_ID,
    name: "Better TS Typecheck",
    description: "Use tsc-rs instead of tsc for faster TypeScript typechecking.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community"
  }
];

export function pluginCatalogEntry(id: PluginId): PluginCatalogEntry {
  const entry = BUILT_IN_PLUGINS.find((plugin) => plugin.id === id);
  if (!entry) {
    throw new Error(`No built-in plugin "${id}".`);
  }
  return entry;
}
