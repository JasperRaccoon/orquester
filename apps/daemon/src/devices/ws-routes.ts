/**
 * The devices WebSocket relay (devices spec §8): `/ws-device/:hostId/*` to the host's hub, on
 * the desktops' model — a child context under the root @fastify/websocket, `?token=` checked after
 * the upgrade (close 1008). Viewing needs a live lease on the host; the hub proxy (`hub-proxy.ts`)
 * owns the allowlist, back-pressure and the controller handoff on the first input frame.
 */

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import { hubSearch } from "./http-routes.ts";
import type { HubProxy } from "./hub-proxy.ts";
import type { DeviceService } from "./service.ts";

interface DeviceWsDeps {
  /**
   * True when `token` (the `?token=` query value) is a valid credential. `socket` is the accepted
   * connection, so the caller can close it when that credential is revoked.
   */
  authorize(token: string | undefined, socket: WebSocket): boolean;
  /** The running service, or null while the plugin is off (read per connection). */
  devices(): DeviceService | null;
  hubProxy(): HubProxy;
}

/** The WebSocket route (`deviceRoutes.socket`). */
const DEVICE_WS_ROUTE = "/ws-device/:hostId/*";

function tokenOf(query: unknown): string | undefined {
  const token = (query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : undefined;
}

/** Register the relay on a child context (root @fastify/websocket already registered). */
export async function registerDeviceWsRoutes(app: FastifyInstance, deps: DeviceWsDeps): Promise<void> {
  void app.register(async (instance) => {
    instance.get<{ Params: { hostId: string; "*": string } }>(DEVICE_WS_ROUTE, { websocket: true }, (socket, request) => {
      if (!deps.authorize(tokenOf(request.query), socket)) {
        socket.close(1008, "unauthorized");
        return;
      }
      const service = deps.devices();
      if (!service) {
        socket.close(1011, "device simulators are off");
        return;
      }
      const { hostId } = request.params;
      if (!service.hosts.get(hostId)) {
        socket.close(1011, "unknown device host");
        return;
      }
      if (!service.hostHasLease(hostId)) {
        socket.close(1008, "no leased device on this host");
        return;
      }
      const origin = service.hubOrigin(hostId);
      if (!origin) {
        socket.close(1013, "device hub not running");
        return;
      }
      deps.hubProxy().handleWebSocket(socket, request, { hostId, origin, hubPath: `/${request.params["*"] ?? ""}`, search: hubSearch(request.url), token: service.hubToken(hostId) });
    });
  });
}
