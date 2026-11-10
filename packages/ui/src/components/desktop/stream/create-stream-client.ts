import { desktopRoutes, type DesktopSummary } from "@orquester/api";
import { capabilities } from "../../device/stream/capabilities";
import { chooseDesktopBackend, type DesktopBackendChoice, type VoxlViewerSupport } from "./backend-choice.logic";
import { RfbStreamClient } from "./rfb-client";
import type { DesktopStreamClient } from "./types";
import { VoxlStreamClient } from "./voxl-client";

export interface DesktopStreamClientOptions {
  /** A desktop socket path (`desktopRoutes.*Socket`) as an authenticated URL, or null where the transport has none. */
  socketUrl: (path: string) => string | null;
  /** Consecutive voxl connection failures the view has counted (it falls back to RFB at 3). */
  voxlFailures: number;
}

export interface DesktopStreamPlan {
  client: DesktopStreamClient;
  /** Why it is this backend (an RFB fallback from a voxl desktop has a reason). */
  choice: DesktopBackendChoice;
}

/** What this browser offers voxl; WebCodecs is probed once per page (`device/stream/capabilities.ts`). */
export async function voxlViewerSupport(): Promise<VoxlViewerSupport> {
  const caps = await capabilities();
  return {
    secureContext: typeof isSecureContext === "boolean" ? isSecureContext : false,
    webCodecs: caps.webCodecs,
    h264: caps.h264High
  };
}

/**
 * The stream client for one connection attempt to `desktop`. The view calls it for every
 * (re)connect, so the choice can change between attempts (`backend-choice.logic.ts`).
 */
export async function createDesktopStreamClient(desktop: DesktopSummary, options: DesktopStreamClientOptions): Promise<DesktopStreamPlan> {
  const choice = chooseDesktopBackend({ desktop, support: await voxlViewerSupport(), voxlFailures: options.voxlFailures });
  const client: DesktopStreamClient =
    choice.backend === "voxl"
      ? new VoxlStreamClient({ socketUrl: options.socketUrl(desktopRoutes.voxlSocket(desktop.id)) })
      : new RfbStreamClient({ socketUrl: options.socketUrl(desktopRoutes.vncSocket(desktop.id)) });
  return { client, choice };
}
