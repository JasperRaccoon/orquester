/**
 * The element's own settings — its attributes and its `loaders` — as one
 * external store the React tree subscribes to, so an attribute change or new
 * loaders re-render what reads them (the appearance, the affordances a
 * missing loader hides).
 */

import type { ColorScheme, ResolvedMode } from "../../../../packages/ui/src/lib/theme";
import { COLOR_SCHEMES } from "../../../../packages/ui/src/lib/theme";

import type { EmbedLoaders } from "./types";

export interface EmbedAppearance {
  mode: ResolvedMode;
  scheme: ColorScheme;
}

export interface EmbedSettingsState {
  /** Kept by identity while mode and scheme stay: what `ChatHost.useAppearance` returns. */
  appearance: EmbedAppearance;
  workspaceRoot: string | undefined;
  loaders: Readonly<EmbedLoaders>;
}

const SCHEMES = new Set<string>(COLOR_SCHEMES.map((scheme) => scheme.id));

/** `mode`: `light`, else the default `dark`. */
export const modeOf = (value: string | null): ResolvedMode => (value === "light" ? "light" : "dark");

/** `scheme`: one of Orquester's schemes, else the default `mono`. */
export const schemeOf = (value: string | null): ColorScheme =>
  value !== null && SCHEMES.has(value) ? (value as ColorScheme) : "mono";

const LOADER_NAMES = ["attachment", "visualUrl", "history", "item", "itemOutput"] as const;

/** The loaders of a host's value: its functions under the five names, nothing else. */
export function loadersOf(value: unknown): Readonly<EmbedLoaders> {
  const loaders: Record<string, unknown> = {};
  if (typeof value === "object" && value !== null) {
    for (const name of LOADER_NAMES) {
      const loader = (value as Record<string, unknown>)[name];
      if (typeof loader === "function") loaders[name] = loader;
    }
  }
  return Object.freeze(loaders) as Readonly<EmbedLoaders>;
}

export class EmbedSettings {
  private state: EmbedSettingsState = {
    appearance: { mode: "dark", scheme: "mono" },
    workspaceRoot: undefined,
    loaders: loadersOf(undefined)
  };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): EmbedSettingsState => this.state;

  setAppearance(mode: ResolvedMode, scheme: ColorScheme): void {
    const current = this.state.appearance;
    if (current.mode === mode && current.scheme === scheme) return;
    this.update({ appearance: { mode, scheme } });
  }

  setWorkspaceRoot(workspaceRoot: string | undefined): void {
    if (this.state.workspaceRoot !== workspaceRoot) this.update({ workspaceRoot });
  }

  setLoaders(loaders: Readonly<EmbedLoaders>): void {
    this.update({ loaders });
  }

  private update(patch: Partial<EmbedSettingsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
