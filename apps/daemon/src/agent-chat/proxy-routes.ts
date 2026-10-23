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

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentAccount, SessionSummary } from "@orquester/api";
import { overlayManagedAccountAuth } from "./provider-auth-overlay.ts";
import {
  AGENT_CHAT_COMMAND_NAMES,
  AGENT_CHAT_ERROR_CODES,
  MCP_APP_OPERATIONS,
  THREAD_SEARCH_MAX_QUERY_CHARS,
  agentChatCommandPath,
  agentChatRoutes,
  isHtmlRenderAttachmentId,
  threadHeadOf,
  threadHeadQueryOf,
  threadHeadQueryParams,
  threadHeadQueryProblem,
  type AgentChatCommandName,
  type AgentHostStatusResponse,
  type AgentChatErrorCode,
  type AgentChatErrorEnvelope,
  type McpAppOperation,
  type Skill,
  type SlashCommand,
  type ThreadCatalogResponse,
  type ThreadSearchResponse,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";
import { agentHostRoutes, type HostThreadCatalogResponse } from "../agent-host/host-protocol.ts";
import { agentHostExtraRoutes } from "../agent-host/server/extra-routes.ts";
import { AgentHostClient, HostUnavailableError, type HostJsonResponse } from "./host-client.ts";
import { VISUAL_PAGE_HEADERS, type VisualUrlSigner } from "./visual-urls.ts";

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
  background: agentHostRoutes.background,
  "task/stop": agentHostRoutes.taskStop,
  "session/stop": agentHostRoutes.sessionStop
};

