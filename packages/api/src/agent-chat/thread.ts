/**
 * Agent chat — the projected thread model (spec §5.1, §5.4, §5.5, §7.2, §7.6).
 *
 * Ported from T3 Code (MIT): `packages/contracts/src/orchestration.ts`,
 * `packages/client-runtime/src/pendingRequests.ts`,
 * `packages/client-runtime/src/state/subagentRuntime.ts`.
 *
 * Everything here is a FOLD over `events.ndjson` (`domain-events.ts`). Nothing
 * in this file is stored as-is; the host rewrites `meta.json` ({@link ThreadHead})
 * from the fold, and every other shape is derived on read.
 */

import type {
  AccountHomeKind,
  AgentAdapterId,
  AttachmentRef,
  ComposerContextRecord,
  ModelSelection,
  ProviderSessionStatus,
  RuntimeMode
} from "./adapter-types.ts";
import type {
  ApprovalOption,
  CanonicalRequestType,
  ProviderRequestKind,
  RuntimeItemStatus,
  RuntimeTaskStatus,
  RuntimeTurnState,
  TaskWorkflowPhase,
  TaskRunHandles,
  TurnTokenUsage,
  UserInputQuestion
} from "./runtime-events.ts";

// ---------------------------------------------------------------------------
// Head (§5.1)
// ---------------------------------------------------------------------------

/**
 * Session status as the head records it. `idle` exists only here — for a
 * thread that has no session yet.
 *
 * *T3: `orchestration.ts:586-595`; differs: T3's `interrupted` is folded into
 * `stopped`.*
 */
export type ThreadSessionStatus =
  | "idle"
  | "starting"
  | "ready"
  | "running"
  | "stopped"
  | "error";

export interface ThreadSessionState {
  status: ThreadSessionStatus;
  /** Adapter-owned blob; see `ProviderSession.resumeCursor`. */
  resumeCursor?: unknown;
  providerThreadId?: string;
  activeTurnId: string | null;
  lastError?: string;
}

/**
 * §3.3. A turn id, **never a boolean**, so a continuation can be matched
 * against the session's `activeTurnId` and a marker left over from an older
 * turn is ignored rather than replaying the wrong work. `prepared` is written
 * by the reconcile immediately before the continuation is sent, which is what
 * makes recovery survive a host that dies *between* resuming and sending.
 */
export interface ContinueAfterRestart {
  turnId: string;
  prepared?: boolean;
}

/**
 * `meta.json` — rewritten atomically every 50 events and on turn end (§5.1).
 *
 * *T3: `orchestration.ts:599-609` (`OrchestrationSession`) plus the thread row;
 * differs: T3 has no `turnCount` on the head (it recomputes it as the maximum
 * `checkpointTurnCount`). Here it is a cached mirror of that same derivation —
 * §5.4 still treats the checkpoints as authoritative.*
 */
