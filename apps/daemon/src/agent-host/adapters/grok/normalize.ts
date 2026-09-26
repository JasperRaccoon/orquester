/**
 * Grok adapter — provider frames → the §4.2 runtime event union.
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/acp/AcpRuntimeModel.ts:795-884` (the `session/update`
 * switch), `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:37-50, 137`
 * (normalised → runtime events) and
 * `apps/server/src/provider/Layers/GrokAdapter.ts:1326-1470` (the notification
 * pump).
 *
 * This module is **deliberately transport-free**: it takes decoded frames and
 * returns events, so a replay test can feed it a recorded `.ndjson` and assert
 * the emitted sequence without a child process (§9). Everything stateful it
 * needs — assistant segmentation, tool-call coalescing counters, the plan-mode
 * flag, the background-task registry, the context size — lives on the instance.
 *
 * §10's rule is enforced two ways: the ACP `session/update` switch ends in
 * `satisfies never`, so a protocol release that adds a variant is a TYPE
 * error; and every unrecognised vendor `sessionUpdate` or method emits
 * `runtime.warning`, which never ends an active turn.
 */

import type {
  ApprovalDecision,
  CanonicalRequestType,
  ProviderThreadTurnSnapshot,
  RuntimeEvent,
  RuntimeEventRaw,
  RuntimeItemStatus,
  RuntimeTaskStatus,
  RuntimeTaskUsage,
  ThreadTokenUsage,
  TurnTokenUsage,
  UserInputQuestion
} from "@orquester/api/agent-chat";

import type {
  SessionNotification,
  SessionUpdate,
  ToolCallStatus
} from "./acp/_generated/schema.ts";
import type {
  XaiAskUserQuestionParams,
  XaiBackgroundTask,
  XaiGoalUpdatedUpdate,
  XaiSessionUpdate,
  XaiSubagentFinishedUpdate,
  XaiSubagentProgressUpdate,
  XaiSubagentSpawnedUpdate,
  XaiUsage
} from "./acp/_generated/xai.ts";
import {
  backgroundFromToolCall,
  endShell,
  foldBackgroundTasks,
  hasEnded,
  isEndedTaskStatus,
  monitorEvent,
  orphanAgentTasks,
  PARENT_SCOPE,
  pollLifecycle,
  rememberEndedTask,
  shellLinkage,
  taskBackgrounded,
  taskCompleted,
  type TaskEndSource,
  type TaskScope
} from "./background-tasks.ts";
import { GrokHistoryCollector } from "./history.ts";
import { goalLinkage, goalUpdated, loopLinkage, scheduledTask } from "./loops-goals.ts";
import {
  ACP_RAW_SOURCE,
  asRecord,
  createNormalizerState,
  event,
  eventWithItem,
  evictOldest,
  ownedEvent,
  textArgument,
  XAI_RAW_SOURCE,
  type GrokNormalizerDeps,
  type GrokNormalizerState
} from "./normalizer-state.ts";
import {
  nextPlanModeActive,
  planMarkdownFromToolCall
} from "./plan.ts";
import {
  childReasoning,
  childText,
  closeAssistantSegment,
  closeChildSegments,
  contentDelta
} from "./segments.ts";
import {
  acpKindFromVendorKind,
  boundRawOutput,
  boundToolContent,
  decideToolEmission,
  extractToolCommand,
  itemTypeFromToolKind,
  normalizeToolKind,
  toolContentText,
  toolProgressLength,
  type ToolCallSnapshot
} from "./tool-output.ts";
import { parseResponseCompletedUsage, parseXaiUsage, turnTokenUsage } from "./usage.ts";
import { contextTokensOf, isReplayFrame, promptIdOf, xaiToolMeta } from "./xai-meta.ts";

export { ENDED_TASKS_REMEMBERED, normalizeTaskStatus } from "./background-tasks.ts";
export {
  ACP_RAW_SOURCE,
  XAI_RAW_SOURCE,
  type GrokEventStamp,
  type GrokNormalizerDeps
} from "./normalizer-state.ts";

/** What a settled turn looks like once every source has been consulted. */
export interface GrokTurnOutcome {
  stopReason: string | null;
  usage?: XaiUsage;
  contextTokens?: number;
  /**
   * Grok's own reason for a `cancelled` stop. **This is the discriminator the
   * fixtures README asks for and does not name**: `04-permission-reject`
   * carries `cancellationCategory: "PermissionRejected"` while
   * `05-cancel-with-pending-permission` carries `"MidTurnAbort"`, so a
   * declined tool is distinguishable from a user Stop without inferring it
   * from the `permission_denied` hook or from "no cancel was sent".
   */
  cancellationCategory?: string;
  cancellationReason?: string;
}

export interface ToolTrack extends ToolCallSnapshot {
  readonly toolCallId: string;
  kind?: string;
  rawInput?: unknown;
  itemType: ReturnType<typeof itemTypeFromToolKind>;
  started: boolean;
  lastEmittedProgressLength?: number;
  skippedSinceEmit: number;
  /**
   * The call is the CLI's own `spawn_subagent` (`_meta["x.ai/tool"]` names it
   * in the `grok_build` namespace). Remembered from the frame that said so:
   * the completion drops the vendor block altogether.
   */
  spawnsSubagent: boolean;
  /**
   * A subagent's own call — its child session made it — and the turn it
   * rides: the turn live when its FIRST frame arrived, absent between parent
   * turns, for every row of the call (AGENTS.md, "Agent rows must survive
   * resumes and retention", rule 6). A parent call has neither.
   */
  owned?: { readonly agentId: string; readonly turnId: string | undefined };
}

/**
 * One subagent's child session (`subagent_spawned.child_session_id`, which is
 * also its `subagent_id`). Its frames reach this client under its own
 * `sessionId` — the child's thinking, words, tool calls, background tasks,
 * turn ends and hooks (fixture 15) — and they are that agent's own rows,
 * never the parent's state.
 */
export interface ChildSession {
  readonly sessionId: string;
  /**
   * The roster task (agent) the session is: every row it produces is owned by
   * it. A resume is a NEW child session of the SAME task (fixture 17), so a
   * segment's item id names the session as well — ingestion derives a
   * message's id from its item's, and one keyed by the task alone appended the
   * resumed run's words to the first run's settled message, in the log.
   */
  readonly taskId: string;
  /** The open assistant text segment, and the turn it rides. */
  text?: { readonly itemId: string; readonly turnId: string | undefined };
  /** The open reasoning block, and the turn it rides. */
  reasoning?: { readonly itemId: string; readonly turnId: string | undefined };
  nextSegment: number;
}

/** One roster agent `spawn_subagent` launched, keyed by its task id (§7.6). */
export interface SubagentTrack {
  readonly taskId: string;
  /** The call that launched the latest run, named on every row as `toolUseId`. */
  toolUseId: string;
  /** The call that opened the run in progress — whose kind decides how it ends. */
  owner: string;
  title: string;
  description: string;
  role?: string;
  live: boolean;
  /**
   * The run in progress goes on without its call: launched `background`, or
   * a foreground run the CLI moved to the background (its answer was not the
   * completion tag) or whose call its turn cut. Said once, on the row that
   * made it so.
   */
  backgrounded: boolean;
  /** The turn the run started in, for the rows that close it after that turn. */
  turnId?: string;
  /** A `background_tasks` snapshot listed it (see {@link foldBackgroundTasks}). */
  listed: boolean;
  /** Who wrote the latest run's end, while it is not live. */
  endedBy?: TaskEndSource;
  /** The model `subagent_spawned` named, carried on the agent's later rows. */
  model?: string;
  /**
   * Live again on the CLI's word after an end the adapter wrote itself (see
   * {@link reviveSubagent}): the roster keeps that end, so no
   * row of this run names a status that would reopen it.
   */
  revived: boolean;
}

/** One `spawn_subagent` call, keyed by its call id. */
export interface SubagentLaunch {
  readonly taskId: string;
  /** The call's own `description` argument, for joining its `subagent_spawned`. */
  readonly description?: string;
  /** `background: true` — the call answers with the subagent's id at once. */
  readonly background: boolean;
  /** The call started or reopened the run, so its failure is the run's. */
  readonly opensRun: boolean;
  /** Ids the launch's own input named: never taken for its subagent's. */
  readonly inputIds: ReadonlySet<string>;
  /**
   * The call's run went on without it: the call answered (a background launch,
   * or the CLI moved a foreground one to the background) or its turn cut it.
   * From here only the completion tag ends the run through the call — a
   * failure of the call is the call's own.
   */
  detached: boolean;
  settled: boolean;
  /** A `subagent_spawned` has named this launch's child (see {@link subagentSpawned}). */
  joined: boolean;
}

/**
 * Who wrote a finished call's end: the CLI, or the adapter's own close
 * ({@link GrokNormalizer.failOpenTools}).
 */
export interface FinishedCall {
  readonly itemType: ToolTrack["itemType"];
  readonly by: "cli" | "adapter";
}

const TOOL_STATUS_TO_ITEM_STATUS: Record<ToolCallStatus, RuntimeItemStatus> = {
  pending: "inProgress",
  in_progress: "inProgress",
  completed: "completed",
  failed: "failed"
};

/**
 * How many finished call ids the normaliser remembers, oldest forgotten
 * first. A finished call's track is dropped (a long session would otherwise
 * keep one per call), so this is what tells a late frame of a finished call
 * from a new call's first one. The bound is memory only: a resend arriving a
 * thousand calls later has never been seen.
 */
export const FINISHED_CALLS_REMEMBERED = 1_024;

export function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

/**
 * The tool that launches a subagent, in the CLI's own tool namespace — the
 * CLI's embedded docs and its Claude-compat tool table (`Agent` →
 * `spawn_subagent`). Captured (fixtures 15–23): its first frame is titled
 * `spawn_subagent` with the model's arguments as `rawInput` (`description`,
 * `prompt`, `subagent_type`, `background`, `resume_from`) and names itself in
 * `_meta["x.ai/tool"]`; the rewrite that follows is `{variant: "Task", …,
 * run_in_background, task_id: null}`.
 */
export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";
const GROK_TOOL_NAMESPACE = "grok_build";

