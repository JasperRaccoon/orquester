/**
 * Agent chat — HTTP routes, command bodies, stream frames and bus events
 * (spec §6).
 *
 * Every chat route lives under `/api/sessions/:id/` and is proxied by the
 * daemon to the agent host. They inherit bearer auth on HTTP, no auth on the
 * unix socket, the SPA-fallback exclusion and the service-worker bypass,
 * all unchanged. The chat stream does **not** get the `?token=` carve-out that
 * `/ws` and `/api/fs/download` have — nothing here is fetched by a bare
 * browser navigation (§6).
 */

import type {
  AccountHomeKind,
  AgentAdapterId,
  AttachmentRef,
  ComposerContextRecord,
  InteractionMode,
  ModelSelection,
  ProviderSnapshot,
  RuntimeMode,
  Skill,
  SlashCommand
} from "./adapter-types.ts";
import type { DomainEvent } from "./domain-events.ts";
import type { AgentGoalStatus } from "./goal.ts";
import type { McpAppCallToolResult } from "./mcp-app.ts";
import type { DelegateView, InterruptCause } from "./delegation.ts";
import type { ForkSessionRequest, MergeBackRequest, MergeBackResponse } from "./lineage.ts";
import type { ApprovalDecision, TurnTokenUsage } from "./runtime-events.ts";
import type { UsageLimitAction } from "./usage-limit.ts";
import type {
  CausedBy,
  Checkpoint,
  LatestTurnSummary,
  ThreadItem,
  ThreadSessionStatus,
  ThreadSnapshotPayload,
  TurnState
} from "./thread.ts";

// ---------------------------------------------------------------------------
// Route path builders (§6.1–§6.3)
// ---------------------------------------------------------------------------

/** Where signed agent pages are served (spec 2026-10-14 §2.2). */
export const AGENT_VISUAL_ROUTE_PREFIX = "/api/agent-visuals";

/**
 * The answer of `POST …/visuals/:attachmentId/url`. `path` is
 * {@link agentChatRoutes.visual} with its `?exp=&sig=` query, relative to the
 * daemon's origin: the client prefixes its own endpoint (web) or its desktop
 * page scheme. `expiresAt` is the daemon's clock, epoch milliseconds.
 */
export interface AgentVisualUrlResponse {
  path: string;
  expiresAt: number;
}

/**
 * The requests an MCP App makes of its host that reach the daemon (spec
 * 2026-10-14 §3). Each is `POST agentChatRoutes.mcpApp(id, itemId, op)`:
 *
 * - `tool-info` {@link McpAppToolInfoRequest} → {@link McpAppToolInfoResponse};
 * - `call-tool` {@link McpAppCallToolRequest} → `McpAppCallToolResult`;
 * - `read-resource` {@link McpAppReadResourceRequest} → {@link McpAppReadResourceResponse};
 * - `model-context` {@link McpAppModelContextRequest} → `{}`.
 *
 * Refusals are the §6.2 envelope: 404 `ITEM_NOT_FOUND` (no such row, or not
 * an app), 400 `INVALID_COMMAND` (a malformed body), 409 `COMMAND_REJECTED`
 * (the session is not running, the provider cannot, the tool is hidden from
 * apps, the request failed) — its message is what the app is told.
 */
export const MCP_APP_OPERATIONS = ["tool-info", "call-tool", "read-resource", "model-context"] as const;
export type McpAppOperation = (typeof MCP_APP_OPERATIONS)[number];

export interface McpAppToolInfoRequest {
  name: string;
}

export interface McpAppToolInfoResponse {
  /** The tool exists on the app's server and its `_meta.ui.visibility` lets an app call it. */
  callable: boolean;
  /** The server marks it read-only (`annotations.readOnlyHint`): no consent is asked. */
  readOnly: boolean;
  title?: string;
  /** The server's MCP `Tool` definition, which the app receives as `toolInfo`. */
  tool?: unknown;
  /**
   * The provider takes `ui/update-model-context` into the agent's next turn
   * (an additive context channel: Codex's `additionalContext`). False: the
   * host does not offer the capability.
   */
  modelContext: boolean;
}

export interface McpAppCallToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export type McpAppCallToolResponse = McpAppCallToolResult;

export interface McpAppReadResourceRequest {
  uri: string;
}

export interface McpAppReadResourceResponse {
  contents: unknown[];
}

/** Text blocks and/or structured content; neither (or blank text) clears the app's context. */
export interface McpAppModelContextRequest {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}

