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
  XaiTaskSnapshot,
  XaiUsage
} from "./acp/_generated/xai.ts";
import { GrokHistoryCollector } from "./history.ts";
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

export interface BackgroundTrack {
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
   * {@link reviveShell}): the roster keeps that end, so no row
   * of this track names a status that would reopen it.
   */
  revived?: boolean;
  /** A monitor's latest line (`_x.ai/monitor_event`), which its progress row shows. */
  lastLine?: string;
  /**
   * The subagent whose child session started it ended while it ran: from
   * then on its rows name itself, so the liveness registry counts it on its
   * own (a watch loop's TTL) rather than as covered by an agent no longer live.
   */
  ownerEnded?: boolean;
}

/**
 * One scheduled prompt — a `/loop`, a `scheduler_create` — by its scheduler
 * task id (fixture 29, observation 52). It runs nothing of its own: each fire
 * is a background subagent the CLI spawns itself, an agent row under its own
 * id, whose end wakes the parent. So its row is typed `scheduled`, which the
 * liveness registry never counts (`INERT_TASK_TYPES`): a week-long loop
 * must not hold a deploy's drain between its fires. It ends when the CLI
 * deletes it, and with the process it lives in.
 */
export interface LoopTrack {
  readonly taskId: string;
  /** The CLI's `human_schedule`: `"every 1 minute"`. */
  schedule: string;
  /** The prompt's first line. */
  prompt: string;
  fires: number;
  /** Its run: the CLI re-creating an ended loop is a new run, a new launch id. */
  run: number;
  /** The turn it was created on: every row of the loop rides it, as a shell's do. */
  readonly turnId?: string;
  live: boolean;
}

/**
 * The session's autonomous goal (`/goal`, fixture 30, observation 53), one at
 * a time. Its work is the turns, wakes and subagents it drives, each live on
 * its own rows; its row — typed `goal`, never live work either — is where its
 * phase, its token budget and how it ended show. A goal that runs again after
 * an end (`/goal resume`) is a relaunch: a new launch id (`run`), which the
 * roster reads as a new run of the same row.
 */