/**
 * The `rawOutput` tag of a foreground spawn that ran its child to the end:
 * `{type: "SubagentCompleted", output, subagent_id, subagent_type,
 * tool_calls, turns, duration_ms, worktree_path, resume_from_hint}` (fixtures
 * 15, 17), a millisecond after `subagent_finished`. Any other answer — a
 * background launch's `Text`, or a foreground run's the CLI moved to the
 * background (fixture 22) — means the run goes on.
 */
const SUBAGENT_COMPLETED_OUTPUT = "SubagentCompleted";

/**
 * A subagent's result as the CLI hands it to the PARENT model: its answer,
 * then `<subagent_meta>…</subagent_meta>` and `<subagent_result>…</subagent_result>`
 * blocks naming its id, counts and how to resume it (fixtures 15–17: the
 * `SubagentCompleted` call's content, a poll's `output`). The blocks are for
 * the model; the roster's result is the answer alone. `undefined` when
 * nothing is left.
 */
export function subagentAnswerText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const answer = text
    .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/g, "")
    .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/g, "")
    .trim();
  return answer.length > 0 ? answer : undefined;
}

/** A task's usage, off the counters `subagent_progress` / `subagent_finished` carry. */
function subagentUsage(
  tokens: unknown,
  toolUses: unknown,
  durationMs: unknown
): RuntimeTaskUsage | undefined {
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const totalTokens = count(tokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const uses = count(toolUses);
  const duration = count(durationMs);
  return {
    totalTokens,
    ...(uses === undefined ? {} : { toolUses: uses }),
    ...(duration === undefined ? {} : { durationMs: duration })
  };
}

/**
 * A `subagent_finished` status as a run's end. Captured: `completed` (with
 * `output`) and `cancelled` (with `error`, no `output`) — every way a run
 * ends short: a kill, a Stop's `session/cancel` and a cut foreground call
 * ("Subagent was cancelled", fixtures 18, 21, 23), a tool of the child's the
 * user declined ("Subagent turn was cancelled: user rejected permission — …",
 * fixture 26) and the runtime's own turn cap ("max turns reached (limit: 1)",
 * fixture 28). The CLI never said `failed` in any capture; `cancelled` is
 * read as `stopped`, and its `error` is the row's reason
 * ({@link subagentFinished}). The rest follows the poll
 * vocabulary; a status nobody knows ends the run failed when it carries an
 * `error`, else completed.
 */
function finishedStatus(status: unknown, error: unknown): "completed" | "failed" | "stopped" {
  switch (typeof status === "string" ? status.trim().toLowerCase() : undefined) {
    case "interrupted":
    case "aborted":
      return "stopped";
    case "timed_out":
    case "timeout":
      return "failed";
    default:
      break;
  }
  const lifecycle = pollLifecycle(status, undefined);
  if (lifecycle !== undefined && lifecycle !== "running") {
    return lifecycle;
  }
  return typeof error === "string" && error.trim().length > 0 ? "failed" : "completed";
}

/**
 * How many launches, agents and subagent ids the normaliser remembers for
 * `resume_from`, oldest forgotten first (a live agent never is). A resume of a
 * forgotten id starts a row of its own — the same as after a host restart.
 */
export const SUBAGENTS_REMEMBERED = 512;

/**
 * How long a Grok agent counts as live work after the latest row naming it
 * (`livenessTtlMs` on every one of its rows): an hour. A run reports its end
 * (`subagent_finished`) and, while it runs, a heartbeat about every ten
 * seconds (`subagent_progress`, fixtures 16 and 19) that re-arms the hour — so
 * the bound is for a run whose reports stop without an end, which would
 * otherwise hold "working" — and every code-only deploy's drain — for as long
 * as its chat stays open. Liveness only: the roster keeps the row.
 */
export const GROK_AGENT_LIVENESS_TTL_MS = 60 * 60_000;

/** At most this many ids are taken from one launch's result. */
const IDS_PER_LAUNCH = 16;

/** Grok's subagent ids are UUIDv7 ("Subagent id must be a UUIDv7", the CLI's own message). */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function uuidsIn(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text.match(UUID_PATTERN) ?? []).map((id) => id.toLowerCase());
}

/** The `_x.ai` `sessionUpdate` names this adapter knows. */
const KNOWN_XAI_UPDATES = new Set([
  "model_changed",
  "turn_completed",
  "response_completed",
  "tool_call_delta_chunk",
  "pending_interaction",
  "interaction_resolved",
  "hook_run_started",
  "hook_execution",
  "background_tasks",
  "auto_compact_completed",
  "last_turn_summary",
  "session_summary_generated",
  "task_backgrounded",
  "task_completed",
  "monitor_event",
  "subagent_spawned",
  "subagent_progress",
  "subagent_finished",
  "scheduled_task_created",
  "scheduled_task_fired",
  "scheduled_task_deleted",
  "goal_updated"
]);

export class GrokNormalizer {
  /**
   * What the normaliser's functions share ({@link GrokNormalizerState}): the
   * work it tracks and the segmentation and plan-mode state around it. The
   * fields below are the session-level readings only this class touches.
   */
  private readonly state: GrokNormalizerState;

  /**
   * What `session/load` replayed. Collected rather than emitted (see
   * {@link handleSessionUpdate}) so a thread whose timeline the host has never
   * seen can still be reconstructed through `projectHistory` (E6).
   */
  private readonly history = new GrokHistoryCollector();

  private readonly hooks = new Map<string, string>();

  /** Slash commands, refreshed from `available_commands_update` (69, not 7). */
  private commands: ReadonlyArray<{ name: string; description?: string; input?: { hint: string } }> = [];
  private currentModelId: string | undefined;
  private currentModeId: string | undefined;
  private contextTokens: number | undefined;
  /**
   * The model's window, from `modelState.availableModels[]._meta
   * .totalContextTokens` (fixtures README observation 14). The session owns
   * the handshake that learns it and pushes it here, because **every**
   * `thread.token-usage.updated` has to carry it: the client keeps only the
   * LATEST such row, so a chunk-driven row without `maxTokens` erased the ring
   * the session-level row had just drawn, and the meter flickered on and off
   * for the whole turn.
   */
  private contextWindow: number | undefined;
  private lastTurnUsage: XaiUsage | undefined;
  private lastResponseUsage: XaiUsage | undefined;
  /** Set when a `pending_interaction` was resolved with no request of ours. */
  private selfResolvedInteractions = 0;
  private openedRequests = 0;
  /**
   * The CLI fires a `permission_denied` hook when the user declines a tool.
   * It is the fallback discriminant for README 12's ambiguous
   * `stopReason:"cancelled"` when no `prompt_complete` carried a
   * `cancellationCategory` (R4 #9).
   */
  private permissionDenied = false;

  constructor(deps: GrokNormalizerDeps, sessionId: string) {
    this.state = createNormalizerState(deps, sessionId);
  }

  // ------------------------------------------------------------------ state

  /**
   * The parent ACP session, once `session/new` (or the `session/load`
   * request) names it. Only what a child session's frames are is decided by
   * session id — a frame of any other session is the parent's, as before.
   */
  bindSession(sessionId: string): void {
    if (sessionId.trim().length > 0) {
      this.state.sessionId = sessionId.trim().toLowerCase();
    }
  }

  /** The child session a frame's `sessionId` names, if a `subagent_spawned` introduced it. */
  private childSessionOf(sessionId: unknown): ChildSession | undefined {
    return typeof sessionId === "string" ? this.state.children.get(sessionId.toLowerCase()) : undefined;
  }

  get slashCommands(): ReadonlyArray<{ name: string; description?: string; input?: { hint: string } }> {
    return this.commands;
  }

  get modelId(): string | undefined {
    return this.currentModelId;
  }

  get modeId(): string | undefined {
    return this.currentModeId;
  }

  get isPlanModeActive(): boolean {
    return this.state.planModeActive;
  }

  get contextSize(): number | undefined {
    return this.contextTokens;
  }

