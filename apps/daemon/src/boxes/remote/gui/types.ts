/**
 * The seam between the box GUI installer and its callers (the box Browser and Desktop tabs).
 * Chromium and the desktop stack run inside a Linux box; this module makes them usable there,
 * installing what is missing the first time a tab needs it.
 */

import type { DesktopHostStatus } from "@orquester/api";

import type { BoxConnection } from "../../contracts.ts";

export type BoxGuiFeature = "browser" | "desktop";

/** Refusal both tabs show verbatim: why the box cannot run it, and what the owner can do. */
export class BoxGuiUnavailableError extends Error {
  readonly code = "BOX_GUI_UNAVAILABLE";
  constructor(
    message: string,
    readonly hint: string | null = null
  ) {
    super(message);
    this.name = "BoxGuiUnavailableError";
  }
}

export interface BoxBrowserRuntime {
  /** Absolute path of the Chromium/Chrome (or chrome-headless-shell) binary in the box. */
  chromiumPath: string;
  /** True when it must run with --no-sandbox (box user is root, or no usable sandbox: container, userns blocked). */
  noSandbox: boolean;
  /** What `--version` printed ("Google Chrome 141.0.7390.54"), for logs. */
  version: string | null;
}

export interface BoxGuiProgress {
  (line: string): void;
}

export interface BoxGuiInstaller {
  /** The desktop stack as present in the box now (same shape the host's GET /api/desktops/host-status returns); never installs. `installHint` says Orquester installs the missing packages when a desktop opens, or why it cannot (no root/sudo, unsupported OS/distro, non-Linux box). */
  desktopStatus(connection: BoxConnection, options?: { signal?: AbortSignal }): Promise<DesktopHostStatus>;
  /** Make the desktop stack usable (installs once per box; concurrent callers share one run). Resolves with the status after install; throws BoxGuiUnavailableError when it cannot (non-Linux box, no root/sudo and packages missing, no supported package manager, install failed — message includes the tail of the install log). */
  ensureDesktop(connection: BoxConnection, options?: { signal?: AbortSignal; onProgress?: BoxGuiProgress }): Promise<DesktopHostStatus>;
  /** Make Chromium usable (same once-per-box/shared-run rules). */
  ensureBrowser(connection: BoxConnection, options?: { signal?: AbortSignal; onProgress?: BoxGuiProgress }): Promise<BoxBrowserRuntime>;
  /** Drop the memo for a box (destroyed/forgotten). */
  forget(boxId: string): void;
}

export interface BoxGuiInstallerDeps {
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}
