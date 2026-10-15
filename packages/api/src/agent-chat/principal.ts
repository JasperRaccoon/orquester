/**
 * Who is acting on a daemon route (unified MCP design 2026-10-15, coordinator ruling on the
 * agent principal).
 *
 * Several routes behave differently when the caller is an in-chat AGENT acting through an
 * Orquester tool: what it creates is stamped `agentCreated` / `createdBy: agent`, the turns it
 * causes carry `causedBy`, and it may not pin a prompt or answer a card. That fact must never come
 * from anything a remote client can write — not a body field, not a header — or any client could
 * claim to be an agent (or a user) at will.
 *
 * **How it travels.** The catalog executor (`apps/daemon/src/mcp/executor.ts`, Task 2) is the only
 * place that knows the principal. It calls the daemon through `DaemonApi.request(method, path,
 * {…, principal})`; the in-process `InjectDaemonApi` (unix-socket app only) mints a one-time opaque
 * nonce, registers `nonce → principal` in an in-memory registry for the life of that inject, and
 * sends it as {@link PRINCIPAL_TOKEN_HEADER}. An `onRequest` hook on the SOCKET app resolves the
 * nonce and decorates the request (`request.principal`); an unknown or reused nonce is refused
 * (401). The REMOTE (HTTP/WebSocket) app never resolves it: it deletes the header before routing,
 * and every request there is `{kind: "user"}` (the GUI) or `{kind: "external"}` (the external
 * `/mcp`, decorated by that transport itself). A request with no token is the user's.
 *
 * Body fields that name agent facts (`CreateAgentChatSessionFields.lineage.agentCreated`,
 * `ForkSessionRequest.agentCreated`, `MergeBackRequest.causedBy`, `TurnCommandBody.causedBy`) are
 * HINTS the route honours only when `request.principal` is an agent and matches (see each field);
 * otherwise they are ignored (remote transport: stripped — {@link REMOTE_STRIPPED_TURN_FIELDS}).
 *
 * **Routes that read the principal** ({@link PRINCIPAL_ROUTES}):
 * - `POST /api/saved-prompts` — `createdBy` derived (agent → `{kind: "agent", threadId, agent,
 *   title}`; otherwise absent = user). Never read from the body.
 * - `PUT /api/saved-prompts/:id` — pinning an agent-created prompt is refused unless the principal
 *   is `user` (the user's own UI); `external` and `agent` get 403 `AGENT_PROMPT_PIN_REFUSED`.
 * - `POST /api/sessions` (agent chat) — `lineage.relation` `delegate` / `opened` with
 *   `agentCreated` only when the principal is an agent whose `threadId` is `lineage.parentThreadId`.
 * - `POST /api/sessions/:id/fork` — `agentCreated` only when the principal is an agent whose
 *   `threadId` is `:id` (the forked chat).
 * - `POST /api/sessions/:id/merge-back` — `causedBy` only from an agent principal whose `threadId`
 *   is `:id` (the child).
 * - `POST /api/sessions/:id/turn` — `causedBy` only from an agent principal (socket app).
 * - `POST agentChatRoutes.replySubscriptions(id)` / `replySubscriptionWait` — socket-only; the
 *   principal must be an agent whose `threadId` is the request's `fromThreadId`.
 * - `POST /api/push/notify` — the rate-limit key (chat thread, or external credential).
 * - `POST agentChatRoutes.toolApproval(id, approvalId)`, `PUT /api/agent-tools/settings`,
 *   `PUT agentChatRoutes.agentTools(id)`, grant revocation — refused (403) for an `agent`
 *   principal: only a person answers cards or changes tool settings.
 */

/** The server-stamped principal of one request. */
export type CallerPrincipal =
  /** The GUI (desktop, web) — the default for a request with no principal token. */
  | { kind: "user" }
  /** An external MCP client, through the external `/mcp` transport. `credentialId`: its bearer's id (never the bearer). */
  | { kind: "external"; credentialId?: string }
  /** An in-chat agent, through an Orquester tool (the catalog executor). */
  | {
      kind: "agent";
      /** The calling chat (= session id). */
      threadId: string;
      /** Its canonical project root; "" when it has none. */
      projectPath: string;
      /** Its agent adapter id (for `createdBy.agent`). */
      agent?: string;
      /** Its tab title when the call ran (for `createdBy.title`). */
      title?: string;
      /** The running turn's exchange (`causedBy` of the turn the call came from), when agent-caused. */
      exchange?: { id: string; hop: number };
    };

export type AgentPrincipal = Extract<CallerPrincipal, { kind: "agent" }>;

/**
 * The header that carries a principal NONCE on the unix-socket app only — an opaque one-time token
 * minted in-process, never a serialised principal. The remote transport deletes it before routing.
 */
export const PRINCIPAL_TOKEN_HEADER = "x-orquester-principal-token";

/** The principal of a request that names none. */
export const USER_PRINCIPAL: CallerPrincipal = Object.freeze({ kind: "user" });

/** The routes whose behaviour depends on the principal (method + path pattern), for wiring and tests. */
export const PRINCIPAL_ROUTES: readonly { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; reads: string }[] = [
  { method: "POST", path: "/api/saved-prompts", reads: "createdBy" },
  { method: "PUT", path: "/api/saved-prompts/:id", reads: "pin refusal for agent-created prompts" },
  { method: "POST", path: "/api/sessions", reads: "lineage.agentCreated (opened / delegate)" },
  { method: "POST", path: "/api/sessions/:id/fork", reads: "agentCreated" },
  { method: "POST", path: "/api/sessions/:id/merge-back", reads: "causedBy" },
  { method: "POST", path: "/api/sessions/:id/turn", reads: "causedBy" },
  { method: "POST", path: "/api/sessions/:id/reply-subscriptions", reads: "fromThreadId must be the agent" },
  { method: "POST", path: "/api/sessions/:id/reply-subscriptions/:subscriptionId/wait", reads: "the agent must own the subscription" },
  { method: "POST", path: "/api/push/notify", reads: "rate-limit key" },
  { method: "POST", path: "/api/sessions/:id/tool-approvals/:approvalId", reads: "agents refused" },
  { method: "PUT", path: "/api/agent-tools/settings", reads: "agents refused" },
  { method: "PUT", path: "/api/sessions/:id/agent-tools", reads: "agents refused" },
  { method: "DELETE", path: "/api/agent-tools/grants", reads: "agents refused" },
  { method: "DELETE", path: "/api/agent-tools/grants/:id", reads: "agents refused" }
];

/** Whether an agent-fact hint in a body may be honoured: the principal is that very agent. */
export function isAgentPrincipalFor(principal: CallerPrincipal | undefined, threadId: string): principal is AgentPrincipal {
  return principal?.kind === "agent" && principal.threadId === threadId;
}
