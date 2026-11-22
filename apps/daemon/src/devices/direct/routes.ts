/**
 * The routes a stream ticket offers, best first (tailnet machines spec §4.5 item 1): the machine's
 * own HTTPS name while its `tailscale serve` is up; its LAN addresses only for the desktop app (an
 * HTTPS page blocks plain `http`/`ws` as mixed content); the daemon's hub proxy always, last.
 */

import type { DeviceStreamClient, DeviceStreamRoute } from "@orquester/api";

import type { DeviceDirectStream } from "../host.ts";

export interface StreamRoutesInput {
  /** The host's direct routes (its stream gate running); null: none. */
  direct: Pick<DeviceDirectStream, "tailnetUrl" | "lanUrls"> | null;
  /** The machine the direct routes must identify as; null: the host is no machine (no direct route is offered). */
  machineId: string | null;
  client: DeviceStreamClient;
  /** The hub proxy's base path for the host (`deviceRoutes.hub(hostId, "")`). */
  daemonUrl: string;
}

export function streamRoutes(input: StreamRoutesInput): DeviceStreamRoute[] {
  const routes: DeviceStreamRoute[] = [];
  if (input.direct && input.machineId !== null) {
    if (input.direct.tailnetUrl) routes.push({ kind: "tailnet", url: input.direct.tailnetUrl });
    if (input.client === "desktop") for (const url of input.direct.lanUrls) routes.push({ kind: "lan", url });
  }
  routes.push({ kind: "daemon", url: input.daemonUrl });
  return routes;
}