  /** The window the session resolved. A `0`/absent reading clears nothing. */
  setContextWindow(window: number | undefined): void {
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      this.contextWindow = window;
    }
  }

  get contextWindowTokens(): number | undefined {
    return this.contextWindow;
  }

  /** The meter payload every emission must carry — window included when known. */
  private tokenUsagePayload(usedTokens: number, maxTokens?: number): ThreadTokenUsage {
    const window = maxTokens ?? this.contextWindow;
    return {
      usedTokens,
      ...(window === undefined ? {} : { maxTokens: window }),
      compactsAutomatically: true
    };
  }

  /**
   * True when the CLI resolved approvals by itself and never asked us — the
   * `[features] support_permission` symptom (observation 5). Read once a turn
   * has settled so the adapter can warn exactly once.
   */
  get approvalsWereSelfResolved(): boolean {
    return this.selfResolvedInteractions > 0 && this.openedRequests === 0;
  }

  /** Every turn `session/load` replayed, as opaque `ThreadSnapshot` items. */
  historyTurns(): ProviderThreadTurnSnapshot[] {
    return this.history.snapshotTurns();
  }

  /** The best usage block seen for the current turn, from any source. */
  turnUsage(): XaiUsage | undefined {
    return this.lastTurnUsage ?? this.lastResponseUsage;
  }

  resetTurnUsage(): void {
    this.lastTurnUsage = undefined;
    this.lastResponseUsage = undefined;
  }

  /** True when this turn saw the CLI's `permission_denied` hook. */
  get sawPermissionDenied(): boolean {
    return this.permissionDenied;
  }

  /** A new turn begins: open the assistant stream and drop the plan fallback. */
  beginTurn(): void {
    this.state.assistantUpdatesOpen = true;
    this.permissionDenied = false;
    this.resetTurnUsage();
  }

  /**
   * The turn settled: close any open assistant bubble so the UI never keeps a
   * dangling in-progress row, and stop accepting late chunks. A subagent's
   * text or thinking riding the turn closes with it — ingestion ends every
   * segment of a turn at its end, whoever owns it, so the agent's next words
   * open a segment of their own rather than one inside a settled turn.
   *
   * A FOREGROUND subagent whose launching call is still open is NOT sent to
   * the background here. A turn that settles with the call unanswered was cut
   * by `session/cancel` (a Stop, a steer's cancel, the watchdog's interrupt),
   * and the CLI cancels the child with it: fixture 23's cut child answered
   * `subagent_finished {status: "cancelled"}` 42 ms after the cancel, and that
   * is what ends the run ({@link subagentFinished}). Until then it stays live;
   * without it, Stop, the session's stop or the exit ends it, and its liveness
   * lapses an hour after its latest row ({@link GROK_AGENT_LIVENESS_TTL_MS}).
   */
  endTurn(): RuntimeEvent[] {
    this.state.assistantUpdatesOpen = false;
    const events = closeAssistantSegment(this.state);
    const turnId = this.state.deps.activeTurnId();
    for (const child of this.state.children.values()) {
      events.push(...closeChildSegments(this.state, child, { turnId }));
    }
    return events;
  }

  // ------------------------------------------------- ACP `session/update`

  /**
   * One ACP `session/update` notification.
   *
   * A REPLAY frame (`_meta.isReplay`) produces **no events at all**, and that
   * is a deliberate, declared deviation from README 27's "the replay path must
   * keep `user_message_chunk`": the HOST owns the thread history
   * (`events.ndjson`), so re-emitting five replayed rows would duplicate the
   * timeline rather than restore it — and `session/load` replays only a
   * fraction anyway (39 events produced, 5 replayed), so it could never be a
   * reconstruction. A replayed `turn_completed` is still read for its usage
   * block (see {@link handleXaiNotification}); nothing else is.
   */
  handleSessionUpdate(params: SessionNotification): RuntimeEvent[] {
    const child = this.childSessionOf(params.sessionId);
    if (child !== undefined) {
      return isReplayFrame(params._meta) ? [] : this.childSessionUpdate(child, params);
    }
    if (isReplayFrame(params._meta)) {
      this.history.observeAcpUpdate(params.update as Record<string, unknown>);
      return [];
    }
    const contextSize = contextTokensOf(params._meta);
    const events: RuntimeEvent[] = [];
    if (contextSize !== undefined && contextSize !== this.contextTokens) {
      this.contextTokens = contextSize;
      events.push(
        this.event(
          "thread.token-usage.updated",
          { usage: this.tokenUsagePayload(contextSize) },
          undefined,
          {
            source: ACP_RAW_SOURCE,
            method: "session/update",
            payload: { _meta: params._meta }
          }
        )
      );
    }
    events.push(...this.handleUpdateBody(params.update, params));
    return events;
  }

  private handleUpdateBody(update: SessionUpdate, params: SessionNotification): RuntimeEvent[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        // Dropped during live streaming by design: the host persisted the
        // user's message before the provider ever saw it.
        return [];
      case "agent_message_chunk":
        return contentDelta(this.state, update.content, "assistant_text", params);
      case "agent_thought_chunk":
        return contentDelta(this.state, update.content, "reasoning_text", params);
      case "tool_call":
        return toolCall(this.state, update, params, "tool_call");
      case "tool_call_update":
        return toolCall(this.state, update, params, "tool_call_update");
      case "plan":
        return [
          this.event(
            "turn.plan.updated",
            {
              plan: (update.entries ?? []).map((entry, index) => ({
                step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
                status:
                  entry.status === "completed"
                    ? ("completed" as const)
                    : entry.status === "in_progress"
                      ? ("inProgress" as const)
                      : ("pending" as const)
              }))
            },
            undefined,
            { source: ACP_RAW_SOURCE, method: "session/update", payload: params }
          )
        ];
      case "available_commands_update":
        // The catalog GROWS as plugins load and arrives 2–4 times per session,
        // so the LAST one wins rather than the first (observation 20).
        this.commands = (update.availableCommands ?? []).map((command) => ({
          name: command.name,
          ...(command.description.trim().length > 0 ? { description: command.description } : {}),
          ...(command.input !== null && command.input !== undefined && "hint" in command.input
            ? { input: { hint: (command.input as { hint: string }).hint } }
            : {})
        }));
        return [];
      case "current_mode_update": {
        const modeId = update.currentModeId.trim();
        this.currentModeId = modeId.length > 0 ? modeId : undefined;
        this.state.planModeActive = this.currentModeId === "plan";
        return [];
      }
      case "config_option_update": {
        // `SessionConfigOption`'s generated type drops the `id`/`category`
        // fields the wire carries (they live on an `allOf` branch the
        // generator flattens away), so this reads them defensively.
        for (const option of (update.configOptions ?? []) as ReadonlyArray<Record<string, unknown>>) {
          if (option["id"] === "model" && typeof option["currentValue"] === "string") {
            this.currentModelId = option["currentValue"];
          }
        }
        return [];
      }
      case "session_info_update": {
        const title = update.title?.trim();
        return title === undefined || title.length === 0
          ? []
          : [this.event("thread.metadata.updated", { name: title })];
      }
      case "usage_update":
        // Defined by ACP 0.11.3 and never used by this CLI, which prefers
        // `_meta`. Handled anyway so a later release is not a surprise.
        return this.usageUpdate(update);
      default: {
        // §10 / §4.2: a protocol release that adds a variant must be a TYPE
        // error here, not a silent drop. At runtime it degrades to a visible
        // warning, which never ends an active turn.
        update satisfies never;
        return [
          this.event("runtime.warning", {
            message: "grok: unmapped ACP session/update variant",
            detail: { sessionUpdate: (update as { sessionUpdate?: unknown }).sessionUpdate }
          })
        ];
      }
    }
  }

  /**
   * One `session/update` of a subagent's child session: the agent's own rows
   * — its thinking, its words, its tool calls — owned by it (`agentId` on the
   * envelope, where ingestion reads a row's author, and on an item's payload)
   * and riding the turn live when each started. Never the parent's state: a
   * child's `_meta.totalTokens` is its own context, not the thread's (the
   * meter would jump to the child's size and back — AGENTS.md, "The context
   * meter is per adapter and never a subagent's"), and its catalog, mode,
   * title and model are its session's, not the thread's.
   */
  private childSessionUpdate(child: ChildSession, params: SessionNotification): RuntimeEvent[] {
    const update = params.update;
    const raw: RuntimeEventRaw = { source: ACP_RAW_SOURCE, method: "session/update", payload: params };
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return childText(this.state, child, update.content, raw);
      case "agent_thought_chunk":
        return childReasoning(this.state, child, update.content, raw);
      case "tool_call":
        return toolCall(this.state, update, params, "tool_call", child);
      case "tool_call_update":
        return toolCall(this.state, update, params, "tool_call_update", child);
      case "user_message_chunk":
        // The child's prompt, live (not a replay: fixture 15). The spawn
        // call's `rawInput` already holds it.
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
      case "plan":
        // The child session's own state. The thread's catalog, mode, model,
        // title, context meter and plan are the parent's alone.
        return [];
      default: {
        update satisfies never;
        return [
          this.event("runtime.warning", {
            message: "grok: unmapped ACP session/update variant",
            detail: { sessionUpdate: (update as { sessionUpdate?: unknown }).sessionUpdate, childSession: true }
          })
        ];
      }
    }
  }

  private usageUpdate(update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>): RuntimeEvent[] {
    const used = typeof update.used === "number" && Number.isFinite(update.used) ? update.used : undefined;
    const max = typeof update.size === "number" && update.size > 0 ? update.size : undefined;
    if (used === undefined) {
      return [];
    }
    this.contextTokens = used;
    // `update.size` wins when the CLI states it; otherwise the window the
    // handshake resolved is still the truth, and dropping it here would blank
    // the ring on the next chunk.
    return [
      this.event("thread.token-usage.updated", { usage: this.tokenUsagePayload(used, max) })
    ];
  }

  /** The plan the agent last wrote, for an `exit_plan_mode` with no content. */
  get lastPlanMarkdown(): string | undefined {
    const markdown = this.state.lastProposedPlan?.markdown;
    return markdown !== undefined && markdown.length > 0 ? markdown : undefined;
  }

  clearPlanFallback(): void {
    this.state.lastProposedPlan = undefined;
    this.state.planModeActive = false;
  }

  // --------------------------------------------------- the private channel

  /**
   * `_x.ai/session_notification` (live) and `_x.ai/session/update` (replay).
   * **Both names must be registered**: an adapter that knows only the first
   * silently loses the replayed `turn_completed`, `hook_execution` and usage
   * rows — exactly the data a resumed thread needs (observation 10).
   */
  handleXaiNotification(method: string, params: unknown): RuntimeEvent[] {
    const envelope = params as { sessionId?: unknown; update?: XaiSessionUpdate; _meta?: unknown } | null;
    const update = envelope?.update;
    if (update === undefined || update === null || typeof update.sessionUpdate !== "string") {
      return [
        this.event("runtime.warning", {
          message: `grok: ${method} without an update body`
        })
      ];
    }
    const child = this.childSessionOf(envelope?.sessionId);
    if (child !== undefined) {
      return isReplayFrame(envelope?._meta) ? [] : this.childXaiUpdate(child, method, update, params);
    }
    if (isReplayFrame(envelope?._meta)) {
      // Replay is history the HOST already holds for a thread it has seen;
      // for one it has not, `projectHistory` rebuilds it from here.
      this.history.observeXaiUpdate(update as Record<string, unknown>);
      this.absorbReplayUsage(update);
      return [];
    }
    return this.handleXaiUpdate(method, update, params);
  }

  private absorbReplayUsage(update: XaiSessionUpdate): void {
    if (update.sessionUpdate === "turn_completed") {
      this.lastTurnUsage = parseXaiUsage((update as { usage?: unknown }).usage) ?? this.lastTurnUsage;
    }
  }

  private handleXaiUpdate(method: string, update: XaiSessionUpdate, params: unknown): RuntimeEvent[] {
    const raw: RuntimeEventRaw = { source: XAI_RAW_SOURCE, method, payload: params };
    switch (update.sessionUpdate) {
      case "model_changed": {
        const modelId = (update as { model_id?: unknown }).model_id;
        if (typeof modelId === "string" && modelId.trim().length > 0) {
          this.currentModelId = modelId.trim();
        }
        // `reasoning_effort` here reported `"high"` even when the process was
        // launched with `--reasoning-effort low`, so it is NOT a confirmation
        // of what was requested and is deliberately not stored.
        return [];
      }
      case "turn_completed": {
        this.lastTurnUsage = parseXaiUsage((update as { usage?: unknown }).usage) ?? this.lastTurnUsage;
        return [];
      }
      case "response_completed": {
        this.lastResponseUsage =
          parseResponseCompletedUsage((update as { usage?: unknown }).usage) ?? this.lastResponseUsage;
        return [];
      }
      case "tool_call_delta_chunk":
        // Streaming tool ARGUMENTS, several per call. The `tool_call` frame
        // that follows carries the same information assembled; emitting these
        // would flood the bus for nothing.
        return [];
      case "pending_interaction":
        return [];
      case "interaction_resolved": {
        // With `support_permission` off the agent opens and resolves its own
        // interaction 6 ms apart and never asks us (observation 5). Counted so
        // the adapter can warn once per session rather than per tool call.
        this.selfResolvedInteractions += 1;
        return [];
      }
      case "hook_run_started": {
        const event = (update as { event_name?: string }).event_name ?? "hook";
        if (event === "permission_denied") {
          this.permissionDenied = true;
        }
        const tool = (update as { tool_name?: string }).tool_name;
        const hookId = this.state.deps.uuid();
        this.hooks.set(`${event}:${tool ?? ""}`, hookId);
        return [
          this.event(
            "hook.started",
            { hookId, hookName: tool === undefined ? event : `${event} (${tool})`, hookEvent: event },
            undefined,
            raw
          )
        ];
      }
      case "hook_execution": {
        const event = (update as { event_name?: string }).event_name ?? "hook";
        const tool = (update as { tool_name?: string }).tool_name;
        const key = `${event}:${tool ?? ""}`;
        const hookId = this.hooks.get(key) ?? this.state.deps.uuid();
        this.hooks.delete(key);
        const runs = (update as { runs?: ReadonlyArray<{ status?: { status?: string; error?: string } }> }).runs ?? [];
        const failed = runs.some((run) => run.status?.status !== "success");
        return [
          this.event(
            "hook.completed",
            {
              hookId,
              outcome: failed ? ("error" as const) : ("success" as const),
              ...(failed
                ? { stderr: runs.map((run) => run.status?.error ?? "").filter((text) => text.length > 0).join("\n") }
                : {})
            },
            undefined,
            raw
          )
        ];
      }
      case "background_tasks":
        return foldBackgroundTasks(
          this.state,
          (update as { tasks?: ReadonlyArray<XaiBackgroundTask> }).tasks ?? [],
          raw,
          PARENT_SCOPE
        );
      case "auto_compact_completed": {
        const before = (update as { tokens_before?: number }).tokens_before;
        const after = (update as { tokens_after?: number }).tokens_after;
        if (typeof after === "number" && after > 0) {
          this.contextTokens = after;
        }
        return [
          this.event(
            "thread.state.changed",
            {
              state: "compacted",
              ...(typeof before === "number" ? { beforeTokens: before } : {}),
              ...(typeof after === "number" ? { afterTokens: after } : {})
            },
            undefined,
            raw
          )
        ];
      }
      case "last_turn_summary":
      case "session_summary_generated":
        // The model's own one-line recap. `session_info_update` already
        // carries the title; there is no runtime event for a turn summary and
        // inventing one would put model prose in the timeline twice.
        return [];
      case "task_backgrounded":
        return taskBackgrounded(this.state, update as unknown as Record<string, unknown>, raw, PARENT_SCOPE);
      case "task_completed":
        return taskCompleted(this.state, update as unknown as Record<string, unknown>, raw);
      case "monitor_event":
        return monitorEvent(this.state, update as unknown as Record<string, unknown>, raw);
      case "subagent_spawned":
        return subagentSpawned(this.state, update as unknown as XaiSubagentSpawnedUpdate, raw);
      case "subagent_progress":
        return subagentProgress(this.state, update as unknown as XaiSubagentProgressUpdate, raw);
      case "subagent_finished":
        return subagentFinished(this.state, update as unknown as XaiSubagentFinishedUpdate, raw);
      case "scheduled_task_created":
      case "scheduled_task_fired":
      case "scheduled_task_deleted":
        return scheduledTask(this.state, update as unknown as Record<string, unknown>, raw);
      case "goal_updated":
        return goalUpdated(this.state, update as unknown as XaiGoalUpdatedUpdate, raw);
      default: {
        const name = (update as { sessionUpdate: string }).sessionUpdate;
        if (KNOWN_XAI_UPDATES.has(name)) {
          return [];
        }
        return [
          this.event(
            "runtime.warning",
            { message: `grok: unmapped ${method} update`, detail: { sessionUpdate: name } },
            undefined,
            raw
          )
        ];
      }
    }
  }

  /**
   * One private-channel frame of a subagent's child session. Its background
   * work is the agent's own ({@link TaskScope}); its turn end closes the
   * agent's open segments. The rest is the child session's own bookkeeping —
   * its usage, hooks, interactions, model, summaries and compaction — which
   * must never become the parent's: a child's `turn_completed` usage is not
   * the thread's turn (it replaced the parent's), a child's `permission_denied`
   * hook is not the parent's decline, and a hook row has no owner to carry
   * (ingestion stamps none), so a child's would land in the parent timeline.
   */
  private childXaiUpdate(
    child: ChildSession,
    method: string,
    update: XaiSessionUpdate,
    params: unknown
  ): RuntimeEvent[] {
    const raw: RuntimeEventRaw = { source: XAI_RAW_SOURCE, method, payload: params };
    const scope: TaskScope = { session: child.sessionId, owner: child.taskId };
    switch (update.sessionUpdate) {
      case "turn_completed":
        return closeChildSegments(this.state, child);
      case "background_tasks":
        return foldBackgroundTasks(
          this.state,
          (update as { tasks?: ReadonlyArray<XaiBackgroundTask> }).tasks ?? [],
          raw,
          scope
        );
      case "task_backgrounded":
        return taskBackgrounded(this.state, update as unknown as Record<string, unknown>, raw, scope);
      case "task_completed":
        return taskCompleted(this.state, update as unknown as Record<string, unknown>, raw);
      case "monitor_event":
        return monitorEvent(this.state, update as unknown as Record<string, unknown>, raw);
      case "scheduled_task_created":
      case "scheduled_task_fired":
      case "scheduled_task_deleted":
        // Not captured from a child: a fire's own subagent is told it may
        // delete its loop, and the scheduler knows it by its task id alone.
        return scheduledTask(this.state, update as unknown as Record<string, unknown>, raw);
      default: {
        const name = (update as { sessionUpdate: string }).sessionUpdate;
        if (KNOWN_XAI_UPDATES.has(name) && name !== "goal_updated") {
          return [];
        }
        return [
          this.event(
            "runtime.warning",
            { message: `grok: unmapped ${method} update`, detail: { sessionUpdate: name, childSession: true } },
            undefined,
            raw
          )
        ];
      }
    }
  }

  // ------------------------------------------------------ background tasks

  /**
   * The monitors a wake carries lines of, re-armed as its turn opens. A
   * monitor's line arrives just BEFORE the wake it causes (fixture 20: a line,
   * then the CLI's own prompt carrying it), so the liveness registry's
   * turn-boundary sweep — a watch loop that reported nothing during a turn
   * was not live — read the monitor as silent through that wake and dropped
   * it at its end, and a code-only deploy stopped waiting for it between
   * lines. One status-less `task.progress` per live monitor the wake names
   * (the registry re-arms only a live entry), carrying its latest line —
   * the row replaces the monitor's own progress row, so this costs no row.
   * Only the monitors the wake names: re-arming every live monitor at every
   * wake would let unrelated wakes hold a silent one forever.
   */
  rearmMonitors(taskIds: readonly string[]): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const taskId of taskIds) {
      const track = this.state.tasks.get(taskId);
      if (track === undefined || track.taskType !== "monitor") {
        continue;
      }
      const linkage = shellLinkage(taskId, track);
      events.push(
        this.event(
          "task.progress",
          {
            ...linkage,
            description: linkage.title,
            ...(track.lastLine === undefined ? {} : { summary: track.lastLine })
          },
          track.turnId
        )
      );
    }
    return events;
  }

  /**
   * Close every live background task and every live subagent. Called before
   * `session.exited`, on the session's stop and on a session-scoped Stop,
   * because a running state must never outlive its process (§3.1) — and
   * because a background run's own end shows only when the CLI reports it.
   * The session closes the open calls FIRST ({@link failOpenTools}): calls
   * before tasks, as every adapter's teardown orders them.
   *
   * `leftRunning` is said on a shell's or a monitor's row when its PROCESS
   * outlives this end — a deploy, a restart or a crash ends the session
   * without the user, and only the user's end sweeps the work
   * (`GrokSession.stop`): a subagent, a loop and a goal live in the CLI and
   * end with it.
   *
   * These are the adapter's own ends, not the CLI's: fixture 21 shows a
   * session-scoped Stop's `session/cancel` cancelling a background subagent
   * (`subagent_finished {status: "cancelled"}`, which then adds no row) while
   * a background shell runs on — and on past the CLI's own exit — so a later
   * report that a task still runs counts it live again ({@link shellReport}).
   */
  stopBackgroundTasks(leftRunning?: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    // Shells and monitors first: a subagent's own ones are closed with the
    // rest, so its end below leaves none to count on its own.
    for (const [taskId, track] of [...this.state.tasks.entries()]) {
      endShell(this.state, taskId, "adapter");
      events.push(
        this.event(
          "task.completed",
          {
            ...shellLinkage(taskId, track),
            status: "stopped",
            // Its process outlives this end (a deploy, a restart, a crash):
            // the row says so rather than reading stopped for work that runs,
            // marked as the adapter's note — the one summary a stopped
            // shell's roster row shows.
            ...(leftRunning === undefined ? {} : { summary: leftRunning, leftRunning: true })
          },
          track.turnId
        )
      );
    }
    // A loop and a goal live in the CLI's process: its exit ends them (a loop
    // made `durable` would be the CLI's to bring back, not captured). After a
    // Stop that leaves the process up — whether its `session/cancel` stops
    // either is not captured — the CLI's later reports note themselves on the
    // ended rows (a fire, a goal's progress), and only the CLI re-creating a
    // loop or resuming a goal it ended itself opens a new run
    // ({@link scheduledTask}, {@link goalUpdated}).
    for (const loop of this.state.loops.values()) {
      if (loop.live) {
        loop.live = false;
        events.push(this.event("task.completed", { ...loopLinkage(loop), status: "stopped" }, loop.turnId));
      }
    }
    if (this.state.goal?.live === true) {
      this.state.goal.live = false;
      this.state.goal.endedBy = "adapter";
      events.push(
        this.event("task.completed", { ...goalLinkage(this.state.goal), status: "stopped" }, this.state.goal.turnId)
      );
    }
    for (const track of this.state.subagents.values()) {
      if (!track.live) {
        continue;
      }
      const owner = this.state.subagentLaunches.get(track.owner);
      if (owner !== undefined) {
        owner.settled = true;
      }
      events.push(...closeSubagent(this.state, track, "stopped", "adapter"));
    }
    return events;
  }

  /**
   * Every live tool call, failed — the parent's and every subagent's, each
   * on its own turn and under its owner — then every open bubble and thinking
   * block. Same rule as {@link stopBackgroundTasks}, for the item rows, and
   * run before it.
   */
  failOpenTools(reason: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [toolCallId, track] of [...this.state.tools.entries()]) {
      events.push(...failTool(this.state, toolCallId, track, reason));
    }
    events.push(...closeAssistantSegment(this.state));
    for (const child of this.state.children.values()) {
      events.push(...closeChildSegments(this.state, child));
    }
    return events;
  }

  /**
   * The calls a `session/cancel` cut: every open PARENT call — the prompt's
   * own foreground work: a question's call, a `write` its permission held, a
   * foreground spawn — failed with the reason and remembered as the adapter's
   * end. After the cancel the CLI answers none of them (fixtures 05, 23 and
   * 31: no terminal frame, ever — every other call in every capture gets
   * one), so left open each read in progress for good: in the MCP transcript,
   * in one of retention's open-work slots, and to the next host's first
   * load, which closed it "when the agent host restarted". A background
   * launch is no open call: its call answers at once and the WORK runs on. A
   * subagent's own calls are not the prompt's either: a cut foreground
   * child's close with its run when `subagent_finished` comes
   * ({@link closeSubagent}), a background child's outlive the turn.
   */
  cutTurnCalls(reason: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [toolCallId, track] of [...this.state.tools.entries()]) {
      if (track.owned === undefined) {
        events.push(...failTool(this.state, toolCallId, track, reason));
      }
    }
    return events;
  }

  // ------------------------------------------------------------- requests

  /** `session/request_permission` → `request.opened`. */
  requestOpened(input: {
    requestId: string;
    requestType: CanonicalRequestType;
    detail: string;
    args: unknown;
    raw: RuntimeEventRaw;
  }): RuntimeEvent {
    this.openedRequests += 1;
    const base = this.event(
      "request.opened",
      {
        requestType: input.requestType,
        // Every one of these blocks the agent's JSON-RPC response until it is
        // answered, so none of them may be dismissed (§6.2).
        dismissible: false,
        detail: input.detail,
        args: input.args
        // `options` is deliberately ABSENT: the UI then shows §4.3's canonical
        // four buttons, and `selectPermissionOptionId` translates the chosen
        // decision back into Grok's own option id. Forwarding the provider's
        // list would expose "always allow" only when Grok happened to offer
        // it and would defeat the adapter's session-grant emulation.
      },
      undefined,
      input.raw
    );
    return { ...base, requestId: input.requestId };
  }

  /**
   * `withdrawn`: nobody answered the card — a Stop, a steer, the session's
   * stop, the exit — so ingestion writes the host's own "Request cancelled".
   */
  requestResolved(input: {
    requestId: string;
    requestType: CanonicalRequestType;
    decision: ApprovalDecision;
    withdrawn?: true;
  }): RuntimeEvent {
    const base = this.event("request.resolved", {
      requestType: input.requestType,
      decision: input.decision,
      ...(input.withdrawn === true ? { withdrawn: true } : {})
    });
    return { ...base, requestId: input.requestId };
  }

  /** `_x.ai/ask_user_question` → `user-input.requested`. */
  /**
   * `turnId`: the turn the question's rows ride, stamped once by the session
   * so the request and its resolution agree — `null` for none at all, never
   * the open turn (`GrokSession.questionTurnId`).
   */
  userInputRequested(input: {
    requestId: string;
    params: XaiAskUserQuestionParams;
    raw: RuntimeEventRaw;
    turnId?: string | null;
  }): RuntimeEvent {
    const questions: UserInputQuestion[] = input.params.questions.map((question) => ({
      // The question carries NO `id` on this CLI, so the text is the only key
      // that can work — and it is also the key the answer map uses.
      id: question.id ?? question.question,
      header: "Question",
      question: question.question,
      multiSelect: question.multiSelect === true,
      options:
        question.options.length > 0
          ? question.options.map((option) => ({
              label: option.label,
              description: option.description ?? option.label
            }))
          : [{ label: "OK", description: "Continue" }]
    }));
    const base = this.event(
      "user-input.requested",
      { questions, dismissible: false },
      input.turnId ?? undefined,
      input.raw
    );
    return ridingTurn({ ...base, requestId: input.requestId }, input.turnId);
  }

  /** `withdrawn`: nobody answered the question ("Question cancelled"), as for an approval. */
  userInputResolved(
    requestId: string,
    answers: Record<string, unknown>,
    turnId?: string | null,
    withdrawn = false
  ): RuntimeEvent {
    const base = this.event(
      "user-input.resolved",
      { answers, ...(withdrawn ? { withdrawn: true } : {}) },
      turnId ?? undefined
    );
    return ridingTurn({ ...base, requestId: requestId }, turnId);
  }

  // ---------------------------------------------------------------- turns

  /** `turn.completed`, from whichever sources settled the turn. */
  turnCompleted(turnId: string, outcome: GrokTurnOutcome, errorMessage?: string): RuntimeEvent {
    // "Did THIS turn have subagents?" (Codex's rule): a live agent from an
    // earlier turn is not this turn's, and a background shell is no subagent.
    const usage = turnTokenUsage(outcome.usage, this.state.lastSubagentTurnId === turnId);
    const state = turnStateFromOutcome(outcome, errorMessage);
    const costUsd =
      outcome.usage?.costUsdTicks === undefined ? undefined : outcome.usage.costUsdTicks / 1_000_000_000;
    return this.event(
      "turn.completed",
      {
        state,
        stopReason: outcome.stopReason,
        tokenUsage: usage satisfies TurnTokenUsage,
        ...(costUsd === undefined ? {} : { totalCostUsd: costUsd }),
        ...(errorMessage === undefined ? {} : { errorMessage })
      },
      turnId
    );
  }

  // --------------------------------------------------------------- helpers

  /** Build an event of any arm of the union with the shared envelope. */
  event(
    type: RuntimeEvent["type"],
    payload: unknown,
    turnId?: string,
    raw?: RuntimeEventRaw
  ): RuntimeEvent {
    return event(this.state, type, payload, turnId, raw);
  }
}