export interface ThreadHead {
  id: string;
  projectPath: string;
  cwd: string;
  title: string;
  adapter: AgentAdapterId;
  /** Registry id the tab launched from (claude, claudex, codex, …). */
  refId: string;
  accountId: string;
  home: AccountHomeKind;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  session: ThreadSessionState;
  turnCount: number;
  seq: number;
  continueAfterRestart?: ContinueAfterRestart;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Provider session binding (§3.3, §4.1 "Cursor per turn")
// ---------------------------------------------------------------------------

/**
 * The durable per-thread binding between a thread and the provider session that
 * serves it. **This — not `ThreadHead.session` — is the authority for the
 * resume cursor.**
 *
 * Why it exists: `ThreadHead.session` is a projection of `thread.session-set`,
 * and a `session-set` event names the whole block. One that omitted the cursor
 * (a settle to `ready`, a stop) replaced the block wholesale, the head lost its
 * cursor, and the next host to start that session — after a deploy's
 * drain-restart — opened a FRESH provider session with no memory of the
 * conversation (2026-09-22, thread c8979f6a). The fold now carries the cursor
 * forward, but that is a belt: an event-sourced field can always be replaced by
 * the next event that names it. The binding cannot, because nothing replaces it
 * whole — every write is a field-wise
 * {@link ProviderSessionBindingPatch} merge.
 *
 * *T3: `apps/server/src/persistence/ProviderSessionRuntime.ts:35-52` — the
 * `provider_session_runtime` row, outside the event log; differs: Orquester has
 * no database, so the row is a `binding.json` beside `meta.json`.*
 */
export interface ProviderSessionBinding {
  threadId: string;
  /** The adapter that owns the session this cursor belongs to. */
  adapter: AgentAdapterId;
  /**
   * The registry entry the session launched from (`claude`, `claudex`, …).
   * A cursor minted under one launcher can be unusable under another.
   */
  adapterKey: string | null;
  runtimeMode: RuntimeMode | null;
  /** The provider instance/home the cursor is valid in, when one is known. */
  providerInstanceId: string | null;
  status: ProviderSessionStatus;
  /**
   * The adapter-owned resume blob — the one field the whole binding exists
   * for. `null` means "this thread has no resumable session", which is
   * different from "unchanged" (see {@link ProviderSessionBindingPatch}).
   */
  resumeCursor: unknown;
  providerThreadId: string | null;
  lastSeenAt: string;
}

/**
 * A field-wise patch. **`undefined` means unchanged; `null` means cleared.**
 * That contract is the whole point: a caller that knows nothing about the
 * cursor simply omits it and cannot erase it, and a caller that genuinely ends
 * a session says so with `null`.
 *
 * *T3: `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:142-145` —
 * `resumeCursor: binding.resumeCursor !== undefined ? binding.resumeCursor :
 * (existingRuntime?.resumeCursor ?? null)`, and `:118-138` for adapterKey /
 * runtimeMode / providerInstanceId.*
 */
export interface ProviderSessionBindingPatch {
  adapter?: AgentAdapterId;
  adapterKey?: string | null;
  runtimeMode?: RuntimeMode | null;
  providerInstanceId?: string | null;
  status?: ProviderSessionStatus;
  resumeCursor?: unknown;
  providerThreadId?: string | null;
}

// ---------------------------------------------------------------------------
// Items (§5.1, read by the §7.2 presentation resolver)
// ---------------------------------------------------------------------------

/** Reasoning is a sibling message with its own role, never part of the assistant message. */
export type ThreadMessageRole = "user" | "assistant" | "reasoning";

export interface ThreadMessageItem {
  kind: "message";
  id: string;
  role: ThreadMessageRole;
  text: string;
  attachments?: AttachmentRef[];
  /** Composer chips persisted for re-render only (§4.1). */
  context?: ComposerContextRecord[];
  turnId: string | null;
  /** Owning subagent; such an item never renders in the parent timeline (§7.2). */
  agentId?: string;
  /**
   * Only on a `reasoning` message: whether the provider sent raw reasoning or a
   * summary of it (`reasoning_text` vs `reasoning_summary_text`, §4.2). §7.3
   * asks the collapsed row to be **labelled "summary"** in the second case, and
   * the distinction is not recoverable from the text — so it is carried here.
   * Absent means unknown, and the row then shows no badge rather than guessing.
   *
   * *Added by W12; additive. Producers: the adapters / ingestion (W3, W6–W9).*
   */
  reasoningKind?: "text" | "summary";
  /**
   * Only on an `assistant` message: whether this is the turn's answer or the
   * running "I'll do X next" narration.
   *
   * REALITY (Codex): an `agentMessage` carries a `phase` of `final_answer` or
   * `commentary`, and §7.3 wants commentary demoted into the activity group
   * rather than shown as a second full-width answer — a thread of narration
   * rendered as answers is unreadable. The projection (W11) demotes it; the
   * timeline additionally renders a commentary message quietly if one reaches
   * it, so a missed demotion degrades instead of shouting.
   *
   * *Added by W12; additive. Producers: the adapters / ingestion (W3, W6–W9).*
   */
  messageKind?: "answer" | "commentary";
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ThreadActivityTone = "info" | "tool" | "approval" | "error";

/**
 * The one normalised activity record — **not** a component taxonomy (§7.2).
 * `activityKind` and `payload` are deliberately an open string and `unknown`
 * at this layer; `agentId`, `parentToolUseId` and `status` are promoted out of
 * the payload so the roster folds without decoding it.
 *
 * The presentation resolver reads `tone`, `activityKind`, `status`, `turnId`,
 * `agentId`, `parentToolUseId` plus the allow-listed payload fields §5.6
 * guarantees survive slimming — see {@link ThreadActivityPayloadFields}.
 *
 * *T3: `orchestration.ts:641-650` (`OrchestrationThreadActivity`).*
 */
export interface ThreadActivityItem {
  kind: "activity";
  id: string;
  tone: ThreadActivityTone;
  /** The originating event kind, e.g. `tool.started`, `approval.requested`. */
  activityKind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  agentId?: string;
  parentToolUseId?: string;
  status?: RuntimeItemStatus;
  createdAt: string;
  updatedAt: string;
}

export type ThreadItem = ThreadMessageItem | ThreadActivityItem;

/**
 * The payload fields §5.6's slimming allow-list guarantees survive onto the
 * wire, and therefore the only ones the §7.3 presentation resolver may read.
 * Everything is optional — a row written by an older adapter still renders.
 */
export interface ThreadActivityPayloadFields {
  itemType?: string;
  /** Stable across the in-progress and completed updates of ONE tool call. */
  toolUseId?: string;
  title?: string;
  detail?: string;
  command?: string;
  changedFiles?: string[];
  taskId?: string;
  /** Canonical approval kind; the raw `requestType` is persisted beside it (§5.1). */
  requestKind?: ProviderRequestKind;
  requestType?: CanonicalRequestType;
  /** Set on the folded-out answered-question row (§7.3). */
  questionAnswer?: {
    requestId: string;
    answers: Record<string, unknown>;
    questionTextById?: Record<string, string>;
  };
  /**
   * Present on agent-spawn rows. Stores **only ids**: the label, live flag and
   * member list resolve from the roster model at render time, because a
   * persisted count goes stale the moment a member finishes (§7.6).
   */
  agentSpawn?: {
    workflowId: string | null;
    agentTaskIds: string[];
  };
  /** True when the full payload was truncated and `GET …/items/:itemId` has more. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Turns (§5.1)
// ---------------------------------------------------------------------------

/**
 * The turn state machine. `pending` is the row between a `/turn` command and
 * the provider's first `turn.started` — it has no turn id yet. A turn is
 * settled **by the fold from session status**, not by `turn.completed`, which
 * is what keeps a late checkpoint or diff from extending the recorded
 * duration (§5.1).
 */
export type TurnState = "pending" | "running" | RuntimeTurnState;

export const SETTLED_TURN_STATES: ReadonlySet<TurnState> = new Set<TurnState>([
  "completed",
  "failed",
  "interrupted",
  "cancelled"
]);

export interface Turn {
  /** The provider's own turn id, stringified — never host-minted. Null while pending. */
  turnId: string | null;
  state: TurnState;
  /** Turn count this turn's checkpoint pair is keyed by (§5.4); null before capture. */
  turnCount: number | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
  interactionMode?: import("./adapter-types.ts").InteractionMode;
  model?: string;
  tokenUsage?: TurnTokenUsage;
  totalCostUsd?: number;
  stopReason?: string | null;
  errorMessage?: string;
}

/** The compact turn row every ambient surface reads off `SessionSummary` (§6.4). */
export interface LatestTurnSummary {
  turnId: string | null;
  state: TurnState;
  startedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Checkpoints (§5.4)
// ---------------------------------------------------------------------------

export interface CheckpointFile {
  path: string;
  additions: number;
  deletions: number;
}

/** `missing` never clobbers a captured `ready` checkpoint (§5.4). */
export type CheckpointStatus = "ready" | "missing" | "error";

/**
 * One captured turn boundary. The ref is
 * `refs/orquester/checkpoints/<base64url(threadId)>/turn/<n>` — never the
 * user's branch, HEAD or visible reflog.
 *
 * *T3: `orchestration.ts:620-633` (`OrchestrationCheckpointSummary`).*
 */
export interface Checkpoint {
  turnId: string | null;
  checkpointTurnCount: number;
  checkpointRef: string;
  status: CheckpointStatus;
  files: CheckpointFile[];
  assistantMessageId: string | null;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Pending requests (§5.1 — derived from the activity fold, never stored)
// ---------------------------------------------------------------------------

/** *T3: `packages/client-runtime/src/pendingRequests.ts:12-19`.* */
export interface PendingApproval {
  requestId: string;
  requestKind: ProviderRequestKind;
  createdAt: string;
  detail?: string;
  appName?: string;
  /**
   * The tool call this request gates, when the adapter knows it.
   *
   * Stable across that call's in-progress and completed updates (§5.1), so the
   * card can join the approval to its `item.started` activity and show the
   * paths and diff it is about to approve — without it a file-change card has
   * nothing to render but its own title (E2E E7).
   */
  toolUseId?: string;
  /** Absent ⇒ the UI offers §4.3's default four. */
  options?: ApprovalOption[];
}

/** *T3: `pendingRequests.ts:21-27`.* */
export interface PendingUserInput {
  requestId: string;
  createdAt: string;
  questions: UserInputQuestion[];
  /**
   * **How this question is answered**, carried as a first-class contract field
   * rather than re-derived from the payload by each consumer (§6.2).
   *
   * `"message"` (Codex `delivery: "async"`) means the provider parked NO
   * request: there is nothing to reply to over RPC, the answer is an ordinary
   * user message steered into the turn, and the question may outlive the turn
   * that asked it. Absent means a native protocol callback — the provider is
   * blocked until it gets a reply.
   *
   * Four behaviours read it and must never disagree: `/dismiss` legality, the
   * terminal-turn cleanup (only NON-message requests are force-resolved),
   * settle eligibility, and the turn-pause gate (an async question never parks
   * the turn).
   *
   * *T3: `providerRuntime.ts:496` (`responseMode` on the pending request),
   * consumed at `decider.ts:500-511,653-661,1769-1775` and
   * `ProviderRuntimeIngestion.ts:2076-2079,2330-2360`.*
   */
  responseMode?: "message";
  /**
   * `responseMode === "message"`, kept as the boolean every card already
   * branches on. Derived, never independently authored.
   */
  dismissible: boolean;
  /**
   * The turn this question was asked in, or `null` when it was asked outside
   * one. What the terminal-turn cleanup scopes itself by.
   */
  turnId?: string | null;
}

export interface PendingRequests {
  approvals: PendingApproval[];
  userInputs: PendingUserInput[];
}

// ---------------------------------------------------------------------------
// Roster (§7.6)
// ---------------------------------------------------------------------------

/**
 * The same eight values as {@link RuntimeTaskStatus} — the roster uses these
 * names and no other. A `task.completed {status: "stopped"}` folds to
 * `interrupted`.
 *
 * *T3: `state/subagentRuntime.ts:22-30`.*
 */
export type RuntimeSubagentStatus = RuntimeTaskStatus;

export const TERMINAL_SUBAGENT_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set<
  RuntimeSubagentStatus
>(["completed", "failed", "cancelled", "interrupted"]);

/**
 * Active = the user may still need to care while it runs. `idle` is
 * settled-ish but resumable; `waiting` counts as active because it needs the
 * user. The three in-flight statuses all present as one steady "working" look
 * (§7.6).
 *
 * *T3: `state/subagentRuntime.ts:98-104`.*
 */
export const ACTIVE_SUBAGENT_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set<
  RuntimeSubagentStatus
>(["pending", "running", "waiting"]);

export interface SubagentUsage {
  totalTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface SubagentActivityEntry {
  at: string;
  summary: string;
}

/** *T3: `state/subagentRuntime.ts:59-88`.* */
export interface RuntimeSubagent {
  id: string;
  kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  /** `"background"` rows are listed too (§7.6, differs from T3). */
  agentKind: "agent" | "background";
  title: string;
  role: string | null;
  model: string | null;
  effort: string | null;
  status: RuntimeSubagentStatus;
  activationCount: number;
  usage: SubagentUsage | null;
  progress: string | null;
  lastToolName: string | null;
  result: string | null;
  error: string | null;
  outputFile: string | null;
  /**
   * A background shell's exit code once it settled; `null` for agents and for
   * a shell still running or one whose provider never said.
   */
  exitCode: number | null;
  /**
   * Whether the task ran detached from its launching tool call (§7.6). `null`
   * when the provider never said — an older row, or an adapter without the
   * notion.
   */
  isBackgrounded: boolean | null;
  parentAgentId: string | null;
  agentIndex: number | null;
  phaseIndex: number | null;
  phaseTitle: string | null;
  attempt: number | null;
  workflowName: string | null;
  phases: TaskWorkflowPhase[];
  runHandles: TaskRunHandles | null;
  recentActivity: SubagentActivityEntry[];
  /** First retained observation — the roster's stable display order. */
  firstSeenAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/** *T3: `state/subagentRuntime.ts:683-697`.* */
export interface AgentPanelWorkflowGroup {
  workflow: RuntimeSubagent;
  phases: Array<{
    index: number;
    title: string;
    members: RuntimeSubagent[];
    /** `done` = every member settled; `running` = any active. */
    state: "pending" | "running" | "done";
    activeCount: number;
    settledCount: number;
  }>;
  /** Members with no resolvable phase render under the workflow. */
  unphasedMembers: RuntimeSubagent[];
}

/** *T3: `state/subagentRuntime.ts:698-708`.* */
export interface AgentPanelModel {
  workflows: AgentPanelWorkflowGroup[];
  directAgents: RuntimeSubagent[];
  runningCount: number;
  waitingCount: number;
  idleCount: number;
  settledCount: number;
  totalTokens: number;
  hasAgents: boolean;
  liveCount: number;
}

/** At most this many rows are retained, evicting live last, newest-settled first (§7.6). */
export const ROSTER_LIMIT = 100;

// ---------------------------------------------------------------------------
// The §6.3 read
// ---------------------------------------------------------------------------

/**
 * `GET /api/sessions/:id/thread` (§6.3), and the body of a `snapshot` stream
 * frame.
 *
 * `seq` is the **floor, not the ceiling**: the lowest sequence every
 * projection in it has been folded to, so a snapshot never claims to be newer
 * than its least-advanced part and a client resuming from it cannot skip an
 * event (§6.3).
 */
export interface ThreadSnapshotPayload {
  head: ThreadHead;
  items: ThreadItem[];
  turns: Turn[];
  checkpoints: Checkpoint[];
  pending: PendingRequests;
  roster: RuntimeSubagent[];
  seq: number;
}