const sessionBase = (sessionId: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}`;

/** Every §6.2 command path and every §6.3 read path, built in one place. */
export const agentChatRoutes = {
  // §6.2 commands (POST, JSON, all carry `commandId`)
  turn: (sessionId: string): string => `${sessionBase(sessionId)}/turn`,
  interrupt: (sessionId: string): string => `${sessionBase(sessionId)}/interrupt`,
  approval: (sessionId: string): string => `${sessionBase(sessionId)}/approval`,
  answer: (sessionId: string): string => `${sessionBase(sessionId)}/answer`,
  dismiss: (sessionId: string): string => `${sessionBase(sessionId)}/dismiss`,
  revert: (sessionId: string): string => `${sessionBase(sessionId)}/revert`,
  compact: (sessionId: string): string => `${sessionBase(sessionId)}/compact`,
  mode: (sessionId: string): string => `${sessionBase(sessionId)}/mode`,
  /**
   * Move a running tool call (or every foreground one) to the background — the
   * GUI's Ctrl+B. Only a provider whose capabilities carry
   * `supportsBackgroundTasks` accepts it (Claude, via the SDK's
   * `backgroundTasks` control).
   */
  background: (sessionId: string): string => `${sessionBase(sessionId)}/background`,
  /**
   * Stop ONE live background task — a workflow run, a subagent, a background
   * shell — by its roster id, leaving the turn and every other task running
   * (the `task/stop` command, {@link TaskStopCommandBody}). Only a provider
   * whose capabilities carry `supportsTaskStop` accepts it (Claude, via the
   * SDK's `stop_task` control). The session-scoped `/interrupt` stays the way
   * to stop the whole fleet.
   */
  taskStop: (sessionId: string): string => `${sessionBase(sessionId)}/task/stop`,
  sessionStop: (sessionId: string): string => `${sessionBase(sessionId)}/session/stop`,
  /**
   * Switch the managed account an existing thread runs under (§3.4 "account
   * changed"). Deliberately **not** a §6.2 command and deliberately absent
   * from {@link AGENT_CHAT_COMMAND_NAMES}: every command there is forwarded to
   * the host verbatim, and this one cannot be — only the daemon can recompose
   * the launch environment, resolve the new home and prepare it, so the daemon
   * owns the route and calls the host itself.
   */
  account: (sessionId: string): string => `${sessionBase(sessionId)}/account`,
  /**
   * Switch the Agent Profile an existing thread runs with ({@link ProfileCommandBody}) — the
   * composer's profile chip. Daemon-owned exactly like {@link agentChatRoutes.account} and for
   * the same reason: only the daemon can resolve the profile's prepared directory and recompose
   * the launch environment, so it is absent from {@link AGENT_CHAT_COMMAND_NAMES}.
   */
  profile: (sessionId: string): string => `${sessionBase(sessionId)}/profile`,
  /**
   * Usage-limit recovery of a limited chat (`usage-limit.ts`), daemon-owned like
   * {@link agentChatRoutes.account} — never proxied to the host, both transports. `POST`:
   * - `auto-resume` (`UsageLimitAutoResumeRequest`): arm or cancel the automatic resume;
   * - `resume` (`UsageLimitResumeRequest`): send the continue message now;
   * - `switch` (`UsageLimitSwitchRequest`): move to another account of the family and continue;
   * - `dismiss-failover` (no body): clear the "switched account" notice.
   * Each answers `UsageLimitActionResponse`; refusals are the §6.2 envelope (409
   * `COMMAND_REJECTED` when the chat is not limited or the action cannot apply).
   */
  usageLimit: (sessionId: string, action: UsageLimitAction): string => `${sessionBase(sessionId)}/usage-limit/${action}`,
  /**
   * The thread's pending `request_secret` cards (`GET`,
   * `SecretRequestListResponse`) — daemon-owned like `account`: the
   * daemon holds the requests, in memory, and never forwards them to the host.
   */
  secretRequests: (sessionId: string): string => `${sessionBase(sessionId)}/secret-requests`,
  /**
   * Answer one (`POST`, `SecretRequestAnswerRequest`): the value goes in
   * the body, never the URL, and the response never echoes it.
   */
  secretRequest: (sessionId: string, requestId: string): string =>
    `${sessionBase(sessionId)}/secret-requests/${encodeURIComponent(requestId)}`,
  /**
   * The chat's pending Orquester approval cards (`GET`, `ToolApprovalListResponse`; unified MCP
   * design 2026-10-15 §7.3) — daemon-owned like `secretRequests`, both transports, never proxied.
   */
  toolApprovals: (sessionId: string): string => `${sessionBase(sessionId)}/tool-approvals`,
  /**
   * One card: `GET` → `ToolApprovalDetailResponse` (its whole preview); `POST`
   * `ToolApprovalAnswer` → `ToolApprovalAnswerResponse` (409 `APPROVAL_NOT_PENDING`, 400 for a
   * grant outside its `grantOptions`). The ONLY way to answer a card.
   */
  toolApproval: (sessionId: string, approvalId: string): string =>
    `${sessionBase(sessionId)}/tool-approvals/${encodeURIComponent(approvalId)}`,
  /**
   * The chat's grants for its Tools chip: `GET` → `ThreadAgentToolsResponse` (`@orquester/api`'s
   * `agent-tools.ts`). Daemon-owned.
   */
  agentTools: (sessionId: string): string => `${sessionBase(sessionId)}/agent-tools`,
  /**
   * SOCKET-ONLY (never on the remote transport): `POST` {@link ReplySubscriptionRequest} →
   * {@link ReplySubscriptionResponse} on the TARGET chat — persist a reply subscription, then send
   * the message as the target's next turn (queued while it works or waits for its user; §8.3).
   */
  replySubscriptions: (sessionId: string): string => `${sessionBase(sessionId)}/reply-subscriptions`,
  /**
   * SOCKET-ONLY: `POST` {@link ReplyWaitRequest} → {@link ReplyWaitResponse} — attach the
   * requester's waiter to one subscription until its reply, the timeout or the target needing its
   * user (then the subscription becomes `notify`).
   */
  replySubscriptionWait: (sessionId: string, subscriptionId: string): string =>
    `${sessionBase(sessionId)}/reply-subscriptions/${encodeURIComponent(subscriptionId)}/wait`,
  /**
   * SOCKET-ONLY: `POST` (no body) → {@link ReplySubscriptionReleaseResponse} — the requester's
   * waiting tool call was cancelled (an in-process `DaemonApi.request` cannot abort its inject), so
   * the attached waiter is released and the reply comes as a message instead (§8.3). With an agent
   * principal, only the requester (`fromThreadId`) may release (403 `PERMISSION_DENIED`).
   */
  replySubscriptionRelease: (sessionId: string, subscriptionId: string): string =>
    `${sessionBase(sessionId)}/reply-subscriptions/${encodeURIComponent(subscriptionId)}/release`,

  // §6.3 reads
  thread: (sessionId: string): string => `${sessionBase(sessionId)}/thread`,
  /**
   * `GET ?replyChars=` → `ThreadHeadResponse` (`thread-head.ts`): the thread's head — status,
   * running and recent turns, open requests, goal, modes, lineage, and with `replyChars` the last
   * reply — without the retained window a whole snapshot carries. For the daemon's per-call and
   * per-event readers. Against a host that predates its own `/head` route the daemon derives the
   * same answer from the host's snapshot (`threadHeadOf`), so every daemon answers it.
   */
  threadHead: (sessionId: string): string => `${sessionBase(sessionId)}/head`,
  events: (sessionId: string): string => `${sessionBase(sessionId)}/events`,
  turnDiff: (sessionId: string, turnCount: number): string =>
    `${sessionBase(sessionId)}/turns/${turnCount}/diff`,
  item: (sessionId: string, itemId: string): string =>
    `${sessionBase(sessionId)}/items/${encodeURIComponent(itemId)}`,
  /**
   * The streamed output of the tool call an item belongs to — every
   * `tool.output` chunk of the call, joined by the host
   * ({@link ThreadItemOutputResponse}). With `?offset=&maxBytes=`
   * ({@link ThreadItemOutputWindowQuery}) it answers one UTF-8 window of that
   * join instead ({@link ThreadItemOutputWindowResponse}) — unless the host
   * predates windows, which ignores the query and answers the whole join. A
   * 404 of its own is `ITEM_NOT_FOUND`; a host that predates the route answers
   * the miss as its generic 404 `THREAD_NOT_FOUND` ("No route for GET …").
   */
  itemOutput: (sessionId: string, itemId: string): string =>
    `${sessionBase(sessionId)}/items/${encodeURIComponent(itemId)}/output`,
  /**
   * §6.3 attachment read-back. NOT `/api/fs/download`: that route is confined
   * to `fsRoot`, and a thread's attachments live under the appdir's
   * `daemon/agent/threads/<id>/attachments`. Carries the same `?token=`
   * carve-out a native `<a download>` needs.
   */
  attachment: (sessionId: string, attachmentId: string): string =>
    `${sessionBase(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
  /**
   * `POST` — mint a short-lived signed URL for an agent's published page
   * (spec 2026-10-14 §2.2, {@link AgentVisualUrlResponse}). Bearer-authed like
   * every chat route; the page itself is fetched by an iframe, which cannot
   * send that header, so it is served from {@link agentChatRoutes.visual}.
   */
  visualUrl: (sessionId: string, attachmentId: string): string =>
    `${sessionBase(sessionId)}/visuals/${encodeURIComponent(attachmentId)}/url`,
  /**
   * `GET ?exp=&sig=` — the page, authorised by its signature alone (an HMAC
   * the daemon holds, bound to session + attachment + expiry), served with
   * the sandbox CSP ({@link HTML_RENDER_CONTENT_SECURITY_POLICY}). Outside
   * `/api/sessions/` so production Caddy can carve its framing out by prefix
   * (`deploy/Caddyfile`).
   */
  visual: (sessionId: string, attachmentId: string): string =>
    `${AGENT_VISUAL_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/${encodeURIComponent(attachmentId)}`,
  /**
   * `POST` — one request of the MCP App a tool call produced (spec
   * 2026-10-14 §3), named by the call's completed row (`itemId`, the
   * activity id): {@link McpAppOperation}. The host resolves the app from the
   * stored row and runs the request through the thread's live provider
   * session, against the app's own MCP server only.
   */
  mcpApp: (sessionId: string, itemId: string, operation: McpAppOperation): string =>
    `${sessionBase(sessionId)}/mcp-apps/${encodeURIComponent(itemId)}/${operation}`,

  // §6.3 host-level reads (not per session)
  providers: "/api/agent/providers",
  providerRefresh: (adapterId: string): string =>
    `/api/agent/providers/${encodeURIComponent(adapterId)}/refresh`,
  hostStop: "/api/agent-host/stop",
  /** `GET`: {@link AgentHostStatusResponse} — the host and its pending drain-restart. */
  hostStatus: "/api/agent-host/status",

  // Indexed history (design 2026-09-23 "thread index and lazy boot").
  /**
   * A page of turns OLDER than what the client holds, folded from the log by
   * the host: `?before=<cursor>&turns=<n>`. No cursor means "the turns just
   * below the retained window" (the snapshot's `history.beforeCursor`).
   */
  history: (sessionId: string): string => `${sessionBase(sessionId)}/history`,
  /** Full-text search over every indexed thread on the host: `?q=&limit=&projectPath=`. */
  search: "/api/agent/search",
  /**
   * The thread's own user prompts, newest first, read from the index — the
   * right rail's History (`?before=&limit=`, {@link ThreadPromptsResponse}).
   * A host without a usable index answers 200 `indexed:false`; a host that
   * predates the route answers its generic 404 `THREAD_NOT_FOUND`.
   */
  prompts: (sessionId: string): string => `${sessionBase(sessionId)}/prompts`,
  /**
   * One prompt's whole text ({@link ThreadPromptTextResponse}) — for a page
   * entry cut at {@link THREAD_PROMPT_TEXT_MAX_CHARS}. 404 `PROMPT_NOT_FOUND`
   * when the thread has no such user prompt.
   */
  promptText: (sessionId: string, messageId: string): string =>
    `${sessionBase(sessionId)}/prompts/${encodeURIComponent(messageId)}`,
  /**
   * `GET` → {@link ThreadCatalogResponse}: an Agent Profile chat's own command and skill catalog
   * for the composer — what its live provider session loaded, else the profile's own items. A
   * Global chat answers `source: "none"` (the composer keeps the provider's catalog).
   * Daemon-owned (it asks the host and falls back to the profile), both transports.
   */
  catalog: (sessionId: string): string => `${sessionBase(sessionId)}/catalog`,

  // Thread lineage (spec 2026-10-14 §6). Daemon-owned, like `account`: none is
  // a proxied §6.2 command.
  /**
   * `POST` {@link ForkSessionRequest} → `ForkSessionResponse`: a new chat tab
   * in the same project, same agent, model and options, whose conversation is
   * this one's up to a message.
   */
  fork: (sessionId: string): string => `${sessionBase(sessionId)}/fork`,
  /**
   * `POST` {@link MergeBackRequest} → {@link MergeBackResponse}, on the CHILD:
   * send its result to the parent, queued while the parent is busy.
   */
  mergeBack: (sessionId: string): string => `${sessionBase(sessionId)}/merge-back`,
  /**
   * `POST` `MergeBackActionRequest` → `MergeBackActionResponse`: deliver now,
   * or discard, one pending merge — from the fork that sent it or the parent
   * it is addressed to.
   */
  mergeBackItem: (sessionId: string, mergeId: string): string =>
    `${sessionBase(sessionId)}/merge-back/${encodeURIComponent(mergeId)}`,
  /** `GET` → `SessionLineageResponse`: parent, children and pending merges. */
  lineage: (sessionId: string): string => `${sessionBase(sessionId)}/lineage`
} as const;

// ---------------------------------------------------------------------------
// Indexed history and search (design 2026-09-23 "thread index and lazy boot")
// ---------------------------------------------------------------------------

/** Query string of `GET …/history`. */
export interface ThreadHistoryQuery {
  /** Opaque, from a previous page or the snapshot's `history.beforeCursor`. */
  before?: string;
  /** Turns per page, clamped to `[1, THREAD_HISTORY_MAX_TURNS]`. */
  turns?: number;
}

export const THREAD_HISTORY_DEFAULT_TURNS = 20;
export const THREAD_HISTORY_MAX_TURNS = 100;

/** One turn of a history page, as the index knows it. Oldest first in a page. */
export interface ThreadHistoryTurn {
  turnId: string;
  /** 1-based, by ORDER of started turns — the same count `/revert` uses. */
  ordinal: number;
  userMessageId: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * False when a compaction happened after this turn: rewinding to it would
   * cross the compaction boundary, which the provider cannot honour (§5.5).
   * The client withholds "rewind to here" on it, as it does inside the window.
   */
  rewindable: boolean;
}

/**
 * `GET …/history`. `items`/`checkpoints` are the fold of exactly the events
 * those turns span, slimmed like a snapshot (§5.6). A client merges them
 * ABOVE what it holds and drops any item whose id it already has — the newest
 * page and the retained window can overlap by a few rows, because retention
 * evicts rows, not turns.
 */
export interface ThreadHistoryPage {
  threadId: string;
  turns: ThreadHistoryTurn[];
  items: ThreadItem[];
  checkpoints: Checkpoint[];
  page: {
    /** Cursor of the next older page, or null when this page reached turn 1. */
    beforeCursor: string | null;
    /**
     * The id of the row at the page's upper boundary — the first row of the
     * log the page does NOT hold: the window's first row for a page asked
     * without a cursor, the previous page's first row otherwise (a message's
     * first chunk when the boundary moved back to keep a message whole). The
     * client places every window row written before it in the history section,
     * so the timeline stays in log order when the page shares no row with the
     * window (design 2026-09-23 fold performance, "Client"). Null when that
     * line is not a row; absent from a host that predates the field.
     */
    endItemId?: string | null;
  };
  /** The thread's sequence the page was computed against. */
  seq: number;
}

/** Query string of `GET /api/agent/search`. */
export interface ThreadSearchQuery {
  q: string;
  /** Clamped to `[1, THREAD_SEARCH_MAX_RESULTS]`. */
  limit?: number;
  /** Restrict to one project root. */
  projectPath?: string;
}

export const THREAD_SEARCH_MAX_RESULTS = 50;
export const THREAD_SEARCH_MAX_QUERY_CHARS = 200;

export interface ThreadSearchHit {
  threadId: string;
  projectPath: string;
  title: string;
  /** The turn the row belongs to; null for a turnless row. */
  turnId: string | null;
  ordinal: number | null;
  kind: "message" | "activity";
  /** Message id or activity id. */
  id: string;
  role: "user" | "assistant" | "reasoning" | null;
  activityKind: string | null;
  /** A short excerpt with the match highlighted by `«` and `»`. */
  snippet: string;
  at: string;
  seq: number;
}

export interface ThreadSearchResponse {
  query: string;
  hits: ThreadSearchHit[];
  /** More hits existed than `limit`. */
  truncated: boolean;
  /** False when the host has no usable index; `hits` is then empty. */
  indexed: boolean;
}

// ---------------------------------------------------------------------------
// The thread's prompts (the right rail's History)
// ---------------------------------------------------------------------------

/**
 * Query string of `GET …/prompts`. A page holds AT MOST `limit` prompts: the
 * host walks a bounded number of rows per request, so a stretch of rows that
 * are no prompts (a subagent fleet's task notifications) can end a page short
 * — even empty — with a `before` cursor. Only `before: null` means the
 * thread's first prompt was reached.
 */
export interface ThreadPromptsQuery {
  /** Opaque, from a previous page's `before`. Absent: the newest prompts. */
  before?: string;
  /** Prompts per page at most, clamped to `[1, THREAD_PROMPTS_MAX_LIMIT]`. */
  limit?: number;
}

export const THREAD_PROMPTS_DEFAULT_LIMIT = 100;
export const THREAD_PROMPTS_MAX_LIMIT = 500;
/** A page entry's `text` is cut here (UTF-16 units); `truncated` says so. */
export const THREAD_PROMPT_TEXT_MAX_CHARS = 4_000;

/**
 * One prompt the user sent in the thread — a `user` message of the PARENT
 * conversation that `recallablePromptText` accepts (never a subagent's, never
 * a provider-internal row, never the verbatim `/compact` or an Implement), its
 * text already normalised by that rule.
 */
export interface ThreadPromptEntry {
  messageId: string;
  /** The turn the message belongs to (a steer: the turn it steered); null when no turn claimed it. */
  turnId: string | null;
  /**
   * The 1-based ordinal — by ORDER of started turns, the count `/revert` uses —
   * of the turn this prompt STARTED; null for a steer (a message-mode answer
   * sent while a turn runs is one) or a prompt no started turn claims yet.
   */
  turnOrdinal: number | null;
  /**
   * For a prompt that started a turn: false when a compaction happened after
   * that turn (the history page's `rewindable` rule). Null when it started none.
   */
  rewindable: boolean | null;
  /** The normalised text, cut at {@link THREAD_PROMPT_TEXT_MAX_CHARS}. */
  text: string;
  /** `text` was cut; `GET …/prompts/:messageId` reads it whole. */
  truncated: boolean;
  createdAt: string;
  /** The log sequence of the message's line. */
  seq: number;
}

/**
 * `GET …/catalog` ({@link agentChatRoutes.catalog}) — the composer's `/` and `$` catalog for ONE
 * chat. An Agent Profile chat must never offer the agent's Global commands and skills:
 * - `session`: the chat's live provider session reported what it loaded (Claude's
 *   initialization commands, Grok's `available_commands_update`, the thread's OpenCode server,
 *   Codex's `skills/list` minus the switched-off ones);
 * - `profile`: no live report yet — the profile's own enabled skills and commands for the agent
 *   (the composer adds its host commands, as always);
 * - `none`: a Global chat (no `profileId`): use the provider's catalog. Never for a profile chat:
 *   a profile catalog that cannot be read (gone, a failure) answers `profile` with empty lists.
 */
export interface ThreadCatalogResponse {
  threadId: string;
  source: "session" | "profile" | "none";
  slashCommands: SlashCommand[];
  skills: Skill[];
}

/** `GET …/prompts` — newest first. */
export interface ThreadPromptsResponse {
  threadId: string;
  prompts: ThreadPromptEntry[];
  /** Cursor of the next OLDER page; null when this page reached the thread's first prompt. */
  before: string | null;
  /**
   * False when the host cannot list this thread's prompts from its index:
   * `prompts` is then empty and the client falls back to what it holds.
   */
  indexed: boolean;
  /**
   * With `indexed: false`: the index exists but has not caught up with this
   * thread yet — a rebuild (every `INDEX_SCHEMA_VERSION` bump) or the boot
   * catch-up is still reading its log — so the answer WILL change: ask again
   * shortly. Absent (or false) with `indexed: false` when the host has no
   * usable index, or this thread's rows are behind and nothing will read them
   * before the host restarts — neither changes by asking again; and absent
   * from a host that predates the field. A failed read of a usable index is
   * neither: it answers 503 `INDEX_UNAVAILABLE`, which is retryable.
   */
  catchingUp?: boolean;
}

/** `GET …/prompts/:messageId` — one prompt's whole normalised text. */
export interface ThreadPromptTextResponse {
  messageId: string;
  text: string;
  /** True only when even the host's copy is cut (the index keeps at most 128 K chars of a message). */
  truncated: boolean;
}

/** The `name` accepted by `Transporter.agentChat.command(sessionId, name, body)`. */
export type AgentChatCommandName =
  | "turn"
  | "interrupt"
  | "approval"
  | "answer"
  | "dismiss"
  | "revert"
  | "compact"
  | "mode"
  | "background"
  | "task/stop"
  | "session/stop";

/** The eleven §6.2 command names, in table order. */
export const AGENT_CHAT_COMMAND_NAMES = [
  "turn",
  "interrupt",
  "approval",
  "answer",
  "dismiss",
  "revert",
  "compact",
  "mode",
  "background",
  "task/stop",
  "session/stop"
] as const satisfies readonly AgentChatCommandName[];

/** Resolve a command name to its route. */
export function agentChatCommandPath(sessionId: string, name: AgentChatCommandName): string {
  switch (name) {
    case "session/stop":
      return agentChatRoutes.sessionStop(sessionId);
    case "task/stop":
      return agentChatRoutes.taskStop(sessionId);
    default:
      return agentChatRoutes[name](sessionId);
  }
}

// ---------------------------------------------------------------------------
// §6.1 lifecycle additions
// ---------------------------------------------------------------------------

/**
 * Extra fields on `POST /api/sessions` when `kind: "agent-chat"` (§6.1). The
 * daemon validates the account and model exactly as it does for terminals,
 * writes the tab record, then asks the host to create the thread — in that
 * order, so a failed first turn leaves an empty thread the user retries into
 * rather than a half-created tab.
 */
export interface CreateAgentChatSessionFields {
  accountId?: string;
  /**
   * The Agent Profile the thread launches with (`@orquester/api` `session-profiles.ts`). Absent =
   * Global. Clients may leave it unset and send `CreateSessionRequest.profileId` instead.
   */
  profileId?: string;
  /**
   * An unattended launch (an MCP `create_session`, a workflow run): the chat's Agent Profile
   * must apply or the launch FAILS — at create and at every later agent (re)start. Without it an
   * interactive chat whose profile was deleted falls back to Global with a visible notice at its
   * next agent start (spec 2026-10-18 §5.5, §5.6). A create naming a profile that does not exist
   * or is not ready fails either way. Persisted on the tab record.
   */
  unattended?: boolean;
  modelSelection: ModelSelection;
  runtimeMode?: RuntimeMode;
  /**
   * A conversation from `GET /api/agents/conversations`, which becomes the
   * thread's initial resume cursor. One the adapter cannot use is refused at
   * creation with 400 `RESUME_UNAVAILABLE` — the only route that answers that
   * code; no §6.2 command does.
   */
  resume?: { home: AccountHomeKind; conversationId: string };
  /**
   * Create the thread as a child of another chat tab (spec 2026-10-14 §6; unified MCP design
   * 2026-10-15 §4.1): `delegate` (a task) or `opened` (a chat another chat opened). The parent may
   * be in ANOTHER project — `create_session` opens chats in any project. A fork carries the
   * parent's conversation and is created by `POST …/fork` instead. The daemon checks the parent
   * and stamps `createdAt` and `delegationDepth` itself.
   *
   * `agentCreated: true` is PRINCIPAL-GATED: honoured only when the request's server-stamped
   * principal is an agent whose `threadId` is `parentThreadId` (`principal.ts`,
   * `isAgentPrincipalFor`); ignored from every other caller, socket callers included.
   */
  lineage?: { parentThreadId: string; relation: "delegate" | "opened"; agentCreated?: true };
}

/** §6.1's create-time refusal code. Deliberately not in {@link AgentChatErrorCode}. */
export const RESUME_UNAVAILABLE = "RESUME_UNAVAILABLE";

/**
 * Create-time refusal for a resume whose conversation is already open in
 * another tab. The 400 body carries `ownerSessionId` (that tab), so a client
 * switches to it instead of reporting a failure. Like
 * {@link RESUME_UNAVAILABLE}, deliberately not in {@link AgentChatErrorCode}.
 */
export const CONVERSATION_ALREADY_OPEN = "CONVERSATION_ALREADY_OPEN";

// ---------------------------------------------------------------------------
// §6.2 command bodies
// ---------------------------------------------------------------------------

/** Every command body carries the client-minted idempotency key. */
export interface AgentChatCommandBase {
  /** A UUID minted by the client (§6.2). */
  commandId: string;
}

/** Start a turn, or steer the active one (§4.1: steering reuses the turn id). */
export interface TurnCommandBody extends AgentChatCommandBase {
  /** Trimmed, ≤ `MAX_TURN_INPUT_CHARS`. */
  input: string;
  /** ≤ `MAX_TURN_ATTACHMENTS`, references only. */
  attachments?: AttachmentRef[];
  interactionMode?: InteractionMode;
  modelSelection?: ModelSelection;
  /** Composer chips persisted beside the message for re-render only (§4.1). */
  context?: ComposerContextRecord[];
  /**
   * The agent exchange the turn belongs to, when another chat caused it (unified MCP design
   * 2026-10-15 §8.4). SOCKET-TRUSTED (`principal.ts`): honoured from any unix-socket /
   * in-process caller — the catalog executor, and the daemon's own workers (reply router,
   * delivery queue) that post without a principal — and STRIPPED by the remote transport before
   * the route sees the body ({@link stripRemoteTurnFields}, {@link REMOTE_STRIPPED_TURN_FIELDS};
   * Task 5 enforces). The GUI, the external MCP and user-authored turns never carry one. The host
   * persists it with the turn (`Turn.causedBy`); a steer leaves the running turn's own. Additive:
   * an older host ignores it.
   */
  causedBy?: CausedBy;
  /**
   * Precondition (unified MCP design 2026-10-15 §8.3): start a NEW turn only — with a turn active
   * the command is refused 409 {@link TURN_NOT_IDLE} instead of steering it, and NOT recorded as a
   * receipt, so the same `commandId` may be posted again at the next idle point. The daemon's
   * delivery queue sets it on reply-bound messages and replies. Accepted from ANY caller (remote
   * included, never stripped): it can only make a turn refuse, never widen what one does.
   * Additive: an older host ignores it (the steer race stays there).
   */
  ifIdle?: true;
  /**
   * The message REDIRECTS the agent: the pending approvals the user saw when they sent it
   * (`requestId`s). The host declines every one of them still pending and unanswered, telling the
   * provider the user is redirecting where it takes a reason with a denial, then sends this message
   * as a steer — one command, so a retry under the same `commandId` neither declines nor sends
   * twice. An approval already answered — resolved, or its answer committed and the provider's
   * resolution on its way (another tab's Approve, the MCP's `respond_to_request`) — is skipped,
   * listed or not. An unanswered approval pending but NOT listed (one that arrived after the user
   * looked) refuses the whole command 409 `COMMAND_REJECTED` ({@link APPROVAL_ARRIVED_REASON})
   * before anything is written, so the message goes back to the draft and a new send declines that
   * one too. Additive: an older host ignores it and the message steers in behind the open card.
   *
   * **A subagent's approval** (`PendingApproval.requestingAgentId`, on an adapter with
   * `approvalFeedbackToSubagents`) gets the message itself as its denial, capped at
   * {@link APPROVAL_FEEDBACK_MAX_CHARS}: the subagent that asked reads the user's words, which a
   * steer into the main agent would never reach. When every declined approval is a subagent's,
   * nothing is steered — the message is recorded in the thread as the user's and sent nowhere
   * else — and attachments are refused ({@link SUBAGENT_FEEDBACK_ATTACHMENTS_REASON}). With a
   * main-agent approval among them, the main agent is redirected and steered as above.
   */
  declineApprovals?: string[];
}

/** Why a redirect ({@link TurnCommandBody.declineApprovals}) was refused: an approval the user had not seen is pending. */
export const APPROVAL_ARRIVED_REASON =
  "Another approval arrived, so your message wasn't sent. Read it, then send again to decline it too.";

/** Why an `approval` command was refused: the request already has an answer on its way to the provider. */
export const APPROVAL_ALREADY_ANSWERED_REASON = "This request has already been answered.";

/** Why an `answer` command was refused: the question already has an answer on its way to the provider. */
export const QUESTION_ALREADY_ANSWERED_REASON = "This question has already been answered.";

/**
 * Why a message over a subagent's approval was refused: it goes to that
 * subagent as its approval's denial, which carries text only.
 */
export const SUBAGENT_FEEDBACK_ATTACHMENTS_REASON =
  "This message goes to the subagent that asked, as its answer, and can't carry attachments. Remove them, or answer on the card.";

/** The longest a message handed to an agent as its approval's denial is, in characters; the rest is cut. */
export const APPROVAL_FEEDBACK_MAX_CHARS = 16_000;

/** Why a redirect that is a `/compact` was refused: a compaction waits for the turn the card holds. */
export const REDIRECT_COMPACT_REASON =
  "A compaction can't redirect the agent. Answer the request above first, or stop the turn.";

/** The {@link TurnCommandBody} fields only the daemon may set: removed from every remote body. */
export const REMOTE_STRIPPED_TURN_FIELDS = ["causedBy"] as const satisfies readonly (keyof TurnCommandBody)[];

/** The {@link MergeBackRequest} fields only socket / in-process callers may set: removed from every remote body. */
export const REMOTE_STRIPPED_MERGE_BACK_FIELDS = ["causedBy"] as const satisfies readonly (keyof MergeBackRequest)[];

/** The {@link InterruptCommandBody} fields only the daemon may set: removed from every remote body. */
export const REMOTE_STRIPPED_INTERRUPT_FIELDS = ["cause", "cascade"] as const satisfies readonly (keyof InterruptCommandBody)[];

function stripFields<T extends object>(body: T, fields: readonly string[]): T {
  if (!fields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) return body;
  const copy = { ...body } as Record<string, unknown>;
  for (const field of fields) delete copy[field];
  return copy as T;
}

/** A turn body without its socket-trusted fields — what the remote transport forwards. Same reference when none was present. */
export function stripRemoteTurnFields<T extends object>(body: T): T {
  return stripFields(body, REMOTE_STRIPPED_TURN_FIELDS);
}

/** A merge-back body without its socket-trusted fields — what the remote transport forwards. Same reference when none was present. */
export function stripRemoteMergeBackFields<T extends object>(body: T): T {
  return stripFields(body, REMOTE_STRIPPED_MERGE_BACK_FIELDS);
}

/** An interrupt body without its socket-trusted fields — what the remote transport forwards. Same reference when none was present. */
export function stripRemoteInterruptFields<T extends object>(body: T): T {
  return stripFields(body, REMOTE_STRIPPED_INTERRUPT_FIELDS);
}

/**
 * Settle pending requests, then interrupt. With no running turn it stops the
 * thread's live background work — the client omits `turnId` whenever the
 * session is not `running` (§6.2, §7.6).
 */
export interface InterruptCommandBody extends AgentChatCommandBase {
  turnId?: string;
  /**
   * Why Orquester interrupts this chat: the chat that delegated it stopped (the daemon's stop
   * cascade, `agent-chat/delegates.ts`). SOCKET-TRUSTED like `TurnCommandBody.causedBy`: only the
   * daemon sets it, and the remote transport strips it ({@link REMOTE_STRIPPED_INTERRUPT_FIELDS}).
   * The host writes it into the timeline as a `STOP_CASCADED_ACTIVITY_KIND` row; one that does not
   * parse is dropped, never a refusal. Additive: an older host ignores it (the interrupt still runs).
   */
  cause?: InterruptCause;
  /**
   * `false` when the interrupt is Orquester's own housekeeping rather than a stop — usage-limit
   * recovery clearing a parked turn before it resumes (`agent-chat/limit-recovery.ts`): the chats
   * this one delegated keep running (`agent-chat/delegates.ts`). SOCKET-TRUSTED and stripped from
   * remote bodies like `cause`; the host ignores it.
   */
  cascade?: false;
}

export interface ApprovalCommandBody extends AgentChatCommandBase {
  requestId: string;
  decision: ApprovalDecision;
}

/** Attachments are folded into the answer text by the host (§4.3). */
export interface AnswerCommandBody extends AgentChatCommandBase {
  requestId: string;
  answers: Record<string, unknown>;
  /** ≤ 8 per question. */
  attachmentsByQuestionId?: Record<string, AttachmentRef[]>;
}

/** Close a `dismissible` question without answering it (§6.2). */
export interface DismissCommandBody extends AgentChatCommandBase {
  requestId: string;
}

export interface RevertCommandBody extends AgentChatCommandBase {
  targetTurnCount: number;
}

export interface CompactCommandBody extends AgentChatCommandBase {
  /**
   * Idle compaction (`idle-compaction.ts`): the daemon's own `/compact`, sent before the chat's
   * prompt cache expires. A precondition and a label: the host refuses it (409
   * {@link TURN_NOT_IDLE}, never recorded, so the same id may come again) unless `turnId` is still the chat's latest turn, settled
   * `completed`, with nothing pending — so a chat that moved on since the daemon looked is never
   * compacted under the user — and records the message with `sentBy: "idle-compaction"`.
   * Additive: an older host ignores it and compacts as asked.
   */
  idle?: { turnId: string };
}

/**
 * `/background`: `toolUseId` names the one running call to move (the
 * `toolUseId` on its activity row); absent moves every foreground task, which
 * is exactly what Ctrl+B does in the terminal.
 */
export interface BackgroundCommandBody extends AgentChatCommandBase {
  toolUseId?: string;
}

/**
 * `/task/stop`: stop the one live task `taskId` names — the `id` of its row in
 * the thread's roster (`RuntimeSubagent.id`), which for Claude is the SDK's
 * task id. The host refuses (409 `COMMAND_REJECTED`) a task the roster does not
 * list, one that already settled, and a row that is not a provider task of its
 * own — a Claude workflow's member rows among them: the provider can stop the
 * workflow run, not one of its agents. The task's own `task.completed`
 * (`stopped`) closes its row; a stop the provider failed lands as a
 * `provider.task.stop.failed` activity.
 */
export interface TaskStopCommandBody extends AgentChatCommandBase {
  taskId: string;
}

/**
 * The activity kinds `/task/stop` appends: the user's request, accepted (the
 * command's own row), and a stop the provider then failed. Both name the task
 * as `payload.targetTaskId` — never `taskId`, which would file the row among
 * the task's own.
 */
export const TASK_STOP_REQUESTED_ACTIVITY_KIND = "task-stop.requested";
export const TASK_STOP_FAILED_ACTIVITY_KIND = "provider.task.stop.failed";

/** Applied per §3.4 — the ensure-session step runs on the send path. */
export interface ModeCommandBody extends AgentChatCommandBase {
  runtimeMode?: RuntimeMode;
  modelSelection?: ModelSelection;
}

/** Stop the provider child, keep the thread, its log and its cursor (§6.2). */
export type SessionStopCommandBody = AgentChatCommandBase;

/**
 * `POST /api/sessions/:id/account` — the composer's account chip.
 *
 * Applied on the **next message**: the daemon recomposes the launch
 * environment and records the new identity, and §3.4's ensure-session step
 * restarts the provider child on the send path, carrying the resume cursor. It
 * is not in {@link AgentChatCommandBodies} because it is not a proxied command
 * (see `agentChatRoutes.account`), but it answers the same
 * {@link CommandReceiptResponse} and the same {@link AgentChatErrorCode}s.
 *
 * `accountId` is a managed account of the thread's family, or
 * `SYSTEM_ACCOUNT_ID` for the daemon user's own login.
 */
export interface AccountCommandBody extends AgentChatCommandBase {
  accountId: string;
}

/**
 * `POST /api/sessions/:id/profile` — the composer's profile chip (agent profiles spec §5.3).
 *
 * Shaped and answered like {@link AccountCommandBody}: a client-minted `commandId` makes a
 * retry idempotent (the same {@link CommandReceiptResponse} for a repeat), refusals use the
 * same {@link AgentChatErrorCode}s, and it is offered only while the thread is idle. The daemon
 * records the new profile on the thread (`thread.meta-updated {profileId}`, `""` = Global) and
 * restarts the provider child with it, keeping the conversation and its resume cursor.
 *
 * `profileId` is an Agent Profile's id, or `null` for Global (the agent's own setup).
 */
export interface ProfileCommandBody extends AgentChatCommandBase {
  profileId: string | null;
}

/**
 * The activity kind the host appends beside the switch, so the timeline shows
 * where the identity changed. `payload` is
 * `{accountId, home, previousAccountId?}`; the client resolves the id to a
 * label at render time, because a label is a client-side fact the log must not
 * freeze.
 */
export const IDENTITY_CHANGED_ACTIVITY_KIND = "session.identity-changed";

/**
 * The activity kind the host appends beside an Agent Profile switch (spec 2026-10-18 §5.3), the
 * profile counterpart of {@link IDENTITY_CHANGED_ACTIVITY_KIND} — a switch of both writes one of
 * each. `payload` is `{profileId, previousProfileId}`, each a profile id or `null` for Global;
 * the client resolves the id to the profile's current name at render time.
 */
export const PROFILE_CHANGED_ACTIVITY_KIND = "session.profile-changed";

export type AgentChatCommandBody =
  | TurnCommandBody
  | InterruptCommandBody
  | ApprovalCommandBody
  | AnswerCommandBody
  | DismissCommandBody
  | RevertCommandBody
  | CompactCommandBody
  | ModeCommandBody
  | BackgroundCommandBody
  | TaskStopCommandBody
  | SessionStopCommandBody;

/** Maps each command name to its body type. */
export interface AgentChatCommandBodies {
  turn: TurnCommandBody;
  interrupt: InterruptCommandBody;
  approval: ApprovalCommandBody;
  answer: AnswerCommandBody;
  dismiss: DismissCommandBody;
  revert: RevertCommandBody;
  compact: CompactCommandBody;
  mode: ModeCommandBody;
  background: BackgroundCommandBody;
  "task/stop": TaskStopCommandBody;
  "session/stop": SessionStopCommandBody;
}

// ---------------------------------------------------------------------------
// §6.2 responses
// ---------------------------------------------------------------------------

/**
 * The receipt response: the sequence the command landed at, or the recorded
 * sequence for a repeated `commandId`, so a retry after a dropped connection
 * never double-sends a turn (§6.2).
 */
export interface CommandReceiptResponse {
  seq: number;
}

/**
 * The closed code list of §6.2. A *provider-side* failure is never one of
 * these: `/turn` returns as soon as the command is recorded, and a provider
 * that then refuses appends an activity with tone `error` instead.
 */
export type AgentChatErrorCode =
  /** 400 — the body failed validation (§4.1 bounds, unknown decision, bad turn count). */
  | "INVALID_COMMAND"
  /** 404 — no thread, or it was deleted between the client's snapshot and the post. */
  | "THREAD_NOT_FOUND"
  /** 409 — that `commandId` is recorded against a different thread. Never replayed. */
  | "COMMAND_ID_CONFLICT"
  /** 409 — an invariant: revert past `turnCount`, revert while a turn is active, … */
  | "COMMAND_REJECTED"
  /** 409 — a turn is running or another compaction is in flight (§3.4). */
  | "COMPACTION_UNAVAILABLE"
  /** 503 — the host is restarting; the client retries the SAME `commandId`. */
  | "HOST_UNAVAILABLE"
  /**
   * 503 — the host has no usable thread index right now (driver missing, file
   * being rebuilt). Only `GET …/history` answers it: `GET /api/agent/search`
   * is never an error for "no index" — it answers 200 with `indexed:false`
   * and no hits — and nothing about the live thread is affected.
   */
  | "INDEX_UNAVAILABLE"
  /**
   * 404 — only `GET …/items/:itemId/output` answers it: the thread has no such
   * item, or the item names no tool call. A code of its own because a host
   * that predates the route answers the miss as its generic 404
   * `THREAD_NOT_FOUND` ("No route for GET …") — the code `GET …/items/:itemId`
   * gives a missing item — and a reader must tell the two apart.
   */
  | "ITEM_NOT_FOUND"
  /**
   * 404 — only `GET …/prompts/:messageId` answers it: the thread has no such
   * message, or not one the user sent. Its own code for `ITEM_NOT_FOUND`'s
   * reason: a host that predates the route answers the miss as its generic
   * 404 `THREAD_NOT_FOUND`.
   */
  | "PROMPT_NOT_FOUND"
  /**
   * 409 — only `turn` with `ifIdle: true` answers it: a turn is active, so the message would steer
   * it. A refusal of the moment, never recorded as a receipt: the same `commandId` may land at the
   * next idle point ({@link TurnCommandBody.ifIdle}).
   */
  | "TURN_NOT_IDLE";

export const AGENT_CHAT_ERROR_CODES = [
  "INVALID_COMMAND",
  "THREAD_NOT_FOUND",
  "COMMAND_ID_CONFLICT",
  "COMMAND_REJECTED",
  "COMPACTION_UNAVAILABLE",
  "HOST_UNAVAILABLE",
  "INDEX_UNAVAILABLE",
  "ITEM_NOT_FOUND",
  "PROMPT_NOT_FOUND",
  "TURN_NOT_IDLE"
] as const satisfies readonly AgentChatErrorCode[];

/**
 * {@link AgentChatErrorCode} `TURN_NOT_IDLE`: the `ifIdle` precondition of a `turn` refused, or the
 * `idle` precondition of an idle compaction (`CompactCommandBody.idle`).
 */
export const TURN_NOT_IDLE = "TURN_NOT_IDLE" satisfies AgentChatErrorCode;

/** A failed command answers this, and it is not a transport error to swallow. */
export interface AgentChatErrorEnvelope {
  error: {
    code: AgentChatErrorCode;
    message: string;
    detail?: unknown;
  };
}

/**
 * `detail.reason` of the one refusal that is a moment's, not the thread's: a
 * step of the command ran out of time after the host's command gate opened
 * (a 409 `COMMAND_REJECTED`, never recorded as a receipt). It may pass; a
 * client may retry it as a new command.
 */
export const DEADLINE_REFUSAL_REASON = "deadline";

/** The host's own wording of a deadline (`DeadlineExceededError`), for an answer with no `detail`. */
const DEADLINE_MESSAGE = /timed out after \d+ms$/;

/** Whether a §6.2 error is the host's post-gate deadline refusal ({@link DEADLINE_REFUSAL_REASON}). */
export function isDeadlineRefusal(error: { code?: unknown; message?: unknown; detail?: unknown } | null | undefined): boolean {
  if (error?.code !== "COMMAND_REJECTED") return false;
  const detail = error.detail;
  if (typeof detail === "object" && detail !== null && (detail as { reason?: unknown }).reason === DEADLINE_REFUSAL_REASON) {
    return true;
  }
  return typeof error.message === "string" && DEADLINE_MESSAGE.test(error.message);
}

/**
 * Commands answered with 409 for a thread in `error`, **except**
 * `session/stop` and `revert` (§6.2) — without that carve-out a session wedged
 * in `starting` or `error` would be unrecoverable. A `turn` is let through as
 * well while the thread's log is readable: its send path restarts the errored
 * session from the persisted cursor.
 */
export const COMMANDS_ALLOWED_IN_ERROR_STATE: ReadonlySet<AgentChatCommandName> = new Set<
  AgentChatCommandName
>(["session/stop", "revert"]);

// ---------------------------------------------------------------------------
// §6.3 stream frames
// ---------------------------------------------------------------------------

/**
 * `GET /api/sessions/:id/events?after=<seq>` — long-lived chunked NDJSON.
 *
 * Order is fixed: an optional `snapshot` (when `after` is older than the
 * retained replay window or below a revert truncation), then one `event` per
 * sequence, then exactly one `synchronized` once live. `synchronized` is
 * pushed through the **same** buffer as live events, never written straight to
 * the socket, or the client believes it is caught up while frames are queued.
 *
 * *T3: `orchestration.ts:2164-2177`, adopted verbatim.*
 */
export type AgentChatStreamFrame =
  | { kind: "snapshot"; thread: ThreadSnapshotPayload }
  | { kind: "event"; seq: number; event: DomainEvent }
  | {
      kind: "synchronized";
      /**
       * Changes on every host start (§8). A client that reconnects to a
       * different instance id re-reads the thread instead of resuming by
       * sequence.
       */
      hostInstanceId: string;
    }
  | HistoryImportFrame;

/**
 * The stream's last line when it cannot be served at all — the thread read
 * failed. Not a frame: never sequenced, and the host closes the stream after
 * it. `code` is the failure's §6.2 code (additive: a host from before it sends
 * `message` alone). `THREAD_NOT_FOUND` means the host holds no such thread —
 * a fork whose create never landed, a thread deleted there — and is terminal:
 * reconnecting would only read the same miss again.
 */
export interface AgentChatStreamErrorLine {
  kind: "error";
  code?: AgentChatErrorCode;
  message: string;
}

/** The host's own wording of a missing thread (`threadNotFound`), for a line with no `code`. */
const THREAD_NOT_FOUND_MESSAGE = /^Thread '.+' was not found\.$/;

/** Whether a stream's error line says the thread does not exist on the host. */
export function isThreadGoneStreamError(line: AgentChatStreamErrorLine): boolean {
  if (line.code !== undefined) return line.code === "THREAD_NOT_FOUND";
  return THREAD_NOT_FOUND_MESSAGE.test(line.message);
}

/**
 * Where a resumed conversation's history replay stands (E6), so a client can
 * show a loading screen instead of an empty thread.
 *
 * - `reading`: the agent is starting and its own history is being read;
 * - `importing`: `done` of `total` history events are in the thread's log;
 * - `done`: the replay is over (finished, failed or skipped).
 */
export interface HistoryImportProgress {
  phase: "reading" | "importing" | "done";
  done: number;
  /** Null until the history has been read. */
  total: number | null;
}

/**
 * **Transient, never persisted and never sequenced.** Sent after
 * `synchronized` on a stream that attaches while a replay runs, then on every
 * change. A client that does not know the kind skips the line.
 */
export interface HistoryImportFrame {
  kind: "history-import";
  progress: HistoryImportProgress;
}

/**
 * The comment line sent every {@link AGENT_CHAT_HEARTBEAT_MS} to keep proxies
 * and browsers from timing out — matching the daemon's existing `/events`
 * heartbeat. It is a comment, not NDJSON: a client must skip any line starting
 * with `:`.
 */
export const AGENT_CHAT_HEARTBEAT_LINE = ":hb";
export const AGENT_CHAT_HEARTBEAT_MS = 15_000;

/**
 * Backpressure: if the response's write buffer exceeds this the host closes
 * the stream and the client reconnects with its last sequence (§6.3).
 */
export const AGENT_CHAT_STREAM_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Snapshot-or-replay is the SERVER's decision (§6.3). The host replays events
 * after `after` only when the range, measured over this thread's rows alone,
 * is within both budgets; past either it sends a snapshot. Row count alone is
 * not a bound — a handful of events with large tool payloads decode to far
 * more than their number suggests.
 */
export const AGENT_CHAT_REPLAY_MAX_EVENTS = 1_000;
export const AGENT_CHAT_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

/** Query of the §6.3 stream and of `GET …/thread`. */
export interface AgentChatEventsQuery {
  after?: number;
}

// ---------------------------------------------------------------------------
// §6.3 reads
// ---------------------------------------------------------------------------

/**
 * `GET /api/sessions/:id/thread`. With `?after=<seq>` the host MAY answer with
 * events instead; the response says which it is, so the client handles either.
 */
export type ThreadReadResponse =
  | { kind: "snapshot"; thread: ThreadSnapshotPayload }
  | { kind: "events"; seq: number; events: DomainEvent[] };

export interface TurnDiffQuery {
  /**
   * Hide whitespace-only changes (`git diff --ignore-all-space`); `1`/`0` on
   * the wire. Absent is false: every change shows, indentation included.
   */
  ignoreWhitespace?: boolean;
}

export interface TurnDiffResponse {
  fromTurnCount: number;
  toTurnCount: number;
  /** Unified diff text; `from === to` short-circuits to "". */
  diff: string;
}

/** `GET /api/sessions/:id/items/:itemId` — the full, unslimmed payload (§5.6). */
export interface ThreadItemResponse {
  item: ThreadItem;
}

/**
 * The most bytes of streamed output {@link ThreadItemOutputResponse} carries
 * (UTF-8). Past it the join stops, on a character boundary, and says so with
 * `truncated`: the answer stays a bounded read however long a command ran.
 */
export const THREAD_ITEM_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `GET /api/sessions/:id/items/:itemId/output` — the streamed output of the
 * tool call the item belongs to.
 *
 * Some output exists only as `tool.output` chunks (`payload.delta`, the §5.6
 * command-output buffer): a Claude background shell's, tailed from the file
 * the CLI writes, and a running command's so far. No single item holds it —
 * the GUI joins the chunks onto the call's row — and the snapshot cannot give
 * it back whole (per-agent windows evict chunks, every string is capped on the
 * wire, history pages are slimmed), so the host joins them from the log.
 *
 * The join reads the raw log: a chunk written in a turn a later rewind
 * (`thread.reverted`) removed is still joined — chunks written before a rewind
 * are what the command printed, and a rewind unprints nothing (a Claude rewind
 * restarts the session, closing an open shell first, so none prints on through
 * one). It is by call, not by stream: a file change's `file_change_output`
 * chunks join like a command's, and the reader decides what the text is.
 *
 * This is the WHOLE join, the answer when the query asks for no window (and
 * every answer of a host that predates windows); one window of it is
 * {@link ThreadItemOutputWindowResponse}, which carries `text`, never `output`.
 *
 * 404 `ITEM_NOT_FOUND` when the thread has no such item, or the item names no
 * tool call (no `payload.toolUseId`).
 */
export interface ThreadItemOutputResponse {
  /** The call: the item's `payload.toolUseId`. */
  toolUseId: string;
  /**
   * Every `tool.output` chunk of the call, joined verbatim in log order — ""
   * when it streamed nothing.
   */
  output: string;
  /** A `tool.completed` row exists for the call: its output will not grow. */
  complete: boolean;
  /**
   * The join passed {@link THREAD_ITEM_OUTPUT_MAX_BYTES}: `output` is its head,
   * cut on a character boundary.
   */
  truncated: boolean;
}

/**
 * The query of `GET …/items/:itemId/output` that asks for ONE window of the
 * join ({@link ThreadItemOutputWindowResponse}); without either field the
 * route answers the whole join ({@link ThreadItemOutputResponse}), as it did
 * before windows existed.
 *
 * Both count UTF-8 bytes of the join. On the wire they are decimal strings:
 * an `offset` that is not one, or is given twice, is a 400
 * `INVALID_COMMAND`, and one past the end (however large) reads as the end;
 * `maxBytes` (its first value, if repeated) is clamped to
 * `[1, THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES]` and defaults to
 * {@link THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES} when absent or unparseable
 * — a window's size is a preference, never a reason to refuse.
 */
export interface ThreadItemOutputWindowQuery {
  offset?: number;
  maxBytes?: number;
}

/** A window's size when the query names none. */
export const THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES = 64 * 1024;

/** The widest window one request takes. */
export const THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES = 1024 * 1024;

/**
 * One UTF-8 window of the join {@link ThreadItemOutputResponse} describes —
 * never an `output` field, so a reader tells it from the whole join a host
 * that ignores the query answers ({@link isThreadItemOutputWindow}).
 *
 * The byte space is the join's UTF-8 as it stands (`Buffer.from(output)`; a
 * lone surrogate reads as U+FFFD, 3 bytes), the same space whichever host
 * serves a page, so offsets carry across a host restart. A running call's
 * join only grows at its end, so an earlier `nextOffset` stays valid.
 */
export interface ThreadItemOutputWindowResponse {
  /** The call: the item's `payload.toolUseId`. */
  toolUseId: string;
  /**
   * Where `text` begins: the requested offset, clamped to `totalBytes` and
   * moved back to the first byte of the character it falls in.
   */
  offset: number;
  /**
   * Whole characters: at most `maxBytes` bytes of UTF-8, or exactly one
   * character when `maxBytes` is narrower than it. Empty only at the end.
   */
  text: string;
  /**
   * UTF-8 bytes of the whole join as it stands (at most
   * {@link THREAD_ITEM_OUTPUT_MAX_BYTES}); grows while the call runs.
   */
  totalBytes: number;
  /** `offset` + the bytes of `text`, present only while that is below `totalBytes`. */
  nextOffset?: number;
  /** A `tool.completed` row exists for the call: its output will not grow. */
  complete: boolean;
  /** The join passed {@link THREAD_ITEM_OUTPUT_MAX_BYTES}: `totalBytes` is its head's. */
  truncated: boolean;
}

const isByteCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * A body shaped like {@link ThreadItemOutputWindowResponse}. The whole join
 * ({@link ThreadItemOutputResponse}) never is: it carries `output`, no `text`
 * and no offsets.
 */
export function isThreadItemOutputWindow(body: unknown): body is ThreadItemOutputWindowResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    typeof value.toolUseId === "string" &&
    typeof value.text === "string" &&
    isByteCount(value.offset) &&
    isByteCount(value.totalBytes) &&
    (value.nextOffset === undefined || isByteCount(value.nextOffset)) &&
    typeof value.complete === "boolean" &&
    typeof value.truncated === "boolean"
  );
}

