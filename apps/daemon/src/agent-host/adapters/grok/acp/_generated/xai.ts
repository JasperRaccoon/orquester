// The `x.ai/*` extension surface of the Grok CLI's ACP transport.
//
// NOT generated from the upstream ACP schema — xAI publishes none. Every name and
// shape below was either observed in the captures under
// `apps/daemon/test/fixtures/grok/` (CLI 1.0.34: 2026-09-21, and the subagent,
// background-task and monitor captures of 2026-09-25) or is registered by T3 Code
// and kept here so the adapter tolerates it if this CLI starts sending it.
// `observed: false` means "T3 registers it, we never saw it" — treat those as
// speculative and do not build behaviour that *requires* them.
//
// See ../../../../../test/fixtures/grok/README.md ("Protocol observations").

import type { ContentBlock, SessionId, StopReason, ToolCallId } from "./schema";

/* ------------------------------------------------------------------ names */

/**
 * Every extension method may exist in a bare (`x.ai/…`) and an underscore-prefixed
 * (`_x.ai/…`) spelling. Dispatch is an exact string match, so BOTH must be
 * registered for each entry.
 */
export function xaiMethodSpellings(bare: string): readonly [string, string] {
  return [bare, `_${bare}`] as const;
}

/** Agent -> client extension REQUESTS (they expect a JSON-RPC result). */
export const XAI_EXTENSION_REQUESTS = {
  ask_user_question: "x.ai/ask_user_question",
  exit_plan_mode: "x.ai/exit_plan_mode",
} as const;

/** Agent -> client extension NOTIFICATIONS (no result). */
export const XAI_EXTENSION_NOTIFICATIONS = {
  /** Races the `session/prompt` RPC; carries the authoritative stop reason. */
  prompt_complete: "x.ai/session/prompt_complete",
  /** Live private session events (see `XaiSessionUpdate`). */
  session_notification: "x.ai/session_notification",
  /** The same payload shape as `session_notification`, used only during `session/load` replay. */
  session_update: "x.ai/session/update",
  /**
   * A `{sessionId, update, _meta}` frame of its own when a shell command — or
   * a monitor — is backgrounded.
   */
  task_backgrounded: "x.ai/task_backgrounded",
  /**
   * A background shell's or monitor's end, as its own `{sessionId, update,
   * _meta}` frame: `update.task_snapshot` is the task's final state (fixtures
   * README observation 39). Never sent for a subagent.
   */
  task_completed: "x.ai/task_completed",
  /** One line a monitor's command printed, as its own frame (observation 41). */
  monitor_event: "x.ai/monitor_event",
  /**
   * The scheduler's own reports (`/loop`, `scheduler_create`), each a
   * `{sessionId, update, _meta}` frame of its own (fixture 29, observation 52):
   * a scheduled prompt created, fired — naming the subagent its fire runs in —
   * and deleted.
   */
  scheduled_task_created: "x.ai/scheduled_task_created",
  scheduled_task_fired: "x.ai/scheduled_task_fired",
  scheduled_task_deleted: "x.ai/scheduled_task_deleted",
  models_update: "x.ai/models/update",
  settings_update: "x.ai/settings/update",
  announcements_update: "x.ai/announcements/update",
  mcp_servers_updated: "x.ai/mcp/servers_updated",
  mcp_init_progress: "x.ai/mcp/init_progress",
  mcp_server_status: "x.ai/mcp/server_status",
  mcp_initialized: "x.ai/mcp_initialized",
  queue_changed: "x.ai/queue/changed",
  sessions_changed: "x.ai/sessions/changed",
} as const;

export type XaiExtensionRequestName =
  (typeof XAI_EXTENSION_REQUESTS)[keyof typeof XAI_EXTENSION_REQUESTS];
export type XaiExtensionNotificationName =
  (typeof XAI_EXTENSION_NOTIFICATIONS)[keyof typeof XAI_EXTENSION_NOTIFICATIONS];

/* ------------------------------------------------------------- the catalog */

