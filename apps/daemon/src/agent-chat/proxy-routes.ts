/**
 * The daemon half of §6.2 and §6.3: every chat route, proxied onto the agent
 * host's unix socket.
 *
 * The daemon is a **proxy, not a translator** — a command body crosses
 * unchanged and the host's error envelope is passed through verbatim, so there
 * is exactly one place that decides what `COMMAND_REJECTED` means.
 *
 * Registered on BOTH transports, inheriting their auth unchanged (§6): bearer
 * on HTTP, none on the unix socket. The chat stream does **not** get the
 * `?token=` carve-out `/ws` and `/api/fs/download` have — nothing here is
 * fetched by a bare browser navigation.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentAccount, SessionSummary } from "@orquester/api";
import { overlayManagedAccountAuth } from "./provider-auth-overlay.ts";
import {
  AGENT_CHAT_COMMAND_NAMES,
  agentChatRoutes,
  type AgentChatCommandName,
  type AgentChatErrorCode,
  type AgentChatErrorEnvelope
} from "@orquester/api/agent-chat";
import { agentHostRoutes } from "../agent-host/host-protocol.ts";
import { AgentHostClient, HostUnavailableError } from "./host-client.ts";

/** Maps a §6.2 command name onto the host's route for the same command. */
const HOST_COMMAND_ROUTE: Record<AgentChatCommandName, (threadId: string) => string> = {
  turn: agentHostRoutes.turn,
  interrupt: agentHostRoutes.interrupt,
  approval: agentHostRoutes.approval,
  answer: agentHostRoutes.answer,
  dismiss: agentHostRoutes.dismiss,
  revert: agentHostRoutes.revert,
  compact: agentHostRoutes.compact,
  mode: agentHostRoutes.mode,
  "session/stop": agentHostRoutes.sessionStop
};

export interface AgentChatRouteDeps {
  client: AgentHostClient;
  /** False while the host is restarting/foreign → every route answers 503. */
  isHostHealthy(): boolean;
  /** The tab, or undefined when this id is not a chat session. */
  chatSession(id: string): SessionSummary | undefined;
  /** Remember the sequence a client has been served to (§5.2 `lastSeq`). */
  noteSeq(id: string, seq: number): void;
  /**
   * §6.3 `POST /api/agent-host/stop`: the host writes every continuation
   * marker for a running thread with a usable cursor, then drains and stops,
   * and the supervisor brings a replacement up. Answers the threads that were
   * marked, and the new instance id (null when the replacement never became
   * ready — §8's "reported as not switched").
   */
  restartHost(): Promise<{ hostInstanceId: string | null; markedThreadIds: string[] }>;
  /**
   * §6.3/§6.4: a refresh that actually changed something raises the coarse
   * `agent.providers.changed` and the client re-reads. Only `changed: true`
   * broadcasts — a no-op refresh must not wake every client.
   */
  onProvidersChanged(adapterId: string): void;
  /**
   * The managed accounts, for the §7.7 auth overlay on every provider snapshot
   * that leaves the daemon: a probe run under the host identity must not
   * report "sign in again" while a managed account of that family is valid.
   */
  managedAccounts?(): { accounts: AgentAccount[]; defaults?: Partial<Record<AgentAccount["agent"], string | null>> };
  /** §6.3 read-back: the host resolves an attachment id to an absolute path. */
  attachmentPath(sessionId: string, attachmentId: string): Promise<string | null>;
  /** Stream that file to the client (`index.ts` owns the download headers). */
  sendAttachment(reply: FastifyReply, path: string): Promise<unknown>;
  logger?: { warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

/** The §6.2 envelope, built in one place so no route invents a shape. */
export function chatError(
  code: AgentChatErrorCode,
  message: string,
  detail?: unknown
): AgentChatErrorEnvelope {
  return detail === undefined ? { error: { code, message } } : { error: { code, message, detail } };
}

const HOST_UNAVAILABLE = chatError(
  "HOST_UNAVAILABLE",
  "The agent host is restarting. Retry the same commandId."
);

const THREAD_NOT_FOUND = chatError("THREAD_NOT_FOUND", "No chat session with that id.");

/**
 * Build a Fastify path pattern from the shared route builders, so the daemon
 * and the client can never drift on a path. The builders percent-encode their
 * arguments (correct for a real id), which turns `:id` into `%3Aid` — decode it
 * back so Fastify sees a parameter.
 */
function pattern(path: string): string {
  return decodeURIComponent(path);
}

/**
 * `agentChatRoutes.turnDiff` takes a number, so the pattern is built from a
 * placeholder count and the digits swapped for the parameter — keeping the
 * shape (`/turns/<n>/diff`) owned by the one shared builder.
 */
const TURN_DIFF_PATTERN = agentChatRoutes.turnDiff(":id", 0).replace(/\/0\/diff$/, "/:turnCount/diff");

/**
 * Register every §6.2/§6.3 route. `mode` exists only so the host-stop route
 * can be named in logs; both transports get the identical surface, because a
 * chat command is not a change of daemon security posture (unlike
 * `PUT /api/config/daemon`).
 */
export function registerAgentChatRoutes(app: FastifyInstance, deps: AgentChatRouteDeps): void {
  // --- §6.2 commands -------------------------------------------------------
  for (const name of AGENT_CHAT_COMMAND_NAMES) {
    const path =
      name === "session/stop" ? agentChatRoutes.sessionStop(":id") : agentChatRoutes[name](":id");
    app.post<{ Params: { id: string } }>(
      pattern(path),
      async (request, reply) => {
        const { id } = request.params;
        if (!deps.chatSession(id)) {
          return reply.code(404).send(THREAD_NOT_FOUND);
        }
        if (!deps.isHostHealthy()) {
          return reply.code(503).send(HOST_UNAVAILABLE);
        }
        return forwardJson(
          deps,
          reply,
          "POST",
          HOST_COMMAND_ROUTE[name](id),
          request.body ?? {}
        );
      }
    );
  }

  // --- §6.3 reads ----------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    pattern(agentChatRoutes.thread(":id")),
    async (request, reply) => {
      const { id } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      const value = await forwardJson(
        deps,
        reply,
        "GET",
        withQuery(agentHostRoutes.read(id), { after: request.query.after })
      );
      noteSeqFrom(deps, id, value);
      return value;
    }
  );

  app.get<{ Params: { id: string; itemId: string } }>(
    pattern(agentChatRoutes.item(":id", ":itemId")),
    async (request, reply) => {
      const { id, itemId } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      return forwardJson(deps, reply, "GET", agentHostRoutes.item(id, itemId));
    }
  );

  app.get<{
    Params: { id: string; turnCount: string };
    Querystring: { ignoreWhitespace?: string };
  }>(pattern(TURN_DIFF_PATTERN), async (request, reply) => {
    const { id } = request.params;
    if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
    if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
    const turnCount = Number(request.params.turnCount);
    if (!Number.isInteger(turnCount) || turnCount < 0) {
      return reply.code(400).send(chatError("INVALID_COMMAND", "turn count must be a non-negative integer."));
    }
    return forwardJson(
      deps,
      reply,
      "GET",
      withQuery(agentHostRoutes.turnDiff(id, turnCount), {
        ignoreWhitespace: request.query.ignoreWhitespace
      })
    );
  });

  // The long-lived §6.3 subscription. Hijacked so Fastify's serializer never
  // sees it: the response is raw chunked NDJSON, piped from the host with
  // backpressure, and the upstream is cancelled the moment the client goes.
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    pattern(agentChatRoutes.events(":id")),
    async (request, reply) => {
      const { id } = request.params;
      if (!deps.chatSession(id)) {
        void reply.code(404).send(THREAD_NOT_FOUND);
        return;
      }
      if (!deps.isHostHealthy()) {
        void reply.code(503).send(HOST_UNAVAILABLE);
        return;
      }
      await pipeStream(
        deps,
        request,
        reply,
        withQuery(agentHostRoutes.events(id), { after: request.query.after })
      );
    }
  );