function toolCall(
  state: GrokNormalizerState,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  params: SessionNotification,
  method: string,
  owner?: ChildSession
): RuntimeEvent[] {
  const toolCallId = update.toolCallId;
  if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
    return [];
  }

  const previous = state.tools.get(toolCallId);
  // A frame of a call that already FINISHED has no lifecycle left to report.
  // Emitted, a status-less one opened the call again as a new `item.started`
  // and re-registered it as live, and the exit sweep (`failOpenTools`) then
  // failed a call that had completed; a terminal restatement wrote a second
  // `tool.completed` and closed the open assistant bubble. Both are dropped
  // — except the CLI's own end of a call the ADAPTER closed (a Stop's
  // `failOpenTools`), which is the call's first real end and lands.
  const finished = previous === undefined ? state.finishedCalls.get(toolCallId) : undefined;
  if (finished !== undefined && (finished.by === "cli" || !isTerminalToolStatus(update.status))) {
    return [];
  }
  const vendor = xaiToolMeta(update._meta);
  // Subagents cannot spawn subagents (depth one, the CLI's docs): a child's
  // call is never a launch.
  const spawnsSubagent =
    owner === undefined &&
    (previous?.spawnsSubagent === true ||
      (vendor?.name === SPAWN_SUBAGENT_TOOL && vendor.namespace === GROK_TOOL_NAMESPACE));
  const kind = normalizeToolKind(update.kind) ?? previous?.kind;
  const title = update.title ?? previous?.title;
  const status = (update.status ?? previous?.status ?? (method === "tool_call" ? "pending" : undefined)) as
    | ToolCallStatus
    | undefined;
  const content = update.content === undefined ? previous?.content : boundToolContent(update.content);
  const rawOutput = update.rawOutput === undefined ? previous?.rawOutput : boundRawOutput(update.rawOutput);
  const rawInput = update.rawInput ?? previous?.rawInput;
  const command = extractToolCommand(rawInput, title ?? undefined);
  const contentText = toolContentText(content);
  // On a FAILED call the content is the reason — "User rejected the
  // execution for tool `write`" — and that is what the row must read.
  // Everywhere else the command is the better summary (T3's order).
  const detail =
    status === "failed"
      ? (contentText ?? command ?? title ?? undefined)
      : (command ?? contentText ?? title ?? undefined);

  const next: ToolTrack = {
    toolCallId,
    kind: kind ?? undefined,
    rawInput,
    // `_meta["x.ai/tool"].kind` is Grok's own authoritative discriminant, it
    // is finer-grained than ACP's, and it is present on the FIRST frame of a
    // call where ACP's `kind` is still absent — so it leads. A subagent's
    // launch is an agent launch, as Claude's `Agent` call is.
    itemType:
      finished?.itemType ??
      (spawnsSubagent
        ? "collab_agent_tool_call"
        : itemTypeFromToolKind(acpKindFromVendorKind(vendor?.kind) ?? kind ?? undefined)),
    spawnsSubagent,
    ...(previous?.owned !== undefined
      ? { owned: previous.owned }
      : owner === undefined
        ? {}
        : { owned: { agentId: owner.taskId, turnId: state.deps.activeTurnId() } }),
    started: previous?.started === true,
    title: title ?? undefined,
    status: status ?? undefined,
    detail,
    content,
    rawOutput,
    lastEmittedProgressLength: previous?.lastEmittedProgressLength,
    skippedSinceEmit: previous?.skippedSinceEmit ?? 0
  };

  const decision = decideToolEmission({
    previous,
    next,
    lastEmittedProgressLength: previous?.lastEmittedProgressLength,
    skippedSinceEmit: previous?.skippedSinceEmit ?? 0
  });

  const events: RuntimeEvent[] = [];
  const terminal = status === "completed" || status === "failed";

  if (decision.emit) {
    // A tool call ends its author's current bubble and thinking block.
    events.push(...(owner === undefined ? closeAssistantSegment(state) : closeChildSegments(state, owner)));

    const lifecycle = terminal ? "item.completed" : next.started ? "item.updated" : "item.started";
    next.started = true;
    next.lastEmittedProgressLength = toolProgressLength(next);
    next.skippedSinceEmit = 0;
    const payload = {
      itemType: next.itemType,
      ...(status === undefined ? {} : { status: TOOL_STATUS_TO_ITEM_STATUS[status] }),
      ...(next.title === undefined ? {} : { title: next.title }),
      ...(next.detail === undefined ? {} : { detail: next.detail }),
      ...(next.owned === undefined ? {} : { agentId: next.owned.agentId }),
      data: {
        toolUseId: toolCallId,
        ...(next.kind === undefined ? {} : { kind: next.kind }),
        ...(command === undefined ? {} : { command }),
        ...(vendor === undefined ? {} : { vendorTool: vendor.name, readOnly: vendor.read_only }),
        ...(rawInput === undefined ? {} : { rawInput }),
        ...(rawOutput === undefined ? {} : { rawOutput }),
        ...(content === undefined ? {} : { content }),
        ...(update.locations === undefined || update.locations === null
          ? {}
          : { locations: update.locations })
      }
    };
    const lifecycleRaw: RuntimeEventRaw = {
      source: ACP_RAW_SOURCE,
      method: `session/update:${method}`,
      payload: params
    };
    events.push(
      next.owned === undefined
        ? eventWithItem(state, lifecycle, payload, toolCallId, lifecycleRaw)
        : ownedEvent(state, lifecycle, payload, next.owned.agentId, next.owned.turnId, toolCallId, lifecycleRaw)
    );
  } else {
    next.skippedSinceEmit = decision.skipped;
  }

  if (terminal) {
    state.tools.delete(toolCallId);
    rememberFinishedCall(state, toolCallId, next.itemType, "cli");
  } else {
    state.tools.set(toolCallId, next);
  }

  const raw: RuntimeEventRaw = {
    source: ACP_RAW_SOURCE,
    method: `session/update:${method}`,
    payload: params
  };
  if (owner !== undefined) {
    // A child's plan mode is its own session's; the thread's is the parent's.
    events.push(
      ...backgroundFromToolCall(state, toolCallId, rawInput, rawOutput, status, raw, {
        session: owner.sessionId,
        owner: owner.taskId
      })
    );
    return events;
  }

  // Plan mode is DECLARED, so the flag follows the tool call regardless of
  // whether the row itself was emitted.
  state.planModeActive = nextPlanModeActive(state.planModeActive, {
    title: next.title,
    status: next.status,
    rawInput: update.rawInput,
    meta: update._meta
  });
  if (state.planModeActive) {
    const markdown = planMarkdownFromToolCall(
      { rawInput: update.rawInput, content },
      state.deps.planHost
    );
    if (markdown !== undefined) {
      events.push(...proposePlan(state, markdown, { source: ACP_RAW_SOURCE, method: "session/update", payload: params }));
    }
  }

  events.push(
    ...(spawnsSubagent
      ? subagentFromToolCall(state, toolCallId, rawInput, update, status, raw)
      : backgroundFromToolCall(state, toolCallId, rawInput, rawOutput, status, raw, PARENT_SCOPE))
  );
  return events;
}