/** `GET /api/agent/providers` (§6.3). */
export interface AgentProvidersResponse {
  providers: ProviderSnapshot[];
  /** §8: changes on every host start. */
  hostInstanceId: string;
}

/** `POST /api/agent/providers/:id/refresh` (§4.6.4). */
export interface RefreshProviderRequest {
  cwd?: string;
}

export interface RefreshProviderResponse {
  provider: ProviderSnapshot;
  /** True only when something actually changed — gates `agent.providers.changed`. */
  changed: boolean;
}

/** `POST /api/agent-host/stop` (§6.3, §3.3). */
export interface AgentHostStopResponse {
  ok: boolean;
  /** Threads whose continuation marker was written before the drain. */
  markedThreadIds: string[];
  /** The replacement's instance id, or null when it never became ready. */
  hostInstanceId?: string | null;
}

/**
 * One thing a pending agent-host restart waits on ({@link AgentHostStatusResponse}): a turn
 * running, a background shell or watch loop, a subagent, a finished background task the
 * provider is about to hand the agent (a pending wake), or background work the daemon knows of
 * but the host does not itemise (an older host).
 */
export interface AgentHostRestartBlocker {
  threadId: string;
  /** The tab's title, when the daemon knows the thread. */
  threadTitle?: string;
  kind: "turn" | "background" | "agent" | "wake" | "work";
  taskId?: string;
  /** The task's own title (a shell's description, an agent's task). */
  title?: string;
  /** A background shell's command line. */
  command?: string;
  /** Since when (ISO): the task started, the wake's task finished. */
  since?: string;
  /** `POST /api/sessions/:id/task/stop` stops this task alone. */
  stoppable?: boolean;
}

