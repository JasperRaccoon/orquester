// Placeholder with the agreed signature; the real preload renderer and writer
// replace this file (spec §3.2).

export interface TsRustPreloadOptions {
  /** Absolute path of plugins.json, baked into the preload. */
  statePath: string;
  /** Resolved workspaces root, baked into the preload. */
  workspacesRoot: string;
}

/** The preload.cjs source with `options` baked in. */
export function renderTsRustPreload(_options: TsRustPreloadOptions): string {
  throw new Error("renderTsRustPreload is not implemented yet");
}

/** Atomically write the rendered preload to `path` (mode 0644), creating parent dirs. */
export async function writeTsRustPreload(_path: string, _options: TsRustPreloadOptions): Promise<void> {
  throw new Error("writeTsRustPreload is not implemented yet");
}
