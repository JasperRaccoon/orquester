/**
 * Linux VM desktops (Ephemeral AI VMs): what the desktop manager needs from the
 * boxes (`DesktopBoxes`) — a `BoxDesktopHost` per Linux box, the box's desktop
 * stack status and its install (through the injected `BoxGuiInstaller`), and
 * the box changes it follows (link up/down, destroyed).
 *
 * A box whose record is gone or on its way out (destroying, destroy-failed,
 * destroyed) has no host: its desktops end stopped. So does a macOS or Windows
 * box (desktops need Linux; the routes refuse them before that).
 */

import { DESKTOP_UNAVAILABLE_CODE, type DesktopHostStatus } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { DesktopBoxes } from "../../../desktops/desktop-host.ts";
import { DesktopError } from "../../../desktops/manager.ts";
import type { BoxConnection, BoxHub, BoxRegistry, BoxToolingProvisioner } from "../../contracts.ts";
import { BoxDesktopHost } from "./host.ts";
import { type BoxGuiInstaller, guiUnavailable } from "./installer.ts";
import { boxDesktopRefusal } from "./suggestions.ts";

export { BoxDesktopHost } from "./host.ts";
export { type BoxGuiInstaller, unwiredBoxGuiInstaller } from "./installer.ts";

export interface BoxDesktopsDeps {
  registry: Pick<BoxRegistry, "get" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  installer: BoxGuiInstaller;
  tooling?: Pick<BoxToolingProvisioner, "contribution">;
  /** The private tmux server desktops use in each box (tests use their own). */
  tmuxServer?: string;
}

/** A box record that no longer runs anything a desktop could use. */
function goneState(state: StoredBox["state"]): boolean {
  return state === "destroying" || state === "destroy-failed" || state === "destroyed";
}

const NOT_CONNECTED = "The VM is not connected right now; try again once it is back.";

export class BoxDesktops implements DesktopBoxes {
  private readonly hosts = new Map<string, BoxDesktopHost>();

  constructor(private readonly deps: BoxDesktopsDeps) {}

  host(boxId: string): BoxDesktopHost | null {
    const record = this.deps.registry.get(boxId);
    const connection = this.deps.hub.get(boxId);
    const linux = connection ? boxDesktopRefusal(connection.sys) === null : record?.kind === "linux" || record?.kind === "linux-gpu";
    if (!record || goneState(record.state) || !linux) {
      this.forget(boxId);
      return null;
    }
    let host = this.hosts.get(boxId);
    if (!host) {
      host = new BoxDesktopHost({
        boxId,
        connection: () => this.deps.hub.get(boxId),
        ...(this.deps.tooling ? { tooling: this.deps.tooling } : {}),
        ...(this.deps.tmuxServer ? { tmuxServer: this.deps.tmuxServer } : {})
      });
      this.hosts.set(boxId, host);
    }
    return host;
  }

  async status(boxId: string): Promise<DesktopHostStatus> {
    return this.deps.installer.desktopStatus(this.connection(boxId));
  }

  async ensure(boxId: string, onProgress: (line: string) => void): Promise<DesktopHostStatus> {
    const connection = this.connection(boxId);
    try {
      return await this.deps.installer.ensureDesktop(connection, { onProgress });
    } catch (error) {
      const refused = guiUnavailable(error);
      if (refused) throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, refused.message, refused.hint);
      if (!connection.connected) throw new DesktopError(409, "DESKTOP_BOX_UNREACHABLE", NOT_CONNECTED);
      throw new DesktopError(500, "DESKTOP_INSTALL_FAILED", `Installing the desktop packages in the VM failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onChange(listener: (boxId: string) => void): () => void {
    const offRegistry = this.deps.registry.onChange((boxId) => {
      const record = this.deps.registry.get(boxId);
      if (!record || goneState(record.state)) this.forget(boxId);
      listener(boxId);
    });
    const offHub = this.deps.hub.onConnectionChange((boxId) => listener(boxId));
    return () => {
      offRegistry();
      offHub();
    };
  }

  private forget(boxId: string): void {
    if (this.hosts.delete(boxId)) this.deps.installer.forget(boxId);
  }

  private connection(boxId: string): BoxConnection {
    if (this.host(boxId) === null) throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "This project's VM cannot run desktops.");
    const connection = this.deps.hub.get(boxId);
    if (!connection?.connected) throw new DesktopError(409, "DESKTOP_BOX_UNREACHABLE", NOT_CONNECTED);
    return connection;
  }
}
