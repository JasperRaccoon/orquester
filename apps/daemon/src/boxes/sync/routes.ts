/**
 * Box → host config changes over HTTP (spec §8.3; paths from `boxRoutes`), on both transports:
 *
 * - `GET boxRoutes.configChanges` → `BoxConfigChangesResponse` (pending first).
 * - `POST boxRoutes.configChange(id)` `DecideBoxConfigChangeRequest` → `{ change }`. Only a person
 *   decides: a request carrying an agent or external principal is refused 403 `PERMISSION_DENIED`
 *   (as tool approvals are), so no agent can approve its own box's change.
 *
 * Every refusal is `{ code, message }`; a message never quotes file content.
 */

import type { FastifyInstance } from "fastify";

import {
  BOX_CONFIG_CHANGES_EVENT,
  BOXES_CHANNEL,
  boxRoutes,
  type BoxConfigChangeSet,
  type BoxConfigChangesResponse,
  type DecideBoxConfigChangeRequest
} from "@orquester/api";

import { requestPrincipal } from "../../agent-chat/tool-approvals.ts";
import type { Broadcaster } from "../../broadcaster.ts";
import { BoxSyncError, type BoxConfigSyncService } from "./config-sync.ts";

export interface BoxConfigChangeRoutesDeps {
  sync: Pick<BoxConfigSyncService, "listChanges" | "decide">;
  logger?: { error(message: string): void };
}

const DECIDE_BODY_LIMIT = 4 * 1024;

/** `boxRoutes` builders percent-encode `:id`; Fastify wants the placeholder itself. */
function pattern(path: string): string {
  return decodeURIComponent(path);
}

function parseDecision(body: unknown): DecideBoxConfigChangeRequest["decision"] | null {
  const decision = (body as { decision?: unknown } | null)?.decision;
  return decision === "approve" || decision === "deny" ? decision : null;
}

export function registerBoxConfigChangeRoutes(app: FastifyInstance, deps: BoxConfigChangeRoutesDeps): void {
  const logger = deps.logger ?? console;

  app.get(boxRoutes.configChanges, async (): Promise<BoxConfigChangesResponse> => ({ changes: await deps.sync.listChanges() }));

  app.post<{ Params: { id: string } }>(pattern(boxRoutes.configChange(":id")), { bodyLimit: DECIDE_BODY_LIMIT }, async (request, reply) => {
    if (requestPrincipal(request).kind !== "user") {
      return reply.code(403).send({ code: "PERMISSION_DENIED", message: "Only a person approves or denies box config changes." });
    }
    const decision = parseDecision(request.body);
    if (decision === null) {
      return reply.code(400).send({ code: "BOX_INVALID_REQUEST", message: '`decision` must be "approve" or "deny".' });
    }
    try {
      const change: BoxConfigChangeSet = await deps.sync.decide(request.params.id, decision);
      return { change };
    } catch (error) {
      if (error instanceof BoxSyncError) return reply.code(error.status).send({ code: error.code, message: error.message });
      logger.error(`boxes: deciding a config change failed (${error instanceof Error ? error.name : typeof error})`);
      return reply.code(500).send({ code: "BOX_SYNC_FAILED", message: "Deciding the change failed." });
    }
  });
}

/** The `publish` option of `BoxConfigSyncService`, on the daemon's broadcaster. */
export function boxConfigChangesPublisher(broadcaster: Pick<Broadcaster, "publish">): (payload: BoxConfigChangesResponse) => void {
  return (payload) => broadcaster.publish(BOXES_CHANNEL, BOX_CONFIG_CHANGES_EVENT, payload);
}