/**
 * `GET /api/agent-host/status`: the agent host as the daemon supervises it, and the drain-restart
 * a deploy left pending — what it waits on, per thread. A pending restart waits for no turn to
 * run and no background work to be live (a running shell is never killed by it, however long
 * it runs); `POST /api/agent-host/stop` restarts at once and stops all of it.
 */
export interface AgentHostStatusResponse {
  state: "stopped" | "starting" | "healthy" | "foreign" | "error";
  reason: string | null;
  hostInstanceId: string | null;
  pid: number | null;
  /** The code the running host was started from (its code stamp), when it reports one. */
  codeStamp: string | null;
  /** The code in the daemon's checkout — what a restart would run. */
  checkoutCodeStamp: string | null;
  pendingRestart: {
    /** Why it is pending ("agent host code 1570de7c8ee6 != f5aff27f7805"). */
    reason: string;
    /** Since when the restart has waited (ISO), or null before its first deferral. */
    since: string | null;
    /** The last deferral as the daemon logged it, or null. */
    deferredBy: string | null;
    blockers: AgentHostRestartBlocker[];
  } | null;
}

// ---------------------------------------------------------------------------
// §6.4 event bus additions (coarse only)
// ---------------------------------------------------------------------------

/** `agentChat.turn` — one per turn transition. Nothing higher-rate rides the bus. */
export interface AgentChatTurnEventPayload {
  /** Session id (= thread id). */
  id: string;
  turnId: string | null;
  state: TurnState;
  tokenUsage?: TurnTokenUsage;
}

