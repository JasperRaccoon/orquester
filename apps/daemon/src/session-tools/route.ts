/**
 * Session tools — the daemon's socket-only route (design §1.1):
 * `POST /api/agent-host/session-tools/call` — the in-chat transport of the unified catalog
 * (design 2026-10-15 §3.3): every call runs through THE executor (`../mcp/executor.ts`) over
 * `catalogFor("chat")`, as a `thread` caller built here from the thread's own tab and snapshot:
 * its title, permission mode, whether its running turn plans, the workflow-owned trait (owner +
 * lineage walk) and the exchange (`causedBy` of its running turn). Never from the arguments.
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
import { canonicalProject } from "../mcp/addressing.ts";
import type { AnyOrquesterTool, ApprovalPort, ThreadCaller } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { ToolError } from "../mcp/errors.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { isWorkflowOwned } from "../mcp/gate/scope.ts";
import { exchangeOfTurn } from "../mcp/gate/turn-policy.ts";
import { listSessions, readThreadHead } from "../mcp/reads.ts";
import { toSafeToolError } from "../mcp/result.ts";
import { KNOWLEDGE_WORKER_OWNER_KIND } from "../knowledge/visibility.ts";
import { KNOWLEDGE_WORKER_TOOLS } from "./manifest.ts";
import type { SessionSecretRequests } from "./contract.ts";
import { chatToolByName } from "./legacy-aliases.ts";

/** 16 MiB, as the external `/mcp` route: room for an inline page or image argument. */
const SESSION_TOOL_BODY_LIMIT = 16 * 1024 * 1024;

/** What the route derives about a thread from the daemon's own records. */
export interface SessionToolThread {
  projectPath: string;
  cwd: string;
  agentId: AgentAdapterId;
  /** The tab's `owner.kind`, when it has one (`"workflow"`, `"knowledge-indexer"`, …). */
  ownerKind?: string;
}

export interface SessionToolRouteDeps {
  /** True only for the agent host's own bearer. */
  authorizeHost(authorization: string | undefined): boolean;
  /** The thread's chat tab, or null when the daemon has none (a closed or unknown thread). */
  resolveThread(threadId: string): SessionToolThread | null;
  /** The daemon's in-process API for handlers; null while it does not exist yet. */
  api(): DaemonApi | null;
  /** The chat tools by name (default: the catalog's `chat` audience, then the legacy aliases, spec §14.1). */
  lookup?: (name: string) => AnyOrquesterTool | undefined;
  /** Cards and grants (default: the daemon's wiring, `executorPorts`). */
  approvals?: ApprovalPort | null;
  /** The daemon's secret requests (`request_secret`); absent where none is wired. */
  secretRequests?: SessionSecretRequests;
  now?: () => number;
}

/**
 * The calling chat as the gate judges it, read NOW from its tab and its head (§3.2
 * `ToolCaller`): the project canonical when it is one, else "" (no own project — every target is
 * "other"; the contract's `projectPath`).
 */
export async function buildThreadCaller(
  api: DaemonApi,
  threadId: string,
  thread: SessionToolThread,
  callId: string,
  delivered?: Promise<boolean>
): Promise<ThreadCaller> {
  // The thread's head, never its whole snapshot: this runs on every session-tool call.
  const [sessions, ownHead] = await Promise.all([listSessions(api), readThreadHead(api, threadId)]);
  const tab = sessions.find((session) => session.id === threadId);
  if (!tab) throw new ToolError("THREAD_NOT_FOUND", "This chat thread is no longer open.");
  const project = thread.projectPath ? await canonicalProject(api, thread.projectPath) : null;
  return {
    kind: "thread",
    threadId,
    title: tab.title,
    // Canonical project root, or "" when the tab's path is no (longer a) project: no own project.
    projectPath: project?.canonical ?? "",
    workspace: project?.workspace ?? "",
    cwd: thread.cwd,
    agentId: thread.agentId,
    callId,
    runtimeMode: ownHead.head.runtimeMode,
    // `runningTurnPlans` / `runningExchange` of the snapshot, as the head carries them.
    planning: ownHead.interactionMode === "plan",
    workflowOwned: isWorkflowOwned(sessions, threadId),
    exchange: exchangeOfTurn(ownHead.runningTurn),
    ...(delivered ? { delivered } : {})
  };
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
    // A Knowledge Graph worker chat reads untrusted entry text: whatever its manifest advertised
    // (a fallback, a degraded read), it may call its two worker tools and nothing else.
    if (thread.ownerKind === KNOWLEDGE_WORKER_OWNER_KIND && !KNOWLEDGE_WORKER_TOOLS.includes(call.name)) {
      return reply.code(200).send(toSafeToolError(new ToolError("TOOL_NOT_FOUND", `Session tool ${call.name.slice(0, 100)} not found.`)));
    }
    const api = deps.api();
    if (api === null) {
      return reply.code(503).send({ code: "UNAVAILABLE", message: "The daemon is still starting." });
    }
    // The host dropping the connection — the provider cancelled the call, the
    // turn was interrupted, the session ended — cancels the handler. 'close'
    // also fires after a sent reply, where the abort is harmless.
    const controller = new AbortController();
    // Whether the result reached the host: a tool that hands out something
    // once (`request_secret`) reports its outcome truthfully by it.
    let markDelivered!: (delivered: boolean) => void;
    const delivered = new Promise<boolean>((resolve) => {
      markDelivered = resolve;
    });
    reply.raw.on("finish", () => markDelivered(true));
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
      markDelivered(reply.raw.writableFinished);
    });
    const now = deps.now ?? Date.now;
    let result;
    try {
      const caller = await buildThreadCaller(api, call.threadId, thread, call.callId, delivered);
      result = await executeToolCall(
        {
          lookup: (name, audience) => (audience === "chat" ? (deps.lookup ? deps.lookup(name) : chatToolByName(name)) : undefined),
          ...(deps.approvals !== undefined ? { approvals: deps.approvals } : {}),
          refreshCaller: (before) => buildThreadCaller(api, before.threadId, thread, before.callId, delivered),
          ...(deps.secretRequests !== undefined ? { secretRequests: deps.secretRequests } : {}),
          now
        },
        { name: call.name, arguments: call.arguments },
        { caller, api, signal: controller.signal }
      );
    } catch (error) {
      // The caller could not be read (the thread closed, the host restarting): a coded result.
      result = toSafeToolError(error);
    }
    if (controller.signal.aborted) {
      // Nobody is left to read it.
      markDelivered(false);
      return reply.code(499).send();
    }
    return reply.code(200).send(result);
  });
}
