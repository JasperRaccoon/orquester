/**
 * The hub's two REMOTE routes. Boxes have no daemon login, so these are
 * exempt from the user-auth hook (exactly these route patterns:
 * {@link BOX_HUB_PUBLIC_ROUTES}) and accept nothing but box authentication:
 *
 * - `boxRoutes.connect` — the box's WebSocket; authenticated by its `hello`.
 * - `boxRoutes.agentBinary(platform)` — `orq-agent` downloads;
 *   `Authorization: Bearer <bootstrap token | box credential>` or
 *   `Authorization: GitHubOIDC <jwt>` + `X-Orq-Box-Id`.
 *
 * Requires `@fastify/websocket` registered at the root (index.ts does).
 */

import { createReadStream } from "node:fs";

import { BOX_AGENT_PLATFORMS, boxRoutes } from "@orquester/api";
import type { FastifyInstance } from "fastify";

import type { BoxHubServer } from "./hub.ts";

const AGENT_BINARY_ROUTE = "/api/boxes/agent/:platform";

/** Route patterns the daemon's user-auth hook must let through (they do box auth themselves). */
export const BOX_HUB_PUBLIC_ROUTES: readonly string[] = [boxRoutes.connect, AGENT_BINARY_ROUTE];

export function registerBoxHubRoutes(app: FastifyInstance, hub: BoxHubServer): void {
  void app.register(async (instance) => {
    instance.get(boxRoutes.connect, { websocket: true }, (socket) => {
      hub.acceptWebSocket(socket);
    });

    instance.get<{ Params: { platform: string } }>(AGENT_BINARY_ROUTE, async (request, reply) => {
      const auth = await hub.authorizeDownload(request.headers);
      if (!auth) {
        return reply.code(401).send({ code: "UNAUTHORIZED", message: "Box authentication is required for this route." });
      }
      const platform = request.params.platform;
      if (!BOX_AGENT_PLATFORMS.includes(platform)) {
        return reply.code(404).send({ code: "UNKNOWN_PLATFORM", message: `No orq-agent platform ${platform}` });
      }
      const build = hub.builds ? await hub.builds.resolve(platform) : null;
      if (!build) {
        return reply.code(404).send({ code: "NO_BUILD", message: `No orq-agent build for ${platform}` });
      }
      request.log.info({ boxId: auth.boxId, platform }, "serving orq-agent");
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(build.size))
        .header("cache-control", "no-store")
        .header("x-orq-agent-sha256", build.sha256)
        .header("x-orq-agent-version", build.version)
        .send(createReadStream(build.path));
    });
  });
}