/** `agentChat.pending` — an approval or question opened or closed. */
export interface AgentChatPendingEventPayload {
  id: string;
  requestId: string;
  kind: "approval" | "question";
  title: string;
  open: boolean;
}

/** `agent.providers.changed` — coarse; the client re-reads §6.3. */
export interface AgentProvidersChangedPayload {
  /** The adapter whose snapshot changed, when the change was scoped to one. */
  adapterId?: AgentAdapterId;
}

export type AgentChatEventType =
  | "agentChat.turn"
  | "agentChat.pending"
  | "agentChat.secretRequest"
  /** An Orquester approval card opened or closed (`AgentChatToolApprovalEventPayload`, `tool-approvals.ts`). */
  | "agentChat.toolApproval"
  | "agent.providers.changed";

// ---------------------------------------------------------------------------
// Reply subscriptions (unified MCP design 2026-10-15 §8.3) — socket-only
// ---------------------------------------------------------------------------

/**
 * `POST agentChatRoutes.replySubscriptions(targetSessionId)` — SOCKET-ONLY, every field
 * socket-trusted (`principal.ts`); when the request carries an agent principal its `threadId` must
 * be `fromThreadId` (403 otherwise). The subscription is persisted
 * (`agent-reply-outbox.json`) BEFORE the message is posted or queued. An idle target gets the turn
 * at once; a working one (or one waiting for its user) gets it as its next turn — never a steer —
 * under the response's fixed `commandId`, which binds the reply to that turn.
 */