/** Oldest first out, so the memory stays within {@link FINISHED_CALLS_REMEMBERED}. */
function rememberFinishedCall(
  state: GrokNormalizerState,
  toolCallId: string,
  itemType: ToolTrack["itemType"],
  by: FinishedCall["by"]
): void {
  state.finishedCalls.delete(toolCallId);
  state.finishedCalls.set(toolCallId, { itemType, by });
  evictOldest(state.finishedCalls, FINISHED_CALLS_REMEMBERED);
}

/**
 * A `spawn_subagent` call → a roster agent (§7.6). Captured (fixtures
 * 15–23): the call, then `subagent_spawned` naming the run's id and child
 * session ({@link subagentSpawned}), the child's own frames under that
 * session ({@link childSessionUpdate}), `subagent_progress` heartbeats
 * ({@link subagentProgress}) and `subagent_finished` — the run's end, every
 * way it ends ({@link subagentFinished}).
 *
 * - The call's first frame STARTS the agent: `task.started`, agent-kind
 *   (`taskType: "subagent"`), stamped with its own id like every Grok task,
 *   launched by the call (`toolUseId`), so the GUI hides the launch row
 *   behind the agent's the way it hides a Claude `Agent` call.
 * - `subagent_finished` ends it, once. The call's own answer ends it only
 *   when that end never came: a foreground call answered with the completion
 *   tag (`SubagentCompleted`) ends the agent with the CLI's `output` as its
 *   result; a call that fails before its run goes on fails it.
 * - Any other answer means the run goes on without its call: a
 *   `background: true` launch answers at once with the subagent's id (a
 *   `Text` answer, fixture 16), and the CLI moves a foreground run past its
 *   await budget to the background (fixture 22: "Subagent took longer than
 *   the foreground budget and was moved to the background…"). A foreground
 *   call its turn cut is NOT one of these: the CLI cancels the child with
 *   the turn (fixture 23; {@link endTurn}). Such a run ends by
 *   `subagent_finished`, a poll or kill answer ({@link
 *   backgroundFromToolCall}, T3's reader), Stop, the session's stop or the
 *   process's exit ({@link stopBackgroundTasks}); its liveness lapses an
 *   hour after the latest row naming it ({@link GROK_AGENT_LIVENESS_TTL_MS}).
 * - `resume_from` re-launches a completed subagent. The relaunch contract
 *   (AGENTS.md, "Agent rows must survive resumes and retention", rule 1):
 *   the SAME task starts again under the NEW call, before any row of the
 *   run, so the roster reopens it; the task is found by the subagent id the
 *   source launch reported ({@link learnSubagentIds}) — the resume spawns a
 *   NEW subagent id, joined to the same task by `resumed_from` (fixture
 *   17); an id no launch reported (a host restart since) names a task of its
 *   own.
 */
