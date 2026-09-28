/**
 * Agent chat — the adapter-boundary runtime event union (spec §4.2).
 *
 * Ported from T3 Code (MIT): `packages/contracts/src/providerRuntime.ts`,
 * translated from Effect Schema into plain TypeScript. Field, event and status
 * names are T3's wherever T3 has one (design decision, spec §1 "Naming").
 *
 * This is the union every adapter emits and the host's ingestion (§5.1)
 * consumes. It is NOT what is persisted — `events.ndjson` holds the *domain*
 * events of `domain-events.ts`. Keeping the two layers apart is what lets a
 * provider capability change without changing the persisted shape.
 */

import type { GoalUpdatedPayload } from "./goal.ts";

// ---------------------------------------------------------------------------
// Envelope (§4.2)
// ---------------------------------------------------------------------------

/**
 * Closed enum naming the native protocol a `raw` frame came from (§4.2). This
 * field is what makes `raw.ndjson` replayable into the normaliser in a test.
 *
 * *T3: `packages/contracts/src/providerRuntime.ts:23-34`.*
 */
/**
 * The marker every event **projected from a provider's own transcript** carries
 * (`AgentAdapter.projectHistory`), as opposed to one decoded from a live frame.
 *
 * A resumed thread replays nothing onto its message stream, so its timeline is
 * rebuilt from native history instead — and a consumer must be able to tell the
 * two apart: a historical event describes something that already happened, so
 * it never raises attention, never fires a push and never moves a live turn.
 *
 * Referred to by name, never spelled inline, so the literal is one edit.
 */
export const HISTORICAL_RAW_SOURCE = "history.replay";

export type RuntimeEventRawSource =
  /**
   * Not a provider frame: an event the HOST synthesised from an adapter's own
   * `readThread` when a resumed thread had no items of its own (§4.1). It is
   * persisted like any other so the timeline can render, but it describes the
   * past — so anything that reacts to *new* work (W10's summary/push gate, the
   * §5.4 checkpoint baseline) must ignore it. Test with
   * {@link isHistoricalRuntimeEvent}, never by spelling the literal.
   */
  | typeof HISTORICAL_RAW_SOURCE
  | "claude.sdk.message"
  | "claude.sdk.permission"
  | "codex.app-server.notification"
  | "codex.app-server.request"
  | "opencode.sdk.event"
  | "acp.jsonrpc"
  | `acp.${string}.extension`;

/**
 * True for an event the host replayed out of a provider's own history rather
 * than observing live. Such an event is real — it is what the conversation
 * contained — but it is not news: it must not raise attention, fire a push, or
 * move a checkpoint.
 */
export function isHistoricalRuntimeEvent(event: { raw?: { source: string } }): boolean {
  return event.raw?.source === HISTORICAL_RAW_SOURCE;
}

/** The untranslated provider frame an event was decoded from (§4.2). */
export interface RuntimeEventRaw {
  source: RuntimeEventRawSource;
  method?: string;
  messageType?: string;
  payload: unknown;
}

/**
 * The provider's own ids, kept beside ours so a captured log can be correlated
 * with the CLI's own (§4.2).
 */
export interface ProviderRefs {
  providerTurnId?: string;
  providerItemId?: string;
  providerRequestId?: string;
}

/** Fields every runtime event carries (§4.2). */
export interface RuntimeEventBase {
  eventId: string;
  threadId: string;
  /** ISO-8601. */
  createdAt: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  /** Owning subagent when this event happened inside one (§7.2 re-homing rule). */
  agentId?: string;
  providerRefs?: ProviderRefs;
  raw?: RuntimeEventRaw;
}

// ---------------------------------------------------------------------------
// Enumerations (§4.2)
// ---------------------------------------------------------------------------

/**
 * States `session.state.changed` carries (§4.2).
 *
 * *differs from T3 (`providerRuntime.ts:54-61`), which also has `waiting`:*
 * `waiting` is derived from an unresolved request and is never emitted here;
 * a runtime `waiting` maps to session status `running` (§5.1).
 */
export type RuntimeSessionState = "starting" | "ready" | "running" | "stopped" | "error";

/** *T3: `providerRuntime.ts:64-72`.* */
export type RuntimeThreadState =
  | "active"
  | "idle"
  | "archived"
  | "closed"
  /**
   * A context compaction is in flight: the provider is rewriting the
   * conversation and no assistant text is coming until it settles. Emitted
   * once per compaction (Claude's `status: "compacting"` frames are
   * deduplicated at the adapter); `compacted` or `compaction-failed` ends it.
   */
  | "compacting"
  | "compacted"
  /** The compaction did not happen; the conversation is unchanged. `error` says why. */
  | "compaction-failed"
  | "error";

/**
 * Terminal vocabulary of a turn. The ONLY vocabulary used for turn state
 * anywhere in this design (§5.1).
 *
 * *T3: `providerRuntime.ts:74`.*
 */
