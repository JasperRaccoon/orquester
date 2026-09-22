/**
 * Claude adapter — the SDK message demux (spec §4.2, §4.5 Claude).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`handleSdkMessage`,
 * `handleStreamEvent`, `handleUserMessage`, `handleAssistantMessage`,
 * `handleResultMessage`, `handleSystemMessage`, `handleSdkTelemetryMessage`,
 * `completeTurn`), translated from Effect into a plain synchronous class.
 *
 * This module is the whole replay surface: every committed fixture is fed
 * through {@link ClaudeNormalizer.handleMessage} in `normalize.test.ts` and
 * the emitted `RuntimeEvent` sequence is asserted. Nothing here touches a
 * process, a socket or the clock beyond the injected {@link Clock}.
 *
 * **An unmapped provider message is surfaced, never dropped by a catch-all**
 * (§10): the top-level switch and the `system` subtype switch each end in
 * `satisfies never`, so a new SDK release fails the typecheck, and the runtime
 * fallback emits `runtime.warning` — which never ends an active turn.
 */

import type {
  ApprovalDecision,
  ApprovalOption,
  CanonicalItemType,
  CanonicalRequestType,
  ProviderUsageLimitsUpdate,
  RuntimeContentStreamKind,
  RuntimeErrorClass,
  RuntimeEvent,
  RuntimeEventRaw,
  RuntimeEventRawSource,
  RuntimeItemStatus,
  RuntimeSessionState,
  RuntimeTaskStatus,
  RuntimeTurnState,
  TaskAgentLinkage,
  UserInputQuestion
} from "@orquester/api/agent-chat";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Clock, IdGen } from "../../adapter.ts";
import {
  classifyToolItemType,
  cliDenialReason,
  extractTextContent,
  isCliDenialResult,
  isStepListTool,
  isTodoTool,
  nonNegativeInt,
  safeJson,
  summarizeToolRequest,
  titleForTool,
  toolInputFingerprint,
  toolResultStreamKind,
  trimmedString,
  tryParseJsonRecord
} from "./classify.ts";
import {
  claudeTotalProcessedTokens,
  compactBoundarySnapshot,
  describeUsageLimit,
  isRateLimitBlocking,
  isRateLimitClearing,
  maxContextWindowFromModelUsage,
  normalizeActiveTokenUsage,
  normalizeTaskUsage,
  normalizeTurnTokenUsage,
  rateLimitEventToUpdate,
  toThreadTokenUsage,
  type ClaudeScopedLimitNames,
  type ClaudeTokenUsageSnapshot
} from "./usage.ts";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface AssistantTextBlockState {
  itemId: string;
  blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

/** Cap on buffered nested frames awaiting an owner (see `pendingNested`). */
const MAX_PENDING_NESTED_FRAMES = 600;

interface ToolInFlight {
  itemId: string;
  itemType: CanonicalItemType;
  toolName: string;
  title: string;
  detail?: string;
  input: Record<string, unknown>;
  partialInputJson: string;
  lastEmittedInputFingerprint?: string;
  agentId?: string;
  parentToolUseId?: string;
}

interface TaskAgentState {
  taskId: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
  workflowName?: string;
  owningAgentId?: string;
  model?: string;
  effort?: string;
  outputFile?: string;
}

/** The `TaskCreate`/`TaskUpdate` step list — NOT `TodoWrite` on this CLI. */
interface StepListEntry {
  id: string;
  subject: string;
  status: "pending" | "inProgress" | "completed";
  blockedBy: Set<string>;
}

export interface ClaudeTurnState {
  turnId: string;
  startedAt: string;
  /**
   * True for turns auto-started by assistant output arriving without an active
   * turn (background agent output between user prompts). Synthetic turns are
   * auto-closed by the next `sendTurn`; real turns are steered instead.
   */
  synthetic: boolean;
  items: unknown[];
  /**
   * Keyed by {@link textBlockKey}: the API message the block belongs to PLUS
   * its content index. A Claude "turn" spans one API message per tool
   * round-trip and every message restarts its indexes at 0, so an index-only
   * key handed a later message's text block the FIRST message's item — the
   * fold appends streamed text by item id, and a long turn's final summary
   * ended up inside its opening bubble, far above where the user was looking
   * (live thread 8b9a20c2, seq 710/862/873/882 share one item id).
   */
  assistantTextBlocks: Map<string, AssistantTextBlockState>;
  /**
   * The content blocks each API message streamed, in stream order, keyed by
   * the `message_start` id. The CLI then emits one complete `assistant`
   * frame PER BLOCK, each carrying `content: [thatBlock]` — so a block's
   * position in its frame is always 0, never its stream index. The k-th
   * per-block frame for a message is its k-th streamed block; this is the
   * join (`backfillAssistantTextFromSnapshot`).
   */
  streamedBlocks: Map<string, Array<{ index: number; type: string }>>;
  /** Id of the message currently streaming (`message_start`), for `streamedBlocks`. */
  currentStreamMessageId: string | null;
  /** How many per-block frames of each message have been matched so far. */
  snapshotBlockCursor: Map<string, number>;
  assistantTextBlockOrder: AssistantTextBlockState[];
  capturedProposedPlanKeys: Set<string>;
  latestAssistantUsage: unknown;
  compactedSinceLatestAssistantUsage: boolean;
  hasSubagents: boolean;
  nextSyntheticAssistantBlockIndex: number;
  authenticationFailureMessage?: string;
  rejectedRateLimitTypes: Set<string>;
  latestAssistantRateLimited: boolean;
  announcedUsageLimitKeys: Set<string>;
}

export interface NormalizerOptions {
  threadId: string;
  clock: Clock;
  ids: IdGen;
  /** Called with every raw SDK frame, for `raw.ndjson` (§3.1). */
  onRawFrame?: (frame: unknown) => void;
  /**
   * Called when a `rate_limit_event` arrives without a percentage, which on
   * this CLI is every one of them: the snapshot's cached windows are stale and
   * only a fresh `get_usage` can refresh them (§4.1).
   */
  onUsageLimitsStale?: () => void;
  /** Called whenever the set of live task ids changes (§3.1 background liveness). */
  onLiveTasksChanged?: (liveTaskIds: ReadonlySet<string>) => void;
}

const MAX_PENDING_TASK_MODELS = 64;

const CLAUDE_TASK_PATCH_STATUS: Record<string, RuntimeTaskStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  killed: "cancelled",
  paused: "idle"
};

const RAW_SDK_MESSAGE: RuntimeEventRawSource = "claude.sdk.message";
const RAW_SDK_PERMISSION: RuntimeEventRawSource = "claude.sdk.permission";

/**
 * Wire-only frames that are real but absent from the SDK's exported union, so
 * they cannot be switch cases. `command_lifecycle` alone is two or three
 * frames per turn (fixtures README observation 6); without this they would
 * each become a spurious `runtime.warning`.
 */
const UNDECLARED_TOP_LEVEL_TYPES = new Set(["command_lifecycle", "keep_alive"]);
const UNDECLARED_SYSTEM_SUBTYPES = new Set(["vcs_state_changed", "code_change_published"]);

// ---------------------------------------------------------------------------
// The normaliser
// ---------------------------------------------------------------------------

export class ClaudeNormalizer {
  readonly threadId: string;

  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly options: NormalizerOptions;

  /** The CLI's own session id, once any message has carried one. */
  providerSessionId: string | undefined;
  /** The uuid of the most recent parent assistant message — the resume anchor. */
  lastAssistantUuid: string | undefined;

  turnState: ClaudeTurnState | undefined;

  private threadStartedEmitted = false;
  private lastSessionState: RuntimeSessionState | undefined;
  private lastSessionStateReason: string | undefined;

  private readonly inFlightTools = new Map<number, ToolInFlight>();
  private readonly taskAgents = new Map<string, TaskAgentState>();
  private readonly liveTaskIds = new Set<string>();
  private readonly pendingTaskModels = new Map<string, string>();
  private readonly stepList = new Map<string, StepListEntry>();

  lastKnownContextWindow: number | undefined;
  lastKnownTotalProcessedTokens: number | undefined;
  lastKnownTokenUsage: ClaudeTokenUsageSnapshot | undefined;

  /** The model this adapter last asked for; a diff against `init` is a reroute. */
  expectedModel: string | undefined;
  /**
   * The uuids the last compaction preserved, from
   * `compact_metadata.preserved_messages.all_uuids`. `undefined` means no
   * compaction has been observed on this session, which is NOT the same as
   * "nothing survived" — a rollback treats it as "no constraint".
   */
  preservedMessageUuids: string[] | undefined;
  /** Scoped usage-window names the last probe saw (§4.1 stable window ids). */
  scopedLimitNames: ClaudeScopedLimitNames = {};

  private lastInitModel: string | undefined;
  private initSeen = false;
  /** Completed turns, for `readThread`'s opaque `ThreadSnapshot` (§4.1). */
  readonly turns: Array<{ id: string; items: unknown[] }> = [];
  /** One native message uuid per turn start, in order — the rollback anchors. */
  readonly turnStartMessageIds: Array<string | null> = [];