export interface ReplySubscriptionRequest {
  /** The requester (the calling chat); its final-reply delivery goes here. */
  fromThreadId: string;
  /** `wait`: the requester may attach a waiter; `notify`: delivered as a new message. */
  reply: "wait" | "notify";
  /** The whole turn input, provenance header (v2) included. */
  input: string;
  attachments?: AttachmentRef[];
  /** The target turn's mode (plan carries on, §5.3). */
  interactionMode?: InteractionMode;
  /** Usually the thread-message chip. */
  context?: ComposerContextRecord[];
  /** The caused turn's exchange (§8.4), computed by the executor. */
  causedBy: CausedBy;
  /** How the message came: its header's origin. Default `sent`. */
  origin?: "sent" | "opened" | "delegated";
  /**
   * Idempotency key (persisted as `ReplySubscriptionRecord.idempotencyKey`): a repeat answers the
   * first subscription (and its `commandId`), never a second one. 1–180 characters, no `:`.
   */
  idempotencyKey?: string;
}

/** Pending (not `done`) reply subscriptions one requester may hold (spec §5.6); the next is refused. */
export const MAX_PENDING_REPLY_SUBSCRIPTIONS = 20;
/** 429 code of a subscription over {@link MAX_PENDING_REPLY_SUBSCRIPTIONS}. */
export const REPLY_SUBSCRIPTION_LIMIT = "REPLY_SUBSCRIPTION_LIMIT";
/**
 * 409 code (lineage and reply-subscription routes, and the chat tools that call them): the target
 * chat is working, so a merge or a reply-bound message is delivered at its next idle point instead
 * of now. Deliberately not in {@link AgentChatErrorCode} (a daemon route code, not a host command's).
 */
