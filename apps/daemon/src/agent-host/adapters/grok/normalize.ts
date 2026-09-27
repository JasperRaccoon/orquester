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
 * This file is the entry point: `GrokNormalizer`, the class the session and
 * the tests drive, and the frame routing — the ACP `session/update` switch and
 * the private channel's, a subagent's child session's frames included. What a
 * frame does to the work the normaliser tracks is in the module for its
 * concern, each a set of functions over the state the instance holds
 * (`normalizer-state.ts`, with the envelope every row is built with):
 * `segments.ts` (assistant text and reasoning, the parent's and a child
 * session's), `tool-calls.ts` (a call's rows, finished calls, the plan card),
 * `subagents.ts` (spawn calls, the `subagent_*` reports, child sessions,
 * `resume_from`), `background-tasks.ts` (shells and monitors: snapshots, the
 * CLI's reports, poll and kill answers, ended-task memory and revival) and
 * `loops-goals.ts` (scheduled prompts and the goal).
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
  ThreadTokenUsage,
  TurnTokenUsage,
  UserInputQuestion
} from "@orquester/api/agent-chat";

import type {
  SessionNotification,
  SessionUpdate
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
  endShell,
  foldBackgroundTasks,
  monitorEvent,
  PARENT_SCOPE,
  shellLinkage,
  taskBackgrounded,
  taskCompleted,
  type TaskScope
} from "./background-tasks.ts";
import { GrokHistoryCollector } from "./history.ts";
import { goalLinkage, goalUpdated, loopLinkage, scheduledTask } from "./loops-goals.ts";
import {
  ACP_RAW_SOURCE,
  createNormalizerState,
  event,
  XAI_RAW_SOURCE,
  type GrokNormalizerDeps,
  type GrokNormalizerState
} from "./normalizer-state.ts";
import {
  childReasoning,
  childText,
  closeAssistantSegment,
  closeChildSegments,
  contentDelta
} from "./segments.ts";
import {
  closeSubagent,
  cutUnspawnedLaunch,
  subagentFinished,
  subagentProgress,
  subagentSpawned,
  type ChildSession,
  type GROK_AGENT_LIVENESS_TTL_MS
} from "./subagents.ts";
import { failTool, toolCall } from "./tool-calls.ts";
import { parseResponseCompletedUsage, parseXaiUsage, turnTokenUsage } from "./usage.ts";
import { contextTokensOf, isReplayFrame } from "./xai-meta.ts";

export { ENDED_TASKS_REMEMBERED, normalizeTaskStatus } from "./background-tasks.ts";
export {
  ACP_RAW_SOURCE,
  XAI_RAW_SOURCE,
  type GrokEventStamp,
  type GrokNormalizerDeps
} from "./normalizer-state.ts";
export {
  GROK_AGENT_LIVENESS_TTL_MS,
  SPAWN_SUBAGENT_TOOL,
  SUBAGENTS_REMEMBERED,
  subagentAnswerText
} from "./subagents.ts";
export { FINISHED_CALLS_REMEMBERED } from "./tool-calls.ts";

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
   * end with it. `ended` is said on a live loop's and goal's row at such an
   * end — "Ended when the agent host stopped", say — which a bare "Stopped"
   * read as the user's doing; the user's end and a Stop say nothing.
   *
   * These are the adapter's own ends, not the CLI's: fixture 21 shows a
   * session-scoped Stop's `session/cancel` cancelling a background subagent
   * (`subagent_finished {status: "cancelled"}`, which then adds no row) while
   * a background shell runs on — and on past the CLI's own exit — so a later
   * report that a task still runs counts it live again: see `shellReport`
   * (`background-tasks.ts`).
   */
  stopBackgroundTasks(notes: { leftRunning?: string; ended?: string } = {}): RuntimeEvent[] {
    const { leftRunning, ended } = notes;
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
    const why = ended === undefined ? {} : { summary: ended };
    for (const loop of this.state.loops.values()) {
      if (loop.live) {
        loop.live = false;
        events.push(this.event("task.completed", { ...loopLinkage(loop), status: "stopped", ...why }, loop.turnId));
      }
    }
    if (this.state.goal?.live === true) {
      this.state.goal.live = false;
      this.state.goal.endedBy = "adapter";
      events.push(
        this.event(
          "task.completed",
          { ...goalLinkage(this.state.goal), status: "stopped", ...why },
          this.state.goal.turnId
        )
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
   * ({@link closeSubagent}), a background child's outlive the turn. A cut
   * spawn no `subagent_spawned` joined — supervised, its own card was
   * pending — never had a child: its agent ends here, `stopped`
   * ({@link cutUnspawnedLaunch}).
   */
  cutTurnCalls(reason: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [toolCallId, track] of [...this.state.tools.entries()]) {
      if (track.owned === undefined) {
        events.push(...failTool(this.state, toolCallId, track, reason));
        // A spawn cut before the CLI spawned its child: its agent never
        // started, and nothing will ever end it but this.
        events.push(...cutUnspawnedLaunch(this.state, toolCallId));
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
