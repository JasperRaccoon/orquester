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
  RuntimeEventRawSource,
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
  XaiSessionUpdate,
  XaiSubagentFinishedUpdate,
  XaiSubagentProgressUpdate,
  XaiSubagentSpawnedUpdate,
  XaiTaskSnapshot,
  XaiUsage
} from "./acp/_generated/xai.ts";
import { GrokHistoryCollector } from "./history.ts";
import {
  nextPlanModeActive,
  planMarkdownFromToolCall,
  type PlanPathHost
} from "./plan.ts";
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

export const ACP_RAW_SOURCE: RuntimeEventRawSource = "acp.jsonrpc";
export const XAI_RAW_SOURCE: RuntimeEventRawSource = "acp.grok.extension";

export interface GrokEventStamp {
  eventId: string;
  createdAt: string;
}

export interface GrokNormalizerDeps {
  readonly threadId: string;
  /** A FRESH stamp per event — two events must never share an `eventId`. */
  stamp(): GrokEventStamp;
  uuid(): string;
  /** The turn a live frame belongs to, or undefined between turns. */
  activeTurnId(): string | undefined;
  readonly planHost: PlanPathHost;
}

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

interface ToolTrack extends ToolCallSnapshot {
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
 * Where a background task was started: `session` is the ACP session whose
 * frames report it — `""` for the parent, a child's session id for a
 * subagent's own shell — and `owner` the agent that session is. A
 * `background_tasks` snapshot lists one session's tasks only (fixture 16: the
 * child's own snapshot), so "dropped out of the snapshot" means dropped out of
 * ITS session's.
 */
interface TaskScope {
  readonly session: string;
  readonly owner?: string;
}

const PARENT_SCOPE: TaskScope = { session: "" };

interface BackgroundTrack {
  readonly taskId: string;
  readonly command: string;
  /** A monitor streams events and wakes the agent on each (fixture 20); a shell does neither. */
  readonly taskType: "shell" | "monitor";
  readonly scope: TaskScope;
  description?: string;
  status: RuntimeTaskStatus;
  toolUseId?: string;
  outputFile?: string;
  turnId?: string;
  /**
   * Live again on the CLI's word after an end the adapter wrote itself (see
   * {@link GrokNormalizer.reviveShell}): the roster keeps that end, so no row
   * of this track names a status that would reopen it.
   */
  revived?: boolean;
}

/**
 * One subagent's child session (`subagent_spawned.child_session_id`, which is
 * also its `subagent_id`). Its frames reach this client under its own
 * `sessionId` — the child's thinking, words, tool calls, background tasks,
 * turn ends and hooks (fixture 15) — and they are that agent's own rows,
 * never the parent's state.
 */
interface ChildSession {
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
interface SubagentTrack {
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
  /** A `background_tasks` snapshot listed it (see {@link GrokNormalizer.foldBackgroundTasks}). */
  listed: boolean;
  /** Who wrote the latest run's end, while it is not live. */
  endedBy?: TaskEndSource;
  /** The model `subagent_spawned` named, carried on the agent's later rows. */
  model?: string;
  /**
   * Live again on the CLI's word after an end the adapter wrote itself (see
   * {@link GrokNormalizer.reviveSubagent}): the roster keeps that end, so no
   * row of this run names a status that would reopen it.
   */
  revived: boolean;
}

/** One `spawn_subagent` call, keyed by its call id. */
interface SubagentLaunch {
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
  /** A `subagent_spawned` has named this launch's child (see {@link GrokNormalizer.subagentSpawned}). */
  joined: boolean;
}

/**
 * Who wrote a finished call's end: the CLI, or the adapter's own close
 * ({@link GrokNormalizer.failOpenTools}).
 */
interface FinishedCall {
  readonly itemType: ToolTrack["itemType"];
  readonly by: "cli" | "adapter";
}

/**
 * Who wrote a background task's end. `cli`: the CLI reported it — a poll or
 * kill answer, a snapshot's terminal status, the completion tag, a failed
 * spawn call. `adapter`: the adapter wrote it itself — Stop, the session's
 * stop, the exit ({@link GrokNormalizer.stopBackgroundTasks}), or a task that
 * dropped out of a snapshot unannounced.
 */
type TaskEndSource = "cli" | "adapter";

/** A background task whose end was written, and by whom. */
interface EndedTask {
  readonly by: TaskEndSource;
  /** A shell the adapter closed itself: its track, to count it live again on the CLI's word. */
  readonly shell?: BackgroundTrack;
}

/** A snapshot status that says the task no longer runs. */
function isEndedTaskStatus(status: RuntimeTaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
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

/**
 * How many ended background task ids the normaliser remembers, oldest
 * forgotten first — {@link FINISHED_CALLS_REMEMBERED}'s rule for tasks. A
 * task's track is dropped at its end, so this is what tells a snapshot that
 * still lists a finished task from a new task's first sighting.
 */
export const ENDED_TASKS_REMEMBERED = 1_024;

function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
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
 * The `rawOutput` tag of a `monitor` call's answer — `{type: "Monitor",
 * taskId, timeoutMs, persistent}`, T3's reader's shape, captured in fixture 20.
 */
const MONITOR_OUTPUT = "Monitor";

/**
 * A poll answer's status, as T3's reader maps it (`XAiBackgroundTasks.ts`
 * `lifecycle`): the words, else the exit code; `undefined` when neither says.
 */
function pollLifecycle(
  status: unknown,
  exitCode: unknown
): "running" | "completed" | "failed" | "stopped" | undefined {
  switch (typeof status === "string" ? status.trim().toLowerCase() : undefined) {
    case "pending":
    case "running":
      return "running";
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "killed":
    case "cancelled":
      return "stopped";
    default:
      return typeof exitCode === "number" && Number.isFinite(exitCode)
        ? exitCode === 0
          ? "completed"
          : "failed"
        : undefined;
  }
}

/**
 * How a COMPLETED kill answer's entry ends the task it names, or `undefined`
 * when it ends nothing. Captured (fixture 18, a subagent and a shell): a
 * `KillTask` `Result` is `{task_id, outcome, message}` — `outcome: "killed"`
 * for both, `message` "Subagent cancellation initiated" / "Task was terminated
 * successfully" — which is T3's shape. `explicitly_killed` and
 * `kill_result_delivered`, which the 1.0.34 strings list beside it, are
 * `TaskSnapshot` fields: they ride `_x.ai/task_completed`
 * ({@link GrokNormalizer.taskCompleted}), never a kill answer. The binary's
 * other kill word, `already_exited` — the tool "reports success if the task
 * was killed or had already exited" — is read as that `outcome`'s other value
 * (not captured): the task ended, with the answer's own terminal status when
 * it carries one, else `stopped`.
 */
function killEnd(
  result: Record<string, unknown>
): "completed" | "failed" | "stopped" | undefined {
  if (result["outcome"] === "killed") {
    return "stopped";
  }
  if (result["outcome"] !== "already_exited") {
    return undefined;
  }
  const lifecycle = pollLifecycle(result["status"], result["exit_code"]);
  return lifecycle === undefined || lifecycle === "running" ? "stopped" : lifecycle;
}

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
 * `output`) and `cancelled` (with `error`, no `output` — a kill, a Stop's
 * `session/cancel`, a cut foreground call). The rest follows the poll
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

function textArgument(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Drop the oldest entries a map may lose until it is back within `limit`. */
function evictOldest<K, V>(
  map: Map<K, V>,
  limit: number,
  evictable: (value: V) => boolean = () => true
): void {
  if (map.size <= limit) {
    return;
  }
  for (const [key, value] of map) {
    if (evictable(value)) {
      map.delete(key);
      if (map.size <= limit) {
        return;
      }
    }
  }
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
  "subagent_finished"
]);

export class GrokNormalizer {
  private readonly deps: GrokNormalizerDeps;

  /** Assistant-message segmentation state (§4.5). */
  private readonly runtimeId: string;
  private nextSegmentIndex = 0;
  private activeAssistantItemId: string | undefined;
  private assistantUpdatesOpen = false;

  /**
   * What `session/load` replayed. Collected rather than emitted (see
   * {@link handleSessionUpdate}) so a thread whose timeline the host has never
   * seen can still be reconstructed through `projectHistory` (E6).
   */
  private readonly history = new GrokHistoryCollector();

  private readonly tools = new Map<string, ToolTrack>();
  /**
   * Calls that reached a terminal status → their row type and who ended them,
   * bounded by {@link FINISHED_CALLS_REMEMBERED}.
   */
  private readonly finishedCalls = new Map<string, FinishedCall>();
  private readonly tasks = new Map<string, BackgroundTrack>();
  /**
   * Background task ids (lower-cased) whose end was written — a shell's, and
   * every id that named an ended subagent run — and who wrote it, bounded by
   * {@link ENDED_TASKS_REMEMBERED}; see {@link shellReport}. A snapshot entry's
   * status may be terminal, so a finished shell can still be listed, and that
   * listing started it again under its id, put it back in the liveness
   * registry as a watch loop, and ended it a second time when it dropped out.
   */
  private readonly endedTasks = new Map<string, EndedTask>();
  /** Roster agents, by task id; see {@link subagentFromToolCall}. */
  private readonly subagents = new Map<string, SubagentTrack>();
  /** `spawn_subagent` calls, by call id. */
  private readonly subagentLaunches = new Map<string, SubagentLaunch>();
  /** A subagent id (lower-cased) → the roster task it is, for `resume_from`. */
  private readonly subagentIds = new Map<string, string>();
  /**
   * Child sessions (lower-cased id) → the agent they are. Learned from
   * `subagent_spawned`, which precedes every frame of the child (fixtures
   * 15–23); bounded like the other subagent memories, a live one never
   * forgotten.
   */
  private readonly children = new Map<string, ChildSession>();
  /**
   * The turn the latest subagent launch ran in (`TurnTokenUsage.hasSubagents`).
   * A turn id, not a per-turn flag: a steer re-runs {@link beginTurn} inside
   * the same turn.
   */
  private lastSubagentTurnId: string | undefined;
  private readonly hooks = new Map<string, string>();

  /** Slash commands, refreshed from `available_commands_update` (69, not 7). */
  private commands: ReadonlyArray<{ name: string; description?: string; input?: { hint: string } }> = [];
  private currentModelId: string | undefined;
  private currentModeId: string | undefined;
  private planModeActive = false;
  private lastProposedPlan: { markdown: string; turnId: string | undefined } | undefined;
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

  /**
   * The ACP session's id — never a subagent's (see {@link learnSubagentIds}).
   * The session learns it only from `session/new`'s answer, after the
   * normaliser exists: {@link bindSession}.
   */
  private sessionId: string;

  constructor(deps: GrokNormalizerDeps, sessionId: string) {
    this.deps = deps;
    this.sessionId = sessionId.toLowerCase();
    // Unique per NORMALISER instance, not per session: a `session/load` reuses
    // the session id, and an item id that collided across the restart would
    // merge two different assistant bubbles.
    this.runtimeId = `${sessionId}:${deps.uuid()}`;
  }

  // ------------------------------------------------------------------ state

  /**
   * The parent ACP session, once `session/new` (or the `session/load`
   * request) names it. Only what a child session's frames are is decided by
   * session id — a frame of any other session is the parent's, as before.
   */
  bindSession(sessionId: string): void {
    if (sessionId.trim().length > 0) {
      this.sessionId = sessionId.trim().toLowerCase();
    }
  }

  /** The child session a frame's `sessionId` names, if a `subagent_spawned` introduced it. */
  private childSessionOf(sessionId: unknown): ChildSession | undefined {
    return typeof sessionId === "string" ? this.children.get(sessionId.toLowerCase()) : undefined;
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
    return this.planModeActive;
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
    this.assistantUpdatesOpen = true;
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
    this.assistantUpdatesOpen = false;
    const events = this.closeAssistantSegment();
    const turnId = this.deps.activeTurnId();
    for (const child of this.children.values()) {
      events.push(...this.closeChildSegments(child, { turnId }));
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
        return this.contentDelta(update.content, "assistant_text", params);
      case "agent_thought_chunk":
        return this.contentDelta(update.content, "reasoning_text", params);
      case "tool_call":
        return this.toolCall(update, params, "tool_call");
      case "tool_call_update":
        return this.toolCall(update, params, "tool_call_update");
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
        this.planModeActive = this.currentModeId === "plan";
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
        return this.childText(child, update.content, raw);
      case "agent_thought_chunk":
        return this.childReasoning(child, update.content, raw);
      case "tool_call":
        return this.toolCall(update, params, "tool_call", child);
      case "tool_call_update":
        return this.toolCall(update, params, "tool_call_update", child);
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

  /**
   * A child's words: the agent's assistant message, a segment of its own
   * (`assistant:…:agent:<task>:…`, so a turnless one can be closed by its
   * own `item.completed` — ingestion's `handleTurnlessCompletion`). Visible
   * text ends the agent's thinking block; a segment whose turn has ended is
   * closed and a new one opens on the turn live now.
   */
  private childText(
    child: ChildSession,
    content: { type?: string; text?: string } | undefined,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
      return [];
    }
    const turnId = this.deps.activeTurnId();
    const events = this.closeChildReasoning(child);
    if (child.text !== undefined && child.text.turnId !== turnId) {
      events.push(...this.closeChildText(child));
    }
    if (child.text === undefined) {
      if (content.text.trim().length === 0) {
        return events;
      }
      const itemId = `assistant:${this.runtimeId}:agent:${child.taskId}:${child.sessionId}:segment:${child.nextSegment}`;
      child.nextSegment += 1;
      child.text = { itemId, turnId };
      events.push(
        this.ownedEvent(
          "item.started",
          { itemType: "assistant_message", status: "inProgress", agentId: child.taskId },
          child.taskId,
          turnId,
          itemId
        )
      );
    }
    events.push(
      this.ownedEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: content.text },
        child.taskId,
        child.text.turnId,
        child.text.itemId,
        raw
      )
    );
    return events;
  }

  /** A child's thinking: the agent's reasoning row, one block per run of chunks. */
  private childReasoning(
    child: ChildSession,
    content: { type?: string; text?: string } | undefined,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
      return [];
    }
    const turnId = this.deps.activeTurnId();
    const events: RuntimeEvent[] = [];
    if (child.reasoning !== undefined && child.reasoning.turnId !== turnId) {
      events.push(...this.closeChildReasoning(child));
    }
    if (child.reasoning === undefined) {
      child.reasoning = {
        itemId: `reasoning:${this.runtimeId}:agent:${child.taskId}:${child.sessionId}:${child.nextSegment}`,
        turnId
      };
      child.nextSegment += 1;
    }
    events.push(
      this.ownedEvent(
        "content.delta",
        { streamKind: "reasoning_text", delta: content.text },
        child.taskId,
        child.reasoning.turnId,
        child.reasoning.itemId,
        raw
      )
    );
    return events;
  }

  private closeChildText(child: ChildSession): RuntimeEvent[] {
    const open = child.text;
    if (open === undefined) {
      return [];
    }
    child.text = undefined;
    return [
      this.ownedEvent(
        "item.completed",
        { itemType: "assistant_message", status: "completed", agentId: child.taskId },
        child.taskId,
        open.turnId,
        open.itemId
      )
    ];
  }

  private closeChildReasoning(child: ChildSession): RuntimeEvent[] {
    const open = child.reasoning;
    if (open === undefined) {
      return [];
    }
    child.reasoning = undefined;
    return [
      this.ownedEvent(
        "item.completed",
        { itemType: "reasoning", status: "completed", agentId: child.taskId },
        child.taskId,
        open.turnId,
        open.itemId
      )
    ];
  }

  /**
   * Close a child's open segments — every one, or (`only` given) those riding
   * that turn, `undefined` meaning the turnless ones.
   */
  private closeChildSegments(
    child: ChildSession,
    only?: { readonly turnId: string | undefined }
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    if (child.reasoning !== undefined && (only === undefined || child.reasoning.turnId === only.turnId)) {
      events.push(...this.closeChildReasoning(child));
    }
    if (child.text !== undefined && (only === undefined || child.text.turnId === only.turnId)) {
      events.push(...this.closeChildText(child));
    }
    return events;
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

  // ----------------------------------------------------- content + segments

  private contentDelta(
    content: { type?: string; text?: string } | undefined,
    streamKind: "assistant_text" | "reasoning_text",
    params: SessionNotification
  ): RuntimeEvent[] {
    if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) {
      // Non-text content (image/resource) has no stream kind on this surface.
      return [];
    }
    const raw: RuntimeEventRaw = { source: ACP_RAW_SOURCE, method: "session/update", payload: params };

    if (streamKind === "reasoning_text") {
      // Reasoning is never attached to an assistant item and never opens or
      // closes a segment.
      return [this.event("content.delta", { streamKind, delta: content.text }, undefined, raw)];
    }
    if (!this.assistantUpdatesOpen) {
      // A late chunk after the turn settled must not reopen it.
      return [];
    }

    const events: RuntimeEvent[] = [];
    if (this.activeAssistantItemId === undefined && content.text.trim().length === 0) {
      // Whitespace never OPENS a segment (it would produce an empty bubble for
      // a provider that flushes a trailing newline) but is kept inside one.
      return [];
    }
    const itemId = this.ensureAssistantSegment(events);
    events.push(
      this.eventWithItem("content.delta", { streamKind, delta: content.text }, itemId, raw)
    );
    return events;
  }

  private ensureAssistantSegment(events: RuntimeEvent[]): string {
    if (this.activeAssistantItemId !== undefined) {
      return this.activeAssistantItemId;
    }
    const itemId = `assistant:${this.runtimeId}:segment:${this.nextSegmentIndex}`;
    this.nextSegmentIndex += 1;
    this.activeAssistantItemId = itemId;
    events.push(
      this.eventWithItem("item.started", { itemType: "assistant_message", status: "inProgress" }, itemId)
    );
    return itemId;
  }

  private closeAssistantSegment(): RuntimeEvent[] {
    const itemId = this.activeAssistantItemId;
    if (itemId === undefined) {
      return [];
    }
    this.activeAssistantItemId = undefined;
    return [
      this.eventWithItem("item.completed", { itemType: "assistant_message", status: "completed" }, itemId)
    ];
  }

  // --------------------------------------------------------------- tools

  private toolCall(
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
    params: SessionNotification,
    method: string,
    owner?: ChildSession
  ): RuntimeEvent[] {
    const toolCallId = update.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
      return [];
    }

    const previous = this.tools.get(toolCallId);
    // A frame of a call that already FINISHED has no lifecycle left to report.
    // Emitted, a status-less one opened the call again as a new `item.started`
    // and re-registered it as live, and the exit sweep (`failOpenTools`) then
    // failed a call that had completed; a terminal restatement wrote a second
    // `tool.completed` and closed the open assistant bubble. Both are dropped
    // — except the CLI's own end of a call the ADAPTER closed (a Stop's
    // `failOpenTools`), which is the call's first real end and lands.
    const finished = previous === undefined ? this.finishedCalls.get(toolCallId) : undefined;
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
          : { owned: { agentId: owner.taskId, turnId: this.deps.activeTurnId() } }),
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
      events.push(...(owner === undefined ? this.closeAssistantSegment() : this.closeChildSegments(owner)));

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
          ? this.eventWithItem(lifecycle, payload, toolCallId, lifecycleRaw)
          : this.ownedEvent(lifecycle, payload, next.owned.agentId, next.owned.turnId, toolCallId, lifecycleRaw)
      );
    } else {
      next.skippedSinceEmit = decision.skipped;
    }

    if (terminal) {
      this.tools.delete(toolCallId);
      this.rememberFinishedCall(toolCallId, next.itemType, "cli");
    } else {
      this.tools.set(toolCallId, next);
    }

    const raw: RuntimeEventRaw = {
      source: ACP_RAW_SOURCE,
      method: `session/update:${method}`,
      payload: params
    };
    if (owner !== undefined) {
      // A child's plan mode is its own session's; the thread's is the parent's.
      events.push(
        ...this.backgroundFromToolCall(toolCallId, rawInput, rawOutput, status, raw, {
          session: owner.sessionId,
          owner: owner.taskId
        })
      );
      return events;
    }

    // Plan mode is DECLARED, so the flag follows the tool call regardless of
    // whether the row itself was emitted.
    this.planModeActive = nextPlanModeActive(this.planModeActive, {
      title: next.title,
      status: next.status,
      rawInput: update.rawInput,
      meta: update._meta
    });
    if (this.planModeActive) {
      const markdown = planMarkdownFromToolCall(
        { rawInput: update.rawInput, content },
        this.deps.planHost
      );
      if (markdown !== undefined) {
        events.push(...this.proposePlan(markdown, { source: ACP_RAW_SOURCE, method: "session/update", payload: params }));
      }
    }

    events.push(
      ...(spawnsSubagent
        ? this.subagentFromToolCall(toolCallId, rawInput, update, status, raw)
        : this.backgroundFromToolCall(toolCallId, rawInput, rawOutput, status, raw, PARENT_SCOPE))
    );
    return events;
  }

  /** Oldest first out, so the memory stays within {@link FINISHED_CALLS_REMEMBERED}. */
  private rememberFinishedCall(
    toolCallId: string,
    itemType: ToolTrack["itemType"],
    by: FinishedCall["by"]
  ): void {
    this.finishedCalls.delete(toolCallId);
    this.finishedCalls.set(toolCallId, { itemType, by });
    evictOldest(this.finishedCalls, FINISHED_CALLS_REMEMBERED);
  }

  // ------------------------------------------------------------- subagents

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
  private subagentFromToolCall(
    toolCallId: string,
    rawInput: unknown,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
    status: ToolCallStatus | undefined,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    let launch = this.subagentLaunches.get(toolCallId);
    if (launch === undefined) {
      launch = this.launchSubagent(toolCallId, asRecord(rawInput), raw, events);
    }
    if (isTerminalToolStatus(status) && !launch.settled) {
      launch.settled = true;
      events.push(...this.settleSubagentLaunch(launch, status === "failed", update, raw));
    }
    return events;
  }

  private launchSubagent(
    toolCallId: string,
    input: Record<string, unknown> | undefined,
    raw: RuntimeEventRaw,
    events: RuntimeEvent[]
  ): SubagentLaunch {
    const resumeFrom = textArgument(input, "resume_from");
    const taskId =
      resumeFrom === undefined
        ? toolCallId
        : (this.subagentIds.get(resumeFrom.toLowerCase()) ?? resumeFrom);
    const description = textArgument(input, "description");
    const role = textArgument(input, "subagent_type");
    // `background` is the tool's own argument (its documented parameter; the
    // first frame carries the model's arguments as it wrote them).
    const background = input?.["background"] === true;
    const existing = this.subagents.get(taskId);
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
      track.turnId = this.deps.activeTurnId();
      track.endedBy = undefined;
    }
    this.subagents.delete(taskId);
    this.subagents.set(taskId, track);
    evictOldest(this.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);

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
    this.subagentLaunches.set(toolCallId, launch);
    evictOldest(this.subagentLaunches, SUBAGENTS_REMEMBERED);
    this.lastSubagentTurnId = this.deps.activeTurnId();

    events.push(
      this.event(
        "task.started",
        {
          ...this.subagentLinkage(track),
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
  private settleSubagentLaunch(
    launch: SubagentLaunch,
    failed: boolean,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const track = this.subagents.get(launch.taskId);
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
      return this.closeSubagent(track, "failed", "cli", toolContentText(update.content), raw);
    }
    this.learnSubagentIds(launch, update);
    const output = asRecord(update.rawOutput);
    if (output?.["type"] === SUBAGENT_COMPLETED_OUTPUT) {
      // Normally a no-op: `subagent_finished` arrives a millisecond before
      // this answer and has ended the run already (fixtures 15, 17). The
      // CLI's own `output` is the answer; the call's text adds the
      // `<subagent_meta>` / `<subagent_result>` blocks for the parent model.
      const answer =
        subagentAnswerText(typeof output["output"] === "string" ? output["output"] : undefined) ??
        subagentAnswerText(toolContentText(update.content));
      return track.live ? this.closeSubagent(track, "completed", "cli", answer, raw) : [];
    }
    launch.detached = true;
    return track.live ? this.backgroundSubagent(track, raw) : [];
  }

  /**
   * A foreground run that goes on without its call, said once:
   * `task.updated {isBackgrounded: true}` — the roster keeps a live
   * background row in view — naming the turn the run started in.
   */
  private backgroundSubagent(track: SubagentTrack, raw?: RuntimeEventRaw): RuntimeEvent[] {
    if (track.backgrounded) {
      return [];
    }
    track.backgrounded = true;
    return [
      this.event(
        "task.updated",
        { ...this.subagentLinkage(track), isBackgrounded: true },
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
  private subagentSpawned(update: XaiSubagentSpawnedUpdate, raw: RuntimeEventRaw): RuntimeEvent[] {
    const record = update as unknown as Record<string, unknown>;
    const subagentId = textArgument(record, "subagent_id");
    if (subagentId === undefined) {
      return [
        this.event("runtime.warning", { message: "grok: subagent_spawned without a subagent_id" }, undefined, raw)
      ];
    }
    const description = textArgument(record, "description");
    const resumedFrom = textArgument(record, "resumed_from");
    const events: RuntimeEvent[] = [];
    let taskId =
      this.subagentIds.get(subagentId.toLowerCase()) ??
      (resumedFrom === undefined ? undefined : this.subagentIds.get(resumedFrom.toLowerCase())) ??
      this.unjoinedLaunch(description)?.taskId;
    if (taskId === undefined) {
      taskId = subagentId;
      events.push(...this.startUnlaunchedSubagent(subagentId, record, raw));
    }
    const track = this.subagents.get(taskId);
    const launch = track === undefined ? undefined : this.subagentLaunches.get(track.toolUseId);
    if (launch !== undefined) {
      launch.joined = true;
    }
    const model = textArgument(record, "model");
    if (track !== undefined && model !== undefined) {
      track.model = model;
    }
    this.rememberSubagentId(subagentId, taskId);
    const childSessionId = textArgument(record, "child_session_id") ?? subagentId;
    this.rememberSubagentId(childSessionId, taskId);
    this.children.delete(childSessionId.toLowerCase());
    this.children.set(childSessionId.toLowerCase(), { sessionId: childSessionId, taskId, nextSegment: 0 });
    evictOldest(this.children, SUBAGENTS_REMEMBERED, (child) => this.subagents.get(child.taskId)?.live !== true);
    return events;
  }

  /** The oldest live launch no `subagent_spawned` has named yet — a matching description first. */
  private unjoinedLaunch(description: string | undefined): SubagentLaunch | undefined {
    let oldest: SubagentLaunch | undefined;
    for (const launch of this.subagentLaunches.values()) {
      if (launch.joined || this.subagents.get(launch.taskId)?.live !== true) {
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
  private startUnlaunchedSubagent(
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
      turnId: this.deps.activeTurnId(),
      listed: false,
      revived: false
    };
    this.subagents.set(subagentId, track);
    evictOldest(this.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);
    return [
      this.event(
        "task.started",
        { ...this.subagentLinkage(track), description: title, isBackgrounded: true },
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
  private subagentProgress(update: XaiSubagentProgressUpdate, raw: RuntimeEventRaw): RuntimeEvent[] {
    const track = this.subagentNamed(String(update.subagent_id ?? ""));
    if (track === undefined) {
      return [];
    }
    if (!track.live) {
      return this.subagentReport(track, true, raw);
    }
    const usage = subagentUsage(update.tokens_used, update.tool_call_count, update.duration_ms);
    return [
      this.event(
        "task.progress",
        {
          ...this.subagentLinkage(track),
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
  private subagentFinished(update: XaiSubagentFinishedUpdate, raw: RuntimeEventRaw): RuntimeEvent[] {
    const track = this.subagentNamed(String(update.subagent_id ?? ""));
    if (track === undefined) {
      return [];
    }
    if (!track.live) {
      return this.subagentReport(track, false, raw);
    }
    const owner = this.subagentLaunches.get(track.owner);
    if (owner !== undefined) {
      owner.settled = true;
    }
    const status = finishedStatus(update.status, update.error);
    const answer = subagentAnswerText(typeof update.output === "string" ? update.output : undefined);
    const error = typeof update.error === "string" && update.error.trim().length > 0 ? update.error.trim() : undefined;
    const summary = status === "completed" ? answer : status === "failed" ? (error ?? answer) : undefined;
    const usage = subagentUsage(update.tokens_used, update.tool_calls, update.duration_ms);
    return this.closeSubagent(track, status, "cli", summary, raw, usage);
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
  private learnSubagentIds(
    launch: SubagentLaunch,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>
  ): void {
    const usable = (id: string): boolean =>
      !launch.inputIds.has(id) &&
      id !== this.sessionId &&
      !this.tasks.has(id) &&
      !this.hasEnded(id) &&
      !this.subagentIds.has(id);
    const structured = uuidsIn(update.rawOutput).filter(usable);
    const ids = structured.length > 0 ? structured : uuidsIn(update.content).filter(usable);
    for (const id of ids.slice(0, IDS_PER_LAUNCH)) {
      this.rememberSubagentId(id, launch.taskId);
    }
  }

  private rememberSubagentId(id: string, taskId: string): void {
    const key = id.toLowerCase();
    if (this.subagentIds.has(key)) {
      return;
    }
    this.subagentIds.set(key, taskId);
    evictOldest(this.subagentIds, SUBAGENTS_REMEMBERED);
  }

  /**
   * A shell's end was written: its track goes, and who wrote it is
   * remembered — with the track itself when the adapter wrote it, so the
   * CLI's later word can count it live again ({@link reviveShell}).
   */
  private endShell(taskId: string, by: TaskEndSource): void {
    const track = this.tasks.get(taskId);
    this.tasks.delete(taskId);
    this.rememberEndedTask(taskId, by, by === "adapter" ? track : undefined);
  }

  /**
   * A subagent run's end was written: who wrote it, on the track, and the ids
   * that named it, so no frame naming one — once its launch is forgotten —
   * becomes a shell. A resumed run is found through its launch first, so this
   * never hides it. The CLI's word is never replaced by the adapter's.
   */
  private rememberEndedSubagent(track: SubagentTrack, by: TaskEndSource): void {
    track.endedBy = track.endedBy === "cli" ? "cli" : by;
    this.rememberEndedTask(track.taskId, track.endedBy);
    for (const [id, taskId] of this.subagentIds) {
      if (taskId === track.taskId) {
        this.rememberEndedTask(id, track.endedBy);
      }
    }
  }

  /**
   * Oldest first out, so the memory stays within
   * {@link ENDED_TASKS_REMEMBERED}. The CLI's word is never replaced by the
   * adapter's.
   */
  private rememberEndedTask(id: string, by: TaskEndSource, shell?: BackgroundTrack): void {
    const key = id.toLowerCase();
    const previous = this.endedTasks.get(key);
    this.endedTasks.delete(key);
    this.endedTasks.set(
      key,
      previous?.by === "cli" || by === "cli"
        ? { by: "cli" }
        : { by, ...(shell === undefined ? {} : { shell }) }
    );
    evictOldest(this.endedTasks, ENDED_TASKS_REMEMBERED);
  }

  /** Whether any end of the task was written, by the CLI or by the adapter. */
  private hasEnded(taskId: string): boolean {
    return this.endedTasks.has(taskId.toLowerCase());
  }

  /**
   * A CLI report — a snapshot entry with its status, a start frame (no
   * status), a poll answer — naming a shell with no live track: the rows it
   * produces, or `undefined` when no end of it was written, and so it is a
   * task to start as any other (a poll starts nothing for it).
   *
   * One rule, for shells and subagents alike ({@link subagentReport}):
   * - An end the CLI reported is final: nothing starts again.
   * - An end the adapter wrote itself (Stop, the session's stop, the exit, a
   *   task dropping out of a snapshot unannounced) is not the CLI's word — a
   *   Stop's `session/cancel` leaves a background shell running (fixture 21:
   *   a poll 12 s later answered `running`, and the shell outlived the CLI
   *   itself), and a deploy must never kill running work, which outranks a
   *   duplicate row. So a report that the task still runs counts it live
   *   again ({@link reviveShell}), and a report of its end is the CLI's end,
   *   remembered as such, with no row: the adapter already wrote one.
   */
  private shellReport(
    taskId: string,
    status: RuntimeTaskStatus | undefined,
    raw: RuntimeEventRaw,
    fill: { toolUseId?: string; outputFile?: string } = {}
  ): RuntimeEvent[] | undefined {
    const ended = this.endedTasks.get(taskId.toLowerCase());
    if (ended === undefined) {
      return undefined;
    }
    if (ended.by === "cli") {
      return [];
    }
    if (status !== undefined && isEndedTaskStatus(status)) {
      this.rememberEndedTask(taskId, "cli");
      return [];
    }
    if (status === "idle") {
      // Resting: the CLI says neither that it runs nor that it ended.
      return [];
    }
    if (ended.shell === undefined) {
      // An id that named a subagent whose launch is forgotten: no track to
      // count live again, so it starts as any new task would.
      return undefined;
    }
    const track: BackgroundTrack = {
      ...ended.shell,
      toolUseId: ended.shell.toolUseId ?? fill.toolUseId,
      outputFile: ended.shell.outputFile ?? fill.outputFile
    };
    return this.reviveShell(track, status ?? "running", raw);
  }

  /**
   * A shell the adapter closed itself that the CLI reports still running:
   * live again, under its own start row re-emitted — which the roster reads as
   * a late delivery (it keeps the adapter's end) and the liveness registry as
   * live work, bounded by its watch-loop TTL and re-armed by further reports.
   */
  private reviveShell(
    track: BackgroundTrack,
    status: RuntimeTaskStatus,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    this.endedTasks.delete(track.taskId.toLowerCase());
    const revived: BackgroundTrack = { ...track, status, revived: true };
    this.tasks.set(track.taskId, revived);
    return [
      this.event(
        "task.started",
        {
          ...this.shellLinkage(track.taskId, revived),
          description: revived.description ?? revived.command,
          ...(revived.outputFile === undefined ? {} : { outputFile: revived.outputFile })
        },
        revived.turnId,
        raw
      )
    ];
  }

  /**
   * A CLI report naming a subagent run that is not live — {@link shellReport}'s
   * rule: after an end the adapter wrote itself, a report that it still runs
   * counts it live again ({@link reviveSubagent}) and a report of its end is
   * the CLI's, with no row; after the CLI's own end, nothing.
   */
  private subagentReport(
    track: SubagentTrack,
    running: boolean,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    if (track.endedBy !== "adapter") {
      return [];
    }
    if (!running) {
      this.rememberEndedSubagent(track, "cli");
      return [];
    }
    return this.reviveSubagent(track, raw);
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
  private reviveSubagent(track: SubagentTrack, raw: RuntimeEventRaw): RuntimeEvent[] {
    track.live = true;
    track.revived = true;
    track.endedBy = undefined;
    track.listed = false;
    return [
      this.event(
        "task.started",
        { ...this.subagentLinkage(track), description: track.description, isBackgrounded: true },
        track.turnId,
        raw
      )
    ];
  }

  /** The task a background-task frame's ids name, when they are a subagent's. */
  private subagentOfBackgroundTask(
    taskId: string,
    toolCallId: string | undefined
  ): string | undefined {
    const launched =
      toolCallId === undefined ? undefined : this.subagentLaunches.get(toolCallId)?.taskId;
    if (launched !== undefined) {
      this.rememberSubagentId(taskId, launched);
      return launched;
    }
    return this.subagentIds.get(taskId.toLowerCase());
  }

  /** What every row naming the agent carries — its liveness TTL included. */
  private subagentLinkage(track: SubagentTrack): {
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
  private closeSubagent(
    track: SubagentTrack,
    status: "completed" | "failed" | "stopped",
    by: TaskEndSource,
    summary?: string,
    raw?: RuntimeEventRaw,
    usage?: RuntimeTaskUsage
  ): RuntimeEvent[] {
    track.live = false;
    track.revived = false;
    this.rememberEndedSubagent(track, by);
    const events = this.closeAgentWork(track.taskId, "The subagent ended.");
    // The rows that close a run after its turn name the turn it ran in, as a
    // shell's closers do; a foreground end within its own turn is that turn.
    events.push(
      this.event(
        "task.completed",
        {
          ...this.subagentLinkage(track),
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
  private closeAgentWork(taskId: string, reason: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [toolCallId, track] of [...this.tools.entries()]) {
      if (track.owned?.agentId === taskId) {
        events.push(...this.failTool(toolCallId, track, reason));
      }
    }
    for (const child of this.children.values()) {
      if (child.taskId === taskId) {
        events.push(...this.closeChildSegments(child));
      }
    }
    return events;
  }

  /**
   * Emit a proposed plan, deduped **per turn**: identical markdown on a later
   * turn must still produce a fresh card, and an empty write only resets the
   * fallback.
   */
  private proposePlan(markdown: string, raw: RuntimeEventRaw): RuntimeEvent[] {
    const turnId = this.deps.activeTurnId();
    const trimmed = markdown.trim();
    if (trimmed.length === 0) {
      this.lastProposedPlan = { markdown: "", turnId };
      return [];
    }
    if (this.lastProposedPlan?.markdown === trimmed && this.lastProposedPlan.turnId === turnId) {
      return [];
    }
    this.lastProposedPlan = { markdown: trimmed, turnId };
    return [this.event("turn.proposed.completed", { planMarkdown: trimmed }, undefined, raw)];
  }

  /** The plan the agent last wrote, for an `exit_plan_mode` with no content. */
  get lastPlanMarkdown(): string | undefined {
    const markdown = this.lastProposedPlan?.markdown;
    return markdown !== undefined && markdown.length > 0 ? markdown : undefined;
  }

  clearPlanFallback(): void {
    this.lastProposedPlan = undefined;
    this.planModeActive = false;
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
        const hookId = this.deps.uuid();
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
        const hookId = this.hooks.get(key) ?? this.deps.uuid();
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
        return this.foldBackgroundTasks(
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
        return this.taskBackgrounded(update as unknown as Record<string, unknown>, raw, PARENT_SCOPE);
      case "task_completed":
        return this.taskCompleted(update as unknown as Record<string, unknown>, raw);
      case "monitor_event":
        return this.monitorEvent(update as unknown as Record<string, unknown>, raw);
      case "subagent_spawned":
        return this.subagentSpawned(update as unknown as XaiSubagentSpawnedUpdate, raw);
      case "subagent_progress":
        return this.subagentProgress(update as unknown as XaiSubagentProgressUpdate, raw);
      case "subagent_finished":
        return this.subagentFinished(update as unknown as XaiSubagentFinishedUpdate, raw);
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
        return this.closeChildSegments(child);
      case "background_tasks":
        return this.foldBackgroundTasks(
          (update as { tasks?: ReadonlyArray<XaiBackgroundTask> }).tasks ?? [],
          raw,
          scope
        );
      case "task_backgrounded":
        return this.taskBackgrounded(update as unknown as Record<string, unknown>, raw, scope);
      case "task_completed":
        return this.taskCompleted(update as unknown as Record<string, unknown>, raw);
      case "monitor_event":
        return this.monitorEvent(update as unknown as Record<string, unknown>, raw);
      default: {
        const name = (update as { sessionUpdate: string }).sessionUpdate;
        if (KNOWN_XAI_UPDATES.has(name)) {
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
   * `background_tasks` is a **complete snapshot** of ONE session's background
   * tasks with per-task `status`, so the roster folds it directly instead of
   * inferring a lifecycle from `rawOutput` discriminants the way T3 must.
   * Captured (fixtures 16, 18, 20): the CLI sends one whenever a task of that
   * session starts or ends, restating every task it lists; a subagent's child
   * session sends its own, listing its own tasks only ({@link TaskScope}) —
   * so a task drops out of ITS session's snapshot, never another's.
   *
   * An end shows here (`completed`, a killed shell's `failed`), in
   * `_x.ai/task_completed` — the CLI's own end report, which usually comes
   * first ({@link taskCompleted}) — or in a poll or kill answer
   * ({@link taskAnswers}). A task nobody hears from again is bounded by
   * §3.1's liveness TTL; the adapter's duty is to stop claiming it is live
   * once the session ends, which {@link stopBackgroundTasks} does.
   *
   * An entry whose id a `spawn_subagent` launch reported is that subagent: its
   * end, or its dropping out once listed, is the agent's end. Not seen in any
   * capture — the CLI lists shells and monitors here, never a subagent — but
   * kept, since a subagent's id and a task's share one namespace.
   */
  private foldBackgroundTasks(
    tasks: ReadonlyArray<XaiBackgroundTask>,
    raw: RuntimeEventRaw,
    scope: TaskScope
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const seen = new Set<string>();
    const listedSubagents = new Set<string>();
    for (const task of tasks) {
      if (typeof task.task_id !== "string" || task.task_id.length === 0) {
        continue;
      }
      seen.add(task.task_id);
      const status = normalizeTaskStatus(task.status);
      const existing = this.tasks.get(task.task_id);
      const subagentTask =
        existing === undefined ? this.subagentIds.get(task.task_id.toLowerCase()) : undefined;
      if (subagentTask !== undefined) {
        listedSubagents.add(subagentTask);
        events.push(...this.subagentFromSnapshot(subagentTask, status, raw));
        continue;
      }
      if (existing !== undefined) {
        events.push(...this.snapshotChange(existing, task, status, raw));
        continue;
      }
      const reported = this.shellReport(task.task_id, status, raw);
      if (reported !== undefined) {
        events.push(...reported);
        continue;
      }
      events.push(
        ...this.startBackgroundTask(
          {
            taskId: task.task_id,
            command: task.command,
            taskType: task.kind === "monitor" ? "monitor" : "shell",
            scope,
            status,
            ...(task.description === undefined ? {} : { description: task.description }),
            ...(task.output_file === undefined ? {} : { outputFile: task.output_file })
          },
          raw
        )
      );
    }
    // A task that dropped out of its session's snapshot ended without telling us.
    for (const [taskId, track] of [...this.tasks.entries()]) {
      if (track.scope.session !== scope.session || seen.has(taskId) || track.status === "pending") {
        continue;
      }
      this.endShell(taskId, "adapter");
      events.push(
        this.event("task.completed", { ...this.shellLinkage(taskId, track), status: "completed" }, track.turnId, raw)
      );
    }
    if (scope.session === PARENT_SCOPE.session) {
      for (const track of this.subagents.values()) {
        if (track.live && track.listed && !listedSubagents.has(track.taskId)) {
          events.push(...this.closeSubagent(track, "completed", "adapter", undefined, raw));
        }
      }
    }
    return events;
  }

  /**
   * A snapshot entry of a task already tracked. A row only when something the
   * roster or the GUI reads changed — its status, its title (`description`,
   * else `command`), its output file — and then exactly one row, carrying
   * all of it; an unchanged entry emits nothing. The CLI restates every task
   * of a session whenever one of them changes, and a `task.updated` is an
   * APPENDED row (its id is its event's), so one per unchanged listing would
   * be pure churn in the parent's and the agent's retention windows.
   *
   * Nothing here re-arms liveness, and nothing needs to: a shell is a watch
   * loop the registry's TTL bounds (a snapshot is no heartbeat — the CLI
   * sends one on a start or an end, not while a task runs), a monitor re-arms
   * on its own events ({@link monitorEvent}), an agent on its heartbeat
   * ({@link subagentProgress}). A task the adapter closed and the CLI revived
   * keeps the rule of {@link reviveShell}: its status changes ride a
   * status-less, replaced-in-place `task.progress`, never a status that would
   * reopen the roster's row.
   */
  private snapshotChange(
    track: BackgroundTrack,
    task: XaiBackgroundTask,
    status: RuntimeTaskStatus,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const statusChanged = track.status !== status;
    const description = task.description ?? track.description;
    const titleChanged = description !== track.description;
    const outputFile = task.output_file ?? track.outputFile;
    const fileChanged = outputFile !== track.outputFile;
    if (!statusChanged && !titleChanged && !fileChanged) {
      return [];
    }
    track.status = status;
    if (description !== undefined) {
      track.description = description;
    }
    if (outputFile !== undefined) {
      track.outputFile = outputFile;
    }
    const linkage = {
      ...this.shellLinkage(track.taskId, track),
      ...(outputFile === undefined ? {} : { outputFile })
    };
    if (statusChanged && isEndedTaskStatus(status)) {
      this.endShell(track.taskId, "cli");
      return [
        this.event(
          "task.completed",
          { ...linkage, status: status === "completed" || status === "failed" ? status : "stopped" },
          track.turnId,
          raw
        )
      ];
    }
    if (track.revived === true) {
      // The roster keeps the adapter's end, which a status would reopen: a
      // report that it runs only re-arms the shell's liveness, and a resting
      // one says nothing (its watch-loop TTL bounds it).
      if (statusChanged && status !== "idle") {
        return [this.event("task.progress", { ...linkage, description: linkage.title }, track.turnId, raw)];
      }
      if (!titleChanged && !fileChanged) {
        return [];
      }
      return [this.event("task.updated", { ...linkage, description: linkage.title }, track.turnId, raw)];
    }
    return [
      this.event(
        "task.updated",
        {
          ...linkage,
          ...(statusChanged ? { status } : {}),
          ...(titleChanged ? { description: linkage.title } : {})
        },
        track.turnId,
        raw
      )
    ];
  }

  /** A snapshot entry of a subagent's: its terminal status ends the agent. */
  private subagentFromSnapshot(
    taskId: string,
    status: RuntimeTaskStatus,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const track = this.subagents.get(taskId);
    if (track === undefined) {
      return [];
    }
    if (!track.live) {
      if (status === "idle") {
        return [];
      }
      const events = this.subagentReport(track, !isEndedTaskStatus(status), raw);
      if (track.live) {
        track.listed = true;
      }
      return events;
    }
    track.listed = true;
    switch (status) {
      case "completed":
        return this.closeSubagent(track, "completed", "cli", undefined, raw);
      case "failed":
        return this.closeSubagent(track, "failed", "cli", undefined, raw);
      case "cancelled":
      case "interrupted":
        return this.closeSubagent(track, "stopped", "cli", undefined, raw);
      default:
        return [];
    }
  }

  /** Track a new shell or monitor and emit its start. */
  private startBackgroundTask(
    fields: {
      taskId: string;
      command: string;
      taskType: BackgroundTrack["taskType"];
      scope: TaskScope;
      status: RuntimeTaskStatus;
      description?: string;
      toolUseId?: string;
      outputFile?: string;
    },
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const track: BackgroundTrack = { ...fields, turnId: this.deps.activeTurnId() };
    this.tasks.set(fields.taskId, track);
    return [
      this.event(
        "task.started",
        {
          ...this.shellLinkage(fields.taskId, track),
          description: track.description ?? track.command,
          ...(track.outputFile === undefined ? {} : { outputFile: track.outputFile })
        },
        track.turnId,
        raw
      )
    ];
  }

  /**
   * `_x.ai/task_backgrounded` is the only frame carrying `tool_call_id` AND
   * `task_id` together, so it is the cleanest join between a tool call and the
   * task it started. A monitor's carries `monitor_description` too, and
   * arrives before its call's `Monitor` answer (fixture 20): it starts the
   * monitor. A foreground command the CLI moved to the background is
   * reported here too, its task id being its call's (fixture 16).
   */
  private taskBackgrounded(
    update: Record<string, unknown>,
    raw: RuntimeEventRaw,
    scope: TaskScope
  ): RuntimeEvent[] {
    const taskId = update["task_id"];
    const command = update["command"];
    if (typeof taskId !== "string" || taskId.length === 0) {
      return [];
    }
    const toolUseId = typeof update["tool_call_id"] === "string" ? update["tool_call_id"] : undefined;
    // A task a `spawn_subagent` call backgrounded is that subagent, already on
    // the roster — never a shell row of its own. Captured: the CLI sends this
    // frame for shells and monitors only (fixtures 16–23); the join stays for
    // a subagent's id, which shares the task namespace.
    if (scope.session === PARENT_SCOPE.session) {
      const subagentTask = this.subagentOfBackgroundTask(taskId, toolUseId);
      if (subagentTask !== undefined) {
        const track = this.subagents.get(subagentTask);
        return track === undefined || track.live ? [] : this.subagentReport(track, true, raw);
      }
    }
    if (typeof command !== "string") {
      return [];
    }
    const monitorDescription = textArgument(update, "monitor_description");
    const description = textArgument(update, "description") ?? monitorDescription;
    const outputFile = typeof update["output_file"] === "string" ? update["output_file"] : undefined;
    const existing = this.tasks.get(taskId);
    if (existing !== undefined) {
      existing.toolUseId ??= toolUseId;
      return [];
    }
    const reported = this.shellReport(taskId, undefined, raw, { toolUseId, outputFile });
    if (reported !== undefined) {
      return reported;
    }
    return this.startBackgroundTask(
      {
        taskId,
        command,
        taskType: monitorDescription === undefined ? "shell" : "monitor",
        scope,
        status: "running",
        ...(description === undefined ? {} : { description }),
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(outputFile === undefined ? {} : { outputFile })
      },
      raw
    );
  }

  /**
   * `_x.ai/task_completed`: a background shell's or monitor's end, in the
   * session that owns it (fixtures 16, 18, 20) — the CLI's own end report,
   * with the task's final state in `task_snapshot`, before its session's
   * snapshot lists it ended. Never sent for a subagent. An end the CLI
   * reported, once ({@link endBackgroundTask}): `explicitly_killed` is a kill
   * (`stopped`; fixture 18's `sleep 301`, `signal: "killed"`), else the exit
   * code decides (`0` completed), else a signal is a failure, else completed.
   * `will_wake: true` announces the parent's wake (a monitor's end), which is
   * the session's.
   */
  private taskCompleted(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const snapshot = asRecord(update["task_snapshot"]) as Partial<XaiTaskSnapshot> | undefined;
    const taskId = textArgument(snapshot as Record<string, unknown> | undefined, "task_id");
    if (snapshot === undefined || taskId === undefined) {
      return [
        this.event("runtime.warning", { message: "grok: task_completed without a task_snapshot.task_id" }, undefined, raw)
      ];
    }
    const exitCode =
      typeof snapshot.exit_code === "number" && Number.isInteger(snapshot.exit_code) ? snapshot.exit_code : undefined;
    const status: "completed" | "failed" | "stopped" =
      snapshot.explicitly_killed === true
        ? "stopped"
        : exitCode !== undefined
          ? exitCode === 0
            ? "completed"
            : "failed"
          : typeof snapshot.signal === "string" && snapshot.signal.length > 0
            ? "failed"
            : "completed";
    const output = typeof snapshot.output === "string" ? snapshot.output : undefined;
    return this.endBackgroundTask(taskId, status, output, raw, exitCode);
  }

  /**
   * `_x.ai/monitor_event`: one line a monitor's command printed (fixture 20).
   * The monitor's latest line, as a `task.progress` — replaced in place, so a
   * chatty monitor costs one row — re-arming its liveness: a monitor is a
   * watch loop that reports. The CLI then wakes the agent with the line as a
   * prompt of its own, which is the session's. A monitor the adapter closed
   * that still reports is live again ({@link shellReport}).
   */
  private monitorEvent(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const taskId = textArgument(update, "task_id");
    if (taskId === undefined) {
      return [];
    }
    const track = this.tasks.get(taskId);
    if (track === undefined) {
      return this.shellReport(taskId, "running", raw) ?? [];
    }
    const line = textArgument(update, "event_text");
    const linkage = this.shellLinkage(taskId, track);
    return [
      this.event(
        "task.progress",
        {
          ...linkage,
          description: linkage.title,
          ...(line === undefined ? {} : { summary: line }),
          ...(track.revived === true ? {} : { status: "running" })
        },
        track.turnId,
        raw
      )
    ];
  }

  /**
   * The background-task discriminants on a tool call's answer (T3's reader,
   * `XAiBackgroundTasks.ts`, and fixtures 16, 18, 20): `BackgroundTaskStarted`
   * starts a shell; `Monitor` — `{type, taskId, timeoutMs, persistent}` on a
   * completed `monitor` call — starts a monitor, described by the call's own
   * `description` argument (T3's rule; normally `_x.ai/task_backgrounded`
   * started it a millisecond before); `TaskOutput` (a
   * `get_command_or_subagent_output` answer) and `KillTask` (a
   * `kill_command_or_subagent` answer) report on tasks already started.
   */
  private backgroundFromToolCall(
    toolCallId: string,
    rawInput: unknown,
    rawOutput: unknown,
    status: ToolCallStatus | undefined,
    raw: RuntimeEventRaw,
    scope: TaskScope
  ): RuntimeEvent[] {
    const record = asRecord(rawOutput);
    if (record === undefined) {
      return [];
    }
    if (record["type"] === "TaskOutput" || record["type"] === "KillTask") {
      return isTerminalToolStatus(status)
        ? this.taskAnswers(record, status === "completed", raw)
        : [];
    }
    const answerRaw: RuntimeEventRaw = {
      source: ACP_RAW_SOURCE,
      method: "session/update:tool_call_update",
      payload: { toolCallId, rawOutput }
    };
    if (record["type"] === MONITOR_OUTPUT) {
      const taskId = textArgument(record, "taskId") ?? textArgument(record, "task_id");
      if (status !== "completed" || taskId === undefined) {
        return [];
      }
      const input = asRecord(rawInput);
      const description = textArgument(input, "description") ?? "Monitor";
      return this.taskBackgrounded(
        {
          task_id: taskId,
          command: textArgument(input, "command") ?? description,
          tool_call_id: toolCallId,
          monitor_description: description
        },
        answerRaw,
        scope
      );
    }
    if (record["type"] !== "BackgroundTaskStarted" || status === undefined) {
      return [];
    }
    const taskId = record["task_id"] ?? record["taskId"];
    const command = record["command"];
    if (typeof taskId !== "string" || taskId.length === 0 || typeof command !== "string") {
      return [];
    }
    if (this.tasks.has(taskId)) {
      return [];
    }
    return this.taskBackgrounded(
      {
        task_id: taskId,
        command,
        tool_call_id: toolCallId,
        description: typeof record["summary"] === "string" ? record["summary"] : undefined,
        output_file: typeof record["output_file"] === "string" ? record["output_file"] : undefined
      },
      answerRaw,
      scope
    );
  }

  /**
   * A poll or kill answer about tasks this session started, T3's reader
   * (`XAiBackgroundTasks.ts` `buildGrokBackgroundTaskEvents`) with one
   * departure: a subagent's entry (`command: "[subagent:<type>] …"`) is read
   * too, by the id its launch reported — T3 skips it. Shapes, captured
   * (fixtures 16, 18, 21): `{type: "TaskOutput", Result}` or `{…, MultiResult:
   * {mode, results, summary}}`, each `{task_id, command, status, exit_code,
   * started, ended, duration_secs, output, …}`; `{type: "KillTask", Result:
   * {task_id, outcome: "killed", message}}` ({@link killEnd}). Answers arrive
   * between turns too: the CLI wakes the parent when a background task
   * finishes.
   *
   * - `running` re-arms the task's liveness with a progress row, and ends
   *   nothing (its `output` then is the CLI's advice to the model, not
   *   output); a finished status ends a live run once, with `output` as a
   *   subagent's result (a shell's summary is its first line, as T3's); a
   *   completed kill call ends it as {@link killEnd} says.
   * - An id this session never named — an older process's task, a subagent
   *   whose id no launch reported — starts nothing: T3 starts a row for it,
   *   but after a host restart that would name work the first load already
   *   closed.
   */
  private taskAnswers(
    output: Record<string, unknown>,
    callCompleted: boolean,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const multi = asRecord(output["MultiResult"])?.["results"];
    const results = Array.isArray(multi) ? multi : [output["Result"]];
    const events: RuntimeEvent[] = [];
    for (const value of results) {
      const result = asRecord(value);
      const id = textArgument(result, "task_id");
      if (result === undefined || id === undefined) {
        continue;
      }
      if (output["type"] === "KillTask") {
        const end = callCompleted ? killEnd(result) : undefined;
        if (end !== undefined) {
          events.push(...this.endBackgroundTask(id, end, undefined, raw));
        }
        continue;
      }
      const lifecycle = pollLifecycle(result["status"], result["exit_code"]);
      if (lifecycle === undefined) {
        continue;
      }
      const text = typeof result["output"] === "string" ? result["output"].trim() : "";
      const exitCode =
        typeof result["exit_code"] === "number" && Number.isInteger(result["exit_code"])
          ? result["exit_code"]
          : undefined;
      events.push(
        ...(lifecycle === "running"
          ? this.backgroundTaskRunning(id, raw)
          : this.endBackgroundTask(id, lifecycle, text.length > 0 ? text : undefined, raw, exitCode))
      );
    }
    return events;
  }

  /**
   * A task an answer names as still running. A live one: one progress row
   * re-arms it — with no status on a revived one, whose roster row keeps the
   * adapter's end. One the adapter closed itself counts live again
   * ({@link shellReport}, {@link subagentReport}).
   */
  private backgroundTaskRunning(id: string, raw: RuntimeEventRaw): RuntimeEvent[] {
    const shell = this.tasks.get(id);
    if (shell !== undefined) {
      const linkage = this.shellLinkage(id, shell);
      return [
        this.event(
          "task.progress",
          {
            ...linkage,
            description: linkage.title,
            ...(shell.revived === true ? {} : { status: "running" })
          },
          shell.turnId,
          raw
        )
      ];
    }
    const track = this.subagentNamed(id);
    if (track === undefined) {
      return this.shellReport(id, "running", raw) ?? [];
    }
    if (!track.live) {
      return this.subagentReport(track, true, raw);
    }
    return [
      this.event(
        "task.progress",
        {
          ...this.subagentLinkage(track),
          description: track.title,
          ...(track.revived ? {} : { status: "running" })
        },
        track.turnId,
        raw
      )
    ];
  }

  /**
   * A task the CLI reports finished: a live one's end, once — a shell's or
   * monitor's with its output's first line and its exit code, a subagent's
   * with its answer. For one the adapter closed itself, the CLI's end —
   * remembered, with no second row; for one whose end the CLI already
   * reported, nothing.
   */
  private endBackgroundTask(
    id: string,
    status: "completed" | "failed" | "stopped",
    output: string | undefined,
    raw: RuntimeEventRaw,
    exitCode?: number
  ): RuntimeEvent[] {
    const shell = this.tasks.get(id);
    if (shell !== undefined) {
      this.endShell(id, "cli");
      const firstLine = output
        ?.split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim();
      return [
        this.event(
          "task.completed",
          {
            ...this.shellLinkage(id, shell),
            status,
            ...(firstLine === undefined ? {} : { summary: firstLine }),
            ...(exitCode === undefined ? {} : { exitCode })
          },
          shell.turnId,
          raw
        )
      ];
    }
    const track = this.subagentNamed(id);
    if (track === undefined) {
      return this.shellReport(id, status === "stopped" ? "cancelled" : status, raw) ?? [];
    }
    if (!track.live) {
      return this.subagentReport(track, false, raw);
    }
    const owner = this.subagentLaunches.get(track.owner);
    if (owner !== undefined) {
      owner.settled = true;
    }
    return this.closeSubagent(track, status, "cli", subagentAnswerText(output), raw);
  }

  /** The agent an answer's id names, through the ids its launches reported. */
  private subagentNamed(id: string): SubagentTrack | undefined {
    const taskId = this.subagentIds.get(id.toLowerCase());
    return taskId === undefined ? undefined : this.subagents.get(taskId);
  }

  /**
   * A shell's or monitor's rows, as the snapshot and Stop closers write them.
   * Its `agentId` is its owner's — the subagent whose child session started
   * it — else itself (every Grok task row names an agent; the liveness
   * registry reads an id equal to the task's own as "no owner").
   */
  private shellLinkage(
    taskId: string,
    track: BackgroundTrack
  ): {
    taskId: string;
    taskType: string;
    agentKind: "background";
    agentId: string;
    title: string;
    toolUseId?: string;
  } {
    return {
      taskId,
      taskType: track.taskType,
      agentKind: "background",
      agentId: track.scope.owner ?? taskId,
      title: track.description ?? track.command,
      ...(track.toolUseId === undefined ? {} : { toolUseId: track.toolUseId })
    };
  }

  /**
   * Close every live background task and every live subagent. Called before
   * `session.exited`, on the session's stop and on a session-scoped Stop,
   * because a running state must never outlive its process (§3.1) — and
   * because a background run's own end shows only when the CLI reports it.
   * The session closes the open calls FIRST ({@link failOpenTools}): calls
   * before tasks, as every adapter's teardown orders them.
   *
   * These are the adapter's own ends, not the CLI's: fixture 21 shows a
   * session-scoped Stop's `session/cancel` cancelling a background subagent
   * (`subagent_finished {status: "cancelled"}`, which then adds no row) while
   * a background shell runs on — and on past the CLI's own exit — so a later
   * report that a task still runs counts it live again ({@link shellReport}).
   */
  stopBackgroundTasks(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const track of this.subagents.values()) {
      if (!track.live) {
        continue;
      }
      const owner = this.subagentLaunches.get(track.owner);
      if (owner !== undefined) {
        owner.settled = true;
      }
      events.push(...this.closeSubagent(track, "stopped", "adapter"));
    }
    for (const [taskId, track] of [...this.tasks.entries()]) {
      this.endShell(taskId, "adapter");
      events.push(this.event("task.completed", { ...this.shellLinkage(taskId, track), status: "stopped" }, track.turnId));
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
    for (const [toolCallId, track] of [...this.tools.entries()]) {
      events.push(...this.failTool(toolCallId, track, reason));
    }
    events.push(...this.closeAssistantSegment());
    for (const child of this.children.values()) {
      events.push(...this.closeChildSegments(child));
    }
    return events;
  }

  /** One live call, failed by the adapter: its end, and remembered as the adapter's. */
  private failTool(toolCallId: string, track: ToolTrack, reason: string): RuntimeEvent[] {
    this.tools.delete(toolCallId);
    this.rememberFinishedCall(toolCallId, track.itemType, "adapter");
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
        ? this.eventWithItem("item.completed", payload, toolCallId)
        : this.ownedEvent("item.completed", payload, track.owned.agentId, track.owned.turnId, toolCallId)
    ];
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

  requestResolved(input: {
    requestId: string;
    requestType: CanonicalRequestType;
    decision: ApprovalDecision;
  }): RuntimeEvent {
    const base = this.event("request.resolved", {
      requestType: input.requestType,
      decision: input.decision
    });
    return { ...base, requestId: input.requestId };
  }

  /** `_x.ai/ask_user_question` → `user-input.requested`. */
  userInputRequested(input: {
    requestId: string;
    params: XaiAskUserQuestionParams;
    raw: RuntimeEventRaw;
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
      undefined,
      input.raw
    );
    return { ...base, requestId: input.requestId };
  }

  userInputResolved(requestId: string, answers: Record<string, unknown>): RuntimeEvent {
    const base = this.event("user-input.resolved", { answers });
    return { ...base, requestId: requestId };
  }

  // ---------------------------------------------------------------- turns

  /** `turn.completed`, from whichever sources settled the turn. */
  turnCompleted(turnId: string, outcome: GrokTurnOutcome, errorMessage?: string): RuntimeEvent {
    // "Did THIS turn have subagents?" (Codex's rule): a live agent from an
    // earlier turn is not this turn's, and a background shell is no subagent.
    const usage = turnTokenUsage(outcome.usage, this.lastSubagentTurnId === turnId);
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
    const stamp = this.deps.stamp();
    const resolvedTurn = turnId ?? this.deps.activeTurnId();
    return {
      eventId: stamp.eventId,
      threadId: this.deps.threadId,
      createdAt: stamp.createdAt,
      ...(resolvedTurn === undefined ? {} : { turnId: resolvedTurn }),
      ...(raw === undefined ? {} : { raw }),
      type,
      payload
    } as RuntimeEvent;
  }

  private eventWithItem(
    type: RuntimeEvent["type"],
    payload: unknown,
    itemId: string,
    raw?: RuntimeEventRaw
  ): RuntimeEvent {
    return { ...this.event(type, payload, undefined, raw), itemId } as RuntimeEvent;
  }

  /**
   * A subagent's own row: owned on the envelope (`agentId`, where ingestion
   * reads a row's author) and stamped with the EXPLICIT turn it rides —
   * `undefined` is turnless, never "whatever turn is live now".
   */
  private ownedEvent(
    type: RuntimeEvent["type"],
    payload: unknown,
    agentId: string,
    turnId: string | undefined,
    itemId?: string,
    raw?: RuntimeEventRaw
  ): RuntimeEvent {
    const stamp = this.deps.stamp();
    return {
      eventId: stamp.eventId,
      threadId: this.deps.threadId,
      createdAt: stamp.createdAt,
      ...(turnId === undefined ? {} : { turnId }),
      ...(itemId === undefined ? {} : { itemId }),
      agentId,
      ...(raw === undefined ? {} : { raw }),
      type,
      payload
    } as RuntimeEvent;
  }
}

/** `killed`→`cancelled`, `paused`→`idle`, normalised at the adapter (§4.2). */
export function normalizeTaskStatus(status: string | undefined): RuntimeTaskStatus {
  switch (status?.trim().toLowerCase()) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "paused":
    case "idle":
      return "idle";
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "stopped":
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
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
