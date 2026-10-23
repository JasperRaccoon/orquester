/**
 * Linux VM desktops (Ephemeral AI VMs): what the desktop manager needs from the
 * boxes (`DesktopBoxes`) — a `BoxDesktopHost` per Linux box, the box's desktop
 * stack status and its install (through the daemon's one `BoxGuiInstaller`,
 * `remote/gui`, whose memo the box wiring forgets with the box), and the box
 * changes it follows (link up/down, destroyed).
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
import { type BoxGuiInstaller, BoxGuiUnavailableError } from "../gui/index.ts";
import { BoxDesktopHost } from "./host.ts";
import { boxDesktopRefusal } from "./suggestions.ts";

export { BoxDesktopHost } from "./host.ts";

export interface BoxDesktopsDeps {
  registry: Pick<BoxRegistry, "get" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  installer: Pick<BoxGuiInstaller, "desktopStatus" | "ensureDesktop">;
  tooling?: Pick<BoxToolingProvisioner, "contribution">;
  /** The private tmux server desktops use in each box (tests use their own). */
  tmuxServer?: string;
}

/** A box record that no longer runs anything a desktop could use. */
function goneState(state: StoredBox["state"]): boolean {
  return state === "destroying" || state === "destroy-failed" || state === "destroyed";
}

const NOT_CONNECTED = "The VM is not connected right now; try again once it is back.";

/**
 * A box whose `orq-agent` predates `unix` channels. The hub asks an outdated
 * agent to update on every connect; one keeping processes alive for the
 * daemon (terminals, agent chats) defers the update until they have ended.
 */
const AGENT_TOO_OLD =
  "The VM's orq-agent is too old for desktops. It updates itself once the terminals and agent chats it keeps running in the VM have ended.";
const AGENT_TOO_OLD_HINT = "Close (or let finish) this VM's terminals and agent chats, then open the desktop again; or recreate the VM.";

function agentTooOldStatus(): DesktopHostStatus {
  return {
    available: false,
    audioAvailable: false,
    tools: [],
    ffmpegPulse: false,
    ffmpegOpus: false,
    renderNode: false,
    tmuxUsable: false,
    warnings: [AGENT_TOO_OLD],
    installHint: AGENT_TOO_OLD_HINT
  };
}

/** The installer's refusal (`BoxGuiUnavailableError`, or its code on any error), else null. */
function guiRefusal(error: unknown): { message: string; hint: string | null } | null {
  if (error instanceof BoxGuiUnavailableError) return { message: error.message, hint: error.hint };
  const { code, hint, message } = (error ?? {}) as { code?: unknown; hint?: unknown; message?: unknown };
  if (code !== "BOX_GUI_UNAVAILABLE") return null;
  return { message: typeof message === "string" && message ? message : "The VM cannot run desktops.", hint: typeof hint === "string" ? hint : null };
}

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
    const connection = this.connection(boxId);
    if (!(await this.unixChannels(boxId))) return agentTooOldStatus();
    return this.deps.installer.desktopStatus(connection);
  }

  async ensure(boxId: string, onProgress: (line: string) => void): Promise<DesktopHostStatus> {
    const connection = this.connection(boxId);
    if (!(await this.unixChannels(boxId))) throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, AGENT_TOO_OLD, AGENT_TOO_OLD_HINT);
    try {
      return await this.deps.installer.ensureDesktop(connection, { onProgress });
    } catch (error) {
      const refused = guiRefusal(error);
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

  /** Drop a gone box's host (the installer's own memo is the box wiring's to forget). */
  private forget(boxId: string): void {
    this.hosts.delete(boxId);
  }

  /** Whether the box's `orq-agent` carries `unix` channels (a link that drops while asking: 409). */
  private async unixChannels(boxId: string): Promise<boolean> {
    try {
      return await this.host(boxId)!.unixChannels();
    } catch {
      throw new DesktopError(409, "DESKTOP_BOX_UNREACHABLE", NOT_CONNECTED);
    }
  }

  private connection(boxId: string): BoxConnection {
    if (this.host(boxId) === null) throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "This project's VM cannot run desktops.");
    const connection = this.deps.hub.get(boxId);
    if (!connection?.connected) throw new DesktopError(409, "DESKTOP_BOX_UNREACHABLE", NOT_CONNECTED);
    return connection;
  }
}