export type RuntimeTurnState = "completed" | "failed" | "interrupted" | "cancelled";

/** *T3: `providerRuntime.ts:77`.* */
export type RuntimePlanStepStatus = "pending" | "inProgress" | "completed";

/** *T3: `providerRuntime.ts:80`.* */
export type RuntimeItemStatus = "inProgress" | "completed" | "failed" | "declined";

/** *T3: `providerRuntime.ts:83-91`.* */
export type RuntimeContentStreamKind =
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output"
  | "unknown";

/** *T3: `providerRuntime.ts:94`.* */
export type RuntimeSessionExitKind = "graceful" | "error";

/** `class` decides retry vs surface vs re-auth (§4.2). *T3: `providerRuntime.ts:97-103`.* */
export type RuntimeErrorClass =
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";

/**
 * The seven item types that become activity rows (§5.1 ingestion rules).
 * Everything else in `CanonicalItemType` is already represented as a message
 * or as its own event and is dropped from the activity path.
 *
 * *T3: `providerRuntime.ts:106-114`.*
 */
export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view"
] as const;

export type ToolLifecycleItemType = (typeof TOOL_LIFECYCLE_ITEM_TYPES)[number];

/** *T3: `providerRuntime.ts:119-121`.* */
export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return (TOOL_LIFECYCLE_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * Closed item vocabulary (§4.2). `review_entered` / `review_exited` stay in the
 * enum exactly as in T3 — the Codex item classifier needs somewhere to put
 * them — but they never become a timeline row and nothing starts a review (§2).
 *
 * *T3: `providerRuntime.ts:123-134`.*
 */
export type CanonicalItemType =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "plan"
  | ToolLifecycleItemType
  | "review_entered"
  | "review_exited"
  | "context_compaction"
  | "error"
  | "unknown";

/**
 * The eleven canonical request types (§4.3). There is no dedicated plan-exit
 * kind — Claude's `ExitPlanMode` arrives as `permission_approval`.
 *
 * *T3: `providerRuntime.ts:137-149`.*
 */
export type CanonicalRequestType =
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "apply_patch_approval"
  | "exec_command_approval"
  | "mcp_elicitation_approval"
  | "permission_approval"
  | "tool_user_input"
  | "dynamic_tool_call"
  | "auth_tokens_refresh"
  | "unknown";

/**
 * The canonical kind the persisted approval activity is classified under
 * (§5.1). Both this and the raw `requestType` are persisted, so a row written
 * by an older adapter is still classifiable.
 *
 * *T3: `packages/contracts/src/orchestration.ts:139-145` (`ProviderRequestKind`).*
 */
export type ProviderRequestKind =
  | "command"
  | "file-read"
  | "file-change"
  | "mcp-elicitation"
  | "permission";

// ---------------------------------------------------------------------------
// Questions (§4.2 / §4.3)
// ---------------------------------------------------------------------------

/** *T3: `providerRuntime.ts:475-479`.* */
export interface UserInputQuestionOption {
  label: string;
  description: string;
  value?: string;
}

/**
 * One structured question (§4.2). `id` must equal the full question text for
 * Claude (§4.5) — the SDK looks answers up by text — so it is NOT trimmed or
 * normalised anywhere.
 *
 * *T3: `providerRuntime.ts:482-491`.*
 */
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputQuestionOption[];
  allowCustomAnswer?: boolean;
  /** Defaults to false when absent. */
  multiSelect?: boolean;
  /**
   * The provider's own "offer a free-text *other* option" flag, Codex's
   * `isOther` (`ToolRequestUserInputQuestion`). It is the source
   * {@link allowCustomAnswer} is derived from and is carried through so the
   * composer can render the provider's wording rather than a generic one; a
   * provider that has no such notion leaves it absent.
   *
   * *Added for the real 0.154.0 shape; `apps/daemon/test/fixtures/codex/README.md`
   * observation 11.*
   */
  isOther?: boolean;
  /**
   * The answer is a secret and the input must be **masked**, and never carried
   * into a draft or persisted beside the message. Codex's `isSecret`; absent
   * means false.
   *
   * *Added for the real 0.154.0 shape; fixtures README observation 11.*
   */
  isSecret?: boolean;
}

// ---------------------------------------------------------------------------
// Task linkage (§4.2)
// ---------------------------------------------------------------------------

/**
 * Watch-loop task types: Monitor-tool tasks plus background shells. Canonical
 * single copy — the host liveness registry, ingestion's `agentKind` stamp and
 * the client roster fold all classify with these sets.
 *
 * *T3: `providerRuntime.ts:543-550`.*
 */
export const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell"
]);

/**
 * Task types that are neither agents nor watch loops: plan-mode bookkeeping,
 * and a provider's scheduled prompt (`scheduled`, a Grok `/loop`) — and
 * `goal`, the task type a 2026-09-26/27 build gave a Grok `/goal` before the
 * goal became the thread's goal (goals §6.3); no adapter emits it since, and it
 * stays here so nothing such a row names can ever read as live work. These
 * run nothing of their own — their fires, turns and subagents are the work,
 * and each is live on its own rows. A row of these types is background, never
 * live work: a week-long loop must not hold a deploy's drain between its fires.
 */