export interface XaiExtensionEntry {
  /** The bare spelling; `_` + this is the other legal spelling. */
  readonly method: string;
  readonly kind: "request" | "notification";
  /** True when this build's capture actually contains the frame. */
  readonly observed: boolean;
  /** The spelling the CLI actually used, when we saw it. */
  readonly observedSpelling: "bare" | "underscore" | null;
  /**
   * True when params were seen wrapped as `{ method, params }`. Never observed on
   * 1.0.34 — every frame arrived unwrapped — but T3 unwraps defensively and so must we.
   */
  readonly observedWrapped: boolean;
  readonly note: string;
}

export const XAI_EXTENSION_CATALOG: ReadonlyArray<XaiExtensionEntry> = [
  {
    method: "x.ai/exit_plan_mode",
    kind: "request",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Fires when the model calls the `exit_plan_mode` tool. `planContent` was populated with the full plan markdown.",
  },
  {
    method: "x.ai/ask_user_question",
    kind: "request",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Only fires when GROK_ASK_USER_QUESTION=1 is in the child environment. Question carries no `id`, so answers must be keyed by question text.",
  },
  {
    method: "x.ai/session/prompt_complete",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Always arrived 1-3 ms BEFORE the session/prompt result, never instead of it.",
  },
  {
    method: "x.ai/session_notification",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "The private live event channel. Carries turn_completed, response_completed, hook_*, pending_interaction, background_tasks, tool_call_delta_chunk, model_changed, auto_compact_completed, last_turn_summary, session_summary_generated, (2026-09-25) subagent_spawned / subagent_progress / subagent_finished, (2026-09-26) goal_updated, and — read off 1.0.3 sessions, named by the 1.0.34 binary — retry_state and compaction_checkpoint (README 57-58). A subagent's child session speaks on it too, under the child's own sessionId.",
  },
  {
    method: "x.ai/session/update",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Same payload as session_notification but used only for `_meta.isReplay` frames during session/load.",
  },
  {
    method: "x.ai/task_backgrounded",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Its own method rather than a session_notification variant. Ties tool_call_id to task_id, and names the on-disk output_file. A monitor's also carries monitor_description. Never sent for a subagent.",
  },
  {
    method: "x.ai/task_completed",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ update: { sessionUpdate: task_completed, task_snapshot, will_wake } } — a background shell's or monitor's end, with its final output, exit_code, signal and explicitly_killed. Sent in the session that owns the task (a subagent's own shell ends in the child's session).",
  },
  {
    method: "x.ai/monitor_event",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ update: { sessionUpdate: monitor_event, task_id, description, event_text } } — one line of a monitor's output; the CLI then wakes the agent with it as a prompt of its own.",
  },
  {
    method: "x.ai/scheduled_task_created",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ update: { sessionUpdate: scheduled_task_created, task_id, prompt, human_schedule, next_fire_at } } — a scheduled prompt (`/loop`, `scheduler_create`) created; `_meta` adds `x.ai/schedulerGeneration` and `x.ai/schedulerRevision` (fixture 29).",
  },
  {
    method: "x.ai/scheduled_task_fired",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ update: { sessionUpdate: scheduled_task_fired, task_id, prompt, human_schedule, next_fire_at, subagent_id } } — one fire, run in a detached background subagent the CLI spawns itself; its `subagent_spawned` follows (fixture 29).",
  },
  {
    method: "x.ai/scheduled_task_deleted",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ update: { sessionUpdate: scheduled_task_deleted, task_id, reason } } — `reason: \"deleted\"` after `scheduler_delete` (fixture 29); expiry after seven days is read off the docs, not captured.",
  },
  {
    method: "x.ai/models/update",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "A SessionModelState, identical in shape to initialize._meta.modelState.",
  },
  {
    method: "x.ai/settings/update",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Server-pushed product settings: tips, announcements, campaigns, gating, permission_mode (observed null).",
  },
  {
    method: "x.ai/announcements/update",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "Marketing announcements keyed by `gen`. Never surface these in the timeline.",
  },
  {
    method: "x.ai/mcp/servers_updated",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "DANGER: echoes every configured MCP server INCLUDING its env values, i.e. the host's real credentials. Must never be written to raw.ndjson unredacted.",
  },
  {
    method: "x.ai/mcp/init_progress",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ total, connected, sessionId } while MCP servers boot after session/new.",
  },
  {
    method: "x.ai/mcp/server_status",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ sessionId, name, source, status, reason, tools }.",
  },
  {
    method: "x.ai/mcp_initialized",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ sessionId, mcpToolCount, elapsedMs } — fires AFTER the first turn may already have completed.",
  },
  {
    method: "x.ai/queue/changed",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "The prompt queue. This is how a steering prompt is visible before it starts running. A client's prompt is listed in `entries` before it runs; a prompt the CLI starts on its own (a wake: subagent-completed-*, task-completed-*, notifications-*) appears only as `runningPromptId`.",
  },
  {
    method: "x.ai/sessions/changed",
    kind: "notification",
    observed: true,
    observedSpelling: "underscore",
    observedWrapped: false,
    note: "{ upserted: SessionRow[], removed: [] } with activity working|idle and a resident flag.",
  },
];

