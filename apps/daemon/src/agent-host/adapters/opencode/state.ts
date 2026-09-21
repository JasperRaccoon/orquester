/**
 * Agent host — the per-thread OpenCode session state and its pure helpers
 * (spec §4.5 OpenCode).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
 * (`OpenCodeSessionContext`, `mergeOpenCodeAssistantText`,
 * `accumulateOpenCodeStepUsage`, `takeOpenCodeTurnTokenUsage`), translated
 * from Effect into plain mutable state.
 *
 * Everything here is deliberately synchronous and side-effect free so the
 * normaliser (`normalize.ts`) can be replayed against a captured fixture
 * without a server.
 */

import type { RuntimeMode, RuntimeTaskStatus, TurnTokenUsage } from "@orquester/api/agent-chat";

import type {
  OpenCodeMessageRole,
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest,
  OpenCodeTokens
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Text parts
// ---------------------------------------------------------------------------

export interface OpenCodeTextPartState {
  id: string;
  messageID: string;
  type: "text" | "reasoning";
  time?: { start?: number; end?: number };
  /** The latest snapshot. `undefined` once a non-text PATCH cleared it. */
  text: string | undefined;
  /** Everything already emitted as `content.delta`. Never cleared. */
  emittedText: string | undefined;
  completed: boolean;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/** A truncated snapshot must never rewind output that already went out. */
function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (
    previousText !== undefined &&
    previousText.length > nextText.length &&
    previousText.startsWith(nextText)
  ) {
    return previousText;
  }
  return nextText;
}

/**
 * Snapshot → delta. Keeps the **previous** text when it is longer *and* a
 * prefix of the incoming one; the prefix length is `previous.length` when the
 * latest starts with it, otherwise a real common-prefix length.
 *
 * In 1.18.5 this is the *defensive* path, not the primary one: text arrives as
 * an empty opening snapshot, then genuinely incremental
 * `message.part.delta {field:"text"}`, then a terminal full snapshot with
 * `time.end` (fixtures README observation 4). Because the delta branch writes
 * **both** `emittedText` and `text` before emitting, that closing snapshot
 * yields `deltaToEmit === ""` here and emits nothing. Keep it anyway — it is
 * what makes a future partial snapshot safe.
 */
export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string
): { latestText: string; deltaToEmit: string } {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  const previous = previousText ?? "";
  const prefixLength = latestText.startsWith(previous)
    ? previous.length
    : commonPrefixLength(previous, latestText);
  return { latestText, deltaToEmit: latestText.slice(prefixLength) };
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface OpenCodeStepUsage {
  id: string;
  tokens: OpenCodeTokens;
}

export interface OpenCodeTurnTokenUsageAccumulator {
  partIds: Set<string>;
  /** Client-minted user message ids this turn submitted. */
  promptMessageIds: Set<string>;
  assistantOwnershipByMessageId: Map<string, "owned" | "other" | "unknown">;
  unresolvedStepsByMessageId: Map<string, Map<string, OpenCodeStepUsage>>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  complete: boolean;
  hasSubagents: boolean;
}

export function makeTurnTokenUsageAccumulator(): OpenCodeTurnTokenUsageAccumulator {
  return {
    partIds: new Set(),
    promptMessageIds: new Set(),
    assistantOwnershipByMessageId: new Map(),
    unresolvedStepsByMessageId: new Map(),
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    complete: true,
    hasSubagents: false
  };
}

/**
 * `input + cache.read + cache.write` into input, `output + reasoning` into
 * output (§4.5). Every field is present on every `step-finish` in 1.18.5
 * (fixtures README observation 23), so the arithmetic needs no guards — but
 * the defaults keep a future sparse step from producing `NaN`.
 */
export function accumulateStepUsage(
  accumulator: OpenCodeTurnTokenUsageAccumulator,
  part: OpenCodeStepUsage,
  costUsd?: number
): void {
  if (accumulator.partIds.has(part.id)) {
    return;
  }
  accumulator.partIds.add(part.id);
  const tokens = part.tokens;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  accumulator.inputTokens += (tokens.input ?? 0) + cacheRead + cacheWrite;
  accumulator.cachedInputTokens += cacheRead;
  accumulator.cacheCreationTokens += cacheWrite;
  accumulator.outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  accumulator.reasoningTokens += tokens.reasoning ?? 0;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
    accumulator.costUsd += costUsd;
  }
}