  // --- §6.3 host-level -----------------------------------------------------

  app.get(agentChatRoutes.providers, async (_request, reply) => {
    if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
    const value = await forwardJson(deps, reply, "GET", agentHostRoutes.providers);
    if (isRecord(value) && Array.isArray(value.providers)) {
      return { ...value, providers: value.providers.map((p) => overlayAuth(deps, p)) };
    }
    return value;
  });

  app.post<{ Params: { id: string } }>(
    pattern(agentChatRoutes.providerRefresh(":id")),
    async (request, reply) => {
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      const value = await forwardJson(
        deps,
        reply,
        "POST",
        agentHostRoutes.providerRefresh(request.params.id),
        request.body ?? {}
      );
      if (value && typeof value === "object" && (value as { changed?: unknown }).changed === true) {
        deps.onProvidersChanged(request.params.id);
      }
      if (isRecord(value) && isRecord(value.provider)) {
        return { ...value, provider: overlayAuth(deps, value.provider) };
      }
      return value;
    }
  );

  // §6.3 attachment read-back. `/api/fs/download` cannot serve these — it is
  // confined to `fsRoot` and the thread's attachments live under the appdir's
  // `daemon/agent/threads/<id>/attachments`. The host resolves the id (it owns
  // the namespace and its traversal guard) and the daemon streams the file,
  // carrying the same `?token=` carve-out a native `<a download>` needs.
  app.get<{ Params: { id: string; attachmentId: string } }>(
    pattern(agentChatRoutes.attachment(":id", ":attachmentId")),
    async (request, reply) => {
      const { id, attachmentId } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      let path: string | null;
      try {
        path = await deps.attachmentPath(id, attachmentId);
      } catch (error) {
        if (error instanceof HostUnavailableError) {
          return reply.code(503).send(HOST_UNAVAILABLE);
        }
        deps.logger?.error?.("agent chat attachment resolve failed", error);
        return reply.code(503).send(HOST_UNAVAILABLE);
      }
      if (!path) {
        return reply.code(404).send(chatError("THREAD_NOT_FOUND", "No such attachment."));
      }
      return deps.sendAttachment(reply, path);
    }
  );