/* -------------------------------------------------------------- the shapes */

/**
 * `x.ai/ask_user_question` params. Observed verbatim on 1.0.34 (gated behind
 * `GROK_ASK_USER_QUESTION=1`); see the catalog entry above and README 16.
 */
export interface XaiAskUserQuestionParams {
  readonly sessionId: SessionId;
  readonly toolCallId: ToolCallId;
  readonly questions: ReadonlyArray<XaiAskUserQuestion>;
  /** Required in T3's decoder. */
  readonly mode: "default" | "plan";
}

export interface XaiAskUserQuestion {
  readonly id?: string;
  readonly question: string;
  readonly options: ReadonlyArray<XaiAskUserQuestionOption>;
  readonly multiSelect?: boolean | null;
}

export interface XaiAskUserQuestionOption {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
  readonly id?: string;
}

/** Keys of `answers`/`annotations` are the QUESTION TEXT, not the question id. */
export type XaiAskUserQuestionResponse =
  | {
      readonly outcome: "accepted";
      readonly answers: { readonly [questionText: string]: ReadonlyArray<string> };
      readonly annotations?: {
        readonly [questionText: string]: { readonly preview?: string; readonly notes?: string };
      };
    }
  | { readonly outcome: "cancelled" };

/** `x.ai/exit_plan_mode` params. Observed verbatim on 1.0.34. */
export interface XaiExitPlanModeParams {
  readonly sessionId: SessionId;
  readonly toolCallId: ToolCallId;
  readonly planContent?: string | null;
}

export type XaiExitPlanModeOutcome = "approved" | "abandoned" | "request_changes";

export interface XaiExitPlanModeResponse {
  readonly outcome: XaiExitPlanModeOutcome;
  readonly feedback?: string;
}

/** `_x.ai/session/prompt_complete` params. */
export interface XaiPromptCompleteParams {
  readonly sessionId: SessionId;
  readonly promptId?: string;
  /** Observed values are the ACP `StopReason` set; `rate_limit` and `error` are T3's extras. */
  readonly stopReason?: StopReason | "rate_limit" | "error" | (string & {});
  readonly agentResult?: unknown;
}

/**
 * Wrapper for the private event channel. `update.sessionUpdate` is xAI's own
 * vocabulary and does NOT overlap the ACP `SessionUpdate` union.
 */
export interface XaiSessionNotificationParams {
  readonly sessionId: SessionId;
  readonly update: XaiSessionUpdate;
  readonly _meta?: XaiUpdateMeta;
}