export const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream", "scheduled", "goal"]);

/** Server-stamped classification carried on every task row (§4.2). */
export type TaskAgentKind = "agent" | "background";

/**
 * Agent-vs-background classification, stamped by the host at ingestion so
 * persisted rows are self-describing and clients trust the stamp outright.
 * A deliberate denylist: agent-flavoured type names drift, and an allowlist
 * silently dropped real subagents. A task launched from inside a subagent is
 * agent-internal background work UNLESS it is itself agent-flavoured — a
 * nested agent can outlive its parent and stays in the roster (§3.1).
 *
 * *T3: `providerRuntime.ts:561-572`.*
 */
export function classifyTaskAgentKind(input: {
  readonly taskType?: string | undefined;
  readonly agentId?: string | undefined;
}): TaskAgentKind {
  const { taskType, agentId } = input;
  const nonAgentType =
    taskType !== undefined && (MONITOR_TASK_TYPES.has(taskType) || INERT_TASK_TYPES.has(taskType));
  if (agentId !== undefined && agentId.trim().length > 0) {
    return taskType === undefined || nonAgentType ? "background" : "agent";
  }
  return nonAgentType ? "background" : "agent";
}

/** One phase of a multi-agent workflow. *T3: `providerRuntime.ts:522-525`.* */
export interface TaskWorkflowPhase {
  index: number;
  title: string;
}

/** *T3: `providerRuntime.ts:528-534`. Only http/https URLs may reach `sessionUrl`. */
export interface TaskRunHandles {
  runId?: string;
  scriptPath?: string;
  transcriptDir?: string;
  sessionUrl?: string;
}

