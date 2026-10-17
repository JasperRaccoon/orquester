// The built-in plugins Settings → Plugins lists (spec §5.2). Static on purpose:
// a later built-in plugin needs an entry here and its own service handler, and
// there is no generic plugin runtime.

import {
  EXCALIDRAW_PLUGIN_ID,
  type PluginEngineInfo,
  type PluginId,
  type PluginInfo,
  TS_RUST_PLUGIN_ID,
  type TsCheckerEngine
} from "@orquester/api";

/** A plugin's display fields and kind, as `PluginInfo` carries them. */
export type PluginCatalogEntry = Pick<
  PluginInfo,
  "id" | "name" | "description" | "source" | "provider" | "scope" | "updates"
>;

export const BUILT_IN_PLUGINS: readonly PluginCatalogEntry[] = [
  {
    id: TS_RUST_PLUGIN_ID,
    name: "Better TS Typecheck",
    description: "Use tsrs or tsc-rs, native ports of TypeScript 7, instead of tsc for faster typechecking.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community",
    scope: "global",
    updates: true
  },
  {
    // Ships with the app (the UI bundles @excalidraw/excalidraw); turning it on
    // only shows the whiteboard in every project's Tools menu.
    id: EXCALIDRAW_PLUGIN_ID,
    name: "Excalidraw Whiteboard",
    description: "Sketch hand-drawn diagrams in a whiteboard tab, saved as .excalidraw files in the project.",
    source: { label: "excalidraw/excalidraw", url: "https://github.com/excalidraw/excalidraw" },
    provider: "Community",
    scope: "global",
    updates: false
  }
];

export function pluginCatalogEntry(id: PluginId): PluginCatalogEntry {
  const entry = BUILT_IN_PLUGINS.find((plugin) => plugin.id === id);
  if (!entry) {
    throw new Error(`No built-in plugin "${id}".`);
  }
  return entry;
}

/** The engines "Better TS Typecheck" can run, in display order; `platform` is the service's. */
export const TS_CHECKER_ENGINE_CATALOG: readonly Omit<PluginEngineInfo, "platform">[] = [
  {
    id: "tsrs",
    label: "tsrs",
    description: "The fastest. For Linux and Apple Silicon Macs.",
    source: { label: "oxc-project/tsrs", url: "https://github.com/oxc-project/tsrs" }
  },
  {
    id: "tsc-rs",
    label: "tsc-rs",
    description: "Also runs on Windows and Intel Macs.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" }
  }
];

export function tsCheckerEngineEntry(id: TsCheckerEngine): Omit<PluginEngineInfo, "platform"> {
  const entry = TS_CHECKER_ENGINE_CATALOG.find((engine) => engine.id === id);
  if (!entry) {
    throw new Error(`No TypeScript engine "${id}".`);
  }
  return entry;
}