export interface AgentChatRouteDeps {
  client: AgentHostClient;
  /** False while the host is restarting/foreign → every route answers 503. */
  isHostHealthy(): boolean;
  /** The tab, or undefined when this id is not a chat session. */
  chatSession(id: string): SessionSummary | undefined;
  /**
   * The adopted host's instance id (`AgentHostHealthResponse.hostInstanceId`), null when none. Keys
   * what this daemon learned about that host's routes (the head route's miss): a restart or a
   * handover brings another id, and the host is asked afresh. Absent: nothing is remembered.
   */
  hostInstanceId?(): string | null;
  /** Remember the sequence a client has been served to (§5.2 `lastSeq`). */
  noteSeq(id: string, seq: number): void;
  /**
   * boxes: why a command that runs the agent CLI (a turn, a compaction) cannot run in this chat
   * now — its project's box was destroyed — or null. Optional: route tests build partial deps.
   */
  agentRunRefusal?(id: string): string | null;
  /**
   * §3.4's account switch. **Not** a proxied command: the body is not forwarded
   * verbatim — the daemon resolves the account, recomposes the launch
   * environment, prepares the home and only then calls the host, which is why
   * this route exists here rather than in {@link AGENT_CHAT_COMMAND_NAMES}.
   */
  switchAccount(id: string, body: { commandId: string; accountId: string }): Promise<{ seq: number }>;
  /**
   * The Agent Profile switch (spec 2026-10-18 §5.3), daemon-owned like {@link switchAccount}:
   * only the daemon resolves the profile's prepared directory and recomposes the launch.
   * `profileId: null` is Global. Optional: route tests build partial deps (the route then 404s).
   */
  switchProfile?(id: string, body: { commandId: string; profileId: string | null }): Promise<{ seq: number }>;
  /**
   * A profile chat's composer catalog when its live session reported none: the profile's own
   * items (`AgentChatService.profileCatalog`); `null` when there is none to offer. Optional: route
   * tests build partial deps (the route then answers `none`).
   */
  profileCatalog?(summary: SessionSummary): Promise<{ slashCommands: SlashCommand[]; skills: Skill[] } | null>;
  /**
   * §6.3 `POST /api/agent-host/stop`: the host writes every continuation
   * marker for a running thread with a usable cursor, then drains and stops,
   * and the supervisor brings a replacement up. Answers the threads that were
   * marked, and the new instance id (null when the replacement never became
   * ready — §8's "reported as not switched").
   */
  restartHost(): Promise<{ hostInstanceId: string | null; markedThreadIds: string[] }>;
  /**
   * `GET /api/agent-host/status`: the supervised host and a pending drain-restart's blockers,
   * per thread (`AgentHostSupervisor.restartStatus`). Optional: route tests build partial deps
   * (the route then answers 404).
   */
  hostStatus?(): AgentHostStatusResponse;
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
  /** Mints and checks the signed URLs agent pages are framed from (spec 2026-10-14 §2.2). */
  visualUrls: VisualUrlSigner;
  /**
   * The host accepted an `interrupt` or a `session/stop` for this chat (any caller): the delegate
   * stop cascade interrupts the chats it delegated to (`DelegateStopCascade.commandAccepted`).
   * Must not throw or block. Optional: without it nothing cascades.
   */
  onStopCommand?(id: string, command: "interrupt" | "session/stop", body: unknown): void;
  logger?: { warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

/**
 * How long an MCP App's request may wait on the host: the host bounds the
 * provider call itself at two minutes; this lets that answer through.
 */
const MCP_APP_PROXY_TIMEOUT_MS = 130_000;

/** The §6.2 envelope, built in one place so no route invents a shape. */
function chatError(code: AgentChatErrorCode, message: string): AgentChatErrorEnvelope {
  return { error: { code, message } };
}

const HOST_UNAVAILABLE = chatError(
  "HOST_UNAVAILABLE",
  "The agent host is restarting. Retry the same commandId."
);

/**
 * The §6.2 status of every code. Total by construction: a code added to
 * {@link AgentChatErrorCode} without a status here is a typecheck error, never
 * a silent 409.
 */
const CHAT_ERROR_STATUS: Record<AgentChatErrorCode, number> = {
  INVALID_COMMAND: 400,
  THREAD_NOT_FOUND: 404,
  COMMAND_ID_CONFLICT: 409,
  COMMAND_REJECTED: 409,
  COMPACTION_UNAVAILABLE: 409,
  HOST_UNAVAILABLE: 503,
  INDEX_UNAVAILABLE: 503,
  ITEM_NOT_FOUND: 404,
  PROMPT_NOT_FOUND: 404,
  TURN_NOT_IDLE: 409
};

/**
 * Map a `ChatSessionError`/host envelope code onto the closed §6.2 list. A
 * daemon-side refusal that names no code is a 409 `COMMAND_REJECTED`, the same
 * shape the client's command-rejection banner already understands.
 */
function accountSwitchErrorCode(error: unknown): AgentChatErrorCode {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" &&
    (AGENT_CHAT_ERROR_CODES as readonly string[]).includes(code)
    ? (code as AgentChatErrorCode)
    : "COMMAND_REJECTED";
}

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
 * The signed page route's pattern. The daemon's bearer hook lets exactly this
 * route through (`index.ts`): an iframe cannot send the header, and the route
 * refuses anything its signature does not authorise.
 */
export const AGENT_VISUAL_ROUTE_PATTERN = pattern(agentChatRoutes.visual(":id", ":attachmentId"));

/** A refusal a frame may display: plain text, under the page's own sandbox. */
function refuseVisual(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply
    .code(status)
    .header("Content-Type", "text/plain; charset=utf-8")
    .header("Content-Security-Policy", VISUAL_PAGE_HEADERS["Content-Security-Policy"]!)
    .header("X-Content-Type-Options", "nosniff")
    .header("Cache-Control", "private, no-store")
    .send(message);
}

/**
 * Register every §6.2/§6.3 route on both transports. Chat commands do not
 * change daemon security settings, unlike `PUT /api/config/daemon`.
 */
export function registerAgentChatRoutes(app: FastifyInstance, deps: AgentChatRouteDeps): void {
  // --- §6.2 commands -------------------------------------------------------
  for (const name of AGENT_CHAT_COMMAND_NAMES) {
    const path = agentChatCommandPath(":id", name);
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
        // boxes: a turn in a chat whose box is gone would wait for a CLI that can never start.
        const refusal = name === "turn" || name === "compact" ? (deps.agentRunRefusal?.(id) ?? null) : null;
        if (refusal !== null) {
          return reply.code(CHAT_ERROR_STATUS.COMMAND_REJECTED).send(chatError("COMMAND_REJECTED", refusal));
        }
        const answer = await forwardJson(
          deps,
          reply,
          "POST",
          HOST_COMMAND_ROUTE[name](id),
          request.body ?? {}
        );
        // A stop the host took: the chats this one delegated stop too (`delegates.ts`).
        if ((name === "interrupt" || name === "session/stop") && reply.statusCode < 400) {
          try {
            deps.onStopCommand?.(id, name, request.body ?? {});
          } catch (error) {
            deps.logger?.warn?.("the delegate stop cascade could not start", error);
          }
        }
        return answer;
      }
    );
  }