/** `_meta` seen on both `session/update` and `_x.ai/session_notification`. */
export interface XaiUpdateMeta {
  readonly eventId?: string;
  readonly agentTimestampMs?: number;
  readonly promptId?: string;
  readonly turnStartMs?: number;
  readonly streamStartMs?: number;
  readonly updateType?: string;
  readonly chunkId?: number;
  /** Running context size in tokens. Present on every streamed chunk. */
  readonly totalTokens?: number;
  /** `true` on every frame replayed by `session/load`. */
  readonly isReplay?: boolean;
  readonly [key: string]: unknown;
}

/** Per-turn token accounting, as it appears in several places. */
export interface XaiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly modelCalls?: number;
  readonly apiDurationMs?: number;
  /** USD * 1e9. 121_754_000 ticks = $0.121754. */
  readonly costUsdTicks?: number;
  readonly modelUsage?: { readonly [modelId: string]: XaiUsage };
  readonly numTurns?: number;
}

/** `session/prompt`'s own `_meta` — the richest usage report Grok emits. */
export interface XaiPromptResponseMeta {
  readonly sessionId: SessionId;
  readonly requestId?: string;
  readonly promptId?: string;
  readonly modelId?: string;
  /** Context size after the turn. 0 for locally-handled slash commands. */
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly reasoningTokens?: number;
  readonly usage?: XaiUsage;
  readonly [key: string]: unknown;
}

export type XaiSessionUpdate =
  | { readonly sessionUpdate: "model_changed"; readonly model_id: string; readonly reasoning_effort?: string }
  | {
      readonly sessionUpdate: "turn_completed";
      readonly prompt_id: string;
      readonly stop_reason: StopReason | (string & {});
      readonly usage?: XaiUsage;
      readonly elapsed_ms?: number;
    }
  | {
      readonly sessionUpdate: "response_completed";
      readonly usage?: {
        readonly input_tokens: number;
        readonly output_tokens: number;
        readonly cache_read_input_tokens?: number;
        readonly cache_creation_input_tokens?: number;
        readonly reasoning_tokens?: number;
      };
      readonly signature?: string;
    }
  | {
      readonly sessionUpdate: "tool_call_delta_chunk";
      readonly tool_call_id?: string;
      readonly tool_index: number;
      readonly name?: string;
      readonly arguments_delta?: string;
    }
  | {
      readonly sessionUpdate: "pending_interaction";
      readonly tool_call_id: string;
      /** `question` accompanies `_x.ai/ask_user_question` (README 33). */
      readonly kind: "permission" | "plan_approval" | "question" | (string & {});
    }
  | { readonly sessionUpdate: "interaction_resolved"; readonly tool_call_id: string }
  | {
      readonly sessionUpdate: "hook_run_started";
      readonly event_name: string;
      readonly prompt_id?: string;
      readonly tool_name?: string;
      readonly count: number;
    }
  | {
      readonly sessionUpdate: "hook_execution";
      readonly event_name: string;
      readonly prompt_id?: string;
      readonly tool_name?: string;
      readonly runs: ReadonlyArray<{
        readonly name: string;
        readonly status: { readonly status: string; readonly elapsed_ms?: number };
      }>;
    }
  | { readonly sessionUpdate: "background_tasks"; readonly tasks: ReadonlyArray<XaiBackgroundTask> }
  | {
      readonly sessionUpdate: "auto_compact_completed";
      readonly tokens_before: number;
      readonly tokens_after: number;
      readonly summary_preview?: string | null;
    }
  | { readonly sessionUpdate: "last_turn_summary"; readonly summary: string; readonly prompt_id?: string }
  | { readonly sessionUpdate: "session_summary_generated"; readonly session_summary: string }
  | XaiGoalUpdate
  | XaiSubagentSpawnedUpdate
  | XaiSubagentProgressUpdate
  | XaiSubagentFinishedUpdate
  | XaiRetryState
  | XaiCompactionCheckpoint
  | { readonly sessionUpdate: string; readonly [key: string]: unknown };

