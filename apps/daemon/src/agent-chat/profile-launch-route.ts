/**
 * Agent Profiles — the daemon's socket-only route the agent host calls before every provider
 * session start of a profile thread (`daemonRoutesForHost.threadLaunchProfile`, spec 2026-10-18
 * §5.6, §6.5): the thread's current prepared profile and launch fields, or a refusal the host
 * fails the start with.
 *
 * Registered ONLY on the unix-socket app, never on remote HTTP, and it requires the agent host's
 * own bearer besides (it answers a thread's launch environment, which may carry credentials).
 */

import type { FastifyInstance } from "fastify";

import {
  daemonRoutesForHost,
  type ThreadLaunchProfileRequest,
  type ThreadLaunchProfileResponse
} from "../agent-host/host-protocol.ts";

export interface ThreadLaunchProfileRouteDeps {
  /** True only for the agent host's own bearer. */
  authorizeHost(authorization: string | undefined): boolean;
  /** `AgentChatService.threadLaunchProfile`. Throws errors carrying a `code`. */
  resolve(threadId: string, profileId: string): Promise<ThreadLaunchProfileResponse>;
  logger?: { warn?: (...a: unknown[]) => void };
}

function parseRequest(body: unknown): ThreadLaunchProfileRequest | null {
  if (body === null || typeof body !== "object") return null;
  const { threadId, profileId } = body as Record<string, unknown>;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256) return null;
  if (typeof profileId !== "string" || profileId.length === 0 || profileId.length > 128) return null;
  return { threadId, profileId };
}

export function registerThreadLaunchProfileRoute(app: FastifyInstance, deps: ThreadLaunchProfileRouteDeps): void {
  app.post(daemonRoutesForHost.threadLaunchProfile, async (request, reply) => {
    if (!deps.authorizeHost(request.headers.authorization)) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "Only the agent host may ask for a thread's launch." });
    }
    const body = parseRequest(request.body);
    if (body === null) {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "threadId and profileId are required." });
    }
    try {
      return await deps.resolve(body.threadId, body.profileId);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const message = error instanceof Error ? error.message : "The thread's Agent Profile could not be resolved.";
      if (code === "THREAD_NOT_FOUND") return reply.code(404).send({ code, message });
      // Not a refusal: the host launches from its persisted profile if that still validates.
      if (code === "PROFILES_UNAVAILABLE" || typeof code !== "string") {
        if (typeof code !== "string") deps.logger?.warn?.("agent chat: resolving a thread's Agent Profile failed", error);
        return reply.code(503).send({ code: "UNAVAILABLE", message });
      }
      return reply.code(409).send({ code, message });
    }
  });
}