  constructor(options: NormalizerOptions) {
    this.threadId = options.threadId;
    this.clock = options.clock;
    this.ids = options.ids;
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Event construction
  // -------------------------------------------------------------------------

  private base(extra?: {
    turnId?: string;
    itemId?: string;
    requestId?: string;
    agentId?: string;
    providerItemId?: string;
    providerRequestId?: string;
    raw?: RuntimeEventRaw;
  }): {
    eventId: string;
    threadId: string;
    createdAt: string;
    turnId?: string;
    itemId?: string;
    requestId?: string;
    agentId?: string;
    providerRefs?: {
      providerTurnId?: string;
      providerItemId?: string;
      providerRequestId?: string;
    };
    raw?: RuntimeEventRaw;
  } {
    const providerRefs = {
      ...(this.providerSessionId !== undefined ? { providerTurnId: this.providerSessionId } : {}),
      ...(extra?.providerItemId !== undefined ? { providerItemId: extra.providerItemId } : {}),
      ...(extra?.providerRequestId !== undefined
        ? { providerRequestId: extra.providerRequestId }
        : {})
    };
    return {
      eventId: this.ids.eventId(),
      threadId: this.threadId,
      createdAt: this.clock.nowIso(),
      ...(extra?.turnId !== undefined ? { turnId: extra.turnId } : {}),
      ...(extra?.itemId !== undefined ? { itemId: extra.itemId } : {}),
      ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
      ...(extra?.agentId !== undefined ? { agentId: extra.agentId } : {}),
      ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
      ...(extra?.raw !== undefined ? { raw: extra.raw } : {})
    };
  }

  private get activeTurnId(): string | undefined {
    return this.turnState?.turnId;
  }

  // -------------------------------------------------------------------------
  // Session / thread lifecycle events (called by the session, not the stream)
  // -------------------------------------------------------------------------

  sessionStarted(resume: unknown, message?: string): RuntimeEvent {
    return {
      ...this.base(),
      type: "session.started",
      payload: {
        ...(message !== undefined ? { message } : {}),
        ...(resume !== undefined ? { resume } : {})
      }
    };
  }

  /**
   * Deduped on the **state**, not on the reason. `system/status` alone is ~3
   * frames per turn and `api_retry` one per attempt (fixtures README
   * observation 6); keying the dedupe on the reason too would put every one of
   * them on the bus as a "change" that changes nothing.
   */
  sessionStateChanged(
    state: RuntimeSessionState,
    reason?: string,
    detail?: unknown
  ): RuntimeEvent[] {
    if (this.lastSessionState === state) {
      return [];
    }
    this.lastSessionState = state;
    this.lastSessionStateReason = reason;
    return [
      {
        ...this.base({ turnId: this.activeTurnId }),
        type: "session.state.changed",
        payload: {
          state,
          ...(reason !== undefined ? { reason } : {}),
          ...(detail !== undefined ? { detail } : {})
        }
      }
    ];
  }

  sessionExited(input: {
    reason?: string;
    recoverable: boolean;
    exitKind: "graceful" | "error";
  }): RuntimeEvent {
    return {
      ...this.base(),
      type: "session.exited",
      payload: {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        recoverable: input.recoverable,
        exitKind: input.exitKind
      }
    };
  }

  warning(message: string, detail?: unknown): RuntimeEvent {
    return {
      ...this.base({ turnId: this.activeTurnId }),
      type: "runtime.warning",
      payload: { message, ...(detail !== undefined ? { detail } : {}) }
    };
  }

  error(message: string, errorClass: RuntimeErrorClass, detail?: unknown): RuntimeEvent {
    return {
      ...this.base({ turnId: this.activeTurnId }),
      type: "runtime.error",
      payload: { message, class: errorClass, ...(detail !== undefined ? { detail } : {}) }
    };
  }

  requestOpened(input: {
    requestId: string;
    requestType: CanonicalRequestType;
    detail?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId?: string;
    options?: ApprovalOption[];
    appName?: string;
  }): RuntimeEvent {
    return {
      ...this.base({
        turnId: this.activeTurnId,
        requestId: input.requestId,
        ...(input.toolUseId !== undefined ? { providerItemId: input.toolUseId } : {}),
        providerRequestId: input.requestId,
        raw: {
          source: RAW_SDK_PERMISSION,
          method: "canUseTool/request",
          payload: { toolName: input.toolName, input: input.toolInput }
        }
      }),
      type: "request.opened",
      payload: {
        requestType: input.requestType,
        // Every native-callback approval blocks the provider until it is
        // answered or cancelled, so none of them is dismissible (§4.2).
        dismissible: false,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.appName !== undefined ? { appName: input.appName } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
        args: {
          toolName: input.toolName,
          input: input.toolInput,
          ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {})
        }
      }
    };
  }

  requestResolved(input: {
    requestId: string;
    requestType: CanonicalRequestType;
    decision: ApprovalDecision;
    toolUseId?: string;
  }): RuntimeEvent {
    return {
      ...this.base({
        turnId: this.activeTurnId,
        requestId: input.requestId,
        ...(input.toolUseId !== undefined ? { providerItemId: input.toolUseId } : {}),
        providerRequestId: input.requestId,
        raw: {
          source: RAW_SDK_PERMISSION,
          method: "canUseTool/decision",
          payload: { decision: input.decision }
        }
      }),
      type: "request.resolved",
      payload: { requestType: input.requestType, decision: input.decision }
    };
  }

  userInputRequested(input: {
    requestId: string;
    questions: UserInputQuestion[];
    toolInput: Record<string, unknown>;
    toolUseId?: string;
  }): RuntimeEvent {
    return {
      ...this.base({
        turnId: this.activeTurnId,
        requestId: input.requestId,
        ...(input.toolUseId !== undefined ? { providerItemId: input.toolUseId } : {}),
        providerRequestId: input.requestId,
        raw: {
          source: RAW_SDK_PERMISSION,
          method: "canUseTool/AskUserQuestion",
          payload: { toolName: "AskUserQuestion", input: input.toolInput }
        }
      }),
      type: "user-input.requested",
      payload: {
        questions: input.questions,
        // The provider's own callback is blocked on the answer, so this is not
        // a message-mode question and `/dismiss` does not apply (§4.2).
        dismissible: false
      }
    };
  }

  userInputResolved(input: {
    requestId: string;
    answers: Record<string, unknown>;
    toolUseId?: string;
  }): RuntimeEvent {
    return {
      ...this.base({
        turnId: this.activeTurnId,
        requestId: input.requestId,
        ...(input.toolUseId !== undefined ? { providerItemId: input.toolUseId } : {}),
        providerRequestId: input.requestId,
        raw: {
          source: RAW_SDK_PERMISSION,
          method: "canUseTool/AskUserQuestion/resolved",
          payload: { answers: input.answers }
        }
      }),
      type: "user-input.resolved",
      payload: { answers: input.answers }
    };
  }

  /**
   * `ExitPlanMode` — the plan is a client-owned card, never the SDK's gate
   * (§4.5). Deduped per turn on the plan body plus the tool-use id, because
   * the same plan arrives twice: once on the assistant snapshot and once
   * through `canUseTool`.
   */
  proposedPlanCompleted(input: {
    planMarkdown: string;
    toolUseId?: string;
    planFilePath?: string;
    source: RuntimeEventRawSource;
    method: string;
    payload: unknown;
  }): RuntimeEvent[] {
    const turn = this.turnState;
    const key = `${input.toolUseId ?? ""}:${input.planMarkdown}`;
    if (turn) {
      if (turn.capturedProposedPlanKeys.has(key)) {
        return [];
      }
      turn.capturedProposedPlanKeys.add(key);
    }
    return [
      {
        ...this.base({
          turnId: this.activeTurnId,
          ...(input.toolUseId !== undefined ? { providerItemId: input.toolUseId } : {}),
          raw: { source: input.source, method: input.method, payload: input.payload }
        }),
        type: "turn.proposed.completed",
        payload: {
          // The markdown is user-facing content — the plan card offers copy
          // and download — so it is never edited. `planFilePath` rides in its
          // own field (fixtures README observation 10).
          planMarkdown: input.planMarkdown,
          ...(input.planFilePath !== undefined ? { planFilePath: input.planFilePath } : {})
        }
      }
    ];
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  beginTurn(input: {
    turnId: string;
    model?: string;
    effort?: string;
    synthetic?: boolean;
    anchorUuid?: string;
  }): RuntimeEvent[] {
    const turn: ClaudeTurnState = {
      turnId: input.turnId,
      startedAt: this.clock.nowIso(),
      synthetic: input.synthetic === true,
      items: [],
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      streamedBlocks: new Map(),
      currentStreamMessageId: null,
      snapshotBlockCursor: new Map(),
      capturedProposedPlanKeys: new Set(),
      latestAssistantUsage: undefined,
      compactedSinceLatestAssistantUsage: false,
      hasSubagents: false,
      nextSyntheticAssistantBlockIndex: -1,
      rejectedRateLimitTypes: new Set(),
      latestAssistantRateLimited: false,
      announcedUsageLimitKeys: new Set()
    };
    this.turnState = turn;
    this.turnStartMessageIds.push(input.anchorUuid ?? input.turnId);
    const events: RuntimeEvent[] = [
      {
        ...this.base({ turnId: input.turnId }),
        type: "turn.started",
        payload: {
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {})
        }
      }
    ];
    events.push(...this.sessionStateChanged("running", "turn:started"));
    return events;
  }

  /**
   * Settle the in-flight turn. Every open tool item and assistant text block
   * is closed first, so a running state never outlives its turn (§4.1).
   */
  completeTurn(
    status: RuntimeTurnState,
    errorMessage?: string,
    result?: SDKResultMessage
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];