export interface GoalTrack {
  readonly goalId: string;
  readonly taskId: string;
  objective: string;
  run: number;
  live: boolean;
  /**
   * Who wrote the latest run's end, while it is not live: the CLI (the goal
   * left `active`) or the adapter (the session's teardown, a Stop). Only a
   * goal the CLI ended is resumed by its next `active` report.
   */
  endedBy?: TaskEndSource;
  turnId?: string;
  /** What the latest progress row said, bar the token count: a note is written on a change. */
  noted?: string;
  /**
   * The latest `tokens_used` its OWN updates reported: a goal a new one
   * replaces ends with it — the update that replaces it counts the new goal.
   */
  tokensUsed?: number;
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

/**
 * Who wrote a background task's end. `cli`: the CLI reported it — a poll or
 * kill answer, a snapshot's terminal status, the completion tag, a failed
 * spawn call. `adapter`: the adapter wrote it itself — Stop, the session's
 * stop, the exit ({@link GrokNormalizer.stopBackgroundTasks}), or a task that
 * dropped out of a snapshot unannounced.
 */
type TaskEndSource = "cli" | "adapter";

/** A background task whose end was written, and by whom. */
export interface EndedTask {
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
 * ({@link taskCompleted}), never a kill answer. The other
 * kill word, `already_exited` — captured too (fixture 27): `{task_id, outcome:
 * "already_exited", message: "Task had already completed"}` for a shell,
 * "Subagent already completed" for a subagent, no status and no exit code —
 * means nobody stopped the task: the kill found it done. The CLI had reported
 * that end first, so the answer ends nothing then (a run already ended gets no
 * second end); for a run whose end the adapter never saw, it is `completed`,
 * or the answer's own terminal status when it carries one.
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
  return lifecycle === undefined || lifecycle === "running" ? "completed" : lifecycle;
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

/** How many loops the normaliser remembers, the live never forgotten. */
const LOOPS_REMEMBERED = 256;

/** A text's first non-empty line, trimmed; `undefined` for none. */
function firstLineOf(text: string | undefined): string | undefined {
  return text?.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
}

function capitalized(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1).replace(/_/g, " ")}`;
}

/** A non-negative whole count, or `undefined`. */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * What a goal's progress row says, and the key a new note is written on: the
 * phase (planning first), its deliverables and rounds, its last event — never
 * the token count alone, which ticks every few seconds (fixture 30).
 */
function goalNote(update: XaiGoalUpdatedUpdate): { key: string; summary: string } {
  const planning = update.planning === true;
  const phase = typeof update.phase === "string" && update.phase.length > 0 ? update.phase : "active";
  const done = countOf(update.completed_deliverables);
  const total = countOf(update.total_deliverables);
  const used = countOf(update.tokens_used) ?? 0;
  const budget = countOf(update.token_budget);
  const parts = [
    planning ? "Planning" : capitalized(phase),
    ...(total !== undefined && total > 0 ? [`${done ?? 0} of ${total} deliverables`] : []),
    budget === undefined ? `${used} tokens` : `${used} of ${budget} tokens`
  ];
  const key = [
    planning,
    phase,
    update.last_event ?? "",
    done ?? "",
    total ?? "",
    countOf(update.total_worker_rounds) ?? "",
    countOf(update.total_verify_rounds) ?? ""
  ].join("\u0000");
  return { key, summary: parts.join(" · ") };
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
 * A shell's end was written: its track goes, and who wrote it is
 * remembered — with the track itself when the adapter wrote it, so the
 * CLI's later word can count it live again ({@link reviveShell}).
 */
function endShell(state: GrokNormalizerState, taskId: string, by: TaskEndSource): void {
  const track = state.tasks.get(taskId);
  state.tasks.delete(taskId);
  rememberEndedTask(state, taskId, by, by === "adapter" ? track : undefined);
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
 * Oldest first out, so the memory stays within
 * {@link ENDED_TASKS_REMEMBERED}. The CLI's word is never replaced by the
 * adapter's.
 */
function rememberEndedTask(state: GrokNormalizerState, id: string, by: TaskEndSource, shell?: BackgroundTrack): void {
  const key = id.toLowerCase();
  const previous = state.endedTasks.get(key);
  state.endedTasks.delete(key);
  state.endedTasks.set(
    key,
    previous?.by === "cli" || by === "cli"
      ? { by: "cli" }
      : { by, ...(shell === undefined ? {} : { shell }) }
  );
  evictOldest(state.endedTasks, ENDED_TASKS_REMEMBERED);
}

/** Whether any end of the task was written, by the CLI or by the adapter. */
function hasEnded(state: GrokNormalizerState, taskId: string): boolean {
  return state.endedTasks.has(taskId.toLowerCase());
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
function shellReport(
  state: GrokNormalizerState,
  taskId: string,
  status: RuntimeTaskStatus | undefined,
  raw: RuntimeEventRaw,
  fill: { toolUseId?: string; outputFile?: string } = {}
): RuntimeEvent[] | undefined {
  const ended = state.endedTasks.get(taskId.toLowerCase());
  if (ended === undefined) {
    return undefined;
  }
  if (ended.by === "cli") {
    return [];
  }
  if (status !== undefined && isEndedTaskStatus(status)) {
    rememberEndedTask(state, taskId, "cli");
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
  return reviveShell(state, track, status ?? "running", raw);
}

/**
 * A shell the adapter closed itself that the CLI reports still running:
 * live again, under its own start row re-emitted — which the roster reads as
 * a late delivery (it keeps the adapter's end) and the liveness registry as
 * live work, bounded by its watch-loop TTL and re-armed by further reports.
 */
function reviveShell(
  state: GrokNormalizerState,
  track: BackgroundTrack,
  status: RuntimeTaskStatus,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  state.endedTasks.delete(track.taskId.toLowerCase());
  const revived: BackgroundTrack = { ...track, status, revived: true };
  state.tasks.set(track.taskId, revived);
  return [
    event(
      state,
      "task.started",
      {
        ...shellLinkage(track.taskId, revived),
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
function subagentReport(
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
function subagentOfBackgroundTask(
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
function subagentLinkage(track: SubagentTrack): {
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
function closeSubagent(
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
 * The shells and monitors an ended agent's child session started and left
 * running. Stamped with the agent, the liveness registry counted them as
 * covered by its entry — which the agent's end just removed — so a server
 * the subagent left running stopped holding a deploy's drain. Whether the
 * CLI stops them when their subagent ends is not captured, and not killing
 * running work outranks a stale row: from here each names itself, and one
 * row says so — with its own tracked status, so a resting (`idle`) one is
 * not re-armed, and a running one counts on its own (the watch loop's TTL)
 * until its own end. One the CLI revived after an end the adapter wrote
 * gets its own start row again instead ({@link reviveShell}'s rule): a
 * status would reopen the roster's row, which keeps that end, and a
 * status-less row re-arms nothing the registry no longer counts.
 */
function orphanAgentTasks(state: GrokNormalizerState, agentTaskId: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [taskId, task] of state.tasks) {
    if (task.scope.owner !== agentTaskId || task.ownerEnded === true) {
      continue;
    }
    task.ownerEnded = true;
    const linkage = shellLinkage(taskId, task);
    if (task.revived === true) {
      events.push(
        event(
          state,
          "task.started",
          {
            ...linkage,
            description: task.description ?? task.command,
            ...(task.outputFile === undefined ? {} : { outputFile: task.outputFile })
          },
          task.turnId
        )
      );
      continue;
    }
    events.push(
      event(
        state,
        "task.progress",
        {
          ...linkage,
          description: linkage.title,
          ...(task.lastLine === undefined ? {} : { summary: task.lastLine }),
          status: task.status
        },
        task.turnId
      )
    );
  }
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
function foldBackgroundTasks(
  state: GrokNormalizerState,
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
    const existing = state.tasks.get(task.task_id);
    const subagentTask =
      existing === undefined ? state.subagentIds.get(task.task_id.toLowerCase()) : undefined;
    if (subagentTask !== undefined) {
      listedSubagents.add(subagentTask);
      events.push(...subagentFromSnapshot(state, subagentTask, status, raw));
      continue;
    }
    if (existing !== undefined) {
      events.push(...snapshotChange(state, existing, task, status, raw));
      continue;
    }
    const reported = shellReport(state, task.task_id, status, raw);
    if (reported !== undefined) {
      events.push(...reported);
      continue;
    }
    events.push(
      ...startBackgroundTask(
        state,
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
  for (const [taskId, track] of [...state.tasks.entries()]) {
    if (track.scope.session !== scope.session || seen.has(taskId) || track.status === "pending") {
      continue;
    }
    endShell(state, taskId, "adapter");
    events.push(
      event(state, "task.completed", { ...shellLinkage(taskId, track), status: "completed" }, track.turnId, raw)
    );
  }
  if (scope.session === PARENT_SCOPE.session) {
    for (const track of state.subagents.values()) {
      if (track.live && track.listed && !listedSubagents.has(track.taskId)) {
        events.push(...closeSubagent(state, track, "completed", "adapter", undefined, raw));
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
function snapshotChange(
  state: GrokNormalizerState,
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
    ...shellLinkage(track.taskId, track),
    ...(outputFile === undefined ? {} : { outputFile })
  };
  if (statusChanged && isEndedTaskStatus(status)) {
    endShell(state, track.taskId, "cli");
    return [
      event(
        state,
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
      return [event(state, "task.progress", { ...linkage, description: linkage.title }, track.turnId, raw)];
    }
    if (!titleChanged && !fileChanged) {
      return [];
    }
    return [event(state, "task.updated", { ...linkage, description: linkage.title }, track.turnId, raw)];
  }
  return [
    event(
      state,
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
function subagentFromSnapshot(
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

/** Track a new shell or monitor and emit its start. */
function startBackgroundTask(
  state: GrokNormalizerState,
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
  const track: BackgroundTrack = { ...fields, turnId: state.deps.activeTurnId() };
  state.tasks.set(fields.taskId, track);
  return [
    event(
      state,
      "task.started",
      {
        ...shellLinkage(fields.taskId, track),
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
function taskBackgrounded(
  state: GrokNormalizerState,
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
    const subagentTask = subagentOfBackgroundTask(state, taskId, toolUseId);
    if (subagentTask !== undefined) {
      const track = state.subagents.get(subagentTask);
      return track === undefined || track.live ? [] : subagentReport(state, track, true, raw);
    }
  }
  if (typeof command !== "string") {
    return [];
  }
  const monitorDescription = textArgument(update, "monitor_description");
  const description = textArgument(update, "description") ?? monitorDescription;
  const outputFile = typeof update["output_file"] === "string" ? update["output_file"] : undefined;
  const existing = state.tasks.get(taskId);
  if (existing !== undefined) {
    existing.toolUseId ??= toolUseId;
    return [];
  }
  const reported = shellReport(state, taskId, undefined, raw, { toolUseId, outputFile });
  if (reported !== undefined) {
    return reported;
  }
  return startBackgroundTask(
    state,
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
function taskCompleted(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const snapshot = asRecord(update["task_snapshot"]) as Partial<XaiTaskSnapshot> | undefined;
  const taskId = textArgument(snapshot as Record<string, unknown> | undefined, "task_id");
  if (snapshot === undefined || taskId === undefined) {
    return [
      event(state, "runtime.warning", { message: "grok: task_completed without a task_snapshot.task_id" }, undefined, raw)
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
  return endBackgroundTask(state, taskId, status, output, raw, exitCode);
}

/**
 * `_x.ai/monitor_event`: one line a monitor's command printed (fixture 20).
 * The monitor's latest line, as a `task.progress` — replaced in place, so a
 * chatty monitor costs one row — re-arming its liveness: a monitor is a
 * watch loop that reports. The CLI then wakes the agent with the line as a
 * prompt of its own, which is the session's. A monitor the adapter closed
 * that still reports is live again ({@link shellReport}).
 */
function monitorEvent(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const taskId = textArgument(update, "task_id");
  if (taskId === undefined) {
    return [];
  }
  const track = state.tasks.get(taskId);
  if (track === undefined) {
    return shellReport(state, taskId, "running", raw) ?? [];
  }
  const line = textArgument(update, "event_text");
  if (line !== undefined) {
    track.lastLine = line;
  }
  const linkage = shellLinkage(taskId, track);
  return [
    event(
      state,
      "task.progress",
      {
        ...linkage,
        description: linkage.title,
        ...(track.lastLine === undefined ? {} : { summary: track.lastLine }),
        ...(track.revived === true ? {} : { status: "running" })
      },
      track.turnId,
      raw
    )
  ];
}

/**
 * `_x.ai/scheduled_task_created` / `_fired` / `_deleted` — the scheduler's
 * own reports of one scheduled prompt (`/loop`, `scheduler_create`), methods
 * of their own, keyed by its task id (fixture 29, observation 52). Before
 * they were mapped, each was a peer warning: one per fire of a week-long
 * loop. Created: the loop's row starts, typed `scheduled`, titled by its
 * schedule. Fired: the fire notes itself on that row, status-less and in
 * place — the fire itself is the background subagent the CLI spawns right
 * after, an agent row of its own. Deleted: the row ends, `stopped` for a
 * `scheduler_delete` (`reason: "deleted"`), `completed` for one that ran its
 * course (`expired`: loops expire after seven days, read off the docs, not
 * captured). A report naming a loop this process never saw created starts
 * its row first; a loop already ended ends nothing again — a fire after the
 * adapter's own end (a Stop that left the process up; whether a Stop's
 * `session/cancel` deletes a loop is not captured) notes itself on the
 * ended row, and only the CLI re-creating it opens a new run.
 */
function scheduledTask(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const taskId = textArgument(update, "task_id");
  if (taskId === undefined) {
    return [];
  }
  const kind = update["sessionUpdate"];
  const schedule = textArgument(update, "human_schedule");
  const prompt = firstLineOf(textArgument(update, "prompt"));
  let loop = state.loops.get(taskId);
  if (kind === "scheduled_task_deleted") {
    if (loop === undefined || !loop.live) {
      return [];
    }
    loop.live = false;
    const reason = textArgument(update, "reason");
    return [
      event(
        state,
        "task.completed",
        {
          ...loopLinkage(loop),
          status: reason === "expired" ? "completed" : "stopped",
          summary: reason === undefined ? "Deleted" : capitalized(reason)
        },
        loop.turnId,
        raw
      )
    ];
  }
  const events: RuntimeEvent[] = [];
  if (loop === undefined) {
    loop = {
      taskId,
      schedule: schedule ?? "on a schedule",
      prompt: prompt ?? "",
      fires: 0,
      run: 1,
      turnId: state.deps.activeTurnId(),
      live: true
    };
    state.loops.set(taskId, loop);
    evictOldest(state.loops, LOOPS_REMEMBERED, (value) => !value.live);
    events.push(event(state, "task.started", loopLinkage(loop), loop.turnId, raw));
  } else if (kind === "scheduled_task_created") {
    // The CLI re-created a loop it knows (`scheduler_create` naming its id):
    // new words on a live one, a new run of an ended one.
    loop.schedule = schedule ?? loop.schedule;
    loop.prompt = prompt ?? loop.prompt;
    if (loop.live) {
      events.push(event(state, "task.updated", loopLinkage(loop), loop.turnId, raw));
    } else {
      loop.live = true;
      loop.run += 1;
      loop.fires = 0;
      events.push(event(state, "task.started", loopLinkage(loop), loop.turnId, raw));
    }
  }
  if (kind === "scheduled_task_fired") {
    loop.fires += 1;
    events.push(
      event(
        state,
        "task.progress",
        {
          ...loopLinkage(loop),
          summary: loop.fires === 1 ? "Fired once" : `Fired ${loop.fires} times`
        },
        loop.turnId,
        raw
      )
    );
  }
  return events;
}

/**
 * Every row of a loop: nobody's work but the thread's, never live work
 * (`INERT_TASK_TYPES`). The roster folds its type to a `loop` row, chipped
 * as one; its title is its cadence, then what it does.
 */
function loopLinkage(loop: LoopTrack): {
  taskId: string;
  taskType: "scheduled";
  title: string;
  description: string;
  toolUseId: string;
} {
  const cadence = capitalized(loop.schedule);
  return {
    taskId: loop.taskId,
    taskType: "scheduled",
    title: loop.prompt.length > 0 ? `${cadence}: ${loop.prompt}` : cadence,
    description: loop.prompt.length > 0 ? loop.prompt : cadence,
    toolUseId: `loop-run:${loop.taskId}:${loop.run}`
  };
}

/**
 * `goal_updated` (fixture 30, observation 53): the session's autonomous goal,
 * restated whole at every change and every few seconds while its planner or
 * worker runs — eleven warnings in one short run before it was mapped. Its
 * row starts when a goal turns `active`, typed `goal` and titled by its
 * objective; a change of phase, of planning, of its last event or of its
 * deliverables and rounds notes itself on the row (status-less, in place),
 * a tick of the token count alone does not. It ends when the goal leaves
 * `active`: `completed` (its result summary), else `stopped` — out of token
 * budget (`budget_limited`, captured), `paused`, `cleared` (every id and text
 * emptied, captured) — or `failed`. A goal active again after the CLI's own
 * end (`/goal resume`) is a new run of the same row; after the adapter's
 * (a Stop), its progress notes itself on the ended row. A new goal ends the
 * old one.
 */
function goalUpdated(state: GrokNormalizerState, update: XaiGoalUpdatedUpdate, raw: RuntimeEventRaw): RuntimeEvent[] {
  const goalId = typeof update.goal_id === "string" ? update.goal_id.trim() : "";
  const status = typeof update.status === "string" ? update.status.trim() : "";
  let goal = state.goal;
  if (status !== "active") {
    if (goal === undefined || (goalId.length > 0 && goal.goalId !== goalId)) {
      return [];
    }
    if (!goal.live) {
      // The CLI's end of a goal the adapter closed itself: no second row,
      // but its own word from now on — its next `active` is a resume.
      goal.endedBy = "cli";
      return [];
    }
    return [endGoal(state, goal, update, raw)];
  }
  if (goalId.length === 0) {
    return [];
  }
  const events: RuntimeEvent[] = [];
  const objective = typeof update.objective === "string" && update.objective.trim().length > 0
    ? update.objective.trim()
    : "Goal";
  const note = goalNote(update);
  if (goal === undefined || goal.goalId !== goalId) {
    if (goal?.live === true) {
      events.push(endGoal(state, goal, "replaced", raw));
    }
    goal = { goalId, taskId: `goal:${goalId}`, objective, run: 1, live: true, turnId: state.deps.activeTurnId() };
    state.goal = goal;
  } else if (!goal.live && goal.endedBy === "cli") {
    goal.run += 1;
    goal.live = true;
    goal.endedBy = undefined;
    goal.turnId = state.deps.activeTurnId() ?? goal.turnId;
  } else {
    // Live — or closed by the adapter while the CLI still reports it active
    // (whether a Stop's `session/cancel` stops a goal is not captured): its
    // progress notes itself, on the ended row then, and reopens nothing.
    goal.tokensUsed = countOf(update.tokens_used) ?? goal.tokensUsed;
    if (note.key !== goal.noted) {
      goal.noted = note.key;
      events.push(
        event(
          state,
          "task.progress",
          {
            ...goalLinkage(goal),
            summary: note.summary,
            // Its own count, for its row's metrics: the roster never sums a
            // goal's tokens with its agents' (they are the same tokens).
            ...(goal.tokensUsed === undefined ? {} : { usage: { totalTokens: goal.tokensUsed } })
          },
          goal.turnId,
          raw
        )
      );
    }
    return events;
  }
  goal.objective = objective;
  goal.noted = note.key;
  goal.tokensUsed = countOf(update.tokens_used) ?? goal.tokensUsed;
  events.push(event(state, "task.started", goalLinkage(goal), goal.turnId, raw));
  return events;
}

/**
 * The row that ends a goal's run: by the status its own update left
 * `active` in, or `replaced` by a new goal — whose update counts the NEW
 * goal's tokens, so the old one ends with the count it last reported itself.
 */
function endGoal(
  state: GrokNormalizerState,
  goal: GoalTrack,
  end: XaiGoalUpdatedUpdate | "replaced",
  raw: RuntimeEventRaw
): RuntimeEvent {
  goal.live = false;
  goal.endedBy = "cli";
  const update = end === "replaced" ? undefined : end;
  const used = countOf(update?.tokens_used) ?? goal.tokensUsed;
  const budget = countOf(update?.token_budget);
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const endStatus = end === "replaced" ? "replaced" : end.status;
  const [status, summary] = ((): ["completed" | "failed" | "stopped", string] => {
    switch (endStatus) {
      case "completed":
        return ["completed", text(update?.result_summary) ?? "Goal completed"];
      case "budget_limited":
        return [
          "stopped",
          used !== undefined && budget !== undefined
            ? `Token budget reached: ${used} of ${budget} tokens`
            : "Token budget reached"
        ];
      case "paused":
        return ["stopped", text(update?.pause_message) ?? "Paused"];
      case "cleared":
        return ["stopped", "Cleared"];
      case "replaced":
        return ["stopped", "Replaced by a new goal"];
      case "failed":
        return ["failed", text(update?.pause_message) ?? text(update?.result_summary) ?? "Failed"];
      default:
        return ["stopped", capitalized(String(endStatus || "ended"))];
    }
  })();
  return event(
    state,
    "task.completed",
    {
      ...goalLinkage(goal),
      status,
      summary,
      ...(used === undefined || endStatus === "cleared" ? {} : { usage: { totalTokens: used } })
    },
    goal.turnId,
    raw
  );
}

/** Every row of a goal: never live work (`INERT_TASK_TYPES`); a run is a launch id. */
function goalLinkage(goal: GoalTrack): {
  taskId: string;
  taskType: "goal";
  title: string;
  description: string;
  toolUseId: string;
} {
  return {
    taskId: goal.taskId,
    taskType: "goal",
    // The roster folds the type to a `goal` row, chipped as one: the title
    // is the objective alone.
    title: goal.objective,
    description: goal.objective,
    toolUseId: `goal-run:${goal.goalId}:${goal.run}`
  };
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
function backgroundFromToolCall(
  state: GrokNormalizerState,
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
      ? taskAnswers(state, record, status === "completed", raw)
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
    return taskBackgrounded(
      state,
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
  if (state.tasks.has(taskId)) {
    return [];
  }
  return taskBackgrounded(
    state,
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
function taskAnswers(
  state: GrokNormalizerState,
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
        events.push(...endBackgroundTask(state, id, end, undefined, raw));
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
        ? backgroundTaskRunning(state, id, raw)
        : endBackgroundTask(state, id, lifecycle, text.length > 0 ? text : undefined, raw, exitCode))
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
function backgroundTaskRunning(state: GrokNormalizerState, id: string, raw: RuntimeEventRaw): RuntimeEvent[] {
  const shell = state.tasks.get(id);
  if (shell !== undefined) {
    const linkage = shellLinkage(id, shell);
    return [
      event(
        state,
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
  const track = subagentNamed(state, id);
  if (track === undefined) {
    return shellReport(state, id, "running", raw) ?? [];
  }
  if (!track.live) {
    return subagentReport(state, track, true, raw);
  }
  return [
    event(
      state,
      "task.progress",
      {
        ...subagentLinkage(track),
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
function endBackgroundTask(
  state: GrokNormalizerState,
  id: string,
  status: "completed" | "failed" | "stopped",
  output: string | undefined,
  raw: RuntimeEventRaw,
  exitCode?: number
): RuntimeEvent[] {
  const shell = state.tasks.get(id);
  if (shell !== undefined) {
    endShell(state, id, "cli");
    // A shell's summary is its output's first line (T3's rule); a monitor's
    // its LAST — its latest event, as its progress row showed while it ran.
    const lines = (output ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const summary = shell.taskType === "monitor" ? lines.at(-1) : lines[0];
    return [
      event(
        state,
        "task.completed",
        {
          ...shellLinkage(id, shell),
          status,
          ...(summary === undefined ? {} : { summary }),
          ...(exitCode === undefined ? {} : { exitCode })
        },
        shell.turnId,
        raw
      )
    ];
  }
  const track = subagentNamed(state, id);
  if (track === undefined) {
    return shellReport(state, id, status === "stopped" ? "cancelled" : status, raw) ?? [];
  }
  if (!track.live) {
    return subagentReport(state, track, false, raw);
  }
  const owner = state.subagentLaunches.get(track.owner);
  if (owner !== undefined) {
    owner.settled = true;
  }
  return closeSubagent(state, track, status, "cli", subagentAnswerText(output), raw);
}

/** The agent an answer's id names, through the ids its launches reported. */
function subagentNamed(state: GrokNormalizerState, id: string): SubagentTrack | undefined {
  const taskId = state.subagentIds.get(id.toLowerCase());
  return taskId === undefined ? undefined : state.subagents.get(taskId);
}

/**
 * A shell's or monitor's rows, as the snapshot and Stop closers write them.
 * Its `agentId` is its owner's — the subagent whose child session started
 * it — else itself (every Grok task row names an agent; the liveness
 * registry reads an id equal to the task's own as "no owner").
 */
function shellLinkage(
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
    agentId: track.scope.owner !== undefined && track.ownerEnded !== true ? track.scope.owner : taskId,
    title: track.description ?? track.command,
    ...(track.toolUseId === undefined ? {} : { toolUseId: track.toolUseId })
  };
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
