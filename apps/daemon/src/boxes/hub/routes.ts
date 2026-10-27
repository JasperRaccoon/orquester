/**
 * The hub's REMOTE routes. Boxes have no daemon login, so these are
 * exempt from the user-auth hook (exactly these route patterns:
 * {@link BOX_HUB_PUBLIC_ROUTES}) and accept nothing but box authentication:
 *
 * - `boxRoutes.connect` — the box's WebSocket; authenticated by its `hello`.
 * - `boxRoutes.agentBinary(platform)` — `orq-agent` downloads;
 *   `Authorization: Bearer <bootstrap token | box credential>` or
 *   `Authorization: GitHubOIDC <jwt>` + `X-Orq-Box-Id`.
 * - `boxRoutes.bootstrapScript(variant)` — the second stage of a staged bootstrap
 *   (`bootstrap.ts`), authenticated exactly like the downloads. Generic per variant
 *   and secret-free; box auth keeps the route from being an open endpoint.
 * - `boxRoutes.pair(code)` — a bring-your-own machine's pairing script. Its one-time code is
 *   its only authentication (`service/byo.ts` spends it on the first fetch, expires it, and
 *   throttles failures per client); the answer carries that machine's single-use bootstrap
 *   token and nothing else. Every refusal is the same 404 (or 429), so it says nothing about
 *   which codes exist; the code is never logged.
 *
 * Requires `@fastify/websocket` registered at the root (index.ts does).
 */

import { createReadStream } from "node:fs";

import { BOX_AGENT_PLATFORMS, boxRoutes } from "@orquester/api";
import type { FastifyInstance } from "fastify";

import { bootstrapSecondStage } from "../bootstrap/bootstrap.ts";
import type { PairingScriptOutcome } from "../service/byo.ts";
import type { BoxHubServer } from "./hub.ts";

const AGENT_BINARY_ROUTE = "/api/boxes/agent/:platform";
const BOOTSTRAP_SCRIPT_ROUTE = "/api/boxes/bootstrap/:variant";
export const BYO_PAIR_ROUTE = "/api/boxes/pair/:code";

/** Route patterns the daemon's user-auth hook must let through (they do box auth themselves). */
export const BOX_HUB_PUBLIC_ROUTES: readonly string[] = [boxRoutes.connect, AGENT_BINARY_ROUTE, BOOTSTRAP_SCRIPT_ROUTE, BYO_PAIR_ROUTE];

/** The pair route's source of scripts (`ByoMachines`, service/byo.ts). */
export interface BoxPairingScripts {
  pairingScript(code: string, client: string): Promise<PairingScriptOutcome>;
}

export function registerBoxHubRoutes(app: FastifyInstance, hub: BoxHubServer, options: { pairing?: BoxPairingScripts } = {}): void {
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

    instance.get<{ Params: { variant: string } }>(BOOTSTRAP_SCRIPT_ROUTE, async (request, reply) => {
      const auth = await hub.authorizeDownload(request.headers);
      if (!auth) {
        return reply.code(401).send({ code: "UNAUTHORIZED", message: "Box authentication is required for this route." });
      }
      const script = bootstrapSecondStage(request.params.variant);
      if (script === null) {
        return reply.code(404).send({ code: "UNKNOWN_VARIANT", message: `No bootstrap variant ${request.params.variant}` });
      }
      request.log.info({ boxId: auth.boxId, variant: request.params.variant }, "serving the bootstrap's second stage");
      return reply.header("content-type", "text/x-shellscript").header("cache-control", "no-store").send(script);
    });

    instance.get<{ Params: { code: string } }>(BYO_PAIR_ROUTE, async (request, reply) => {
      const outcome: PairingScriptOutcome = options.pairing
        ? await options.pairing.pairingScript(request.params.code, request.ip)
        : { ok: false, status: 404, code: "PAIRING_NOT_FOUND", message: "Pairing is not available." };
      reply.header("cache-control", "no-store");
      if (!outcome.ok) {
        if (outcome.retryAfterSeconds !== undefined) reply.header("retry-after", String(outcome.retryAfterSeconds));
        return reply.code(outcome.status).send({ code: outcome.code, message: outcome.message });
      }
      request.log.info("serving a pairing script");
      return reply.header("content-type", "text/x-shellscript").send(outcome.script);
    });
  });
}
