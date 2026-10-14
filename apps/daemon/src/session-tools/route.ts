/**
 * Session tools — the daemon's socket-only route (design §1.1):
 * `POST /api/agent-host/session-tools/call`.
 *
 * Registered ONLY on the unix-socket app (`createServer` with `mode:
 * "local"`), never on remote HTTP. The socket is trusted local control, yet a
 * call acts as a thread, so the route also requires the agent host's own
 * bearer (the 0600 `agent-host.token` the daemon already authenticates to
 * the host with): only the host, which resolved the thread from a credential
 * the provider could not forge, may say which thread is calling. Everything
 * else in the handler's context — project, cwd, provider — is read from the
 * thread's own tab record here, never from the request's tool arguments.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import { daemonRoutesForHost, type SessionToolCallRequest } from "../agent-host/host-protocol.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { executeSessionToolCall } from "./executor.ts";
import type { SessionToolRegistry } from "./registry.ts";

/** 16 MiB, as the external `/mcp` route: room for an inline page or image argument. */
const SESSION_TOOL_BODY_LIMIT = 16 * 1024 * 1024;

/** What the route derives about a thread from the daemon's own records. */
export interface SessionToolThread {
  projectPath: string;
  cwd: string;
  agentId: AgentAdapterId;
}

export interface SessionToolRouteDeps {
  /** True only for the agent host's own bearer. */
  authorizeHost(authorization: string | undefined): boolean;
  /** The thread's chat tab, or null when the daemon has none (a closed or unknown thread). */
  resolveThread(threadId: string): SessionToolThread | null;
  /** The daemon's in-process API for handlers; null while it does not exist yet. */
  api(): DaemonApi | null;
  registry(): SessionToolRegistry;
  now?: () => number;
}

function parseBody(body: unknown): SessionToolCallRequest | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const { threadId, callId, name } = record;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > 256) return null;
  return {
    threadId,
    callId: typeof callId === "string" && callId.length > 0 && callId.length <= 256 ? callId : `call-${randomUUID()}`,
    name,
    arguments: record.arguments
  };
}

export function registerSessionToolsRoute(app: FastifyInstance, deps: SessionToolRouteDeps): void {
  app.post(daemonRoutesForHost.sessionToolCall, { bodyLimit: SESSION_TOOL_BODY_LIMIT }, async (request, reply) => {
    if (!deps.authorizeHost(request.headers.authorization)) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "Only the agent host may call session tools." });
    }
    const call = parseBody(request.body);
    if (call === null) {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "threadId and name are required." });
    }
    const thread = deps.resolveThread(call.threadId);
    if (thread === null) {
      return reply.code(404).send({ code: "THREAD_NOT_FOUND", message: "No chat thread with that id." });
    }
    const api = deps.api();
    if (api === null) {
      return reply.code(503).send({ code: "UNAVAILABLE", message: "The daemon is still starting." });
    }
    // The host dropping the connection — the provider cancelled the call, the
    // turn was interrupted, the session ended — cancels the handler. 'close'
    // also fires after a sent reply, where the abort is harmless.
    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const result = await executeSessionToolCall(
      deps.registry(),
      { name: call.name, arguments: call.arguments },
      {
        threadId: call.threadId,
        projectPath: thread.projectPath,
        cwd: thread.cwd,
        agentId: thread.agentId,
        callId: call.callId,
        signal: controller.signal,
        api,
        now: deps.now ?? Date.now
      }
    );
    if (controller.signal.aborted) {
      // Nobody is left to read it.
      return reply.code(499).send();
    }
    return reply.code(200).send(result);
  });
}