export const TARGET_BUSY = "TARGET_BUSY";
/**
 * 409 code of a blocking wait that would close a cycle — the target is itself waiting, directly or
 * through others, on the caller (§8.6; project-blind). Chat tools and the reply-subscription
 * waiter answer it at once instead of both sides sitting out their timeouts. Deliberately not in
 * {@link AgentChatErrorCode}.
 */
export const WAIT_CYCLE = "WAIT_CYCLE";

export interface ReplySubscriptionResponse {
  subscriptionId: string;
  /**
   * The command id of the message's FIRST post. A queued message the target refused is retried as
   * `<queueEntryId>:<n>` (the merge-queue rule), so bind the reply by `queueEntryId` when present,
   * never by an attempt's command id.
   */
  commandId: string;
  /** `delivery: "queued"`: the delivery-queue entry (`PendingMergeBack.mergeId`, kind `message`) holding the message. */
  queueEntryId?: string;
  /** `sent`: the target took the turn now; `queued`: it gets it at its next idle point. */
  delivery: "sent" | "queued";
  /** The target's sequence after a `sent` delivery. */
  seq?: number;
}

/** `POST agentChatRoutes.replySubscriptionRelease(targetSessionId, subscriptionId)`. */
export interface ReplySubscriptionReleaseResponse {
  /** False when no waiter was attached (it already answered, timed out, or never attached). */
  released: boolean;
  /** The subscription's state after the release (`ReplySubscriptionState`, `@orquester/config`). */
  state: string;
}

