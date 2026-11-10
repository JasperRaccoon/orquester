import { desktopRoutes, type DesktopSummary } from "@orquester/api";
import { RfbStreamClient } from "./rfb-client";
import type { DesktopStreamClient } from "./types";

export interface DesktopStreamClientOptions {
  /** A desktop socket path (`desktopRoutes.*Socket`) as an authenticated URL, or null where the transport has none. */
  socketUrl: (path: string) => string | null;
}

/**
 * The stream client for one connection attempt to `desktop`. The view calls it
 * for every (re)connect, so the choice can change between attempts. Today
 * every desktop streams over RFB.
 */
export function createDesktopStreamClient(desktop: DesktopSummary, options: DesktopStreamClientOptions): DesktopStreamClient {
  return new RfbStreamClient({ socketUrl: options.socketUrl(desktopRoutes.vncSocket(desktop.id)) });
}
