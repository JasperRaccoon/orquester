/**
 * The token broker's two entry points (spec 2026-10-19 boxes §7):
 *
 * - {@link registerTokenBroker}: the box → host `token.get` request (`orq-agent token …` in a box).
 *   The box's identity is the authenticated link's, never a field of the request, and its
 *   `minValidSeconds` is lowered to {@link BOX_MAX_MIN_VALID_SECONDS}.
 * - {@link registerTokenBrokerRoutes}: `POST boxRoutes.internalToken`, for the agent host at spawn
 *   time and on Codex `account/chatgptAuthTokens/refresh`. SOCKET-ONLY, like the reply-subscription
 *   routes: the daemon calls it with the unix-socket app alone (`unixServer` in `index.ts`), never
 *   with the remote HTTP app, so no remote client can ask for an agent token.
 *
 * Both cap a wait at {@link TOKEN_REQUEST_MAX_WAIT_MS} on top of the caller's own signal.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import { boxRoutes } from "@orquester/api";

import type { AgentTokenBroker, AgentTokenGrant, BoxHub } from "../contracts.ts";
import { AgentTokenError, BOX_MAX_MIN_VALID_SECONDS, parseTokenRequest } from "./broker.ts";

/** Longest a token request waits for a host CLI to renew a held account's login. */
export const TOKEN_REQUEST_MAX_WAIT_MS = 10 * 60_000;

export function registerTokenBroker(hub: Pick<BoxHub, "handle">, broker: AgentTokenBroker): void {
  hub.handle("token.get", (context, params, signal) => {
    const fields = typeof params === "object" && params !== null ? (params as unknown as Record<string, unknown>) : {};
    // Untrusted shapes go through `parseTokenRequest` inside `getToken`; the box id is the link's,
    // and a box never asks for more life than a fresh token has (a refresh on every call).
    const minValidSeconds = fields.minValidSeconds;
    const request = {
      agent: fields.agent,
      accountId: fields.accountId,
      minValidSeconds: typeof minValidSeconds === "number" ? Math.min(minValidSeconds, BOX_MAX_MIN_VALID_SECONDS) : minValidSeconds,
      rejectedAccessToken: fields.rejectedAccessToken,
      boxId: context.boxId
    };
    return broker.getToken(request as Parameters<AgentTokenBroker["getToken"]>[0], AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_MAX_WAIT_MS)]));
  });
}

/** Register on the unix-socket app ONLY. */
export function registerTokenBrokerRoutes(app: FastifyInstance, broker: AgentTokenBroker): void {
  app.post<{ Body: unknown }>(boxRoutes.internalToken, async (request, reply): Promise<AgentTokenGrant | FastifyReply> => {
    void reply.header("Cache-Control", "no-store");
    let parsed: ReturnType<typeof parseTokenRequest>;
    try {
      parsed = parseTokenRequest(request.body);
    } catch (error) {
      if (error instanceof AgentTokenError) return reply.code(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
    // The caller going away ends the wait. `close` on the response, not the request: a request's
    // `close` fires as soon as its body has been read.
    const gone = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) gone.abort();
    };
    reply.raw.once("close", onClose);
    try {
      return await broker.getToken(parsed, AbortSignal.any([gone.signal, AbortSignal.timeout(TOKEN_REQUEST_MAX_WAIT_MS)]));
    } catch (error) {
      if (error instanceof AgentTokenError) return reply.code(error.status).send({ code: error.code, message: error.message });
      // Anything else may carry file-system detail: answer generically.
      request.log.warn({ err: error instanceof Error ? error.name : "unknown" }, "token broker request failed");
      return reply.code(500).send({ code: "TOKEN_UNAVAILABLE", message: "The token broker failed." });
    } finally {
      reply.raw.off("close", onClose);
    }
  });
}