/**
 * `goal_updated` — the WHOLE state of the session's `/goal`, on every change
 * and again whenever its counters move; byte-identical repeats happen
 * (fixtures README observation 57). Shaped on a real goal session's persisted
 * `updates.jsonl`, written by 1.0.3 — 119 rows, which `session/load` replays
 * under `_x.ai/session/update` — and on 1.0.34's live frames on
 * `_x.ai/session_notification` (fixture 30, observation 53): `token_budget` on
 * every frame when the goal was set with one, `planning: true` while its
 * planner runs, `status: "budget_limited"` with `last_event:
 * "budget_exceeded"`, and `/goal clear` as `status: "cleared"` with `goal_id`
 * and `objective` emptied and NO `last_event`. The adapter reads it field by
 * field (`../../goal.ts`), never through this type.
 */
export interface XaiGoalUpdate {
  readonly sessionUpdate: "goal_updated";
  readonly goal_id: string;
  readonly objective: string;
  /**
   * Observed `active`, `complete` (1.0.3), `budget_limited` and `cleared`
   * (1.0.34); the binary also names the `*_paused` family and `blocked`.
   */
  readonly status: string;
  /** Observed `executing`, `idle`. */
  readonly phase: string;
  readonly tokens_used: number;
  readonly elapsed_ms: number;
  readonly total_deliverables: number;
  readonly completed_deliverables: number;
  readonly total_worker_rounds: number;
  readonly total_verify_rounds: number;
  readonly token_baseline: number;
  readonly finished_subagent_tokens: number;
  /**
   * Sticky: it names the LAST event, repeated on every frame until the next
   * one. Observed `goal_created`, `worker_completed`, `goal_completed`; the
   * rest are named by the binary (goals §3.3).
   */
  readonly last_event:
    | "goal_created"
    | "planning_completed"
    | "planning_failed"
    | "worker_started"
    | "worker_completed"
    | "worker_failed"
    | "context_rotated"
    | "goal_paused"
    | "goal_resumed"
    | "goal_completed"
    | "goal_cleared"
    | "budget_exceeded"
    | "premature_stop_detected"
    | (string & {});
  /** RFC 3339 with nanoseconds, e.g. `2026-08-31T11:16:34.622415836+00:00`. */
  readonly last_event_timestamp: string;
  readonly last_event_detail?: string;
  readonly planning?: boolean;
  /** While set, `last_classifier_verdict` is still the PREVIOUS verification's. */
  readonly verifying_completion?: boolean;
  readonly classifier_runs_attempted?: number;
  readonly classifier_max_runs?: number;
  readonly last_classifier_verdict?: "not_achieved" | "achieved" | (string & {});
  readonly last_classifier_details_path?: string;
  readonly token_budget?: number | null;
  readonly live_subagent_tokens?: number;
  readonly live_context_pct?: number;
  readonly live_turn_count?: number;
  readonly live_tool_call_count?: number;
}

// Two more kinds of a goal run's private traffic (fixtures README observation
// 58): not in the capture set, shaped on the rows of 1.0.3 sessions on this
// host, and named by the 1.0.34 binary. The adapter reads each field by field
// (`../../normalize.ts`), never through these types. The run's subagents and
// shells are the captured vocabulary below (`XaiSubagent*Update`,
// `XaiTaskCompletedParams`).

/** The CLI retrying a failed model request; `attempt` restarts at 1 for the next request. */
export interface XaiRetryState {
  readonly sessionUpdate: "retry_state";
  /** Only `retrying` observed. */
  readonly type: string;
  readonly attempt: number;
  /** 15 in every observed row. */
  readonly max_retries: number;
  readonly reason: string;
}

/** The CLI's rewind checkpoint at a compaction boundary, just before `auto_compact_completed`. */
export interface XaiCompactionCheckpoint {
  readonly sessionUpdate: "compaction_checkpoint";
  readonly checkpoint_id: string;
  readonly prompt_index_at_compaction: number;
  /** Relative to the session directory: `compaction_checkpoints/<id>.json`. */
  readonly checkpoint_file: string;
  readonly schema_version: number;
  readonly created_at: string;
}

