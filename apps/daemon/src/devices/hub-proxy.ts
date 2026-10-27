/**
 * The authenticated proxy to a device host's hub (devices spec §8): HTTP under
 * `/api/devices/hosts/:hostId/hub/*`, WebSockets under `/ws-device/:hostId/*`. The routes
 * (`http-routes.ts`, `ws-routes.ts`) authenticate, find the host and its loopback hub origin, and
 * hand the request here with the hub path.
 *
 * SEAM — owned by the hub-proxy work package: port t3code's allowlists (`DeviceHubProxy.ts`:
 * device list, serve-sim helper streams and `ws`, serve-sim grid start, serve-emu `ws`, `api/fold`,
 * screenshot; everything else 404, non-GET only on the mutable list), strip cookies /
 * authorization / dpop, rewrite Origin / Host, `Cache-Control: no-store, no-transform`, the MJPEG
 * still-frame repeat, 8 MiB back-pressure, and the controller handoff on the first input frame
 * (`DeviceService.userInput`). {@link createHubProxy} is a stand-in that answers 503 / closes 1013.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

/** Where one proxied request goes. */
export interface HubProxyTarget {
  hostId: string;
  /** The hub's loopback origin (`http://127.0.0.1:<port>`; a box host's `forwardToHost` port). */
  origin: string;
  /** The hub path after the prefix, with a leading `/` (`/vendor/serve-emu/ws`). */
  hubPath: string;
  /** The query string to forward (the `token` already removed), with its `?`, or "". */
  search: string;
}

export interface HubProxy {
  /** Answer one HTTP request (any method) for the target. */
  handleHttp(request: FastifyRequest, reply: FastifyReply, target: HubProxyTarget): Promise<void>;
  /** Relay an accepted, authenticated WebSocket to the target. */
  handleWebSocket(socket: WebSocket, request: FastifyRequest, target: HubProxyTarget): void;
}

export interface HubProxyDeps {
  /** The panel's first input on a device the agent controls: control switches to the user. */
  userInput(hostId: string, deviceParam: string): void;
  logger: Pick<Console, "info" | "warn" | "error">;
}

export function createHubProxy(_deps: HubProxyDeps): HubProxy {
  return {
    async handleHttp(_request, reply) {
      await reply.code(503).send({ code: "UNAVAILABLE", message: "The device hub proxy is not ready yet." });
    },
    handleWebSocket(socket) {
      socket.close(1013, "device hub proxy not ready");
    }
  };
}