/**
 * Settles `complete` only when the turn completed *and* every step resolved;
 * otherwise `partial`, or `unavailable` when no part carried tokens (§4.5).
 */
export function takeTurnTokenUsage(
  state: OpenCodeSessionState,
  complete: boolean
): TurnTokenUsage {
  const usage = state.turnTokenUsage;
  state.turnTokenUsage = undefined;
  if (usage === undefined || usage.partIds.size === 0) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage?.hasSubagents ?? false
    };
  }
  const settled = complete && usage.complete && usage.unresolvedStepsByMessageId.size === 0;
  return {
    usageStatus: settled ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents
  };
}

// ---------------------------------------------------------------------------
// Completion machines (§4.5 "Turn completion is three machines, not a flag")
// ---------------------------------------------------------------------------

/**
 * Machine (3): `promptAsync` returned, but idle may arrive **before** it did.
 * Fixtures README observation 5 catches this 30 ms after submit in an ordinary
 * two-turn capture — it is the common case, not an edge.
 */
export interface OpenCodePromptAdmission {
  generation: number;
  turnId: string;
  /** The client-minted user message id; `prompt_async` answers 204 with no id. */
  messageId: string;
  /** A `session.command` turn is bounded by the user-message receipt, not a submit cap. */
  requiresMessageReceipt: boolean;
  messageObserved: boolean;
  busyObserved: boolean;
  accepted: boolean;
  cancelled: boolean;
  idleStatusConfirmations: number;
  idleDuringAdmission?: { turnId: string; raw: unknown };
  priorIdle?: { turnId: string; raw: unknown };
  priorAwaitingBusy: boolean;
  recoveryRaw?: unknown;
  recovering: boolean;
}

/** Machine (2): reconcile a bare `idle` against `GET /session/status`. */
export interface OpenCodeIdleReconciliation {
  turnId: string;
  promptGeneration: number;
  raw: unknown;
  warned: boolean;
  dirty: boolean;
  running: boolean;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Subagents (§7.6 roster)
// ---------------------------------------------------------------------------

/**
 * One OpenCode child session, folded into the roster as a task.
 *
 * T3 drops every child frame that is not a permission or a question, which is
 * why its OpenCode roster is thin. The captures show the child is fully
 * observable — 38 frames across eight types in fixture 12 — so the adapter
 * routes them instead (see `normalize.ts`, `demuxChild`). The task id and the
 * agent id are both the **child session id**: it is the only identifier every
 * one of those frames carries.
 */
export interface OpenCodeChildAgent {
  sessionId: string;
  parentSessionId: string;
  /** `"list files (@explore subagent)"` — the child's own session title. */
  title?: string;
  /** The `task` tool's `description`, falling back to the title. */
  description: string;
  /** The `subagent_type` the parent asked for (`explore`, `general`, …). */
  role?: string;
  /** `"<providerID>/<modelID>"`, from the parent tool part's metadata. */
  model?: string;
  /** The parent `task` tool call this child belongs to. */
  toolUseId?: string;
  /** Set when this child was itself launched from another child. */
  parentAgentId?: string;
  lastToolName?: string;
  lastStatus?: RuntimeTaskStatus;
  started: boolean;
  completed: boolean;
}

export interface OpenCodeCancellation {
  /** `undefined` = a session-wide stop rather than one turn's interrupt. */
  turnId?: string;
  acknowledged: boolean;
  turnSettled: boolean;
  deferredIdle?: unknown;
  /** Resolves once the abort has been acknowledged (HTTP reply or abort error). */
  acknowledgment: Promise<void>;
  acknowledge: () => void;
  completion: Promise<void>;
  complete: (error?: unknown) => void;
}

// ---------------------------------------------------------------------------
// The session state
// ---------------------------------------------------------------------------

export interface OpenCodeSessionState {
  readonly threadId: string;
  /** The upstream `ses_…` id. Re-pointed by a cwd fork and by a rollback fork. */
  openCodeSessionId: string;
  directory: string;
  runtimeMode: RuntimeMode;

