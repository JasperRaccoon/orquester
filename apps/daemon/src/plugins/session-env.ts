import { appendNodeRequireOption } from "@orquester/config";

let preloadPath: string | null = null;

/**
 * Set by the plugins service: the host preload's absolute path while the
 * plugin is on and the file has been written, otherwise `null`.
 */
export function setSessionNodePreload(path: string | null): void {
  preloadPath = path;
}

/** The file host sessions `--require`, or `null` when the plugin is off. */
export function sessionNodePreload(): string | null {
  return preloadPath;
}

/** Append the host preload to NODE_OPTIONS, preserving the value while the plugin is off. */
export function sessionNodeOptions(existing: string | undefined): string | undefined {
  return preloadPath === null ? existing : appendNodeRequireOption(existing, preloadPath);
}