  // --- §3.4 the account switch (daemon-owned, not a proxied command) -------
  app.post<{ Params: { id: string }; Body: { commandId?: unknown; accountId?: unknown } }>(
    pattern(agentChatRoutes.account(":id")),
    async (request, reply) => {
      const { id } = request.params;
      if (!deps.chatSession(id)) {
        return reply.code(404).send(THREAD_NOT_FOUND);
      }
      if (!deps.isHostHealthy()) {
        return reply.code(503).send(HOST_UNAVAILABLE);
      }
      const body = request.body ?? {};
      try {
        return await deps.switchAccount(id, {
          commandId: String(body.commandId ?? ""),
          accountId: String(body.accountId ?? "")
        });
      } catch (error) {
        const code = accountSwitchErrorCode(error);
        return reply
          .code(CHAT_ERROR_STATUS[code])
          .send(
            chatError(
              code,
              error instanceof Error ? error.message : "Could not switch the account."
            )
          );
      }
    }
  );

  // --- Agent Profiles: the profile switch (daemon-owned, as the account's) --
  if (deps.switchProfile) {
    const switchProfile = deps.switchProfile;
    app.post<{ Params: { id: string }; Body: { commandId?: unknown; profileId?: unknown } }>(
      pattern(agentChatRoutes.profile(":id")),
      async (request, reply) => {
        const { id } = request.params;
        if (!deps.chatSession(id)) {
          return reply.code(404).send(THREAD_NOT_FOUND);
        }
        if (!deps.isHostHealthy()) {
          return reply.code(503).send(HOST_UNAVAILABLE);
        }
        const body = request.body ?? {};
        try {
          return await switchProfile(id, {
            commandId: String(body.commandId ?? ""),
            // Validated by the service: an id, or null for Global; anything else is INVALID_COMMAND.
            profileId: body.profileId as string | null
          });
        } catch (error) {
          // A profile refusal (PROFILE_NOT_READY, …) is a COMMAND_REJECTED with its reason.
          const code = accountSwitchErrorCode(error);
          return reply
            .code(CHAT_ERROR_STATUS[code])
            .send(chatError(code, error instanceof Error ? error.message : "Could not switch the profile."));
        }
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

  // The thread's head (`thread-head.ts`): the daemon's per-call and per-event readers (the MCP's
  // waits and status reads, the reply router, the delivery queue, session-tool callers) ask for
  // this instead of a whole snapshot. A host that predates its `/head` route answers the route
  // miss; the head is then derived here from that host's snapshot by the same `threadHeadOf`, so
  // the answer is the same either way — and that host instance is not asked again: the decision
  // is kept per host instance, so a handover's new host is asked afresh.
  let headRouteMissingOn: string | null = null;
  app.get<{ Params: { id: string }; Querystring: { replyChars?: string; turnIds?: string; messageIds?: string } }>(
    pattern(agentChatRoutes.threadHead(":id")),
    async (request, reply) => {
      const { id } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      const query = threadHeadQueryOf(request.query);
      const problem = threadHeadQueryProblem(query);
      if (problem !== null) return reply.code(400).send(chatError("INVALID_COMMAND", problem));
      // Read BEFORE the request, and again after a route miss (below).
      const instance = deps.hostInstanceId?.() ?? null;
      if (instance === null || headRouteMissingOn !== instance) {
        let response: HostJsonResponse<unknown>;
        try {
          response = await deps.client.json<unknown>(
            "GET",
            withQuery(agentHostRoutes.head(id), threadHeadQueryParams(query))
          );
        } catch (error) {
          if (!(error instanceof HostUnavailableError)) deps.logger?.error?.("agent host proxy failed on a thread head", error);
          return reply.code(503).send(HOST_UNAVAILABLE);
        }
        if (!isHostRouteMiss(response)) {
          if (response.value === null) {
            return reply.code(502).send(chatError("HOST_UNAVAILABLE", "The agent host returned an unreadable response."));
          }
          if (response.status < 400) noteHeadSeq(deps, id, response.value);
          return reply.code(response.status).send(response.value);
        }
        // Kept only when the same instance was adopted before and after the answer: a host swapped
        // mid-request may be the one that has the route, and it is asked again on the next read.
        if (instance !== null && (deps.hostInstanceId?.() ?? null) === instance) headRouteMissingOn = instance;
      }
      const value = await forwardJson(deps, reply, "GET", agentHostRoutes.read(id));
      noteSeqFrom(deps, id, value);
      if (isRecord(value) && value.kind === "snapshot" && isRecord(value.thread)) {
        return threadHeadOf(value.thread as unknown as ThreadSnapshotPayload, query);
      }
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

  // The streamed output of the tool call an item belongs to, joined by the
  // host from the log — one window of it when `?offset=`/`?maxBytes=` ask for
  // one, forwarded verbatim and never interpreted: the host owns their rules
  // (`parseItemOutputWindow`), so an empty or a repeated value crosses as it
  // came and gets the host's own answer (a 400 for `?offset=`) — dropping it
  // here turned `?offset=` into the whole join and `?offset=1&offset=2` into
  // a window from 0. Passed through verbatim, 404s included: the host's own
  // is `ITEM_NOT_FOUND`, and a surviving older host's route miss is its generic
  // `THREAD_NOT_FOUND`, so a caller can tell them apart (the MCP's
  // `read_tool_output` takes either as "no streamed output" and answers the
  // item's own text). Unlike `/search`, nothing is synthesised here: no answer
  // of this route could stand for an older host's — and a host that predates
  // windows answers the whole join, which the reader tells apart itself.
  app.get<{ Params: { id: string; itemId: string }; Querystring: Record<string, unknown> }>(
    pattern(agentChatRoutes.itemOutput(":id", ":itemId")),
    async (request, reply) => {
      const { id, itemId } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      return forwardJson(
        deps,
        reply,
        "GET",
        `${agentHostRoutes.itemOutput(id, itemId)}${verbatimQuery(request.query, ["offset", "maxBytes"])}`
      );
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

  // A page of turns older than the client's window (design 2026-09-23 "thread
  // index and lazy boot"). Forwarded, never interpreted: the host owns the
  // cursor format and the `turns` clamp, and a host without a usable index
  // answers 503 `INDEX_UNAVAILABLE` itself. The page's `seq` is deliberately
  // NOT noted — it names the thread's current sequence while the page carries
  // only old turns, so moving the tab's reconnect cursor to it would let a
  // §6.3 reconnect skip live events the client was never sent.
  app.get<{ Params: { id: string }; Querystring: { before?: string; turns?: string } }>(
    pattern(agentChatRoutes.history(":id")),
    async (request, reply) => {
      const { id } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      return forwardJson(
        deps,
        reply,
        "GET",
        withQuery(agentHostRoutes.history(id), {
          before: request.query.before,
          turns: request.query.turns
        })
      );
    }
  );

  // The thread's own prompts, newest first, from the host's index (the right
  // rail's History), and one prompt's whole text. Forwarded, never
  // interpreted, like history: the host owns the cursor and the `limit`
  // clamp, and answers itself for an index that cannot list the thread whole
  // (200 `indexed:false`, with `catchingUp` while it catches up) or failed a
  // read (503 `INDEX_UNAVAILABLE`), both passed through verbatim.
  // Every 404 passes through untouched — the host's own `PROMPT_NOT_FOUND`,
  // and a surviving older host's generic route-miss `THREAD_NOT_FOUND`, which
  // the client takes as "fall back to what you hold". Unlike `/search`,
  // nothing is synthesised for that miss: on a per-thread route a 404 can
  // also mean the thread is gone.
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    pattern(agentChatRoutes.prompts(":id")),
    async (request, reply) => {
      const { id } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      return forwardJson(
        deps,
        reply,
        "GET",
        withQuery(agentHostRoutes.prompts(id), {
          before: request.query.before,
          limit: request.query.limit
        })
      );
    }
  );

  app.get<{ Params: { id: string; messageId: string } }>(
    pattern(agentChatRoutes.promptText(":id", ":messageId")),
    async (request, reply) => {
      const { id, messageId } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      return forwardJson(deps, reply, "GET", agentHostRoutes.promptText(id, messageId));
    }
  );

  // An Agent Profile chat's composer catalog (`ThreadCatalogResponse`): what its live session
  // loaded (the host's `/catalog`), else the profile's own items — never the provider's Global
  // catalog. A Global chat answers `none` without asking the host (its composer is unchanged);
  // ONLY a Global chat does. A host that cannot answer (unhealthy, an older host's route miss, a
  // failure) is "no live report", never an error: the fallback still answers. A profile catalog
  // that cannot be offered (gone, unreadable, a failure) is the profile's, empty.
  app.get<{ Params: { id: string } }>(pattern(agentChatRoutes.catalog(":id")), async (request, reply) => {
    const { id } = request.params;
    const summary = deps.chatSession(id);
    if (!summary) return reply.code(404).send(THREAD_NOT_FOUND);
    const none: ThreadCatalogResponse = { threadId: id, source: "none", slashCommands: [], skills: [] };
    if (!summary.profileId) return none;
    if (deps.isHostHealthy()) {
      try {
        const answer = await deps.client.json<HostThreadCatalogResponse>("GET", agentHostRoutes.catalog(id));
        const value = answer.status === 200 ? answer.value : null;
        if (value !== null && value.live === true && Array.isArray(value.slashCommands) && Array.isArray(value.skills)) {
          return { threadId: id, source: "session", slashCommands: value.slashCommands, skills: value.skills } satisfies ThreadCatalogResponse;
        }
      } catch (error) {
        if (!(error instanceof HostUnavailableError)) deps.logger?.warn?.(`agent chat: the catalog of ${id} could not be read from the host`, error);
      }
    }
    let fallback: { slashCommands: SlashCommand[]; skills: Skill[] } | null = null;
    try {
      fallback = (await deps.profileCatalog?.(summary)) ?? null;
    } catch (error) {
      deps.logger?.warn?.(`agent chat: the profile catalog of ${id} could not be read`, error);
    }
    return {
      threadId: id,
      source: "profile",
      slashCommands: fallback?.slashCommands ?? [],
      skills: fallback?.skills ?? []
    } satisfies ThreadCatalogResponse;
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

  // Full-text search across every thread the host has indexed (design
  // 2026-09-23). Host-level like `providers`, so no tab gate. `q` crosses
  // untouched: quoting it for the FTS parser and clamping `q`/`limit` happen
  // once, on the host. "No index" is never an error on this route: a current
  // host without a usable one answers 200 `indexed:false` itself, passed
  // through, and the one case the daemon has to speak for is the 404 below.
  app.get<{ Querystring: { q?: string; limit?: string; projectPath?: string } }>(
    agentChatRoutes.search,
    async (request, reply) => {
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      return forwardJson(
        deps,
        reply,
        "GET",
        withQuery(agentHostRoutes.search, {
          q: request.query.q,
          limit: request.query.limit,
          projectPath: request.query.projectPath
        }),
        undefined,
        // The one 404 this route can see: a surviving older host predates
        // `/search` and answers its generic route-miss 404 until its
        // drain-restart (a current host never 404s here). That means exactly
        // "no index on this host", so answer the shape the palette renders as
        // unavailable rather than an error. `…/history` keeps its passthrough:
        // there a 404 can also mean the thread is gone.
        { notFound: () => unindexedSearch(request.query.q) }
      );
    }
  );

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

  // Agent pages (spec 2026-10-14 §2.2). The mint is an ordinary authenticated
  // chat route; it checks the id names a published page and nothing else —
  // the host's resolve on the signed read is what binds the id to its thread.
  app.post<{ Params: { id: string; attachmentId: string } }>(
    pattern(agentChatRoutes.visualUrl(":id", ":attachmentId")),
    async (request, reply) => {
      const { id, attachmentId } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!isHtmlRenderAttachmentId(attachmentId)) {
        return reply.code(404).send(chatError("THREAD_NOT_FOUND", "No such page."));
      }
      return deps.visualUrls.mint(id, attachmentId);
    }
  );

  // The page itself, for an iframe: authorised by its signature alone, never
  // by the bearer (which the frame cannot send), and served under the sandbox
  // CSP so it runs with an opaque origin.
  app.get<{ Params: { id: string; attachmentId: string }; Querystring: { exp?: unknown; sig?: unknown } }>(
    AGENT_VISUAL_ROUTE_PATTERN,
    async (request, reply) => {
      const { id, attachmentId } = request.params;
      if (!deps.visualUrls.verify(id, attachmentId, request.query.exp, request.query.sig)) {
        return refuseVisual(reply, 403, "This page link has expired. Reopen the thread to show it again.");
      }
      if (!isHtmlRenderAttachmentId(attachmentId) || !deps.chatSession(id)) {
        return refuseVisual(reply, 404, "This page is gone.");
      }
      if (!deps.isHostHealthy()) {
        return refuseVisual(reply, 503, "The agent host is restarting. Try again in a moment.");
      }
      let path: string | null;
      try {
        path = await deps.attachmentPath(id, attachmentId);
      } catch (error) {
        if (!(error instanceof HostUnavailableError)) {
          deps.logger?.error?.("agent visual resolve failed", error);
        }
        return refuseVisual(reply, 503, "The agent host is restarting. Try again in a moment.");
      }
      const info = path === null ? null : await stat(path).catch(() => null);
      if (path === null || !info?.isFile()) {
        return refuseVisual(reply, 404, "This page is gone.");
      }
      return reply
        .headers({ ...VISUAL_PAGE_HEADERS, "Content-Length": String(info.size) })
        .send(createReadStream(path));
    }
  );

  // MCP Apps (spec 2026-10-14 §3): one request of the app a completed tool row
  // carries. Forwarded with the row's id in the body; the host resolves the
  // app from the stored row and runs the request through the thread's live
  // provider session — the daemon never reaches the MCP server itself. A tool
  // call may take as long as the tool does, so the wait outlasts the host's
  // own two-minute bound on it.
  app.post<{ Params: { id: string; itemId: string; operation: string }; Body: unknown }>(
    pattern(agentChatRoutes.mcpApp(":id", ":itemId", ":operation" as McpAppOperation)),
    async (request, reply) => {
      const { id, itemId, operation } = request.params;
      if (!deps.chatSession(id)) return reply.code(404).send(THREAD_NOT_FOUND);
      if (!(MCP_APP_OPERATIONS as readonly string[]).includes(operation)) {
        return reply.code(404).send(chatError("ITEM_NOT_FOUND", "No such MCP app request."));
      }
      if (!deps.isHostHealthy()) return reply.code(503).send(HOST_UNAVAILABLE);
      const body = request.body !== null && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
      return forwardJson(
        deps,
        reply,
        "POST",
        agentHostExtraRoutes.mcpApp(id, operation as McpAppOperation),
        { ...body, itemId },
        { timeoutMs: MCP_APP_PROXY_TIMEOUT_MS }
      );
    }
  );

  // The intentional host stop of §3.3/§6.3: the host writes every continuation
  // marker for a running thread with a usable cursor, then drains and stops.
  // The supervisor then brings a replacement up and holds §8's deadline on it.
  // What a deploy's pending restart waits on — Settings → System shows it, with
  // a Stop for each task and the restart-now below. Read-only and cheap: it
  // answers from the supervisor's last fresh probe.
  app.get(agentChatRoutes.hostStatus, async (_request, reply) => {
    if (deps.hostStatus === undefined) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
    return deps.hostStatus();
  });

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

/**
 * The search answer of a host with no usable index. The query is echoed
 * clamped to the same bound the host applies, and `""` when there was none.
 */
function unindexedSearch(q: unknown): ThreadSearchResponse {
  return {
    // Code points, as the host clamps it: a cut by UTF-16 unit could split an
    // astral character and echo a lone surrogate back as the `query`.
    query: typeof q === "string" ? Array.from(q).slice(0, THREAD_SEARCH_MAX_QUERY_CHARS).join("") : "",
    hits: [],
    truncated: false,
    indexed: false
  };
}

/**
 * The named keys of a query exactly as the client sent them — an empty value,
 * and every value of a repeated key (Fastify hands those over as an array),
 * in order — for a route whose host judges them itself. `""` when none is
 * present, so a request without them stays the route's bare path.
 */
function verbatimQuery(query: Record<string, unknown>, keys: readonly string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = query[key];
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one === "string") params.append(key, one);
    }
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

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
  body?: unknown,
  options: {
    /**
     * Answer a host 404 with 200 and this value instead, decided before
     * anything is sent. Only for a route where the host can 404 for one
     * reason alone — it predates the route (see the search route).
     */
    notFound?: () => unknown;
    /** Overrides the host client's default bound on the answer's headers. */
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  try {
    const response = await deps.client.json<unknown>(
      method,
      path,
      body,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
    );
    if (response.status === 404 && options.notFound) {
      void reply.code(200);
      return options.notFound();
    }
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

/**
 * A host that predates a route answers its generic route miss: 404 `THREAD_NOT_FOUND` "No route
 * for …" (`server/http-server.ts`) — never a refusal of the thread itself.
 */
function isHostRouteMiss(response: HostJsonResponse<unknown>): boolean {
  if (response.status !== 404 || !isRecord(response.value) || !isRecord(response.value.error)) return false;
  const { code, message } = response.value.error;
  return code === "THREAD_NOT_FOUND" && typeof message === "string" && message.startsWith("No route for");
}

/** A head names the thread's sequence as a snapshot does: noted alike ({@link noteSeqFrom}). */
function noteHeadSeq(deps: AgentChatRouteDeps, id: string, value: unknown): void {
  if (isRecord(value) && typeof value.seq === "number") deps.noteSeq(id, value.seq);
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