/** `_x.ai/task_backgrounded` params. */
export interface XaiTaskBackgroundedParams {
  readonly sessionId: SessionId;
  readonly update: {
    readonly sessionUpdate: "task_backgrounded";
    readonly tool_call_id: string;
    readonly task_id: string;
    readonly command: string;
    readonly cwd?: string;
    readonly output_file?: string;
    readonly description?: string;
  };
  readonly _meta?: XaiUpdateMeta;
}

export interface XaiBackgroundTask {
  readonly task_id: string;
  readonly command: string;
  /** A monitor's `[monitor] <description>` (2026-09-25). */
  readonly display_command?: string;
  readonly description?: string;
  readonly cwd?: string;
  readonly kind: "bash" | "monitor" | (string & {});
  /** A killed shell was listed `failed` with `signal: "killed"` (fixture 18). */
  readonly status: "running" | "completed" | "failed" | "stopped" | (string & {});
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly output_file?: string;
  readonly signal?: string | null;
}

/**
 * `_x.ai/task_completed` params (fixtures 16, 18, 20): a background shell's or
 * monitor's end, in the session that owns the task. Never sent for a subagent,
 * whose end is `subagent_finished`.
 */
export interface XaiTaskCompletedParams {
  readonly sessionId: SessionId;
  readonly update: {
    readonly sessionUpdate: "task_completed";
    readonly task_snapshot: XaiTaskSnapshot;
    /** The CLI will wake the agent with the end as a prompt of its own. */
    readonly will_wake?: boolean;
  };
  readonly _meta?: XaiUpdateMeta;
}

/** The twenty-field `TaskSnapshot`, as captured (a shell's has no `display_command`). */
export interface XaiTaskSnapshot {
  readonly task_id: string;
  readonly command: string;
  readonly display_command?: string;
  readonly cwd?: string;
  readonly start_time?: { readonly secs_since_epoch: number; readonly nanos_since_epoch: number };
  readonly end_time?: { readonly secs_since_epoch: number; readonly nanos_since_epoch: number };
  readonly output?: string;
  readonly output_file?: string;
  readonly truncated?: boolean;
  readonly output_total_bytes?: number;
  readonly exit_code?: number | null;
  /** `"killed"` after `kill_command_or_subagent`. */
  readonly signal?: string | null;
  readonly completed?: boolean;
  readonly kind?: "bash" | "monitor" | (string & {});
  /** The model was waiting on it (a positive `timeout_ms` poll) when it ended. */
  readonly block_waited?: boolean;
  readonly explicitly_killed?: boolean;
  readonly kill_result_delivered?: boolean;
  readonly owner_session_id?: string;
  readonly description?: string;
  readonly is_backgrounded?: boolean;
}

/** `_x.ai/monitor_event` params (fixture 20): one line of a monitor's output. */
export interface XaiMonitorEventParams {
  readonly sessionId: SessionId;
  readonly update: {
    readonly sessionUpdate: "monitor_event";
    readonly task_id: string;
    readonly description?: string;
    readonly event_text: string;
  };
  readonly _meta?: XaiUpdateMeta;
}

/**
 * `_x.ai/scheduled_task_created` / `_fired` / `_deleted` params (fixture 29):
 * the scheduler's reports of one scheduled prompt, keyed by its `task_id` (the
 * id `scheduler_create` answered and `scheduler_delete` takes).
 */
export interface XaiScheduledTaskParams {
  readonly sessionId: SessionId;
  readonly update: {
    readonly sessionUpdate: "scheduled_task_created" | "scheduled_task_fired" | "scheduled_task_deleted";
    readonly task_id: string;
    readonly prompt?: string;
    /** `"every 1 minute"`. */
    readonly human_schedule?: string;
    readonly next_fire_at?: string;
    /** A fire's: the subagent it runs in, whose `subagent_spawned` follows. */
    readonly subagent_id?: string;
    /** A deletion's: `"deleted"` after `scheduler_delete`. */
    readonly reason?: string;
  };
  readonly _meta?: XaiUpdateMeta;
}

