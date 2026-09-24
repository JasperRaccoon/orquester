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
  RuntimeMode
} from "./adapter-types.ts";
import type { DomainEvent } from "./domain-events.ts";
import type { AgentGoalStatus } from "./goal.ts";
import type { ApprovalDecision, TurnTokenUsage } from "./runtime-events.ts";
import type {
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

  // §6.3 reads
  thread: (sessionId: string): string => `${sessionBase(sessionId)}/thread`,
  events: (sessionId: string): string => `${sessionBase(sessionId)}/events`,
  turnDiff: (sessionId: string, turnCount: number): string =>
    `${sessionBase(sessionId)}/turns/${turnCount}/diff`,
  item: (sessionId: string, itemId: string): string =>
    `${sessionBase(sessionId)}/items/${encodeURIComponent(itemId)}`,
  /**
   * The streamed output of the tool call an item belongs to — every
   * `tool.output` chunk of the call, joined by the host
   * ({@link ThreadItemOutputResponse}). A 404 of its own is
   * `ITEM_NOT_FOUND`; a host that predates the route answers the miss as its
   * generic 404 `THREAD_NOT_FOUND` ("No route for GET …").
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

  // §6.3 host-level reads (not per session)
  providers: "/api/agent/providers",
  providerRefresh: (adapterId: string): string =>
    `/api/agent/providers/${encodeURIComponent(adapterId)}/refresh`,
  hostStop: "/api/agent-host/stop",

  // Indexed history (design 2026-09-23 "thread index and lazy boot").
  /**
   * A page of turns OLDER than what the client holds, folded from the log by
   * the host: `?before=<cursor>&turns=<n>`. No cursor means "the turns just
   * below the retained window" (the snapshot's `history.beforeCursor`).
   */
  history: (sessionId: string): string => `${sessionBase(sessionId)}/history`,
  /** Full-text search over every indexed thread on the host: `?q=&limit=&projectPath=`. */
  search: "/api/agent/search"
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
  | "session/stop";

/** The ten §6.2 command names, in table order. */
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
  "session/stop"
] as const satisfies readonly AgentChatCommandName[];

/** Resolve a command name to its route. */
export function agentChatCommandPath(sessionId: string, name: AgentChatCommandName): string {
  return name === "session/stop"
    ? agentChatRoutes.sessionStop(sessionId)
    : agentChatRoutes[name](sessionId);
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
  modelSelection: ModelSelection;
  runtimeMode?: RuntimeMode;
  /**
   * A conversation from `GET /api/agents/conversations`, which becomes the
   * thread's initial resume cursor. One the adapter cannot use is refused at
   * creation with 400 `RESUME_UNAVAILABLE` — the only route that answers that
   * code; no §6.2 command does.
   */
  resume?: { home: AccountHomeKind; conversationId: string };
}

/** §6.1's create-time refusal code. Deliberately not in {@link AgentChatErrorCode}. */
export const RESUME_UNAVAILABLE = "RESUME_UNAVAILABLE";

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
}

/**
 * Settle pending requests, then interrupt. With no running turn it stops the
 * thread's live background work — the client omits `turnId` whenever the
 * session is not `running` (§6.2, §7.6).
 */
export interface InterruptCommandBody extends AgentChatCommandBase {
  turnId?: string;
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

export type CompactCommandBody = AgentChatCommandBase;

/**
 * `/background`: `toolUseId` names the one running call to move (the
 * `toolUseId` on its activity row); absent moves every foreground task, which
 * is exactly what Ctrl+B does in the terminal.
 */
export interface BackgroundCommandBody extends AgentChatCommandBase {
  toolUseId?: string;
}

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
 * The activity kind the host appends beside the switch, so the timeline shows
 * where the identity changed. `payload` is
 * `{accountId, home, previousAccountId?}`; the client resolves the id to a
 * label at render time, because a label is a client-side fact the log must not
 * freeze.
 */
export const IDENTITY_CHANGED_ACTIVITY_KIND = "session.identity-changed";

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
  | "ITEM_NOT_FOUND";

export const AGENT_CHAT_ERROR_CODES = [
  "INVALID_COMMAND",
  "THREAD_NOT_FOUND",
  "COMMAND_ID_CONFLICT",
  "COMMAND_REJECTED",
  "COMPACTION_UNAVAILABLE",
  "HOST_UNAVAILABLE",
  "INDEX_UNAVAILABLE",
  "ITEM_NOT_FOUND"
] as const satisfies readonly AgentChatErrorCode[];

/** A failed command answers this, and it is not a transport error to swallow. */
export interface AgentChatErrorEnvelope {
  error: {
    code: AgentChatErrorCode;
    message: string;
    detail?: unknown;
  };
}

/**
 * Commands answered with 409 for a thread in `error`, **except**
 * `session/stop` and `revert` (§6.2) — without that carve-out a session wedged
 * in `starting` or `error` would be unrecoverable.
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
    };

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
  /** Defaults to true (§5.4). */
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
  | "agent.providers.changed";

export const AGENT_CHAT_EVENT_TYPES = [
  "agentChat.turn",
  "agentChat.pending",
  "agent.providers.changed"
] as const satisfies readonly AgentChatEventType[];

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
}