function subagentFromToolCall(
  state: GrokNormalizerState,
  toolCallId: string,
  rawInput: unknown,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  status: ToolCallStatus | undefined,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  let launch = state.subagentLaunches.get(toolCallId);
  if (launch === undefined) {
    launch = launchSubagent(state, toolCallId, asRecord(rawInput), raw, events);
  }
  if (isTerminalToolStatus(status) && !launch.settled) {
    launch.settled = true;
    events.push(...settleSubagentLaunch(state, launch, status === "failed", update, raw));
  }
  return events;
}

function launchSubagent(
  state: GrokNormalizerState,
  toolCallId: string,
  input: Record<string, unknown> | undefined,
  raw: RuntimeEventRaw,
  events: RuntimeEvent[]
): SubagentLaunch {
  const resumeFrom = textArgument(input, "resume_from");
  const taskId =
    resumeFrom === undefined
      ? toolCallId
      : (state.subagentIds.get(resumeFrom.toLowerCase()) ?? resumeFrom);
  const description = textArgument(input, "description");
  const role = textArgument(input, "subagent_type");
  // `background` is the tool's own argument (its documented parameter; the
  // first frame carries the model's arguments as it wrote them).
  const background = input?.["background"] === true;
  const existing = state.subagents.get(taskId);
  const opensRun = existing?.live !== true;
  const title = description ?? existing?.title ?? role ?? "Subagent";
  const track: SubagentTrack = existing ?? {
    taskId,
    toolUseId: toolCallId,
    owner: toolCallId,
    title,
    description: title,
    live: false,
    backgrounded: false,
    listed: false,
    revived: false
  };
  track.toolUseId = toolCallId;
  track.title = title;
  track.description = description ?? track.description;
  if (role !== undefined) {
    track.role = role;
  }
  // Any launch naming the agent — a resume of a live one included — starts
  // what a snapshot must list anew: a listing of the run before it, dropped
  // from the next snapshot, is no end of this one. Its start names a new
  // call, which reopens the roster's row: the run is no longer one the
  // roster holds ended.
  track.listed = false;
  track.revived = false;
  if (opensRun) {
    track.owner = toolCallId;
    track.live = true;
    track.backgrounded = background;
    track.turnId = state.deps.activeTurnId();
    track.endedBy = undefined;
  }
  state.subagents.delete(taskId);
  state.subagents.set(taskId, track);
  evictOldest(state.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);

  const launch: SubagentLaunch = {
    taskId,
    ...(description === undefined ? {} : { description }),
    background,
    opensRun,
    inputIds: new Set(uuidsIn(input)),
    detached: false,
    settled: false,
    joined: false
  };
  state.subagentLaunches.set(toolCallId, launch);
  evictOldest(state.subagentLaunches, SUBAGENTS_REMEMBERED);
  state.lastSubagentTurnId = state.deps.activeTurnId();

  events.push(
    event(
      state,
      "task.started",
      {
        ...subagentLinkage(track),
        description: track.description,
        isBackgrounded: background
      },
      undefined,
      raw
    )
  );
  return launch;
}