/**
 * `subagent_spawned` on the parent's `_x.ai/session_notification` (fixtures
 * 15–23). `subagent_id` equals `child_session_id`: the child's own frames
 * arrive under that session id. A `resume_from` launch spawns a NEW id,
 * naming its source in `resumed_from` (fixture 17).
 */
export interface XaiSubagentSpawnedUpdate {
  readonly sessionUpdate: "subagent_spawned";
  readonly subagent_id: string;
  readonly attempt_id?: string;
  readonly parent_session_id?: string;
  readonly parent_prompt_id?: string;
  readonly child_session_id?: string;
  /** Captured: `general-purpose`; 1.0.3 goal sessions also `explore` (observation 58). */
  readonly subagent_type?: string;
  readonly description?: string;
  /** `"new"`, or `"resumed"` with `resumed_from`. */
  readonly effective_context_source?: string;
  readonly resumed_from?: string;
  /** 1.0.3 goal sessions only, on `explore` agents (observation 58). */
  readonly role?: string;
  /** 1.0.3 goal sessions, e.g. `read-only` (observation 58). */
  readonly capability_mode?: string;
  readonly model?: string;
  readonly agentAddress?: string;
}

/** `subagent_progress`: a heartbeat about every 10 s while the child runs, and after each of its tool calls. */
export interface XaiSubagentProgressUpdate {
  readonly sessionUpdate: "subagent_progress";
  readonly subagent_id: string;
  readonly attempt_id?: string;
  readonly parent_session_id?: string;
  readonly child_session_id?: string;
  readonly duration_ms?: number;
  readonly turn_count?: number;
  readonly tool_call_count?: number;
  readonly tokens_used?: number;
  readonly context_window_tokens?: number;
  readonly context_usage_pct?: number;
  readonly tools_used?: ReadonlyArray<string>;
  readonly error_count?: number;
}

/**
 * `subagent_finished`: the run's end, foreground or background. `output` on a
 * completed run; `error` (and no `output`) on a cancelled one.
 */
export interface XaiSubagentFinishedUpdate {
  readonly sessionUpdate: "subagent_finished";
  readonly subagent_id: string;
  readonly attempt_id?: string;
  readonly child_session_id?: string;
  /** Captured: `completed`, `cancelled`. */
  readonly status: string;
  readonly output?: string;
  readonly error?: string;
  readonly tool_calls?: number;
  readonly turns?: number;
  readonly duration_ms?: number;
  readonly tokens_used?: number;
  /** A background run's end wakes the parent (`subagent-completed-<id>`). */
  readonly will_wake?: boolean;
}

/** `_meta["x.ai/tool"]` on every `tool_call` / `tool_call_update`. */
export interface XaiToolMeta {
  readonly version: number;
  readonly name: string;
  /** Authoritative tool kind. `enter_plan` / `exit_plan` make plan detection exact. */
  readonly kind:
    | "execute"
    | "read"
    | "write"
    | "edit"
    | "search"
    | "list"
    | "enter_plan"
    | "exit_plan"
    | (string & {});
  readonly namespace: string;
  readonly label: string;
  readonly read_only: boolean;
  readonly input?: { readonly [key: string]: unknown };
}

/** `rawOutput` discriminants used to reconstruct background work. */
export type XaiRawOutputType =
  | "Bash"
  | "BackgroundTaskStarted"
  | "TaskOutput"
  | "Monitor"
  | "KillTask"
  | (string & {});

export interface XaiBackgroundTaskStartedRawOutput {
  readonly type: "BackgroundTaskStarted";
  readonly task_id: string;
  readonly task_type: string;
  readonly command: string;
  readonly status: string;
  readonly output_file?: string;
  readonly summary?: string;
  readonly retrieval_hint?: string;
  readonly pid?: number;
}

/** The ONLY content block shape Grok streams in chunks. */
export type GrokContentChunk = Extract<ContentBlock, { type: "text" }>;
