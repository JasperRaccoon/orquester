// The NODE_OPTIONS preload Orquester sessions load while a built-in plugin needs
// one (today: tsc-rs). The plugins service decides when it is active; the shell,
// workflow and agent-host env builders only ask. Spec:
// docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md §3.3.

import { appendNodeRequireOption } from "@orquester/config";

let activePreloadPath: string | null = null;

/**
 * Set by the plugins service: the preload's absolute path while the plugin is on
 * in at least one workspace and the file has been written, otherwise `null`.
 */
export function setSessionNodePreload(path: string | null): void {
  activePreloadPath = path;
}

export function sessionNodePreload(): string | null {
  return activePreloadPath;
}

/**
 * NODE_OPTIONS for a new session: `existing` with the active preload appended,
 * or `existing` unchanged (possibly `undefined`) when no preload is active.
 */
export function sessionNodeOptions(existing: string | undefined): string | undefined {
  const preload = activePreloadPath;
  if (preload === null) return existing;
  return appendNodeRequireOption(existing, preload);
}
