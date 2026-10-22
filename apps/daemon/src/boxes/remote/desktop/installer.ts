/**
 * The desktop stack installer of a box, as VM desktops use it. The real one is
 * `createBoxGuiInstaller()` in `boxes/remote/gui/` (built separately); this is
 * the narrow interface the desktop code is written against, so either can be
 * built and tested without the other. The daemon wiring injects the real one;
 * until it does, {@link unwiredBoxGuiInstaller} reports the stack unavailable.
 */

import type { DesktopHostStatus } from "@orquester/api";

import type { BoxConnection } from "../../contracts.ts";

/** What `ensureDesktop` throws when the box cannot get the desktop stack. */
export const BOX_GUI_UNAVAILABLE = "BOX_GUI_UNAVAILABLE";

export interface BoxGuiInstaller {
  /**
   * The desktop stack as present in the box now (same shape as the host's
   * DesktopHostStatus); never installs. `installHint` explains that Orquester
   * installs missing packages when a desktop opens, or why it cannot.
   */
  desktopStatus(connection: BoxConnection, options?: { signal?: AbortSignal }): Promise<DesktopHostStatus>;
  /**
   * Install what is missing (once per box, shared run); throws an Error with
   * `code === "BOX_GUI_UNAVAILABLE"` and `hint: string | null` when it cannot
   * (non-Linux, no root/sudo, unsupported distro, install failed).
   */
  ensureDesktop(
    connection: BoxConnection,
    options?: { signal?: AbortSignal; onProgress?: (line: string) => void }
  ): Promise<DesktopHostStatus>;
  forget(boxId: string): void;
}

/** An `ensureDesktop` refusal, read off whatever was thrown (null for any other error). */
export function guiUnavailable(error: unknown): { message: string; hint: string | null } | null {
  const { code, hint, message } = (error ?? {}) as { code?: unknown; hint?: unknown; message?: unknown };
  if (code !== BOX_GUI_UNAVAILABLE) return null;
  return {
    message: typeof message === "string" && message ? message : "The VM cannot run desktops.",
    hint: typeof hint === "string" ? hint : null
  };
}

const NOT_WIRED = "VM desktop installer is not wired";

/**
 * The stand-in until the daemon wiring passes `createBoxGuiInstaller()`: every
 * box reports the desktop stack missing and cannot install it.
 */
export const unwiredBoxGuiInstaller: BoxGuiInstaller = {
  async desktopStatus() {
    return {
      available: false,
      audioAvailable: false,
      tools: [],
      ffmpegPulse: false,
      ffmpegOpus: false,
      renderNode: false,
      tmuxUsable: false,
      warnings: [`${NOT_WIRED} on this daemon.`],
      installHint: `${NOT_WIRED}: desktops cannot be set up in VMs by this build.`
    };
  },
  async ensureDesktop() {
    throw Object.assign(new Error(`${NOT_WIRED} on this daemon.`), { code: BOX_GUI_UNAVAILABLE, hint: null });
  },
  forget() {}
};