  /** The parent plus every descendant session id seen so far. */
  relatedSessionIds: Set<string>;
  /** Every child session folded into the roster, keyed by its session id. */
  childAgents: Map<string, OpenCodeChildAgent>;

  activeTurnId?: string;
  activeAgent?: string;
  activeVariant?: string;
  interruptedTurnId?: string;
  reconcileIdleStatus: boolean;
  awaitingBusyAfterInterruption: boolean;
  promptGeneration: number;
  promptAdmission?: OpenCodePromptAdmission;
  pendingIdleReconciliation?: OpenCodeIdleReconciliation;
  cancellation?: OpenCodeCancellation;

  textPartsByMessageId: Map<string, Map<string, OpenCodeTextPartState>>;
  messageRoleById: Map<string, OpenCodeMessageRole>;
  turnTokenUsage?: OpenCodeTurnTokenUsageAccumulator;

  pendingPermissions: Map<string, OpenCodePermissionRequest>;
  pendingQuestions: Map<string, OpenCodeQuestionRequest>;
  resolvedRequestIds: Set<string>;
  emittedTerminalRequestIds: Set<string>;
  autoRepliedRequestIds: Set<string>;
  /** Child-session request ids awaiting an ancestry probe. */
  requestRelationRetries: Set<string>;

  /**
   * Last `session.error` text for the active turn. A single bad model produces
   * **three** frames, two with a full bun stack trace (fixtures README
   * observation 13) — consecutive duplicates are collapsed.
   */
  lastSessionErrorMessage?: string;
  /**
   * The last title mirrored onto the thread. `session.updated` re-states it on
   * every recompute, so only a genuine change becomes
   * `thread.metadata.updated`.
   */
  lastEmittedTitle?: string;
  stopped: boolean;
}

export function createSessionState(input: {
  threadId: string;
  openCodeSessionId: string;
  directory: string;
  runtimeMode: RuntimeMode;
}): OpenCodeSessionState {
  return {
    threadId: input.threadId,
    openCodeSessionId: input.openCodeSessionId,
    directory: input.directory,
    runtimeMode: input.runtimeMode,
    relatedSessionIds: new Set([input.openCodeSessionId]),
    childAgents: new Map(),
    reconcileIdleStatus: false,
    awaitingBusyAfterInterruption: false,
    promptGeneration: 0,
    textPartsByMessageId: new Map(),
    messageRoleById: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    resolvedRequestIds: new Set(),
    emittedTerminalRequestIds: new Set(),
    autoRepliedRequestIds: new Set(),
    requestRelationRetries: new Set(),
    stopped: false
  };
}

/** Re-point the state at a forked upstream session (cwd change or rollback). */
export function repointSession(state: OpenCodeSessionState, sessionId: string): void {
  state.openCodeSessionId = sessionId;
  state.relatedSessionIds.clear();
  state.relatedSessionIds.add(sessionId);
  state.childAgents.clear();
  state.messageRoleById.clear();
  state.textPartsByMessageId.clear();
  state.turnTokenUsage = undefined;
  state.activeTurnId = undefined;
  state.interruptedTurnId = undefined;
  state.reconcileIdleStatus = false;
  state.awaitingBusyAfterInterruption = false;
  state.pendingIdleReconciliation = undefined;
  state.lastSessionErrorMessage = undefined;
  state.lastEmittedTitle = undefined;
}

/**
 * Record a child session of this thread. A child seen during a live turn means
 * that turn used subagents, whether the relation came from `session.created`
 * or from a later ancestry lookup after a reconnect.
 */
export function addRelatedSession(state: OpenCodeSessionState, sessionId: string): void {
  if (state.relatedSessionIds.size < 512) {
    state.relatedSessionIds.add(sessionId);
  }
  if (state.activeTurnId !== undefined && state.turnTokenUsage !== undefined) {
    state.turnTokenUsage.hasSubagents = true;
  }
}

/** A message id whose role is known; `undefined` while it is still unseen. */
export function messageRoleForPart(
  state: OpenCodeSessionState,
  part: { messageID: string }
): OpenCodeMessageRole | undefined {
  return state.messageRoleById.get(part.messageID);
}