  // The intentional host stop of §3.3/§6.3: the host writes every continuation
  // marker for a running thread with a usable cursor, then drains and stops.
  // The supervisor then brings a replacement up and holds §8's deadline on it.
  app.post(agentChatRoutes.hostStop, async (_request, reply) => {
    if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
    try {
      const { hostInstanceId, markedThreadIds } = await deps.restartHost();
      return { ok: hostInstanceId !== null, markedThreadIds, hostInstanceId };
    } catch (error) {
      deps.logger?.error?.("agent host stop failed", error);
      return reply.code(503).send(HOST_UNAVAILABLE);
    }
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/**
 * One bounded hop. The host's status and body are passed through verbatim —
 * including its error envelope — so the client sees exactly one description of
 * a failure, whichever layer produced it (§6.2).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The §7.7 overlay, applied only to a value shaped like a provider snapshot. */
function overlayAuth(deps: AgentChatRouteDeps, provider: unknown): unknown {
  if (!deps.managedAccounts || !isRecord(provider)) return provider;
  const auth = provider.auth;
  if (typeof provider.id !== "string" || typeof provider.status !== "string" || !isRecord(auth)) {
    return provider;
  }
  if (typeof auth.status !== "string") return provider;
  const { accounts, defaults } = deps.managedAccounts();
  return overlayManagedAccountAuth(
    provider as { id: string; status: string; message?: string; auth: { status: string } },
    accounts,
    defaults
  );
}

async function forwardJson(
  deps: AgentChatRouteDeps,
  reply: FastifyReply,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  try {
    const response = await deps.client.json<unknown>(method, path, body);
    void reply.code(response.status);
    if (response.value !== null) return response.value;
    // A non-JSON body from the host is a bug on its side; never leak it raw.
    if (response.raw.trim() === "") return reply.send();
    deps.logger?.warn?.(`agent host answered non-JSON on ${path}`);
    return reply
      .code(502)
      .send(chatError("HOST_UNAVAILABLE", "The agent host returned an unreadable response."));
  } catch (error) {
    if (error instanceof HostUnavailableError) {
      return reply.code(503).send(HOST_UNAVAILABLE);
    }
    deps.logger?.error?.(`agent host proxy failed on ${path}`, error);
    return reply.code(503).send(HOST_UNAVAILABLE);
  }
}

/** Remember the sequence a §6.3 read served, so a reconnect resumes from it. */
function noteSeqFrom(deps: AgentChatRouteDeps, id: string, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (row.kind === "snapshot" && row.thread && typeof row.thread === "object") {
    const seq = (row.thread as Record<string, unknown>).seq;
    if (typeof seq === "number") deps.noteSeq(id, seq);
    return;
  }
  if (row.kind === "events" && typeof row.seq === "number") {
    deps.noteSeq(id, row.seq);
  }
}

/**
 * Pipe the host's NDJSON straight to the client.
 *
 * Three things matter and are all here on purpose:
 * - **backpressure**: `pipe()` pauses the upstream when the downstream socket
 *   stops draining, so a slow browser cannot grow daemon memory;
 * - **cancellation**: the upstream is destroyed on client disconnect, or the
 *   host would keep a subscription alive for a reader that is gone;
 * - **no buffering**: the response is hijacked, so Fastify neither serializes
 *   nor compresses it, and `:hb` comment lines reach the client immediately.
 */
async function pipeStream(
  deps: AgentChatRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  path: string
): Promise<void> {
  const controller = new AbortController();
  request.raw.on("close", () => controller.abort());
  let upstream: Awaited<ReturnType<AgentHostClient["open"]>>;
  try {
    upstream = await deps.client.open("GET", path, {
      headers: { accept: "application/x-ndjson" },
      signal: controller.signal,
      timeoutMs: 15_000
    });
  } catch (error) {
    if (!request.raw.destroyed) {
      void reply.code(503).send(HOST_UNAVAILABLE);
    }
    if (!(error instanceof HostUnavailableError)) {
      deps.logger?.error?.("agent chat stream failed to open", error);
    }
    return;
  }

  if (upstream.status !== 200) {
    // Read the host's error envelope and answer with it rather than an empty
    // stream the client would sit on.
    const chunks: Buffer[] = [];
    for await (const chunk of upstream.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let payload: unknown = null;
    try {
      payload = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    void reply.code(upstream.status).send(payload ?? HOST_UNAVAILABLE);
    return;
  }

  reply.hijack();
  const socket = reply.raw;
  socket.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Proxy buffering would hold the heartbeat and every event until a buffer
    // filled — the whole point of the stream is that it does not.
    "x-accel-buffering": "no"
  });
  const done = (): void => {
    controller.abort();
    upstream.abort();
    if (!socket.destroyed) socket.end();
  };
  socket.on("close", () => {
    controller.abort();
    upstream.abort();
  });
  upstream.body.on("error", done);
  upstream.body.on("end", done);
  upstream.body.pipe(socket, { end: false });
}