/**
 * The launch's call reached its end. Only the completion tag ends a run
 * through its call; any other answer sends it on in the background. A failed
 * call fails the run it opened — unless the run had already gone on without
 * it (a cut call's failure is the call's own) — and a resume the CLI refused
 * (its source still running) fails the call and never the agent it named. A
 * resume answered with the completion tag proves the earlier run over,
 * whatever this adapter had seen of it.
 */
function settleSubagentLaunch(
  state: GrokNormalizerState,
  launch: SubagentLaunch,
  failed: boolean,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = state.subagents.get(launch.taskId);
  if (track === undefined) {
    return [];
  }
  if (failed) {
    if (!launch.opensRun) {
      track.toolUseId = track.owner;
      return [];
    }
    if (launch.detached || !track.live) {
      return [];
    }
    return closeSubagent(state, track, "failed", "cli", toolContentText(update.content), raw);
  }
  learnSubagentIds(state, launch, update);
  const output = asRecord(update.rawOutput);
  if (output?.["type"] === SUBAGENT_COMPLETED_OUTPUT) {
    // Normally a no-op: `subagent_finished` arrives a millisecond before
    // this answer and has ended the run already (fixtures 15, 17). The
    // CLI's own `output` is the answer; the call's text adds the
    // `<subagent_meta>` / `<subagent_result>` blocks for the parent model.
    const answer =
      subagentAnswerText(typeof output["output"] === "string" ? output["output"] : undefined) ??
      subagentAnswerText(toolContentText(update.content));
    return track.live ? closeSubagent(state, track, "completed", "cli", answer, raw) : [];
  }
  launch.detached = true;
  return track.live ? backgroundSubagent(state, track, raw) : [];
}

/**
 * A foreground run that goes on without its call, said once:
 * `task.updated {isBackgrounded: true}` — the roster keeps a live
 * background row in view — naming the turn the run started in.
 */