/** Typed per-task usage rollup. *T3: `providerRuntime.ts:511-519`.* */
export interface RuntimeTaskUsage {
  totalTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/**
 * Optional agent-identity linkage repeated on EVERY task lifecycle payload —
 * not just `task.started` — so a client fold can rebuild an agent whose start
 * row aged out of activity retention (§4.2). Every field is optional so old
 * emitters and old rows decode unchanged.
 *
 * *T3: `providerRuntime.ts:580-618`.*
 */
export interface TaskAgentLinkage {
  /** SDK task_type (subagent/shell/monitor/local_workflow/…). */
  taskType?: string;
  /** Host-stamped `classifyTaskAgentKind` result. */
  agentKind?: TaskAgentKind;
  agentId?: string;
  title?: string;
  role?: string;
  model?: string;
  /** Open string: provider reasoning-effort vocabularies differ. */
  effort?: string;
  toolUseId?: string;
  parentAgentId?: string;
  workflowName?: string;
  agentIndex?: number;
  phaseIndex?: number;
  phaseTitle?: string;
  phases?: TaskWorkflowPhase[];
  attempt?: number;
  runHandles?: TaskRunHandles;
  outputFile?: string;
  /** Codex agent hierarchy path, e.g. "/root/marlow". */
  agentPath?: string;
  /**
   * Set on provider-synthesized child-agent events whose activity belongs in
   * the roster (§7.6), never the parent timeline.
   */
  timelineBypass?: boolean;
  /**
   * The host's background-liveness registry counts the task live for at most
   * this many milliseconds after the latest row naming it, instead of until
   * its end. Set by an adapter whose agents' ends can go unreported (Grok's:
   * a run reports its end and a heartbeat, but a chat lives until Stop or the
   * tab closes, so a run whose reports stop would count forever); absent, an
   * agent counts until its end. Runtime-only: ingestion never copies it onto
   * an activity, so no log holds it.
   */
  livenessTtlMs?: number;
}

/**
 * T3's eight task statuses — used on `task.progress` / `task.updated` and by
 * the roster fold (§7.6), which uses these eight names and no other.
 * `task.completed` narrows to `completed | failed | stopped`, and the roster
 * folds `stopped` to `interrupted`.
 *
 * *T3: `providerRuntime.ts:630-639`.*
 */
export type RuntimeTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** *T3: `providerRuntime.ts:674`.* */
export type RuntimeTaskCompletedStatus = "completed" | "failed" | "stopped";

// ---------------------------------------------------------------------------
// Token usage (§4.2)
// ---------------------------------------------------------------------------

/**
 * Normalised main-agent usage for one turn, tagged by `usageStatus`. Input
 * includes cache reads and writes; output includes reasoning, of which
 * `reasoningTokens` is an optional subset. `complete` means the provider
 * supplied full input AND output totals; `partial` means every included count
 * is valid but the turn total is not known; `unavailable` means the turn
 * produced none. `hasSubagents` is mandatory.
 *
 * *T3: `providerRuntime.ts:325-345`.*
 */
export interface TurnTokenUsageBase {
  usageScope: "main_agent";
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  hasSubagents: boolean;
}

export type TurnTokenUsage =
  | (TurnTokenUsageBase & {
      usageStatus: "complete";
      inputTokens: number;
      outputTokens: number;
    })
  | (TurnTokenUsageBase & {
      usageStatus: "partial" | "unavailable";
      inputTokens?: number;
      outputTokens?: number;
    });

/**
 * The thread-level context-window snapshot that drives the meter (§7.6).
 * Without `maxTokens` there is no ring and no percentage, only a bare total.
 *
 * *T3: `providerRuntime.ts:263-285`.*
 */
export interface ThreadTokenUsage {
  usedTokens: number;
  maxTokens?: number;
  /** Where the provider will auto-compact, when it reports one. */
  autoCompactAtTokens?: number;
  totalProcessedTokens?: number;
  /**
   * Whether the provider compacts on its own when the window fills. `false` is
   * a **verdict** the adapter can prove (Claude's `isAutoCompactEnabled`), and
   * the client says "Auto-compaction is off." on it; `undefined` means nobody
   * asked, and the copy stays vague rather than guessing.
   *
   * Last-writer-wins like every other field here: a snapshot that knows the
   * answer must carry it on **every** emission, never on the first one only.
   */
  compactsAutomatically?: boolean;
}

// ---------------------------------------------------------------------------
// Usage limits (§4.1, §4.2)
// ---------------------------------------------------------------------------

/**
 * One rolling quota window. `id` is stable per provider so a sparse
 * turn-driven `account.rate-limits.updated` lands on the same row a full probe
 * produced (§4.1); `kind` only orders and labels the bar.
 *
 * *T3: `packages/contracts/src/providerUsageLimits.ts:20-27`
 * (`ServerProviderUsageWindow`).*
 */
export interface ProviderUsageWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  /** 0–100. */
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

/**
 * `unsupported` (API key, no subscription) clears the bars; `probeFailed`
 * keeps the last good ones (§4.1).
 *
 * *T3: `providerUsageLimits.ts:50-60`.*
 */
export interface ProviderUsageLimits {
  checkedAt: string;
  windows: ProviderUsageWindow[];
  unavailable?: {
    reason: "unsupported" | "probeFailed";
    message?: string;
  };
}

/**
 * Sparse by contract: windows merge by `id` onto the published snapshot;
 * omitted windows are unchanged.
 *
 * *T3: `providerUsageLimits.ts:69-71`.*
 */
export interface ProviderUsageLimitsUpdate {
  windows: ProviderUsageWindow[];
}

// ---------------------------------------------------------------------------
// Payloads (§4.2)
// ---------------------------------------------------------------------------

export interface SessionStartedPayload {
  message?: string;
  /** The adapter-owned resume cursor the session was started from. */
  resume?: unknown;
}

export interface SessionStateChangedPayload {
  state: RuntimeSessionState;
  reason?: string;
  detail?: unknown;
}

export interface SessionExitedPayload {
  reason?: string;
  /**
   * Whether the next `/turn` may resume from the persisted cursor or the
   * thread must surface the error. Nothing is ever respawned by a supervisor
   * (§3.1).
   */
  recoverable: boolean;
  exitKind: RuntimeSessionExitKind;
}

export interface ThreadStartedPayload {
  providerThreadId: string;
}

export interface ThreadStateChangedPayload {
  state: RuntimeThreadState;
  /** Set on `compacted`, from the provider's compaction boundary. */
  beforeTokens?: number;
  afterTokens?: number;
  /** Set on `compaction-failed`: the provider's own reason, already user-facing. */
  error?: string;
  /**
   * Set on `compacted`: the summary the provider wrote in place of everything
   * it dropped — the ONLY record of what the thread used to say, and the
   * agent's whole memory of it. Claude sends it as a synthetic user message
   * right after the boundary; the marker carries it instead of the timeline
   * showing it as a message nobody typed. A failed compaction has none.
   *
   * *Added by the compaction-summary fix; additive (§8 rollback boundary: an
   * older fold that ignores it still renders the marker).*
   */
  summary?: string;
}

export interface ThreadMetadataUpdatedPayload {
  name?: string;
}

export interface ThreadTokenUsageUpdatedPayload {
  usage: ThreadTokenUsage;
}

export interface TurnStartedPayload {
  model?: string;
  effort?: string;
}

export interface TurnCompletedPayload {
  state: RuntimeTurnState;
  stopReason?: string | null;
  tokenUsage?: TurnTokenUsage;
  totalCostUsd?: number;
  errorMessage?: string;
}

export interface TurnAbortedPayload {
  reason: string;
  tokenUsage?: TurnTokenUsage;
}

export interface RuntimePlanStep {
  step: string;
  status: RuntimePlanStepStatus;
}

export interface TurnPlanUpdatedPayload {
  explanation?: string | null;
  plan: RuntimePlanStep[];
}

export interface TurnProposedDeltaPayload {
  delta: string;
}

export interface TurnProposedCompletedPayload {
  planMarkdown: string;
  /**
   * Where the provider saved the plan, when it saved one. Claude's
   * `ExitPlanMode` carries a `planFilePath` (fixtures/claude README obs. 10)
   * and it is the handle for "open the plan the CLI actually saved".
   *
   * It is a **host** path, and on Claude it lives under `CLAUDE_CONFIG_DIR` —
   * outside `fsRoot` — so it cannot be opened through `/api/fs/*`; treat it as
   * a label, not a link. Optional: no other provider reports one.
   */
  planFilePath?: string;
}

export interface TurnDiffUpdatedPayload {
  unifiedDiff: string;
}

/** *T3: `providerRuntime.ts:432-448`.* */
export interface ItemLifecyclePayload {
  itemType: CanonicalItemType;
  status?: RuntimeItemStatus;
  title?: string;
  detail?: string;
  data?: unknown;
  /** Owning agent when the item ran inside a subagent. */
  agentId?: string;
  parentToolUseId?: string;
  /**
   * The item's output was bounded and `data` holds only part of it — Codex
   * keeps a command's `aggregatedOutput` up to 64 KiB (its head); OpenCode's
   * `bash` tool keeps the end of an output past its limits, behind its own
   * note, and its generic cut the head. Ingestion carries it onto the row as
   * the payload's `truncated` (§5.6), the mark every reader already takes for
   * "the stored item is cut": the MCP's `read_tool_output` then reads the
   * call's streamed join instead of answering the kept part as the whole
   * output. Absent when nothing was cut.
   */
  truncated?: boolean;
}

export interface ContentDeltaPayload {
  streamKind: RuntimeContentStreamKind;
  delta: string;
  contentIndex?: number;
  summaryIndex?: number;
}

/**
 * One advertised approval button (§4.3). The provider's own wording is what
 * the user sees; `warning` is a provider-supplied caution such as a
 * prompt-injection notice.
 *
 * *T3: `packages/contracts/src/orchestration.ts:155-160`.*
 */
export interface ApprovalOption {
  decision: ApprovalDecision;
  label: string;
  warning?: string;
}

/**
 * The five approval decisions (§4.3). `cancel` is issued by both sides: by the
 * user, and by the host to settle every request still open when a turn is
 * interrupted or a session stops (§4.1).
 *
 * *T3: `packages/contracts/src/orchestration.ts:147-153`.*
 */
export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "acceptAlways"
  | "decline"
  | "cancel";

export interface RequestOpenedPayload {
  requestType: CanonicalRequestType;
  /**
   * False for every native-callback approval — the provider is blocked waiting
   * on a reply and the request must be answered or cancelled (§6.2).
   */
  dismissible: boolean;
  detail?: string;
  appName?: string;
  /** When absent the UI shows the default set of §4.3. */
  options?: ApprovalOption[];
  args?: unknown;
}

export interface RequestResolvedPayload {
  requestType: CanonicalRequestType;
  decision?: ApprovalDecision;
  resolution?: unknown;
  /**
   * Nobody answered it, and the wait on it has ended — the adapter settled the
   * card itself, one of two ways. (1) The session's own teardown — a Stop, an
   * interrupt, a steer's cancel, a rewind, the process's exit — in all four
   * adapters: Claude, Codex, Grok and OpenCode each answer the request with
   * the cancel, deny or reject their protocol expects while the transport
   * lives, and nothing once it is gone. (2) Codex only: the work that asked
   * is over (the turn that raised the card ended, or a collab child's own turn
   * or thread did) or the server resolved the request itself
   * (`serverRequest/resolved`), and Codex answers nothing on the wire.
   * Ingestion writes the host's own cancelled row for it
   * (`cancelledRequestActivity`: "Request cancelled"), never "Approval
   * resolved", which would say someone answered. `decision` is `"cancel"`.
   * One closing row per card: an adapter that withdraws a card writes nothing
   * more for it. The user's own answers, a `cancel` among them, are never
   * marked.
   */
  withdrawn?: true;
}

export interface UserInputRequestedPayload {
  questions: UserInputQuestion[];
  /** `"message"` = answered by an ordinary turn, not a protocol reply. */
  responseMode?: "message";
  /** `responseMode === "message"`; what gates `/dismiss` (§6.2). */
  dismissible: boolean;
  /**
   * The provider is **blocked** on this reply. Codex's `isBlocking`, which
   * supersedes its deprecated `autoResolutionMs`; `dismissible` is its inverse
   * for a protocol-reply request, and this field is the provider's own signal
   * rather than our derivation. Absent when the provider does not say.
   *
   * *Added for the real 0.154.0 shape; fixtures README observation 11.*
   */
  isBlocking?: boolean;
}

export interface UserInputResolvedPayload {
  answers: Record<string, unknown>;
  /**
   * Nobody answered it, as {@link RequestResolvedPayload.withdrawn}: ingestion
   * writes "Question cancelled", never "User input submitted". `answers` is
   * empty.
   */
  withdrawn?: true;
}

export interface TaskStartedPayload extends TaskAgentLinkage {
  taskId: string;
  description?: string;
  /**
   * Whether the task runs detached from the tool call that launched it (a
   * `run_in_background` Bash, a Ctrl+B'd command, a resumed subagent). A
   * foreground task blocks its tool call and is that tool's row, not a roster
   * row: an adapter that can tell the two apart surfaces only the detached
   * ones. Absent when the provider does not say.
   */
  isBackgrounded?: boolean;
  /**
   * The prompt THIS launch of the agent was given, verbatim — never a summary,
   * never the description (which is the task's name). It rides the first
   * `task.started` of a run; a relaunch's start (a new launch id) carries the
   * relaunch's own prompt — a resumed Claude agent's message, a Grok
   * `resume_from`'s, an OpenCode `task_id` re-prompt's, a Codex follow-up's —
   * when the provider reports one. Absent when it does not, and never on a
   * shell or a monitor: a shell's command is its description. A start
   * emitted before the provider could refuse the launch keeps the request it
   * carried — a Grok spawn whose own card the user declined (fixture 25,
   * turn 2), which ends `stopped` with the provider's refusal: once emitted,
   * a start cannot be withdrawn.
   *
   * It is what the agent's drill-in shows at its top (spec §7.6, "its prompt
   * at the top"). Ingestion keeps it on the `task.started` row as
   * `payload.prompt`, whole up to {@link TASK_PROMPT_MAX_CHARS} UTF-16 units
   * and marked `promptTruncated` past them; the wire slimmer caps it, like
   * every string, at 16 KiB of UTF-8 (§5.6, `truncated`) — fewer characters
   * than that whenever the text is not ASCII — and `GET …/items/:itemId`
   * then serves the stored value.
   */
  prompt?: string;
}

/**
 * How much of an agent's launch prompt ({@link TaskStartedPayload.prompt}) a
 * `task.started` row keeps AT REST: 32 000 UTF-16 code units — one per
 * character, two for a character outside the Basic Multilingual Plane (an
 * emoji) — cut on a code-point boundary and marked `promptTruncated: true`
 * when cut.
 *
 * The wire cuts on another scale. Every string of an activity payload is
 * capped at `SLIM_MAX_STRING_BYTES`, 16 KiB of UTF-8 (§5.6): about 16 000
 * ASCII characters but only about 5 400 CJK ones, so a prompt the row keeps
 * whole can still reach the client cut, stamped `truncated`. The item read,
 * `GET …/items/:itemId`, returns the STORED value: the whole prompt when it
 * fit this cap, else its head marked `promptTruncated`.
 *
 * The rest of a prompt cut here is on no read of the start row. It survives
 * only where the launching call's own rows keep the call's whole input:
 * ingestion stores a `tool.completed` row whole (only a `tool.updated` row is
 * slimmed at rest), and its item read serves it whole where the wire copy
 * drops the call's input. So once the call has completed, its
 * `tool.completed` row — the one whose `toolUseId` is the start's — holds the
 * prompt: Claude's `Agent` call as `data.input.prompt`, Grok's
 * `spawn_subagent` call as `data.rawInput.prompt`, OpenCode's `task` part as
 * `data.state.input.prompt`. A row an adapter or a host writes to close a
 * call nobody answered (a Stop's cut, a first load's closer) may not carry
 * it. Codex keeps it on no row: its collab call's row holds a 180-character
 * `detail` preview. The client reads none of these for a prompt: its prompt
 * row says only that the start was kept.
 *
 * Bounded because an agent's start row is never evicted from the fold (it
 * anchors the agent's row): a fleet's prompts stay in memory, in the fold
 * snapshot and in every snapshot read for as long as its thread lives.
 */
export const TASK_PROMPT_MAX_CHARS = 32_000;

export interface TaskProgressPayload extends TaskAgentLinkage {
  taskId: string;
  description: string;
  summary?: string;
  usage?: RuntimeTaskUsage;
  lastToolName?: string;
  /** Present on synthesized member/child progress rows that carry state. */
  status?: RuntimeTaskStatus;
  error?: string;
}

/**
 * Non-terminal status patch. `killed`→`cancelled` and `paused`→`idle` are
 * mapped at the adapter so the wire only carries the shared vocabulary (§4.2).
 */
export interface TaskUpdatedPayload extends TaskAgentLinkage {
  taskId: string;
  status?: RuntimeTaskStatus;
  description?: string;
  error?: string;
  endedAt?: string;
  isBackgrounded?: boolean;
}

export interface TaskCompletedPayload extends TaskAgentLinkage {
  taskId: string;
  status: RuntimeTaskCompletedStatus;
  summary?: string;
  usage?: RuntimeTaskUsage;
  /** A background shell's exit code, when the provider reports one. */
  exitCode?: number;
  /**
   * The adapter's own word that the task's PROCESS outlived this end — a
   * deploy, a restart, a crash ended its session without the user (Grok) —
   * with `summary` the note that says so and where to stop it. The one
   * summary a stopped shell's roster row shows; any other (the CLI's stop
   * sentence, its output's line) stays out of it.
   */
  leftRunning?: boolean;
}

export interface HookStartedPayload {
  hookId: string;
  hookName: string;
  hookEvent: string;
}

export interface HookProgressPayload {
  hookId: string;
  stdout?: string;
  stderr?: string;
}

export interface HookCompletedPayload {
  hookId: string;
  outcome: "success" | "error" | "cancelled";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface ToolProgressPayload {
  toolUseId: string;
  toolName?: string;
  summary?: string;
  elapsedSeconds?: number;
  /** Owning task/agent when the tool ran inside a subagent. */
  taskId?: string;
}

/** A policy/hook deny with no user approval behind it (§4.2). */
export interface ToolDeniedPayload {
  toolName: string;
  toolUseId?: string;
  reason?: string;
  agentId?: string;
}

export interface AuthStatusPayload {
  isAuthenticating?: boolean;
  output?: string[];
  error?: string;
}

export interface AccountRateLimitsUpdatedPayload {
  limits: ProviderUsageLimitsUpdate;
}

export interface ModelReroutedPayload {
  fromModel: string;
  toModel: string;
  reason: string;
}

/**
 * Why a turn could not go on, when the adapter KNOWS (workflows spec §5.4): `usage_limit` — the
 * account's quota is exhausted (Claude's parked `rate_limit_event`, Codex `usageLimitExceeded` /
 * `rateLimitExceeded` / `sessionBudgetExceeded`, Grok `stopReason: "rate_limit"`); `auth` — the
 * account's login was refused. Absent = not known to be either. The workflow engine's account
 * failover reads this instead of matching message text.
 */
export type RuntimeFailureReason = "usage_limit" | "auth";

export interface RuntimeWarningPayload {
  message: string;
  detail?: unknown;
  reason?: RuntimeFailureReason;
  /** ISO time the limit resets, when the provider says. */
  resetsAt?: string;
}

export interface RuntimeErrorPayload {
  message: string;
  class: RuntimeErrorClass;
  detail?: unknown;
  reason?: RuntimeFailureReason;
  /** ISO time the limit resets, when the provider says. */
  resetsAt?: string;
}

// ---------------------------------------------------------------------------
// The closed union (§4.2)
// ---------------------------------------------------------------------------

type Ev<TType extends string, TPayload> = RuntimeEventBase & {
  type: TType;
  payload: TPayload;
};

export type RuntimeSessionStartedEvent = Ev<"session.started", SessionStartedPayload>;
export type RuntimeSessionStateChangedEvent = Ev<
  "session.state.changed",
  SessionStateChangedPayload
>;
export type RuntimeSessionExitedEvent = Ev<"session.exited", SessionExitedPayload>;
export type RuntimeThreadStartedEvent = Ev<"thread.started", ThreadStartedPayload>;
export type RuntimeThreadStateChangedEvent = Ev<
  "thread.state.changed",
  ThreadStateChangedPayload
>;
export type RuntimeThreadMetadataUpdatedEvent = Ev<
  "thread.metadata.updated",
  ThreadMetadataUpdatedPayload
>;
export type RuntimeThreadTokenUsageUpdatedEvent = Ev<
  "thread.token-usage.updated",
  ThreadTokenUsageUpdatedPayload
>;
/**
 * The provider's goal moved (goals §4.2). The payload is the WHOLE current
 * goal, never a patch. Not transient — every update is written to
 * `raw.ndjson` — and ingestion coalesces nothing: an adapter throttles its own
 * `change: "progress"` updates (goals §6).
 */
export type RuntimeThreadGoalUpdatedEvent = Ev<"thread.goal.updated", GoalUpdatedPayload>;
export type RuntimeTurnStartedEvent = Ev<"turn.started", TurnStartedPayload>;
export type RuntimeTurnCompletedEvent = Ev<"turn.completed", TurnCompletedPayload>;
export type RuntimeTurnAbortedEvent = Ev<"turn.aborted", TurnAbortedPayload>;
export type RuntimeTurnPlanUpdatedEvent = Ev<"turn.plan.updated", TurnPlanUpdatedPayload>;
export type RuntimeTurnProposedDeltaEvent = Ev<"turn.proposed.delta", TurnProposedDeltaPayload>;
export type RuntimeTurnProposedCompletedEvent = Ev<
  "turn.proposed.completed",
  TurnProposedCompletedPayload
>;
export type RuntimeTurnDiffUpdatedEvent = Ev<"turn.diff.updated", TurnDiffUpdatedPayload>;
export type RuntimeItemStartedEvent = Ev<"item.started", ItemLifecyclePayload>;
export type RuntimeItemUpdatedEvent = Ev<"item.updated", ItemLifecyclePayload>;
export type RuntimeItemCompletedEvent = Ev<"item.completed", ItemLifecyclePayload>;
export type RuntimeContentDeltaEvent = Ev<"content.delta", ContentDeltaPayload>;
export type RuntimeRequestOpenedEvent = Ev<"request.opened", RequestOpenedPayload>;
export type RuntimeRequestResolvedEvent = Ev<"request.resolved", RequestResolvedPayload>;
export type RuntimeUserInputRequestedEvent = Ev<
  "user-input.requested",
  UserInputRequestedPayload
>;
export type RuntimeUserInputResolvedEvent = Ev<"user-input.resolved", UserInputResolvedPayload>;
export type RuntimeTaskStartedEvent = Ev<"task.started", TaskStartedPayload>;
export type RuntimeTaskProgressEvent = Ev<"task.progress", TaskProgressPayload>;
export type RuntimeTaskUpdatedEvent = Ev<"task.updated", TaskUpdatedPayload>;
export type RuntimeTaskCompletedEvent = Ev<"task.completed", TaskCompletedPayload>;
export type RuntimeHookStartedEvent = Ev<"hook.started", HookStartedPayload>;
export type RuntimeHookProgressEvent = Ev<"hook.progress", HookProgressPayload>;
export type RuntimeHookCompletedEvent = Ev<"hook.completed", HookCompletedPayload>;
export type RuntimeToolProgressEvent = Ev<"tool.progress", ToolProgressPayload>;
export type RuntimeToolDeniedEvent = Ev<"tool.denied", ToolDeniedPayload>;
export type RuntimeAuthStatusEvent = Ev<"auth.status", AuthStatusPayload>;
export type RuntimeAccountRateLimitsUpdatedEvent = Ev<
  "account.rate-limits.updated",
  AccountRateLimitsUpdatedPayload
>;
export type RuntimeModelReroutedEvent = Ev<"model.rerouted", ModelReroutedPayload>;
export type RuntimeWarningEvent = Ev<"runtime.warning", RuntimeWarningPayload>;
export type RuntimeErrorEvent = Ev<"runtime.error", RuntimeErrorPayload>;

/**
 * The closed union at the adapter boundary (§4.2). An unmapped provider
 * message is a typecheck error (`satisfies never` in each adapter's switch)
 * and emits `runtime.warning` at runtime — never a silent drop (§10).
 *
 * Deliberately excluded from T3's own union: `thread.realtime.*`,
 * `session.configured`, `mcp.status.updated`, `tool.summary`,
 * `config.warning`, `deprecation.notice`, `account.updated`,
 * `mcp.oauth.completed`, `files.persisted`.
 */
export type RuntimeEvent =
  | RuntimeSessionStartedEvent
  | RuntimeSessionStateChangedEvent
  | RuntimeSessionExitedEvent
  | RuntimeThreadStartedEvent
  | RuntimeThreadStateChangedEvent
  | RuntimeThreadMetadataUpdatedEvent
  | RuntimeThreadTokenUsageUpdatedEvent
  | RuntimeThreadGoalUpdatedEvent
  | RuntimeTurnStartedEvent
  | RuntimeTurnCompletedEvent
  | RuntimeTurnAbortedEvent
  | RuntimeTurnPlanUpdatedEvent
  | RuntimeTurnProposedDeltaEvent
  | RuntimeTurnProposedCompletedEvent
  | RuntimeTurnDiffUpdatedEvent
  | RuntimeItemStartedEvent
  | RuntimeItemUpdatedEvent
  | RuntimeItemCompletedEvent
  | RuntimeContentDeltaEvent
  | RuntimeRequestOpenedEvent
  | RuntimeRequestResolvedEvent
  | RuntimeUserInputRequestedEvent
  | RuntimeUserInputResolvedEvent
  | RuntimeTaskStartedEvent
  | RuntimeTaskProgressEvent
  | RuntimeTaskUpdatedEvent
  | RuntimeTaskCompletedEvent
  | RuntimeHookStartedEvent
  | RuntimeHookProgressEvent
  | RuntimeHookCompletedEvent
  | RuntimeToolProgressEvent
  | RuntimeToolDeniedEvent
  | RuntimeAuthStatusEvent
  | RuntimeAccountRateLimitsUpdatedEvent
  | RuntimeModelReroutedEvent
  | RuntimeWarningEvent
  | RuntimeErrorEvent;

/** Every `RuntimeEvent["type"]` literal. */
export type RuntimeEventType = RuntimeEvent["type"];

/**
 * High-rate delta frames dropped from `raw.ndjson` rather than written: the
 * decoded frame that follows carries the same information without a second
 * copy of every token (§3.1 Observability).
 */
export const TRANSIENT_RUNTIME_EVENT_TYPES: ReadonlySet<RuntimeEventType> = new Set<
  RuntimeEventType
>([
  "content.delta",
  "item.updated",
  "tool.progress",
  "task.progress",
  "turn.proposed.delta"
]);