    const resultContextWindow = maxContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      this.lastKnownContextWindow = resultContextWindow;
    }
    const accumulatedTotal = claudeTotalProcessedTokens(result?.usage);
    if (accumulatedTotal !== undefined) {
      this.lastKnownTotalProcessedTokens = accumulatedTotal;
    }
    const usageSnapshot = this.turnUsageSnapshot(result);

    const turn = this.turnState;
    if (!turn) {
      // A result with no local turn is never a turn this adapter started: what
      // lands here is the resume handshake (`system/init` + `result` with
      // `num_turns: 0`), a late result for a turn already closed locally, or a
      // stream failure with no turn in flight. Keep the usage emission, drop
      // the lifecycle event — an untargeted `turn.completed` carries no turnId
      // and the projection would flip a turn that never existed (§4.5).
      events.push(...this.emitThreadTokenUsage(usageSnapshot, "claude/result", result ?? { status }));
      return events;
    }

    for (const [index, tool] of [...this.inFlightTools.entries()]) {
      events.push({
        ...this.base({
          turnId: turn.turnId,
          itemId: tool.itemId,
          providerItemId: tool.itemId,
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          raw: { source: RAW_SDK_MESSAGE, method: "claude/result", payload: result ?? { status } }
        }),
        type: "item.completed",
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId !== undefined
            ? { parentToolUseId: tool.parentToolUseId }
            : {}),
          data: { toolName: tool.toolName, input: tool.input }
        }
      });
      this.inFlightTools.delete(index);
    }
    this.inFlightTools.clear();

    for (const block of turn.assistantTextBlockOrder) {
      events.push(
        ...this.completeAssistantTextBlock(block, {
          force: true,
          method: "claude/result",
          payload: result ?? { status }
        })
      );
    }

    this.turns.push({ id: turn.turnId, items: [...turn.items] });

    events.push(...this.emitThreadTokenUsage(usageSnapshot, "claude/result", result ?? { status }));

    events.push({
      ...this.base({ turnId: turn.turnId }),
      type: "turn.completed",
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        tokenUsage: normalizeTurnTokenUsage({
          usage: result?.usage,
          resultSubtype: result?.subtype,
          hasSubagents: turn.hasSubagents,
          terminalStatus: status
        })
      }
    });

    this.turnState = undefined;
    events.push(...this.sessionStateChanged("ready", "turn:settled"));
    return events;
  }

  /** Every live task closed `stopped`, for a session that is going away (§3.1). */
  closeLiveTasks(): RuntimeEvent[] {
    // Frames of a subagent that was never named have nowhere to go once the
    // turn is over; they must not outlive it.
    this.dropPendingNested();
    const events: RuntimeEvent[] = [];
    for (const taskId of [...this.liveTaskIds]) {
      this.liveTaskIds.delete(taskId);
      events.push({
        ...this.base({ turnId: this.activeTurnId }),
        type: "task.completed",
        payload: { taskId, status: "stopped", ...this.taskLinkageFor(taskId) }
      });
    }
    if (events.length > 0) {
      this.options.onLiveTasksChanged?.(this.liveTaskIds);
    }
    return events;
  }

  liveTasks(): ReadonlySet<string> {
    return this.liveTaskIds;
  }

  // -------------------------------------------------------------------------
  // The demux
  // -------------------------------------------------------------------------

  handleMessage(message: SDKMessage): RuntimeEvent[] {
    this.options.onRawFrame?.(message);

    const events: RuntimeEvent[] = [];
    events.push(...this.ensureThreadId(message));

    const rawType = (message as { type?: unknown }).type;
    if (typeof rawType === "string" && UNDECLARED_TOP_LEVEL_TYPES.has(rawType)) {
      // Wire-only bookkeeping with no user-facing lifecycle.
      return events;
    }

    switch (message.type) {
      case "stream_event":
        events.push(...this.handleStreamEvent(message));
        return events;
      case "user":
        events.push(...this.handleUserMessage(message));
        return events;
      case "assistant":
        events.push(...this.handleAssistantMessage(message));
        return events;
      case "result":
        events.push(...this.handleResultMessage(message));
        return events;
      case "system":
        events.push(...this.handleSystemMessage(message));
        return events;
      case "tool_progress":
        events.push({
          ...this.base({
            turnId: this.activeTurnId,
            providerItemId: message.tool_use_id,
            ...(message.task_id !== undefined
              ? { agentId: message.task_id }
              : {}),
            raw: {
              source: RAW_SDK_MESSAGE,
              method: "claude/tool_progress",
              messageType: message.type,
              payload: message
            }
          }),
          type: "tool.progress",
          payload: {
            toolUseId: message.tool_use_id,
            toolName: message.tool_name,
            elapsedSeconds: message.elapsed_time_seconds,
            ...(message.task_id !== undefined ? { taskId: message.task_id } : {})
          }
        });
        return events;
      case "auth_status":
        events.push({
          ...this.base({
            turnId: this.activeTurnId,
            raw: {
              source: RAW_SDK_MESSAGE,
              method: "claude/auth_status",
              messageType: message.type,
              payload: message
            }
          }),
          type: "auth.status",
          payload: {
            isAuthenticating: message.isAuthenticating,
            output: message.output,
            ...(message.error !== undefined ? { error: message.error } : {})
          }
        });
        return events;
      case "rate_limit_event":
        events.push(...this.handleRateLimitEvent(message));
        return events;
      // Deliberately consumed: `tool.summary`, `prompt_suggestion` and a
      // CLI-side conversation-id swap have no surface in the §4.2 union, and
      // this adapter keeps its own thread identity and resume cursor.
      case "tool_use_summary":
      case "prompt_suggestion":
      case "conversation_reset":
        return events;
      default: {
        // Exhaustiveness guard: a new SDK top-level message type fails the
        // typecheck here instead of warning only at runtime (§10).
        message satisfies never;
        const unknown = message as { type?: unknown };
        events.push(
          this.warning(
            describeUnknownSdkMessage(`Claude SDK message '${String(unknown.type)}'`, message),
            message
          )
        );
        return events;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Thread identity
  // -------------------------------------------------------------------------

  private ensureThreadId(message: SDKMessage): RuntimeEvent[] {
    const sessionId = (message as { session_id?: unknown }).session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return [];
    }
    // `system` messages with a `hook_*` subtype carry no durable session id
    // and must not move the resume cursor (§4.5 "Traps").
    const subtype = (message as { subtype?: unknown }).subtype;
    if (typeof subtype === "string" && subtype.startsWith("hook_")) {
      return [];
    }
    if (this.providerSessionId === sessionId && this.threadStartedEmitted) {
      return [];
    }
    this.providerSessionId = sessionId;
    if (this.threadStartedEmitted) {
      return [];
    }
    this.threadStartedEmitted = true;
    return [
      {
        ...this.base(),
        type: "thread.started",
        payload: { providerThreadId: sessionId }
      }
    ];
  }

  // -------------------------------------------------------------------------
  // stream_event
  // -------------------------------------------------------------------------

  private handleStreamEvent(
    message: Extract<SDKMessage, { type: "stream_event" }>
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const event = message.event;
    const parentToolUseId = message.parent_tool_use_id ?? undefined;

    // Subagent-owned narration must not write into the parent transcript: the
    // SDK forwards a subagent's tool_use/tool_result blocks and the wrapping
    // text/thinking deltas, and emitting them interleaves N subagents'
    // narration into the chat. Their results reach the UI through `task.*`;
    // their tool blocks are kept and attributed (§4.5).
    if (parentToolUseId !== undefined) {
      const dropStart =
        event.type === "content_block_start" &&
        event.content_block.type !== "tool_use" &&
        event.content_block.type !== "server_tool_use" &&
        event.content_block.type !== "mcp_tool_use";
      const dropDelta =
        event.type === "content_block_delta" &&
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta");
      if (dropStart || dropDelta) {
        return events;
      }
    }

    if (event.type === "message_start") {
      // The join key for the per-block `assistant` frames that follow.
      const started = (event as { message?: { id?: unknown } }).message;
      const turn = this.turnState;
      if (parentToolUseId === undefined && turn && typeof started?.id === "string") {
        turn.currentStreamMessageId = started.id;
        if (!turn.streamedBlocks.has(started.id)) {
          turn.streamedBlocks.set(started.id, []);
        }
      }
      return events;
    }

    if (event.type === "message_delta") {
      if (parentToolUseId !== undefined) {
        return events;
      }
      const snapshot = normalizeActiveTokenUsage(
        (event as { usage?: unknown }).usage,
        this.lastKnownContextWindow,
        this.lastKnownTotalProcessedTokens
      );
      events.push(
        ...this.emitThreadTokenUsage(snapshot, "claude/stream_event/message_delta", message)
      );
      return events;
    }

    if (event.type === "content_block_delta") {
      return this.handleContentBlockDelta(message, event);
    }

    if (event.type === "content_block_start") {
      return this.handleContentBlockStart(message, event);
    }

    if (event.type === "content_block_stop") {
      const turn = this.turnState;
      const block = turn?.assistantTextBlocks.get(
        textBlockKey(turn.currentStreamMessageId, event.index)
      );
      if (block) {
        block.streamClosed = true;
        return this.completeAssistantTextBlock(block, {
          method: "claude/stream_event/content_block_stop",
          payload: message
        });
      }
      return events;
    }

    return events;
  }

  private handleContentBlockDelta(
    message: Extract<SDKMessage, { type: "stream_event" }>,
    event: Extract<
      Extract<SDKMessage, { type: "stream_event" }>["event"],
      { type: "content_block_delta" }
    >
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const delta = event.delta;

    if ((delta.type === "text_delta" || delta.type === "thinking_delta") && this.turnState) {
      const text =
        delta.type === "text_delta"
          ? delta.text
          : typeof (delta as { thinking?: unknown }).thinking === "string"
            ? ((delta as { thinking: string }).thinking)
            : "";
      if (text.length === 0) {
        return events;
      }
      const streamKind: RuntimeContentStreamKind =
        delta.type === "thinking_delta" ? "reasoning_summary_text" : "assistant_text";
      if (streamKind === "reasoning_summary_text") {
        events.push({
          ...this.base({
            turnId: this.turnState.turnId,
            raw: {
              source: RAW_SDK_MESSAGE,
              method: "claude/stream_event/content_block_delta",
              payload: message
            }
          }),
          type: "content.delta",
          payload: { streamKind, delta: text, contentIndex: event.index }
        });
        return events;
      }
      const block = this.ensureAssistantTextBlock(
        this.turnState.currentStreamMessageId,
        event.index
      );
      if (block) {
        block.state.emittedTextDelta = true;
        events.push(...block.events);
      }
      events.push({
        ...this.base({
          turnId: this.turnState.turnId,
          ...(block ? { itemId: block.state.itemId } : {}),
          raw: {
            source: RAW_SDK_MESSAGE,
            method: "claude/stream_event/content_block_delta",
            payload: message
          }
        }),
        type: "content.delta",
        payload: { streamKind, delta: text, contentIndex: event.index }
      });
      return events;
    }

    // `signature_delta` is the thinking block's cryptographic signature: it is
    // neither reasoning text nor a summary, so it is dropped explicitly rather
    // than falling into `unknown` (fixtures README observation 17).
    if (delta.type === "signature_delta") {
      return events;
    }

    if (delta.type === "input_json_delta") {
      const tool = this.inFlightTools.get(event.index);
      if (!tool || typeof delta.partial_json !== "string") {
        return events;
      }
      const partialInputJson = tool.partialInputJson + delta.partial_json;
      const parsed = tryParseJsonRecord(partialInputJson);
      const itemType = parsed ? classifyToolItemType(tool.toolName, parsed) : tool.itemType;
      const detail = parsed ? summarizeToolRequest(tool.toolName, parsed) : tool.detail;
      const next: ToolInFlight = {
        ...tool,
        itemType,
        title: titleForTool(itemType),
        partialInputJson,
        ...(parsed ? { input: parsed } : {}),
        ...(detail !== undefined ? { detail } : {})
      };
      this.inFlightTools.set(event.index, next);

      const fingerprint =
        parsed && Object.keys(parsed).length > 0 ? toolInputFingerprint(parsed) : undefined;
      if (!parsed || fingerprint === undefined || tool.lastEmittedInputFingerprint === fingerprint) {
        return events;
      }
      next.lastEmittedInputFingerprint = fingerprint;
      this.inFlightTools.set(event.index, next);

      events.push({
        ...this.base({
          turnId: this.activeTurnId,
          itemId: next.itemId,
          providerItemId: next.itemId,
          ...(next.agentId !== undefined ? { agentId: next.agentId } : {}),
          raw: {
            source: RAW_SDK_MESSAGE,
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message
          }
        }),
        type: "item.updated",
        payload: {
          itemType: next.itemType,
          status: "inProgress",
          title: next.title,
          ...(next.detail !== undefined ? { detail: next.detail } : {}),
          ...(next.agentId !== undefined ? { agentId: next.agentId } : {}),
          ...(next.parentToolUseId !== undefined
            ? { parentToolUseId: next.parentToolUseId }
            : {}),
          data: { toolName: next.toolName, input: next.input }
        }
      });

      // The legacy `TodoWrite` shape, kept so an older CLI still produces a
      // plan. This CLI uses `TaskCreate`/`TaskUpdate`, folded from their tool
      // RESULTS instead (fixtures README observation 3).
      if (isTodoTool(next.toolName)) {
        const plan = extractPlanStepsFromTodoInput(next.input);
        if (plan && plan.length > 0) {
          events.push({
            ...this.base({ turnId: this.activeTurnId }),
            type: "turn.plan.updated",
            payload: { plan }
          });
        }
      }
      return events;
    }

    return events;
  }

  private handleContentBlockStart(
    message: Extract<SDKMessage, { type: "stream_event" }>,
    event: Extract<
      Extract<SDKMessage, { type: "stream_event" }>["event"],
      { type: "content_block_start" }
    >
  ): RuntimeEvent[] {
    const block = event.content_block;
    if (message.parent_tool_use_id == null && this.turnState?.currentStreamMessageId) {
      const turn = this.turnState;
      const list = turn.streamedBlocks.get(turn.currentStreamMessageId!) ?? [];
      list.push({ index: event.index, type: typeof block.type === "string" ? block.type : "unknown" });
      turn.streamedBlocks.set(turn.currentStreamMessageId!, list);
    }
    if (block.type === "text") {
      const entry = this.ensureAssistantTextBlock(
        message.parent_tool_use_id == null ? (this.turnState?.currentStreamMessageId ?? null) : null,
        event.index,
        {
          fallbackText: typeof (block as { text?: unknown }).text === "string" ? block.text : ""
        }
      );
      return entry?.events ?? [];
    }
    if (
      block.type !== "tool_use" &&
      block.type !== "server_tool_use" &&
      block.type !== "mcp_tool_use"
    ) {
      return [];
    }

    const toolName = block.name;
    const toolInput =
      block.input !== null && typeof block.input === "object"
        ? (block.input as Record<string, unknown>)
        : {};
    const itemType = classifyToolItemType(toolName, toolInput);
    const parentToolUseId = message.parent_tool_use_id ?? undefined;
    const owningAgentId = this.agentIdForParentToolUse(parentToolUseId);
    const tool: ToolInFlight = {
      itemId: block.id,
      itemType,
      toolName,
      title: titleForTool(itemType),
      detail: summarizeToolRequest(toolName, toolInput),
      input: toolInput,
      partialInputJson: "",
      ...(Object.keys(toolInput).length > 0
        ? { lastEmittedInputFingerprint: toolInputFingerprint(toolInput) }
        : {}),
      ...(owningAgentId !== undefined ? { agentId: owningAgentId } : {}),
      ...(parentToolUseId !== undefined ? { parentToolUseId } : {})
    };
    this.inFlightTools.set(event.index, tool);

    return [
      {
        ...this.base({
          turnId: this.activeTurnId,
          itemId: tool.itemId,
          providerItemId: tool.itemId,
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          raw: {
            source: RAW_SDK_MESSAGE,
            method: "claude/stream_event/content_block_start",
            payload: message
          }
        }),
        type: "item.started",
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId !== undefined
            ? { parentToolUseId: tool.parentToolUseId }
            : {}),
          data: { toolName: tool.toolName, input: toolInput }
        }
      }
    ];
  }

  // -------------------------------------------------------------------------
  // Assistant text blocks
  // -------------------------------------------------------------------------

  private ensureAssistantTextBlock(
    messageId: string | null,
    index: number,
    options?: { fallbackText?: string }
  ): { state: AssistantTextBlockState; events: RuntimeEvent[] } | undefined {
    const turn = this.turnState;
    if (!turn) {
      return undefined;
    }
    const key = textBlockKey(messageId, index);
    const existing = turn.assistantTextBlocks.get(key);
    if (existing) {
      if (options?.fallbackText !== undefined && options.fallbackText.length > 0) {
        existing.fallbackText = options.fallbackText;
      }
      return { state: existing, events: [] };
    }
    const state: AssistantTextBlockState = {
      itemId: this.ids.messageId("msg"),
      blockIndex: index,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: false,
      completionEmitted: false
    };
    turn.assistantTextBlocks.set(key, state);
    turn.assistantTextBlockOrder.push(state);
    return {
      state,
      events: [
        {
          ...this.base({ turnId: turn.turnId, itemId: state.itemId }),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress" }
        }
      ]
    };
  }

  private completeAssistantTextBlock(
    state: AssistantTextBlockState,
    options: { force?: boolean; method: string; payload: unknown }
  ): RuntimeEvent[] {
    if (state.completionEmitted) {
      return [];
    }
    if (!state.streamClosed && options.force !== true) {
      return [];
    }
    state.completionEmitted = true;
    const events: RuntimeEvent[] = [];
    // A block whose text never streamed (a snapshot-only assistant message)
    // still has to carry its text, or the timeline shows an empty bubble.
    if (!state.emittedTextDelta && state.fallbackText.length > 0) {
      events.push({
        ...this.base({
          turnId: this.activeTurnId,
          itemId: state.itemId,
          raw: { source: RAW_SDK_MESSAGE, method: options.method, payload: options.payload }
        }),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: state.fallbackText,
          contentIndex: state.blockIndex
        }
      });
    }
    events.push({
      ...this.base({
        turnId: this.activeTurnId,
        itemId: state.itemId,
        raw: { source: RAW_SDK_MESSAGE, method: options.method, payload: options.payload }
      }),
      type: "item.completed",
      payload: { itemType: "assistant_message", status: "completed" }
    });
    return events;
  }

  // -------------------------------------------------------------------------
  // user
  // -------------------------------------------------------------------------

  private handleUserMessage(
    message: Extract<SDKMessage, { type: "user" }>
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const nestedParent = message.parent_tool_use_id ?? undefined;
    if (nestedParent !== undefined) {
      // A subagent's tool_result. Its owner must be known before the result
      // can complete the (attributed) item; otherwise it waits with the rest.
      const owner = this.resolveNestedOwner(
        nestedParent,
        message as { task_description?: unknown; subagent_type?: unknown }
      );
      if (owner === undefined) {
        this.bufferNested(nestedParent, message);
        return events;
      }
    }
    if (this.turnState) {
      this.turnState.items.push(message.message);
    }

    // `content` is sometimes a plain string, not a block array — post
    // compaction, i.e. on a long thread, i.e. exactly where it hurts
    // (fixtures README observation 7).
    const content: unknown = (message.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) {
      return events;
    }

    for (const entry of content) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const block = entry as Record<string, unknown>;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      const toolUseId = block.tool_use_id;
      const text = extractTextContent(block.content);
      const isError = block.is_error === true;

      const found = [...this.inFlightTools.entries()].find(
        ([, tool]) => tool.itemId === toolUseId
      );
      if (!found) {
        // The CLI can deny a tool the adapter never saw start (a gate that
        // fired before any content block reached us).
        if (isCliDenialResult(isError, text)) {
          events.push(this.toolDeniedEvent({ toolName: "unknown", toolUseId, text, message }));
        }
        continue;
      }
      const [index, tool] = found;
      const toolData = { toolName: tool.toolName, input: tool.input, result: block };

      events.push({
        ...this.base({
          turnId: this.activeTurnId,
          itemId: tool.itemId,
          providerItemId: tool.itemId,
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          raw: { source: RAW_SDK_MESSAGE, method: "claude/user", payload: message }
        }),
        type: "item.updated",
        payload: {
          itemType: tool.itemType,
          status: isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId !== undefined
            ? { parentToolUseId: tool.parentToolUseId }
            : {}),
          data: toolData
        }
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind !== undefined && text.length > 0 && this.turnState) {
        events.push({
          ...this.base({
            turnId: this.turnState.turnId,
            itemId: tool.itemId,
            providerItemId: tool.itemId,
            raw: { source: RAW_SDK_MESSAGE, method: "claude/user", payload: message }
          }),
          type: "content.delta",
          payload: { streamKind, delta: text }
        });
      }

      // The CLI gates first and silently: a denial arrives as an ordinary
      // error tool_result, with no `request.*` behind it (fixtures README
      // observation 1). Without this row the timeline renders a policy denial
      // as a plain tool failure.
      const declined = isCliDenialResult(isError, text);
      if (declined) {
        events.push(
          this.toolDeniedEvent({ toolName: tool.toolName, toolUseId, text, message, tool })
        );
      }

      const itemStatus: RuntimeItemStatus = declined ? "declined" : isError ? "failed" : "completed";
      events.push({
        ...this.base({
          turnId: this.activeTurnId,
          itemId: tool.itemId,
          providerItemId: tool.itemId,
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          raw: { source: RAW_SDK_MESSAGE, method: "claude/user", payload: message }
        }),
        type: "item.completed",
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
          ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId !== undefined
            ? { parentToolUseId: tool.parentToolUseId }
            : {}),
          data: toolData
        }
      });

      if (!isError && this.applyStepListToolResult(tool, readToolUseResult(message))) {
        const plan = this.planStepsFromStepList();
        if (plan.length > 0) {
          events.push({
            ...this.base({ turnId: this.activeTurnId }),
            type: "turn.plan.updated",
            payload: { plan }
          });
        }
      }

      this.inFlightTools.delete(index);
    }

    return events;
  }

  private toolDeniedEvent(input: {
    toolName: string;
    toolUseId: string;
    text: string;
    message: unknown;
    tool?: ToolInFlight;
  }): RuntimeEvent {
    return {
      ...this.base({
        turnId: this.activeTurnId,
        providerItemId: input.toolUseId,
        ...(input.tool?.agentId !== undefined ? { agentId: input.tool.agentId } : {}),
        raw: { source: RAW_SDK_MESSAGE, method: "claude/user/tool_use_error", payload: input.message }
      }),
      type: "tool.denied",
      payload: {
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        reason: cliDenialReason(input.text),
        ...(input.tool?.agentId !== undefined ? { agentId: input.tool.agentId } : {})
      }
    };
  }

  // -------------------------------------------------------------------------
  // assistant
  // -------------------------------------------------------------------------

  private handleAssistantMessage(
    message: Extract<SDKMessage, { type: "assistant" }>
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const parentToolUseId = message.parent_tool_use_id ?? undefined;

    if (parentToolUseId !== undefined) {
      // A subagent's own conversation, not the parent's. Its snapshot model is
      // the authoritative API model the subagent ran on, so it refines the
      // seeded launch-time value.
      const owningTaskId = this.resolveNestedOwner(
        parentToolUseId,
        message as { task_description?: unknown; subagent_type?: unknown }
      );
      const snapshotModel = trimmedString(message.message?.model);
      if (snapshotModel !== undefined) {
        const agent = owningTaskId !== undefined ? this.taskAgents.get(owningTaskId) : undefined;
        if (agent) {
          agent.model = snapshotModel;
        } else {
          this.rememberPendingTaskModel(parentToolUseId, snapshotModel);
        }
      }
      this.lastAssistantUuid = message.uuid;
      if (owningTaskId === undefined) {
        this.bufferNested(parentToolUseId, message);
        return events;
      }
      // The subagent's own activity. The CLI forwards a subagent's tool_use /
      // tool_result blocks (and its final text) as COMPLETE `assistant` /
      // `user` messages with `parent_tool_use_id` — never as stream events
      // (a live 2.1.278 thread: 882 nested tool_use blocks, 0 nested
      // stream_events). Only the stream path built tool items, so a drill-in
      // read "This agent has not reported anything yet" while the roster
      // counted its tools. Every block here is attributed to the owning task
      // so it renders in that agent's drill-in and never in the parent's.
      events.push(...this.nestedAssistantEvents(message, parentToolUseId, owningTaskId));
      return events;
    }

    if (!this.turnState) {
      // Background assistant output between prompts opens a synthetic turn.
      events.push(
        ...this.beginTurn({
          turnId: this.ids.uuid(),
          synthetic: true,
          anchorUuid: message.uuid
        })
      );
    }

    const content: unknown = message.message?.content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        const block = entry as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
        if (block.type !== "tool_use" || block.name !== "ExitPlanMode") {
          continue;
        }
        const plan = extractExitPlanModePlan(block.input);
        if (plan === undefined) {
          continue;
        }
        events.push(
          ...this.proposedPlanCompleted({
            planMarkdown: plan.planMarkdown,
            ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
            ...(plan.planFilePath !== undefined ? { planFilePath: plan.planFilePath } : {}),
            source: RAW_SDK_MESSAGE,
            method: "claude/assistant",
            payload: message
          })
        );
      }
    }

    const turn = this.turnState;
    if (turn) {
      turn.latestAssistantRateLimited = message.error === "rate_limit";
      if (message.error === "authentication_failed") {
        turn.authenticationFailureMessage =
          "Claude is not logged in for this account. Open Settings → Accounts and sign in again.";
      }
      turn.items.push(message.message);
      const usage = (message.message as { usage?: unknown } | undefined)?.usage;
      if (
        normalizeActiveTokenUsage(
          usage,
          this.lastKnownContextWindow,
          this.lastKnownTotalProcessedTokens
        )
      ) {
        turn.latestAssistantUsage = usage;
        turn.compactedSinceLatestAssistantUsage = false;
      }
      events.push(...this.backfillAssistantTextFromSnapshot(message));
    }

    this.lastAssistantUuid = message.uuid;
    return events;
  }

  /**
   * A text block that never streamed (no `includePartialMessages`, or a block
   * the stream closed before the deltas arrived) is backfilled from the
   * assistant snapshot so it is never an empty bubble.
   */
  private backfillAssistantTextFromSnapshot(
    message: Extract<SDKMessage, { type: "assistant" }>
  ): RuntimeEvent[] {
    const turn = this.turnState;
    const content: unknown = message.message?.content;
    if (!turn || !Array.isArray(content)) {
      return [];
    }
    const events: RuntimeEvent[] = [];
    // A per-block frame (`content: [one block]`, the CLI's streaming shape)
    // names its block by the message's stream order, not by array position:
    // a text block that streamed at index 1 behind a thinking block arrived
    // here at index 0, matched nothing, and was created AGAIN — the same
    // paragraph rendered twice, only on turns that opened with reasoning
    // (owner report, 2026-09-22). A full snapshot (several blocks) still maps
    // by array position, which IS the stream index there.
    const messageId = (message.message as { id?: unknown } | undefined)?.id;
    const streamed =
      typeof messageId === "string" ? turn.streamedBlocks.get(messageId) : undefined;
    const perBlockFrame = content.length === 1 && streamed !== undefined && streamed.length > 0;
    // The frame's own id is the join key. A frame with no id at all (not a
    // shape this CLI emits) falls back to the message that is streaming.
    const blockMessageId =
      typeof messageId === "string" ? messageId : turn.currentStreamMessageId;
    let index = 0;
    for (const entry of content) {
      let streamIndex = index;
      if (perBlockFrame && typeof messageId === "string") {
        const cursor = turn.snapshotBlockCursor.get(messageId) ?? 0;
        turn.snapshotBlockCursor.set(messageId, cursor + 1);
        const candidate = streamed[cursor];
        const blockType =
          entry !== null && typeof entry === "object"
            ? (entry as { type?: unknown }).type
            : undefined;
        if (candidate !== undefined && candidate.type === blockType) {
          streamIndex = candidate.index;
        } else {
          // Out of step (a frame we never saw stream): take the first
          // streamed block of this type that no text state occupies yet, so a
          // desync degrades to the old behaviour rather than to a duplicate.
          const fallback = streamed.find(
            (streamedBlock) =>
              streamedBlock.type === blockType &&
              (blockType !== "text" ||
                !turn.assistantTextBlocks.get(textBlockKey(blockMessageId, streamedBlock.index))
                  ?.streamClosed)
          );
          if (fallback !== undefined) streamIndex = fallback.index;
        }
      }
      if (entry === null || typeof entry !== "object") {
        index += 1;
        continue;
      }
      const block = entry as { type?: unknown; text?: unknown };
      if (block.type !== "text" || typeof block.text !== "string" || block.text.length === 0) {
        index += 1;
        continue;
      }
      const created = this.ensureAssistantTextBlock(blockMessageId, streamIndex, {
        fallbackText: block.text
      });
      if (created) {
        events.push(...created.events);
      }
      index += 1;
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // result
  // -------------------------------------------------------------------------

  private handleResultMessage(
    message: Extract<SDKMessage, { type: "result" }>
  ): RuntimeEvent[] {
    const turn = this.turnState;
    const failureHint =
      turn?.authenticationFailureMessage ??
      (turn && (turn.rejectedRateLimitTypes.size > 0 || turn.latestAssistantRateLimited)
        ? "Claude usage limit reached. Send the message again once the limit resets."
        : undefined);
    const { status, errorMessage } = resultOutcome(message, failureHint);

    const events: RuntimeEvent[] = [];
    if (status === "failed") {
      events.push(
        this.error(errorMessage ?? "Claude turn failed.", claudeErrorClass(message), message)
      );
    }
    events.push(...this.completeTurn(status, errorMessage, message));
    return events;
  }

  // -------------------------------------------------------------------------
  // system
  // -------------------------------------------------------------------------

  private handleSystemMessage(
    message: Extract<SDKMessage, { type: "system" }>
  ): RuntimeEvent[] {
    const rawSubtype = (message as { subtype?: unknown }).subtype;
    if (typeof rawSubtype === "string" && UNDECLARED_SYSTEM_SUBTYPES.has(rawSubtype)) {
      // Informational CLI notices; the work log already shows the underlying
      // git/gh tool calls.
      return [];
    }

    const raw: RuntimeEventRaw = {
      source: RAW_SDK_MESSAGE,
      method: `claude/system/${String(rawSubtype)}`,
      messageType: `system:${String(rawSubtype)}`,
      payload: message
    };

    switch (message.subtype) {
      case "init":
        return this.handleInit(message, raw);

      case "status": {
        // ~3 per turn, with `requesting` the only value this CLI sends
        // (fixtures README observation 6). Deduped on the derived state, so
        // the bus does not carry one event per frame. `compacting` maps to
        // `running` too: `waiting` is derived from an unresolved request and
        // is never emitted (§4.2).
        return this.sessionStateChanged("running", `status:${message.status ?? "active"}`);
      }

      case "compact_boundary": {
        const turn = this.turnState;
        if (turn) {
          turn.latestAssistantUsage = undefined;
          turn.compactedSinceLatestAssistantUsage = true;
        }
        // `preserved_messages.all_uuids` names exactly the messages that
        // survived the compaction, which is what lets a rollback say "that
        // anchor is gone" precisely instead of failing a deep-equal scan later
        // (§4.5 "or a compaction in between", fixtures README obs. 17).
        this.preservedMessageUuids = readPreservedUuids(
          (message as { compact_metadata?: unknown }).compact_metadata
        );
        const snapshot = compactBoundarySnapshot({
          compactMetadata: (message as { compact_metadata?: unknown }).compact_metadata,
          ...(this.lastKnownContextWindow !== undefined
            ? { contextWindow: this.lastKnownContextWindow }
            : {}),
          ...(this.lastKnownTotalProcessedTokens !== undefined
            ? { totalProcessedTokens: this.lastKnownTotalProcessedTokens }
            : {})
        });
        const events = this.emitThreadTokenUsage(
          snapshot,
          "claude/system/compact_boundary",
          message
        );
        events.push({
          ...this.base({ turnId: this.activeTurnId, raw }),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            ...(snapshot?.lastUsedTokens !== undefined
              ? { beforeTokens: snapshot.lastUsedTokens }
              : {}),
            ...(snapshot?.usedTokens !== undefined ? { afterTokens: snapshot.usedTokens } : {})
          }
        });
        return events;
      }

      case "hook_started":
        return [
          {
            ...this.base({ turnId: this.activeTurnId, raw }),
            type: "hook.started",
            payload: {
              hookId: message.hook_id,
              hookName: message.hook_name,
              hookEvent: message.hook_event
            }
          }
        ];
      case "hook_progress":
        return [
          {
            ...this.base({ turnId: this.activeTurnId, raw }),
            type: "hook.progress",
            payload: {
              hookId: message.hook_id,
              ...(message.stdout ? { stdout: message.stdout } : {}),
              ...(message.stderr ? { stderr: message.stderr } : {})
            }
          }
        ];
      case "hook_response":
        return [
          {
            ...this.base({ turnId: this.activeTurnId, raw }),
            type: "hook.completed",
            payload: {
              hookId: message.hook_id,
              outcome: message.outcome,
              ...(message.stdout ? { stdout: message.stdout } : {}),
              ...(message.stderr ? { stderr: message.stderr } : {}),
              ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {})
            }
          }
        ];

      case "task_started":
        return this.handleTaskStarted(message, raw);
      case "task_progress":
        return this.handleTaskProgress(message, raw);
      case "task_updated":
        return this.handleTaskUpdated(message, raw);
      case "task_notification":
        return this.handleTaskNotification(message, raw);
      case "background_tasks_changed":
        return this.handleBackgroundTasksChanged(message, raw);

      case "api_retry":
        // A transport-level retry heartbeat. Surfacing each attempt as a
        // warning spammed T3's work log during a 502 storm; the terminal
        // result reports the real failure. Keep the session visibly alive.
        return this.sessionStateChanged(
          "running",
          `api_retry:${message.attempt}/${message.max_retries}`
        );

      case "session_state_changed":
        return this.sessionStateChanged(
          message.state === "running" || message.state === "requires_action" ? "running" : "ready",
          `session_state:${message.state}`
        );

      case "notification":
        return message.priority === "high" || message.priority === "immediate"
          ? [this.warning(message.text, message)]
          : [];

      case "model_refusal_fallback": {
        const events: RuntimeEvent[] = [
          {
            ...this.base({ turnId: this.activeTurnId, raw }),
            type: "model.rerouted",
            payload: {
              fromModel: message.original_model,
              toModel: message.fallback_model,
              reason: trimmedString(message.api_refusal_explanation) ?? message.content
            }
          }
        ];
        events.push(this.warning(message.content, message));
        return events;
      }

      case "model_refusal_no_fallback":
        return [
          this.warning(trimmedString(message.api_refusal_explanation) ?? message.content, message)
        ];

      case "informational":
        return message.level === "warning" ? [this.warning(message.content, message)] : [];

      case "permission_denied":
        return [
          {
            ...this.base({
              turnId: this.activeTurnId,
              providerItemId: message.tool_use_id,
              ...(message.agent_id !== undefined ? { agentId: message.agent_id } : {}),
              raw
            }),
            type: "tool.denied",
            payload: {
              toolName: message.tool_name,
              toolUseId: message.tool_use_id,
              ...(message.decision_reason !== undefined
                ? { reason: message.decision_reason }
                : { reason: message.message }),
              ...(message.agent_id !== undefined ? { agentId: message.agent_id } : {})
            }
          }
        ];

      case "mirror_error":
        return [
          this.error(`Claude workspace mirror error: ${message.error}`, "provider_error", message)
        ];

      case "thinking_tokens":
        // Several per second during extended thinking (fixtures README
        // observation 6). The §4.2 union has no thinking-progress event, and
        // one runtime event per frame would flood the bus for a shimmer the
        // reasoning deltas already drive. Consumed deliberately.
        return [];

      // Inner protocol/UX detail with no §4.2 surface, consumed deliberately
      // so none of them masquerades as an unknown-subtype warning.
      // `files_persisted` is in T3's union but excluded from ours (§4.2).
      case "local_command_output":
      case "plugin_install":
      case "commands_changed":
      case "memory_recall":
      case "elicitation_complete":
      case "control_request_progress":
      case "worker_shutting_down":
      case "files_persisted":
        return [];

      default: {
        // Exhaustiveness guard: every subtype in the SDK's typed union is
        // handled above, so a new SDK release fails this typecheck instead of
        // only warning at runtime. The runtime fallback still catches the
        // undeclared wire-only subtypes.
        message satisfies never;
        const unknown = message as { subtype?: unknown };
        return [
          this.warning(
            describeUnknownSdkMessage(
              `Claude system message '${String(unknown.subtype)}'`,
              message
            ),
            message
          )
        ];
      }
    }
  }

  /**
   * `system/init` is emitted once **per turn**, not once per session
   * (fixtures README observation 5). Emitting a configured event per turn
   * would spam the timeline and re-announce a model the user never changed, so
   * it is treated as idempotent state and diffed: only a model that differs
   * from the one this adapter asked for becomes an event, and that is a real
   * reroute.
   */
  private handleInit(
    message: Extract<SDKMessage, { type: "system"; subtype: "init" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const model = trimmedString(message.model);
    const events: RuntimeEvent[] = [];
    if (!this.initSeen) {
      this.initSeen = true;
      this.lastInitModel = model;
      // Deliberately emits NO session state: `init` arrives once per turn, so
      // the first one lands INSIDE the first turn and a `ready` here would
      // flip a running session back and forth (observed live on CLI 2.1.278).
      // Session state is driven by the session and turn lifecycle only.
      return events;
    }
    if (
      model !== undefined &&
      this.lastInitModel !== undefined &&
      model !== this.lastInitModel &&
      this.expectedModel !== model
    ) {
      events.push({
        ...this.base({ turnId: this.activeTurnId, raw }),
        type: "model.rerouted",
        payload: {
          fromModel: this.lastInitModel,
          toModel: model,
          reason: "The CLI reported a different model on this turn."
        }
      });
    }
    if (model !== undefined) {
      this.lastInitModel = model;
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  private handleTaskStarted(
    message: Extract<SDKMessage, { type: "system"; subtype: "task_started" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    // A task launched by a tool that itself ran inside a subagent is
    // agent-internal: a subagent's background shell, not parent work.
    const launchingTool =
      message.tool_use_id !== undefined
        ? [...this.inFlightTools.values()].find((tool) => tool.itemId === message.tool_use_id)
        : undefined;
    const owningAgentId = launchingTool?.agentId;

    if (this.turnState && isAgentFlavoured(message.task_type, owningAgentId)) {
      this.turnState.hasSubagents = true;
    }

    const launchInput = launchingTool?.input;
    const buffered =
      message.tool_use_id !== undefined
        ? this.pendingTaskModels.get(message.tool_use_id)
        : undefined;
    if (message.tool_use_id !== undefined) {
      this.pendingTaskModels.delete(message.tool_use_id);
    }
    const model = buffered ?? trimmedString(launchInput?.model) ?? this.expectedModel;
    const rawEffort = launchInput?.effort;
    const effort =
      trimmedString(rawEffort) ??
      (typeof rawEffort === "number" && Number.isFinite(rawEffort) ? String(rawEffort) : undefined);

    this.taskAgents.set(message.task_id, {
      taskId: message.task_id,
      ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
      ...(message.description !== undefined
        ? { description: message.description }
        : trimmedString(launchInput?.description) !== undefined
          ? { description: trimmedString(launchInput?.description) }
          : {}),
      ...(message.subagent_type !== undefined ? { subagentType: message.subagent_type } : {}),
      ...(message.task_type !== undefined ? { taskType: message.task_type } : {}),
      ...(message.workflow_name !== undefined ? { workflowName: message.workflow_name } : {}),
      ...(owningAgentId !== undefined ? { owningAgentId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {})
    });
    this.liveTaskIds.add(message.task_id);
    this.options.onLiveTasksChanged?.(this.liveTaskIds);

    return [
      ...this.flushPendingNested(),
      {
        ...this.base({
          turnId: this.activeTurnId,
          ...(owningAgentId !== undefined ? { agentId: owningAgentId } : {}),
          raw
        }),
        type: "task.started",
        payload: {
          taskId: message.task_id,
          ...(message.description !== undefined ? { description: message.description } : {}),
          ...this.taskLinkageFor(message.task_id)
        }
      }
    ];
  }

  private handleTaskProgress(
    message: Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const progressAgent = this.taskAgents.get(message.task_id);
    if (progressAgent !== undefined && trimmedString(message.description) !== undefined) {
      // A resumed subagent's `task_started` may carry no description; its
      // first progress does, and that is the join a nested frame needs.
      progressAgent.description = trimmedString(message.description);
    }
    const events = this.emitThreadTokenUsage(
      this.taskProgressTokenUsage(message.usage),
      "claude/system/task_progress",
      message
    );
    const usage = normalizeTaskUsage(message.usage);
    const linkage = this.taskLinkageFor(message.task_id);
    events.push({
      ...this.base({
        turnId: this.activeTurnId,
        ...(linkage.agentId !== undefined ? { agentId: linkage.agentId } : {}),
        raw
      }),
      type: "task.progress",
      payload: {
        taskId: message.task_id,
        description: message.description,
        ...(message.summary !== undefined ? { summary: message.summary } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(message.last_tool_name !== undefined ? { lastToolName: message.last_tool_name } : {}),
        ...linkage,
        ...(message.subagent_type !== undefined ? { role: message.subagent_type } : {})
      }
    });
    events.push(...this.flushPendingNested());
    return events;
  }

  private handleTaskUpdated(
    message: Extract<SDKMessage, { type: "system"; subtype: "task_updated" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const patch = message.patch;
    const status =
      patch.status !== undefined ? CLAUDE_TASK_PATCH_STATUS[patch.status] : undefined;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      if (this.liveTaskIds.delete(message.task_id)) {
        this.options.onLiveTasksChanged?.(this.liveTaskIds);
      }
    }
    const endedAt =
      typeof patch.end_time === "number" && Number.isFinite(patch.end_time)
        ? new Date(patch.end_time).toISOString()
        : undefined;
    // The provider does NOT repeat the linkage on this row — it carries only
    // `{task_id, patch}` (fixtures README observation 4) — so the adapter
    // carries the identity forward from its own map, which is what §4.2's
    // "linkage repeated on every row" actually requires of us.
    const linkage = this.taskLinkageFor(message.task_id);
    return [
      {
        ...this.base({
          turnId: this.activeTurnId,
          ...(linkage.agentId !== undefined ? { agentId: linkage.agentId } : {}),
          raw
        }),
        type: "task.updated",
        payload: {
          taskId: message.task_id,
          ...(status !== undefined ? { status } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(patch.is_backgrounded !== undefined
            ? { isBackgrounded: patch.is_backgrounded }
            : {}),
          ...linkage
        }
      }
    ];
  }

  private handleTaskNotification(
    message: Extract<SDKMessage, { type: "system"; subtype: "task_notification" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    if (this.liveTaskIds.delete(message.task_id)) {
      this.options.onLiveTasksChanged?.(this.liveTaskIds);
    }
    const agent = this.taskAgents.get(message.task_id);
    if (agent && typeof message.output_file === "string") {
      agent.outputFile = message.output_file;
    }
    const events = this.emitThreadTokenUsage(
      this.taskProgressTokenUsage(message.usage),
      "claude/system/task_notification",
      message
    );
    const usage = normalizeTaskUsage(message.usage);
    const linkage = this.taskLinkageFor(message.task_id);
    events.push({
      ...this.base({
        turnId: this.activeTurnId,
        ...(linkage.agentId !== undefined ? { agentId: linkage.agentId } : {}),
        raw
      }),
      type: "task.completed",
      payload: {
        taskId: message.task_id,
        status: message.status,
        ...(message.summary !== undefined ? { summary: message.summary } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...linkage
      }
    });
    return events;
  }

  /**
   * The only frame that reports the **whole** live background set, which makes
   * it the natural source for reconciling the roster after a gap
   * (fixtures README observation 4). A live background task missing from the
   * snapshot is closed `stopped`; a new one is registered so the `task_started`
   * that follows already has its linkage.
   */
  private handleBackgroundTasksChanged(
    message: Extract<SDKMessage, { type: "system"; subtype: "background_tasks_changed" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const present = new Set<string>();
    for (const task of message.tasks) {
      present.add(task.task_id);
      const existing = this.taskAgents.get(task.task_id);
      this.taskAgents.set(task.task_id, {
        taskId: task.task_id,
        ...existing,
        ...(task.description ? { description: task.description } : {}),
        ...(task.task_type ? { taskType: task.task_type } : {})
      });
    }

    const events: RuntimeEvent[] = [];
    let changed = false;
    for (const taskId of [...this.liveTaskIds]) {
      if (present.has(taskId)) {
        continue;
      }
      const agent = this.taskAgents.get(taskId);
      // Only background work is described by this snapshot; a subagent that is
      // absent from it is not finished.
      if (agent?.taskType === undefined || !isBackgroundTaskType(agent.taskType)) {
        continue;
      }
      this.liveTaskIds.delete(taskId);
      changed = true;
      events.push({
        ...this.base({ turnId: this.activeTurnId, raw }),
        type: "task.completed",
        payload: { taskId, status: "stopped", ...this.taskLinkageFor(taskId) }
      });
    }
    if (changed) {
      this.options.onLiveTasksChanged?.(this.liveTaskIds);
    }
    return events;
  }

  private taskLinkageFor(taskId: string): TaskAgentLinkage {
    const agent = this.taskAgents.get(taskId);
    if (!agent) {
      return {};
    }
    return {
      ...(agent.taskType !== undefined ? { taskType: agent.taskType } : {}),
      ...(agent.owningAgentId !== undefined ? { agentId: agent.owningAgentId } : {}),
      ...(agent.description !== undefined ? { title: agent.description } : {}),
      ...(agent.subagentType !== undefined ? { role: agent.subagentType } : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      ...(agent.toolUseId !== undefined ? { toolUseId: agent.toolUseId } : {}),
      ...(agent.workflowName !== undefined ? { workflowName: agent.workflowName } : {}),
      ...(agent.outputFile !== undefined ? { outputFile: agent.outputFile } : {})
    };
  }

  /** Keys for nested tools in `inFlightTools`: negative, so they never collide with a stream index. */
  private nestedToolSeq = 0;

  /**
   * A RESUMED subagent (the `Agent` tool's `resume`) keeps the
   * `parent_tool_use_id` of the session that first launched it, so its nested
   * frames never match the new `task_started.tool_use_id`. Every nested frame
   * does carry `task_description`, and so does the task once `task_started`
   * (or its first `task_progress`) named it — that is the join. Resolved once
   * per parent id and remembered here.
   */
  private readonly nestedParentAliases = new Map<string, string>();
  /**
   * Nested frames whose owner is not known YET (the description arrives on a
   * later `task_progress`), per parent id, in arrival order. Never released
   * into the parent's timeline: an unattributed subagent frame reads as the
   * parent's own work, which is exactly the bug this exists for. Replayed the
   * moment the owner is known; dropped when the turn ends.
   */
  private readonly pendingNested = new Map<string, SDKMessage[]>();
  private pendingNestedCount = 0;

  private resolveNestedOwner(
    parentToolUseId: string,
    frame: { task_description?: unknown; subagent_type?: unknown }
  ): string | undefined {
    const direct = this.agentIdForParentToolUse(parentToolUseId);
    if (direct !== undefined) return direct;
    const alias = this.nestedParentAliases.get(parentToolUseId);
    if (alias !== undefined) return alias;
    const description = trimmedString(frame.task_description);
    if (description === undefined) return undefined;
    const bound = new Set(this.nestedParentAliases.values());
    const candidates = [...this.taskAgents.values()].filter(
      (agent) => agent.description === description && this.liveTaskIds.has(agent.taskId)
    );
    const pick = candidates.find((agent) => !bound.has(agent.taskId)) ?? candidates[0];
    if (pick === undefined) return undefined;
    this.nestedParentAliases.set(parentToolUseId, pick.taskId);
    return pick.taskId;
  }

  private bufferNested(parentToolUseId: string, message: SDKMessage): void {
    if (this.pendingNestedCount >= MAX_PENDING_NESTED_FRAMES) {
      // Bounded: a subagent nobody ever names cannot grow the host without
      // limit. The oldest parent's frames go first.
      const oldest = this.pendingNested.keys().next();
      if (!oldest.done) {
        this.pendingNestedCount -= this.pendingNested.get(oldest.value)?.length ?? 0;
        this.pendingNested.delete(oldest.value);
      }
    }
    const list = this.pendingNested.get(parentToolUseId) ?? [];
    list.push(message);
    this.pendingNested.set(parentToolUseId, list);
    this.pendingNestedCount += 1;
  }

  /** Replay every buffered nested frame whose owner can now be resolved. */
  private flushPendingNested(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [parentToolUseId, frames] of [...this.pendingNested.entries()]) {
      const first = frames[0] as { task_description?: unknown; subagent_type?: unknown } | undefined;
      if (first === undefined) continue;
      if (this.resolveNestedOwner(parentToolUseId, first) === undefined) continue;
      this.pendingNested.delete(parentToolUseId);
      this.pendingNestedCount -= frames.length;
      for (const frame of frames) {
        events.push(...this.handleMessage(frame));
      }
    }
    return events;
  }

  private dropPendingNested(): void {
    this.pendingNested.clear();
    this.pendingNestedCount = 0;
  }

  private nestedAssistantEvents(
    message: Extract<SDKMessage, { type: "assistant" }>,
    parentToolUseId: string,
    owningTaskId: string | undefined
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const content: unknown = (message.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) {
      return events;
    }
    const raw = { source: RAW_SDK_MESSAGE, method: "claude/assistant", payload: message };
    for (const entry of content) {
      if (entry === null || typeof entry !== "object") continue;
      const block = entry as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const toolName = block.name;
        const toolInput =
          block.input !== null && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : {};
        const itemType = classifyToolItemType(toolName, toolInput);
        const tool: ToolInFlight = {
          itemId: block.id,
          itemType,
          toolName,
          title: titleForTool(itemType),
          detail: summarizeToolRequest(toolName, toolInput),
          input: toolInput,
          partialInputJson: "",
          lastEmittedInputFingerprint: toolInputFingerprint(toolInput),
          ...(owningTaskId !== undefined ? { agentId: owningTaskId } : {}),
          parentToolUseId
        };
        // Registered under a synthetic key so the nested `user` tool_result
        // completes it through the ordinary lookup by itemId.
        this.nestedToolSeq -= 1;
        this.inFlightTools.set(this.nestedToolSeq, tool);
        events.push({
          ...this.base({
            turnId: this.activeTurnId,
            itemId: tool.itemId,
            providerItemId: tool.itemId,
            ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
            raw
          }),
          type: "item.started",
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            title: tool.title,
            ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
            ...(tool.agentId !== undefined ? { agentId: tool.agentId } : {}),
            parentToolUseId,
            data: { toolName: tool.toolName, input: toolInput }
          }
        });
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        // The subagent's prose (its final answer, mostly): one settled message
        // row in its drill-in.
        const itemId = this.ids.messageId("msg");
        const base = {
          turnId: this.activeTurnId,
          itemId,
          ...(owningTaskId !== undefined ? { agentId: owningTaskId } : {}),
          raw
        };
        events.push(
          {
            ...this.base(base),
            type: "item.started",
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              ...(owningTaskId !== undefined ? { agentId: owningTaskId } : {})
            }
          },
          {
            ...this.base(base),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: block.text, contentIndex: 0 }
          },
          {
            ...this.base(base),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              ...(owningTaskId !== undefined ? { agentId: owningTaskId } : {})
            }
          }
        );
      }
    }
    return events;
  }

  private agentIdForParentToolUse(parentToolUseId: string | undefined): string | undefined {
    if (parentToolUseId === undefined) {
      return undefined;
    }
    for (const agent of this.taskAgents.values()) {
      if (agent.toolUseId === parentToolUseId) {
        return agent.taskId;
      }
    }
    return undefined;
  }

  private rememberPendingTaskModel(toolUseId: string, model: string): void {
    if (this.pendingTaskModels.size >= MAX_PENDING_TASK_MODELS) {
      const oldest = this.pendingTaskModels.keys().next();
      if (!oldest.done) {
        this.pendingTaskModels.delete(oldest.value);
      }
    }
    this.pendingTaskModels.set(toolUseId, model);
  }

  // -------------------------------------------------------------------------
  // Step list (TaskCreate / TaskUpdate / TaskList)
  // -------------------------------------------------------------------------

  private applyStepListToolResult(
    tool: ToolInFlight,
    result: Record<string, unknown> | undefined
  ): boolean {
    if (!isStepListTool(tool.toolName)) {
      return false;
    }
    if (tool.toolName === "TaskList") {
      const rows = result?.tasks;
      if (!Array.isArray(rows)) {
        return false;
      }
      this.stepList.clear();
      for (const entry of rows) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const row = entry as Record<string, unknown>;
        const id = trimmedString(row.id);
        const subject = trimmedString(row.subject);
        if (id === undefined || subject === undefined) {
          continue;
        }
        this.stepList.set(id, {
          id,
          subject,
          status: normalizeStepStatus(row.status),
          blockedBy: new Set(readStringArray(row.blockedBy))
        });
      }
      return this.stepList.size > 0;
    }

    if (tool.toolName === "TaskCreate") {
      const task =
        result?.task !== null && typeof result?.task === "object" && !Array.isArray(result.task)
          ? (result.task as Record<string, unknown>)
          : undefined;
      const id = trimmedString(task?.id) ?? trimmedString(result?.taskId);
      const subject = trimmedString(task?.subject) ?? trimmedString(tool.input.subject);
      if (id === undefined || subject === undefined) {
        return false;
      }
      this.stepList.set(id, {
        id,
        subject,
        status: normalizeStepStatus(tool.input.status ?? task?.status),
        blockedBy: new Set(readStringArray(tool.input.blockedBy))
      });
      return true;
    }

    // TaskUpdate
    const taskId = trimmedString(tool.input.taskId) ?? trimmedString(result?.taskId);
    if (taskId === undefined) {
      return false;
    }
    const entry = this.stepList.get(taskId);
    if (!entry) {
      return false;
    }
    let changed = false;
    const subject = trimmedString(tool.input.subject);
    if (subject !== undefined && entry.subject !== subject) {
      entry.subject = subject;
      changed = true;
    }
    if (typeof tool.input.status === "string") {
      const status = normalizeStepStatus(tool.input.status);
      if (entry.status !== status) {
        entry.status = status;
        changed = true;
      }
    }
    for (const dependency of readStringArray(tool.input.addBlockedBy)) {
      if (!entry.blockedBy.has(dependency)) {
        entry.blockedBy.add(dependency);
        changed = true;
      }
    }
    for (const dependency of readStringArray(tool.input.removeBlockedBy)) {
      if (entry.blockedBy.delete(dependency)) {
        changed = true;
      }
    }
    return changed;
  }

  private planStepsFromStepList(): Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> {
    return [...this.stepList.values()].map((entry) => {
      const blockedBy = [...entry.blockedBy];
      const suffix = blockedBy.length > 0 ? ` (blocked by #${blockedBy.join(", #")})` : "";
      return { step: `${entry.subject}${suffix}`, status: entry.status };
    });
  }

  // -------------------------------------------------------------------------
  // Rate limits
  // -------------------------------------------------------------------------

  private handleRateLimitEvent(
    message: Extract<SDKMessage, { type: "rate_limit_event" }>
  ): RuntimeEvent[] {
    const info: unknown = (message as { rate_limit_info?: unknown }).rate_limit_info;
    if (info === null || info === undefined) {
      return [];
    }
    const events: RuntimeEvent[] = [];
    const update: ProviderUsageLimitsUpdate | undefined = rateLimitEventToUpdate(
      info,
      this.scopedLimitNames
    );
    if (update) {
      events.push({
        ...this.base({
          turnId: this.activeTurnId,
          raw: {
            source: RAW_SDK_MESSAGE,
            method: "claude/rate_limit_event",
            messageType: message.type,
            payload: message
          }
        }),
        type: "account.rate-limits.updated",
        payload: { limits: update }
      });
    } else {
      // On CLI 2.1.210 the frame carries no percentage at all, so it can only
      // say "the cached windows are out of date" (fixtures README obs. 16).
      this.options.onUsageLimitsStale?.();
    }

    const record = info as Record<string, unknown>;
    const limitType = typeof record.rateLimitType === "string" ? record.rateLimitType : "unknown";
    const turn = this.turnState;
    const blocked = isRateLimitBlocking(info);
    if (turn) {
      if (blocked) {
        turn.rejectedRateLimitTypes.add(limitType);
      } else if (isRateLimitClearing(info)) {
        turn.rejectedRateLimitTypes.delete(limitType);
      }
    }

    if (blocked && turn) {
      // A parked window re-fires while the remaining wait shrinks, and a turn
      // can park on more than one window, so the announcement is tracked as a
      // per-turn set of limit identities rather than one slot.
      const key = `${limitType}:${String(record.resetsAt ?? "unknown")}`;
      if (!turn.announcedUsageLimitKeys.has(key)) {
        turn.announcedUsageLimitKeys.add(key);
        events.push(
          this.warning(
            describeUsageLimit({
              info,
              nowMs: this.clock.now().getTime(),
              names: this.scopedLimitNames
            }),
            info
          )
        );
      }
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Token usage plumbing
  // -------------------------------------------------------------------------

  private emitThreadTokenUsage(
    snapshot: ClaudeTokenUsageSnapshot | undefined,
    method: string,
    payload: unknown
  ): RuntimeEvent[] {
    if (!snapshot) {
      return [];
    }
    const previous = this.lastKnownTokenUsage;
    if (
      previous !== undefined &&
      previous.usedTokens === snapshot.usedTokens &&
      previous.maxTokens === snapshot.maxTokens &&
      previous.totalProcessedTokens === snapshot.totalProcessedTokens
    ) {
      return [];
    }
    this.lastKnownTokenUsage = snapshot;
    if (snapshot.maxTokens !== undefined) {
      this.lastKnownContextWindow = snapshot.maxTokens;
    }
    if (snapshot.totalProcessedTokens !== undefined) {
      this.lastKnownTotalProcessedTokens = snapshot.totalProcessedTokens;
    }
    return [
      {
        ...this.base({
          turnId: this.activeTurnId,
          raw: { source: RAW_SDK_MESSAGE, method, payload }
        }),
        type: "thread.token-usage.updated",
        payload: { usage: toThreadTokenUsage(snapshot) }
      }
    ];
  }

  private taskProgressTokenUsage(usage: unknown): ClaudeTokenUsageSnapshot | undefined {
    const totalTokens = claudeTotalProcessedTokens(usage);
    if (totalTokens === undefined || totalTokens <= 0) {
      return undefined;
    }
    const lastUsed = this.lastKnownTokenUsage?.usedTokens;
    const activeTokens = lastUsed !== undefined ? Math.max(totalTokens, lastUsed) : totalTokens;
    if (lastUsed !== undefined && activeTokens === lastUsed) {
      return undefined;
    }
    return normalizeActiveTokenUsage(
      { total_tokens: activeTokens },
      this.lastKnownContextWindow,
      Math.max(totalTokens, this.lastKnownTotalProcessedTokens ?? totalTokens)
    );
  }

  private turnUsageSnapshot(
    result: SDKResultMessage | undefined
  ): ClaudeTokenUsageSnapshot | undefined {
    const maxTokens = this.lastKnownContextWindow;
    const totalProcessed = this.lastKnownTotalProcessedTokens;
    const fromAssistant = normalizeActiveTokenUsage(
      this.turnState?.latestAssistantUsage,
      maxTokens,
      totalProcessed
    );
    if (fromAssistant) {
      return fromAssistant;
    }
    if (this.turnState?.compactedSinceLatestAssistantUsage === true) {
      // A compaction reset the window; the pre-compaction result totals would
      // report a context that no longer exists.
      return undefined;
    }
    const fromResult = normalizeActiveTokenUsage(result?.usage, maxTokens, totalProcessed);
    if (fromResult) {
      return fromResult;
    }
    const lastGood = this.lastKnownTokenUsage;
    if (!lastGood) {
      return undefined;
    }
    return {
      ...lastGood,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(totalProcessed !== undefined && totalProcessed > lastGood.usedTokens
        ? { totalProcessedTokens: totalProcessed }
        : {})
    };
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function readToolUseResult(message: SDKMessage): Record<string, unknown> | undefined {
  const result = (message as { tool_use_result?: unknown }).tool_use_result;
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

/**
 * `compact_metadata.preserved_messages.all_uuids`, falling back to `uuids` on a
 * CLI that does not ship the wider list. `undefined` when the frame names
 * nothing, so a caller can tell "no constraint" from "nothing survived".
 */
export function readPreservedUuids(compactMetadata: unknown): string[] | undefined {
  if (compactMetadata === null || typeof compactMetadata !== "object") {
    return undefined;
  }
  const preserved = (compactMetadata as { preserved_messages?: unknown }).preserved_messages;
  if (preserved === null || typeof preserved !== "object") {
    return undefined;
  }
  const record = preserved as { all_uuids?: unknown; uuids?: unknown };
  const all = readStringArray(record.all_uuids);
  if (all.length > 0) {
    return all;
  }
  const some = readStringArray(record.uuids);
  return some.length > 0 ? some : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function normalizeStepStatus(value: unknown): "pending" | "inProgress" | "completed" {
  return value === "completed" ? "completed" : value === "in_progress" ? "inProgress" : "pending";
}

function extractPlanStepsFromTodoInput(
  input: Record<string, unknown>
): Array<{ step: string; status: "pending" | "inProgress" | "completed" }> | null {
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  return todos
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status: normalizeStepStatus(todo.status)
    }));
}

/**
 * `ExitPlanMode`'s input. `planFilePath` is new in this CLI and is the handle
 * for the plan the CLI actually saved (fixtures README observation 10).
 */
export function extractExitPlanModePlan(
  value: unknown
): { planMarkdown: string; planFilePath?: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const plan = trimmedString(record.plan);
  if (plan === undefined) {
    return undefined;
  }
  const planFilePath = trimmedString(record.planFilePath);
  return { planMarkdown: plan, ...(planFilePath !== undefined ? { planFilePath } : {}) };
}

/** Task types that are watch loops or shells rather than agents. */
/** `assistantTextBlocks` key: the owning API message, then the content index. */
function textBlockKey(messageId: string | null | undefined, index: number): string {
  return `${messageId ?? "?"}:${index}`;
}

function isBackgroundTaskType(taskType: string): boolean {
  return taskType === "local_bash" || taskType === "shell" || taskType.startsWith("monitor");
}

function isAgentFlavoured(taskType: string | undefined, agentId: string | undefined): boolean {
  if (taskType !== undefined && isBackgroundTaskType(taskType)) {
    return false;
  }
  if (agentId !== undefined && agentId.length > 0) {
    return taskType !== undefined;
  }
  return true;
}

const SDK_MESSAGE_NOISE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "session_id",
  "parent_tool_use_id"
]);

function previewUnknownSdkContent(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") {
    return undefined;
  }
  const entries = Object.entries(message as Record<string, unknown>).filter(
    ([key]) => !SDK_MESSAGE_NOISE_KEYS.has(key)
  );
  if (entries.length === 0) {
    return undefined;
  }
  const preview = safeJson(Object.fromEntries(entries));
  if (preview === undefined) {
    return undefined;
  }
  return preview.length > 200 ? `${preview.slice(0, 197)}...` : preview;
}

export function describeUnknownSdkMessage(kind: string, message: unknown): string {
  const preview = previewUnknownSdkContent(message);
  return preview === undefined ? `${kind} is not handled.` : `${kind} is not handled: ${preview}`;
}

/**
 * The CLI reports repeated 529 overload failures as a **success**-subtype
 * result with `api_error_status: 529` and an empty error list; the status code
 * is the only structured failure signal (§4.5 "Traps").
 */
function isOverloadedResult(result: SDKResultMessage): boolean {
  return result.subtype === "success" && result.api_error_status === 529;
}

function resultErrorsText(result: SDKResultMessage): string {
  const errors = (result as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors.join(" ").toLowerCase() : "";
}

/** Failure text for the structured terminal reasons. */
function terminalResultError(reason: unknown, failureHint?: string): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      return "Claude stopped: a usage limit blocked the request.";
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":
      return "Claude stopped: the prompt exceeds the model's context window.";
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

/**
 * The CLI stamps user aborts explicitly. Interrupting mid-stream yields
 * `aborted_streaming` — which is what the interrupt capture actually recorded,
 * NOT the `aborted_tools` §4.5 predicts (fixtures README observation 13), so
 * both are matched and neither alone is relied on.
 */
function isInterruptedResult(result: SDKResultMessage): boolean {
  const terminalReason = (result as { terminal_reason?: unknown }).terminal_reason;
  if (terminalReason === "aborted_tools" || terminalReason === "aborted_streaming") {
    return true;
  }
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }
  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

/**
 * Turn status and error from one `result`.
 *
 * **`subtype: "success"` does not mean success** (fixtures README observation
 * 13): the unknown-model result is `subtype:"success"` with `is_error:true`
 * and `api_error_status:404`, and the user-facing text is the CLI's own
 * sentence in `result`. Always branch on `is_error` and `api_error_status`.
 * `terminal_reason` is **absent** on a compaction result, so it can never be
 * read unconditionally.
 */
export function resultOutcome(
  result: SDKResultMessage,
  failureHint?: string
): { status: RuntimeTurnState; errorMessage: string | undefined } {
  const successTaggedFailure = result.subtype === "success" && result.is_error === true;
  const apiErrorStatus = (result as { api_error_status?: unknown }).api_error_status;
  const cliSentence =
    successTaggedFailure && typeof (result as { result?: unknown }).result === "string"
      ? trimmedString((result as { result?: unknown }).result)
      : undefined;

  const terminalError = terminalResultError(
    (result as { terminal_reason?: unknown }).terminal_reason,
    failureHint
  );
  const structuredError = isOverloadedResult(result)
    ? "Claude API is overloaded (529). Try again shortly."
    : successTaggedFailure
      ? // A success-tagged failure carries the CLI's own user-facing sentence
        // in `result` ("There's an issue with the selected model (…)"), which
        // beats this adapter's generic terminal-reason wording (fixtures
        // README observation 13).
        (cliSentence ??
        failureHint ??
        terminalError ??
        (typeof apiErrorStatus === "number"
          ? `Claude turn failed (API status ${apiErrorStatus}).`
          : "Claude turn failed."))
      : terminalError;

  // CLI diagnostic entries must never become the error banner: the interrupt
  // result carries `[ede_diagnostic] …` and nothing else (§4.5).
  const listedErrors: unknown[] = Array.isArray((result as { errors?: unknown }).errors)
    ? ((result as { errors: unknown[] }).errors)
    : [];
  const listedError =
    result.subtype === "success" && !successTaggedFailure
      ? undefined
      : listedErrors.find(
          (error): error is string =>
            typeof error === "string" && !error.startsWith("[ede_diagnostic]")
        );

  const errorMessage = listedError ?? structuredError;
  if (structuredError !== undefined) {
    return { status: "failed", errorMessage };
  }
  if (result.subtype === "success") {
    return { status: "completed", errorMessage };
  }
  if (isInterruptedResult(result)) {
    return { status: "interrupted", errorMessage };
  }
  return {
    status: resultErrorsText(result).includes("cancel") ? "cancelled" : "failed",
    errorMessage
  };
}

/** `class` decides retry vs surface vs re-auth (§4.2). */
function claudeErrorClass(result: SDKResultMessage): RuntimeErrorClass {
  const status = nonNegativeInt((result as { api_error_status?: unknown }).api_error_status);
  if (status === 401 || status === 403) {
    return "permission_error";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "validation_error";
  }
  if (status !== undefined && status >= 500) {
    return "provider_error";
  }
  return "provider_error";
}
