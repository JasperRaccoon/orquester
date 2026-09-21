// The `x.ai/*` extension surface of the Grok CLI's ACP transport.
//
// NOT generated from the upstream ACP schema — xAI publishes none. Every name and
// shape below was either observed in the captures under
// `apps/daemon/test/fixtures/grok/` (CLI 1.0.34, 2026-09-21) or is registered by
// T3 Code and kept here so the adapter tolerates it if this CLI starts sending it.
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
    observed: false,
    observedSpelling: null,
    observedWrapped: false,
    note: "Not produced by any capture; gated behind the CLI's GROK_ASK_USER_QUESTION feature. Shape below is T3's.",
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
    note: "The private live event channel. Carries turn_completed, response_completed, hook_*, pending_interaction, background_tasks, tool_call_delta_chunk, model_changed, auto_compact_completed, last_turn_summary, session_summary_generated.",
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
    note: "The prompt queue. This is how a steering prompt is visible before it starts running.",
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

/** `x.ai/ask_user_question` params. Shape from T3; not observed on 1.0.34. */
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
      readonly kind: "permission" | "plan_approval" | (string & {});
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
  | { readonly sessionUpdate: string; readonly [key: string]: unknown };

export interface XaiBackgroundTask {
  readonly task_id: string;
  readonly command: string;
  readonly description?: string;
  readonly cwd?: string;
  readonly kind: "bash" | (string & {});
  readonly status: "running" | "completed" | "failed" | "stopped" | (string & {});
  readonly started_at?: string;
  readonly output_file?: string;
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