function backgroundSubagent(state: GrokNormalizerState, track: SubagentTrack, raw?: RuntimeEventRaw): RuntimeEvent[] {
  if (track.backgrounded) {
    return [];
  }
  track.backgrounded = true;
  return [
    event(
      state,
      "task.updated",
      { ...subagentLinkage(track), isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/**
 * `subagent_spawned`, in the parent's session, before any frame of the
 * child (fixtures 15–23). It names the run's `subagent_id` — which IS its
 * child session's id — and, for a resume, the source it continues: a
 * `resume_from` launch spawns a NEW id naming its source in `resumed_from`
 * (fixture 17). Joined to its launch:
 * - an id a launch already reported is that launch's agent (a background
 *   launch answers with its id a few milliseconds BEFORE this frame,
 *   fixture 16);
 * - a resume is the task its source is;
 * - else the oldest `spawn_subagent` launch no spawn has named yet — one
 *   whose description matches first, since calls of one response spawn in
 *   order.
 * A spawn no launch explains — the CLI's own (a `/loop` fire runs "in a
 * detached background subagent", its docs say; not captured) — is an agent
 * of its own, under its subagent id. From here the child session's frames
 * are that agent's own rows ({@link childSessionUpdate}).
 */
function subagentSpawned(
  state: GrokNormalizerState,
  update: XaiSubagentSpawnedUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const record = update as unknown as Record<string, unknown>;
  const subagentId = textArgument(record, "subagent_id");
  if (subagentId === undefined) {
    return [
      event(state, "runtime.warning", { message: "grok: subagent_spawned without a subagent_id" }, undefined, raw)
    ];
  }
  const description = textArgument(record, "description");
  const resumedFrom = textArgument(record, "resumed_from");
  const events: RuntimeEvent[] = [];
  let taskId =
    state.subagentIds.get(subagentId.toLowerCase()) ??
    (resumedFrom === undefined ? undefined : state.subagentIds.get(resumedFrom.toLowerCase())) ??
    unjoinedLaunch(state, description)?.taskId;
  if (taskId === undefined) {
    taskId = subagentId;
    events.push(...startUnlaunchedSubagent(state, subagentId, record, raw));
  }
  const track = state.subagents.get(taskId);
  const launch = track === undefined ? undefined : state.subagentLaunches.get(track.toolUseId);
  if (launch !== undefined) {
    launch.joined = true;
  }
  const model = textArgument(record, "model");
  if (track !== undefined && model !== undefined) {
    track.model = model;
  }
  rememberSubagentId(state, subagentId, taskId);
  const childSessionId = textArgument(record, "child_session_id") ?? subagentId;
  rememberSubagentId(state, childSessionId, taskId);
  state.children.delete(childSessionId.toLowerCase());
  state.children.set(childSessionId.toLowerCase(), { sessionId: childSessionId, taskId, nextSegment: 0 });
  evictOldest(state.children, SUBAGENTS_REMEMBERED, (child) => state.subagents.get(child.taskId)?.live !== true);
  return events;
}

/** The oldest live launch no `subagent_spawned` has named yet — a matching description first. */
function unjoinedLaunch(state: GrokNormalizerState, description: string | undefined): SubagentLaunch | undefined {
  let oldest: SubagentLaunch | undefined;
  for (const launch of state.subagentLaunches.values()) {
    if (launch.joined || state.subagents.get(launch.taskId)?.live !== true) {
      continue;
    }
    if (description !== undefined && launch.description === description) {
      return launch;
    }
    oldest ??= launch;
  }
  return oldest;
}

/**
 * An agent the CLI spawned with no `spawn_subagent` call of this session's:
 * started under its own id, which is also its launch id (the relaunch
 * contract's first start), backgrounded — nothing waits on it.
 */
function startUnlaunchedSubagent(
  state: GrokNormalizerState,
  subagentId: string,
  record: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const role = textArgument(record, "subagent_type");
  const title = textArgument(record, "description") ?? role ?? "Subagent";
  const track: SubagentTrack = {
    taskId: subagentId,
    toolUseId: subagentId,
    owner: subagentId,
    title,
    description: title,
    ...(role === undefined ? {} : { role }),
    live: true,
    backgrounded: true,
    turnId: state.deps.activeTurnId(),
    listed: false,
    revived: false
  };
  state.subagents.set(subagentId, track);
  evictOldest(state.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);
  return [
    event(
      state,
      "task.started",
      { ...subagentLinkage(track), description: title, isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/**
 * `subagent_progress`: the child's heartbeat — about every ten seconds while
 * it runs, and after each of its tool calls (fixtures 16, 19). One
 * status-less `task.progress` carrying its counters: a heartbeat never names
 * a status, so a late one cannot reopen an ended run, and it re-arms the
 * agent's hour ({@link GROK_AGENT_LIVENESS_TTL_MS}). Progress rows have a
 * stable per-task id and replace the last, so the heartbeat costs one row
 * per agent, not one per tick. A heartbeat of a run the adapter closed
 * itself is the CLI saying it still runs ({@link subagentReport}).
 */
function subagentProgress(
  state: GrokNormalizerState,
  update: XaiSubagentProgressUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = subagentNamed(state, String(update.subagent_id ?? ""));
  if (track === undefined) {
    return [];
  }
  if (!track.live) {
    return subagentReport(state, track, true, raw);
  }
  const usage = subagentUsage(update.tokens_used, update.tool_call_count, update.duration_ms);
  return [
    event(
      state,
      "task.progress",
      {
        ...subagentLinkage(track),
        description: track.title,
        ...(usage === undefined ? {} : { usage })
      },
      track.turnId,
      raw
    )
  ];
}

/**
 * `subagent_finished`: the run's end, foreground or background, whoever
 * ended it — its own answer, a kill, a Stop's `session/cancel`, a cut call
 * (fixtures 15–23). The CLI's end, once: `completed` with its `output` as the
 * agent's result, `cancelled` as `stopped`, a failure with its `error`, and
 * the run's counters as its usage. A run already ended gets nothing more —
 * the foreground call's `SubagentCompleted` answer a millisecond later, a
 * kill answer before it (fixture 18) — and one the adapter closed itself
 * (Stop) takes it as the CLI's final word, with no row ({@link subagentReport}).
 * `will_wake: true` announces the parent's wake, which is the session's.
 */
function subagentFinished(
  state: GrokNormalizerState,
  update: XaiSubagentFinishedUpdate,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = subagentNamed(state, String(update.subagent_id ?? ""));
  if (track === undefined) {
    return [];
  }
  if (!track.live) {
    return subagentReport(state, track, false, raw);
  }
  const owner = state.subagentLaunches.get(track.owner);
  if (owner !== undefined) {
    owner.settled = true;
  }
  const status = finishedStatus(update.status, update.error);
  const answer = subagentAnswerText(typeof update.output === "string" ? update.output : undefined);
  const error = typeof update.error === "string" && update.error.trim().length > 0 ? update.error.trim() : undefined;
  // A run that ended short says why in `error` — a declined tool, a turn
  // cap, a kill — and a `stopped` row without it read as a bare "Stopped"
  // (fixtures 26, 28): the reason is its summary, as a failure's is.
  const summary = status === "completed" ? answer : (error ?? answer);
  const usage = subagentUsage(update.tokens_used, update.tool_calls, update.duration_ms);
  return closeSubagent(state, track, status, "cli", summary, raw, usage);
}

/**
 * Remember the subagent id(s) a launch reported, for a later `resume_from`.
 * Read shape-free — the UUIDs in what the call returned: the CLI's subagent
 * ids are UUIDv7, and the result is where the parent model learns the id it
 * later passes to `resume_from` (captured: a background launch's `Text`
 * answer names `subagent_id: <id>`, fixture 16; a foreground result's
 * `SubagentCompleted` output its `subagent_id` and `resume_from_hint`,
 * fixture 15). `subagent_spawned` names it too ({@link subagentSpawned});
 * whichever comes first is kept.
 *
 * The CLI's own `rawOutput` is read first, and the text only when it names
 * none: the text of a foreground result is the subagent's summary, model
 * prose that may quote any id. Never taken: an id the launch's own input
 * named (a prompt quoting another agent's), the session's own id, a live
 * shell's (whose snapshot rows must stay the shell's), and an id an earlier
 * launch reported first.
 */
function learnSubagentIds(
  state: GrokNormalizerState,
  launch: SubagentLaunch,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>
): void {
  const usable = (id: string): boolean =>
    !launch.inputIds.has(id) &&
    id !== state.sessionId &&
    !state.tasks.has(id) &&
    !hasEnded(state, id) &&
    !state.subagentIds.has(id);
  const structured = uuidsIn(update.rawOutput).filter(usable);
  const ids = structured.length > 0 ? structured : uuidsIn(update.content).filter(usable);
  for (const id of ids.slice(0, IDS_PER_LAUNCH)) {
    rememberSubagentId(state, id, launch.taskId);
  }
}

function rememberSubagentId(state: GrokNormalizerState, id: string, taskId: string): void {
  const key = id.toLowerCase();
  if (state.subagentIds.has(key)) {
    return;
  }
  state.subagentIds.set(key, taskId);
  evictOldest(state.subagentIds, SUBAGENTS_REMEMBERED);
}

/**
 * A subagent run's end was written: who wrote it, on the track, and the ids
 * that named it, so no frame naming one — once its launch is forgotten —
 * becomes a shell. A resumed run is found through its launch first, so this
 * never hides it. The CLI's word is never replaced by the adapter's.
 */
function rememberEndedSubagent(state: GrokNormalizerState, track: SubagentTrack, by: TaskEndSource): void {
  track.endedBy = track.endedBy === "cli" ? "cli" : by;
  rememberEndedTask(state, track.taskId, track.endedBy);
  for (const [id, taskId] of state.subagentIds) {
    if (taskId === track.taskId) {
      rememberEndedTask(state, id, track.endedBy);
    }
  }
}

/**
 * A CLI report naming a subagent run that is not live — {@link shellReport}'s
 * rule: after an end the adapter wrote itself, a report that it still runs
 * counts it live again ({@link reviveSubagent}) and a report of its end is
 * the CLI's, with no row; after the CLI's own end, nothing.
 */
export function subagentReport(
  state: GrokNormalizerState,
  track: SubagentTrack,
  running: boolean,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  if (track.endedBy !== "adapter") {
    return [];
  }
  if (!running) {
    rememberEndedSubagent(state, track, "cli");
    return [];
  }
  return reviveSubagent(state, track, raw);
}

/**
 * A subagent run the adapter closed itself that the CLI reports still
 * running — a heartbeat, a poll, a listing: live again, under its own start
 * row re-emitted, naming its own launch — which the roster reads as a late
 * delivery (it keeps the adapter's end) and the liveness registry as live
 * work for the agent's hour, re-armed by further reports. Captured, a Stop's
 * `session/cancel` cancels a background child (fixture 21:
 * `subagent_finished {status: "cancelled"}` 50 ms later), so after a Stop
 * this is the rule for what the CLI did not cancel.
 */
function reviveSubagent(state: GrokNormalizerState, track: SubagentTrack, raw: RuntimeEventRaw): RuntimeEvent[] {
  track.live = true;
  track.revived = true;
  track.endedBy = undefined;
  track.listed = false;
  return [
    event(
      state,
      "task.started",
      { ...subagentLinkage(track), description: track.description, isBackgrounded: true },
      track.turnId,
      raw
    )
  ];
}

/** The task a background-task frame's ids name, when they are a subagent's. */
export function subagentOfBackgroundTask(
  state: GrokNormalizerState,
  taskId: string,
  toolCallId: string | undefined
): string | undefined {
  const launched =
    toolCallId === undefined ? undefined : state.subagentLaunches.get(toolCallId)?.taskId;
  if (launched !== undefined) {
    rememberSubagentId(state, taskId, launched);
    return launched;
  }
  return state.subagentIds.get(taskId.toLowerCase());
}

/** What every row naming the agent carries — its liveness TTL included. */
export function subagentLinkage(track: SubagentTrack): {
  taskId: string;
  taskType: string;
  agentId: string;
  title: string;
  role?: string;
  model?: string;
  toolUseId: string;
  livenessTtlMs: number;
} {
  return {
    taskId: track.taskId,
    taskType: "subagent",
    agentId: track.taskId,
    title: track.title,
    ...(track.role === undefined ? {} : { role: track.role }),
    ...(track.model === undefined ? {} : { model: track.model }),
    toolUseId: track.toolUseId,
    livenessTtlMs: GROK_AGENT_LIVENESS_TTL_MS
  };
}

/**
 * `task.completed` for a live agent, and out of the live set — after what
 * its child session left open: its calls first, then its words and
 * thinking, then the task (calls before tasks, as every adapter's teardown
 * orders them). A run's end is its child session's end.
 */
export function closeSubagent(
  state: GrokNormalizerState,
  track: SubagentTrack,
  status: "completed" | "failed" | "stopped",
  by: TaskEndSource,
  summary?: string,
  raw?: RuntimeEventRaw,
  usage?: RuntimeTaskUsage
): RuntimeEvent[] {
  track.live = false;
  track.revived = false;
  rememberEndedSubagent(state, track, by);
  const events = closeAgentWork(state, track.taskId, "The subagent ended.");
  events.push(...orphanAgentTasks(state, track.taskId));
  // The rows that close a run after its turn name the turn it ran in, as a
  // shell's closers do; a foreground end within its own turn is that turn.
  events.push(
    event(
      state,
      "task.completed",
      {
        ...subagentLinkage(track),
        status,
        ...(summary === undefined ? {} : { summary }),
        ...(usage === undefined ? {} : { usage })
      },
      track.turnId,
      raw
    )
  );
  return events;
}

/**
 * What an agent's child session left open when its run ended: its calls,
 * failed with `reason` — each on its own turn, under its owner — and then
 * its open words and thinking.
 */
function closeAgentWork(state: GrokNormalizerState, taskId: string, reason: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [toolCallId, track] of [...state.tools.entries()]) {
    if (track.owned?.agentId === taskId) {
      events.push(...failTool(state, toolCallId, track, reason));
    }
  }
  for (const child of state.children.values()) {
    if (child.taskId === taskId) {
      events.push(...closeChildSegments(state, child));
    }
  }
  return events;
}

/**
 * Emit a proposed plan, deduped **per turn**: identical markdown on a later
 * turn must still produce a fresh card, and an empty write only resets the
 * fallback.
 */
function proposePlan(state: GrokNormalizerState, markdown: string, raw: RuntimeEventRaw): RuntimeEvent[] {
  const turnId = state.deps.activeTurnId();
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    state.lastProposedPlan = { markdown: "", turnId };
    return [];
  }
  if (state.lastProposedPlan?.markdown === trimmed && state.lastProposedPlan.turnId === turnId) {
    return [];
  }
  state.lastProposedPlan = { markdown: trimmed, turnId };
  return [event(state, "turn.proposed.completed", { planMarkdown: trimmed }, undefined, raw)];
}

/** A snapshot entry of a subagent's: its terminal status ends the agent. */
export function subagentFromSnapshot(
  state: GrokNormalizerState,
  taskId: string,
  status: RuntimeTaskStatus,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track = state.subagents.get(taskId);
  if (track === undefined) {
    return [];
  }
  if (!track.live) {
    if (status === "idle") {
      return [];
    }
    const events = subagentReport(state, track, !isEndedTaskStatus(status), raw);
    if (track.live) {
      track.listed = true;
    }
    return events;
  }
  track.listed = true;
  switch (status) {
    case "completed":
      return closeSubagent(state, track, "completed", "cli", undefined, raw);
    case "failed":
      return closeSubagent(state, track, "failed", "cli", undefined, raw);
    case "cancelled":
    case "interrupted":
      return closeSubagent(state, track, "stopped", "cli", undefined, raw);
    default:
      return [];
  }
}

/** The agent an answer's id names, through the ids its launches reported. */
export function subagentNamed(state: GrokNormalizerState, id: string): SubagentTrack | undefined {
  const taskId = state.subagentIds.get(id.toLowerCase());
  return taskId === undefined ? undefined : state.subagents.get(taskId);
}

/** One live call, failed by the adapter: its end, and remembered as the adapter's. */
function failTool(state: GrokNormalizerState, toolCallId: string, track: ToolTrack, reason: string): RuntimeEvent[] {
  state.tools.delete(toolCallId);
  rememberFinishedCall(state, toolCallId, track.itemType, "adapter");
  if (!track.started) {
    return [];
  }
  const payload = {
    itemType: track.itemType,
    status: "failed",
    ...(track.title === undefined ? {} : { title: track.title }),
    detail: reason,
    ...(track.owned === undefined ? {} : { agentId: track.owned.agentId })
  };
  return [
    track.owned === undefined
      ? eventWithItem(state, "item.completed", payload, toolCallId)
      : ownedEvent(state, "item.completed", payload, track.owned.agentId, track.owned.turnId, toolCallId)
  ];
}

/** An event on the turn given — with `null`, on none at all, whatever turn is open. */
function ridingTurn(event: RuntimeEvent, turnId: string | null | undefined): RuntimeEvent {
  if (turnId !== null) {
    return event;
  }
  const { turnId: _open, ...turnless } = event;
  return turnless as RuntimeEvent;
}

/**
 * Grok's `stopReason: "cancelled"` is ambiguous: ACP reserves it for "the
 * client sent `session/cancel`", and this CLI also uses it for "the user
 * declined a tool" (observation 12). Mapping it straight onto the Stop button
 * would label a declined approval as an interrupt.
 *
 * `cancellationCategory` on `_x.ai/session/prompt_complete` disambiguates them
 * exactly — `"PermissionRejected"` vs `"MidTurnAbort"` — which the fixtures
 * README does not record; it suggests the `permission_denied` hook event or
 * "no cancel was sent" instead. Both fallbacks are still honoured through
 * `errorMessage` when the category is absent.
 */
export function turnStateFromOutcome(
  outcome: GrokTurnOutcome,
  errorMessage: string | undefined
): "completed" | "failed" | "interrupted" | "cancelled" {
  if (errorMessage !== undefined) {
    return "failed";
  }
  if (outcome.stopReason === "cancelled") {
    return outcome.cancellationCategory === "PermissionRejected" ? "cancelled" : "interrupted";
  }
  if (outcome.stopReason === "refusal") {
    return "cancelled";
  }
  return "completed";
}