/** `POST agentChatRoutes.replySubscriptionWait(targetSessionId, subscriptionId)`. */
export interface ReplyWaitRequest {
  /** 1–600; the waiter gives up then and the subscription becomes `notify`. */
  timeoutSeconds: number;
}

/**
 * The waiter's answer (exactly one consumer, CAS §8.3):
 * - `replied` — the bound turn settled and this waiter got it: `reply` (the final assistant
 *   text; absent with `emptyReply: true` for a turn with no written reply, §13 d), or the
 *   turn's `failed` / `interrupted` state and `error`;
 * - `notify` — the timeout passed, or the target's turn asks its user something: the
 *   subscription is now `notify` and the reply will be delivered as a new message;
 * - `closed` — the target closed before replying.
 */
export type ReplyWaitResponse =
  | {
      outcome: "replied";
      turnId: string | null;
      state: "completed" | "failed" | "interrupted";
      reply?: string;
      emptyReply?: true;
      error?: string;
    }
  | { outcome: "notify"; reason: "timeout" | "needs-input"; willNotify: true }
  | { outcome: "closed" };

// ---------------------------------------------------------------------------
// §6.4 / §7.1 — the seven derived `SessionSummary` fields
// ---------------------------------------------------------------------------

/**
 * Native background work alive after the turn settles (§3.1): `"working"`
 * while any agent work is live, `"monitoring"` only when watch loops and
 * background shells are the *only* live work, `null` otherwise. Deliberately
 * not persisted — after a host restart the registry is empty, which is
 * correct, because orphaned background work is not live.
 */
export type BackgroundLiveness = "working" | "monitoring";

/**
 * A thread's unfinished goal as every ambient surface reads it (goals §4.7).
 * `continuing` is true while the provider starts turns by itself — a Codex
 * goal that is `active` — and one of these holds:
 * - its session is live AND a turn is running, or the last idle point it
 *   continues from (a turn settling, the session (re)starting) is within the
 *   host's grace (`GOAL_CONTINUATION_GRACE_MS`, 60 s): a continuation that
 *   never starts stops reading as work, with no event — the host recomputes
 *   the field on every read;
 * - a host restart's resume of it is still owed (goals §5.5, the head's
 *   `resumeGoalAfterRestart`), even while the session reads `error`.
 * It is also true while the host HOLDS the goal for a deploy (goals §5.7, the
 * head's `goalHeldForHandover`) — then `status` reads `paused`: the next host
 * sets it going again by itself — and through the grace after a host sets a
 * held goal going again, until the provider's own update turns the status
 * `active`. Those are the only cases a paused goal is continuing.
 * A settled latest turn is then not "finished", and the host's word is final:
 * no surface re-derives it. Without a pending resume the host never reports
 * it for a stopped or errored session, so a goal never masks an error.
 */
export interface AgentChatGoalSummary {
  objective: string;
  status: AgentGoalStatus;
  continuing: boolean;
}

/**
 * The seven fields `SessionSummary` gains for chat sessions (§6.4, and
 * goals §4.7 for `goal`). **This list is the contract §7.1 and §7.7 read, and
 * no surface may invent a name for one of them.** The first six names are
 * T3's (`orchestration.ts:860-919`, `OrchestrationThreadShell`).
 *
 * They exist so every surface already reading only `SessionSummary` — tab
 * strip, Attention Center, command palette, push gate — keeps working without
 * a thread subscription. Approvals and questions are separate booleans on
 * purpose: they need different UI and different push copy.
 */
export interface AgentChatSessionSummaryFields {
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
  backgroundLiveness?: BackgroundLiveness | null;
  latestTurn?: LatestTurnSummary | null;
  /** The session status from §5.1's `ThreadHead`. */
  chatSessionStatus?: ThreadSessionStatus;
  /** The thread's unfinished goal, `null` when it has none (goals §4.7). */
  goal?: AgentChatGoalSummary | null;
  /**
   * A delegated child's model and latest word, for its parent's subagent strip and roster
   * (`delegation.ts`). Only on a thread whose lineage is a `delegate`; `null` once it has none, to
   * clear what a client merged. Additive: an older host never sends it.
   */
  delegateView?: DelegateView | null;
}
