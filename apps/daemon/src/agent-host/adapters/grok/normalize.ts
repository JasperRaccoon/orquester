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
  AgentGoal,
  ApprovalDecision,
  CanonicalRequestType,
  ProviderThreadTurnSnapshot,
  RuntimeEvent,
  RuntimeEventRaw,
  RuntimeEventRawSource,
  RuntimeItemStatus,
  RuntimeTaskCompletedStatus,
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
  XaiUsage
} from "./acp/_generated/xai.ts";
import { GrokGoalTracker } from "./goal.ts";
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
  /**
   * The goal the thread shows (`StartSessionInput.knownGoal`, goals §5.3), so
   * a goal row goes out only for a real change (goals §6).
   */
  readonly knownGoal?: AgentGoal | null;
  /** The clock the `progress` throttle reads (goals §6). Default `Date.now`. */
  now?(): number;
  /** Frames this adapter drops on purpose say why here, never in a warning. */
  debug?(message: string, detail?: unknown): void;
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
  /** `_meta["x.ai/tool"].name`, e.g. `spawn_subagent`. */
  vendorName?: string;
  /** The subagent this `spawn_subagent` call launched, once one claimed it. */
  launchedTaskId?: string;
  itemType: ReturnType<typeof itemTypeFromToolKind>;
  started: boolean;
  lastEmittedProgressLength?: number;
  skippedSinceEmit: number;
}

/** A live subagent, from `subagent_spawned` to `subagent_finished`. */
interface SubagentTrack {
  readonly taskId: string;
  /** Repeated on every row of the task (§4.2 "linkage on every row"). */
  readonly linkage: {
    readonly taskType: "subagent";
    readonly agentKind: "agent";
    readonly agentId: string;
    readonly title?: string;
    readonly role?: string;
    readonly model?: string;
    readonly toolUseId?: string;
  };
  readonly turnId: string | undefined;
}

/** How many finished background shells are remembered, so a stale snapshot cannot reopen one. */
const MAX_FINISHED_TASK_IDS = 256;

/** How many finished `spawn_subagent` calls wait, by subagent id, for their `subagent_spawned`. */
const MAX_SPAWN_RESULTS = 256;

/** The `subagent_id: <id>` line of a finished `spawn_subagent` call's result. */
const SPAWN_RESULT_SUBAGENT_ID = /(?:^|\n)subagent_id:[ \t]*(\S+)/;

/** A `spawn_subagent` call, as the subagent it launched will name it. */
interface SpawnCall {
  readonly toolCallId: string;
  /** The call's `rawInput.run_in_background`. */
  readonly background?: boolean;
}

interface BackgroundTrack {
  readonly taskId: string;
  readonly command: string;
  description?: string;
  status: RuntimeTaskStatus;
  toolUseId?: string;
  outputFile?: string;
  turnId?: string;
}

const TOOL_STATUS_TO_ITEM_STATUS: Record<ToolCallStatus, RuntimeItemStatus> = {
  pending: "inProgress",
  in_progress: "inProgress",
  completed: "completed",
  failed: "failed"
};

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
  // Goals §6.3 item 1: it used to reach the unmapped fallback, one warning row
  // per frame of a goal run.
  "goal_updated",
  // A goal run's other traffic (fixtures README observation 37) — about 120
  // warning rows per run before these were mapped.
  "subagent_spawned",
  "subagent_finished",
  "retry_state",
  "compaction_checkpoint",
  "task_completed"
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

  /** The provider's goal, live and replayed (goals §6.3). */
  private readonly goals: GrokGoalTracker;

  private readonly tools = new Map<string, ToolTrack>();
  private readonly tasks = new Map<string, BackgroundTrack>();
  /** Background shells `task_completed` closed: a stale roster snapshot must not reopen one. */
  private readonly finishedTaskIds = new Set<string>();
  private readonly subagents = new Map<string, SubagentTrack>();
  /** Finished `spawn_subagent` calls, by the subagent id their result names — until it spawns. */
  private readonly spawnResults = new Map<string, SpawnCall>();
  /** A subagent ran in the current turn: its usage then says `hasSubagents`. */
  private subagentsThisTurn = false;
  /** The open retry episode's last attempt; `undefined` when none is open. */
  private retryAttempt: number | undefined;
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

  constructor(deps: GrokNormalizerDeps, sessionId: string) {
    this.deps = deps;
    // Unique per NORMALISER instance, not per session: a `session/load` reuses
    // the session id, and an item id that collided across the restart would
    // merge two different assistant bubbles.
    this.runtimeId = `${sessionId}:${deps.uuid()}`;
    this.goals = new GrokGoalTracker({
      ...(deps.knownGoal === undefined ? {} : { knownGoal: deps.knownGoal }),
      now: deps.now ?? Date.now,
      ...(deps.debug === undefined ? {} : { debug: deps.debug })
    });
  }

  // ------------------------------------------------------------------ state

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
    this.retryAttempt = undefined;
    this.resetTurnUsage();
  }

  /**
   * The turn settled: close any open assistant bubble so the UI never keeps a
   * dangling in-progress row, and stop accepting late chunks.
   */
  endTurn(): RuntimeEvent[] {
    this.assistantUpdatesOpen = false;
    this.retryAttempt = undefined;
    return this.closeAssistantSegment();
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
   * block, and a replayed `goal_updated` for the goal it leaves (see
   * {@link handleXaiNotification}); nothing else is.
   */
  handleSessionUpdate(params: SessionNotification): RuntimeEvent[] {
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
    method: string
  ): RuntimeEvent[] {
    const toolCallId = update.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
      return [];
    }

    const previous = this.tools.get(toolCallId);
    const vendor = xaiToolMeta(update._meta);
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

    const vendorName = vendor?.name ?? previous?.vendorName;
    const next: ToolTrack = {
      toolCallId,
      kind: kind ?? undefined,
      rawInput,
      ...(vendorName === undefined ? {} : { vendorName }),
      ...(previous?.launchedTaskId === undefined ? {} : { launchedTaskId: previous.launchedTaskId }),
      // `_meta["x.ai/tool"].kind` is Grok's own authoritative discriminant, it
      // is finer-grained than ACP's, and it is present on the FIRST frame of a
      // call where ACP's `kind` is still absent — so it leads.
      itemType: itemTypeFromToolKind(acpKindFromVendorKind(vendor?.kind) ?? kind ?? undefined),
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
      // A tool call ends the current assistant bubble.
      events.push(...this.closeAssistantSegment());

      const lifecycle = terminal ? "item.completed" : next.started ? "item.updated" : "item.started";
      next.started = true;
      next.lastEmittedProgressLength = toolProgressLength(next);
      next.skippedSinceEmit = 0;
      events.push(
        this.eventWithItem(
          lifecycle,
          {
            itemType: next.itemType,
            ...(status === undefined ? {} : { status: TOOL_STATUS_TO_ITEM_STATUS[status] }),
            ...(next.title === undefined ? {} : { title: next.title }),
            ...(next.detail === undefined ? {} : { detail: next.detail }),
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
          },
          toolCallId,
          { source: ACP_RAW_SOURCE, method: `session/update:${method}`, payload: params }
        )
      );
    } else {
      next.skippedSinceEmit = decision.skipped;
    }

    if (terminal) {
      if (next.vendorName === "spawn_subagent") {
        this.noteSpawnResult(next);
      }
      // A late update on a finished call must look brand-new, not like a
      // no-op that coalescing would swallow.
      this.tools.delete(toolCallId);
    } else {
      this.tools.set(toolCallId, next);
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

    events.push(...this.backgroundFromToolCall(toolCallId, rawInput, rawOutput, status));
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
    const envelope = params as { update?: XaiSessionUpdate; _meta?: unknown } | null;
    const update = envelope?.update;
    if (update === undefined || update === null || typeof update.sessionUpdate !== "string") {
      return [
        this.event("runtime.warning", {
          message: `grok: ${method} without an update body`
        })
      ];
    }
    if (isReplayFrame(envelope?._meta)) {
      // Replay is history the HOST already holds for a thread it has seen;
      // for one it has not, `projectHistory` rebuilds it from here.
      this.history.observeXaiUpdate(update as Record<string, unknown>);
      this.absorbReplayUsage(update);
      if (update.sessionUpdate === "goal_updated") {
        // Goals §6.3 item 4: a replayed goal is the past. It is remembered as
        // the provider's state and compared ONCE, by `reconcileGoal`, when
        // the load has completed — never emitted as it arrives.
        this.goals.replayed(update);
      }
      return [];
    }
    return this.handleXaiUpdate(method, update, params);
  }

  /**
   * Goals §6.3 item 4: once the session is up, the provider's goal against
   * the goal the thread shows. At most one `thread.goal.updated`, live. A
   * fresh session (`"new"`) has no goal; a load (`"load"`) that replayed no
   * goal row is no evidence of anything ({@link GrokGoalTracker.reconcile}).
   */
  reconcileGoal(opened: "new" | "load"): RuntimeEvent[] {
    const payload = this.goals.reconcile(opened);
    return payload === null ? [] : [this.event("thread.goal.updated", payload)];
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
        return this.foldBackgroundTasks((update as { tasks?: ReadonlyArray<XaiBackgroundTask> }).tasks ?? [], raw);
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
        return this.taskBackgrounded(update as unknown as Record<string, unknown>, raw);
      case "subagent_spawned":
        return this.subagentSpawned(update as unknown as Record<string, unknown>, raw);
      case "subagent_finished":
        return this.subagentFinished(update as unknown as Record<string, unknown>, raw);
      case "retry_state":
        return this.retryState(update as unknown as Record<string, unknown>, raw);
      case "compaction_checkpoint":
        // The CLI's own rewind checkpoint at the compaction boundary, written
        // 1–36 ms BEFORE `auto_compact_completed`, which carries the boundary
        // itself (and `10`'s 1.0.34 capture did not even send it live —
        // observation 37). A row here would mark one compaction twice.
        return [];
      case "task_completed":
        return this.taskCompleted(update as unknown as Record<string, unknown>, raw);
      case "goal_updated": {
        // Goals §6.3: the whole goal, on every change and whenever its
        // counters move. Whatever method carried it — a frame that is not a
        // replay is live — it becomes at most one goal row, never a warning.
        const payload = this.goals.live(update);
        return payload === null ? [] : [this.event("thread.goal.updated", payload, undefined, raw)];
      }
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

  // ------------------------------------------------------ background tasks

  /**
   * `background_tasks` is a **complete snapshot** with per-task `status`, so
   * the roster folds it directly instead of inferring a lifecycle from
   * `rawOutput` discriminants the way T3 must.
   *
   * The catch (observation 29): **nothing is emitted after the turn settles.**
   * Twenty seconds of watching a `sleep 25` produced no completion event at
   * all — Grok surfaces background progress only when the model polls. So a
   * task seen `running` may never be heard from again, and §3.1's liveness
   * registry needs its own expiry or the thread reads "monitoring" forever.
   * That is a host-side concern; the adapter's duty is to stop claiming the
   * task is live once the session ends, which {@link stopBackgroundTasks}
   * does.
   */
  private foldBackgroundTasks(tasks: ReadonlyArray<XaiBackgroundTask>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const seen = new Set<string>();
    for (const task of tasks) {
      if (typeof task.task_id !== "string" || task.task_id.length === 0) {
        continue;
      }
      if (this.finishedTaskIds.has(task.task_id)) {
        // `task_completed` closed it; a snapshot still listing it is stale.
        continue;
      }
      seen.add(task.task_id);
      const status = normalizeTaskStatus(task.status);
      const existing = this.tasks.get(task.task_id);
      const turnId = existing?.turnId ?? this.deps.activeTurnId();
      const linkage = {
        taskId: task.task_id,
        taskType: task.kind === "bash" ? "shell" : (task.kind ?? "shell"),
        agentKind: "background" as const,
        agentId: task.task_id,
        title: task.description ?? task.command,
        ...(existing?.toolUseId === undefined ? {} : { toolUseId: existing.toolUseId }),
        ...(task.output_file === undefined ? {} : { outputFile: task.output_file })
      };
      if (existing === undefined) {
        this.tasks.set(task.task_id, {
          taskId: task.task_id,
          command: task.command,
          description: task.description,
          status,
          outputFile: task.output_file,
          turnId
        });
        events.push(
          this.event("task.started", { ...linkage, description: task.description ?? task.command }, turnId, raw)
        );
        continue;
      }
      if (existing.status === status) {
        continue;
      }
      existing.status = status;
      if (status === "completed" || status === "failed") {
        this.tasks.delete(task.task_id);
        events.push(this.event("task.completed", { ...linkage, status }, turnId, raw));
      } else {
        events.push(this.event("task.updated", { ...linkage, status }, turnId, raw));
      }
    }
    // A task that dropped out of the snapshot ended without telling us.
    for (const [taskId, track] of [...this.tasks.entries()]) {
      if (seen.has(taskId) || track.status === "pending") {
        continue;
      }
      this.tasks.delete(taskId);
      events.push(
        this.event(
          "task.completed",
          {
            taskId,
            taskType: "shell",
            agentKind: "background",
            agentId: taskId,
            title: track.description ?? track.command,
            status: "completed"
          },
          track.turnId,
          raw
        )
      );
    }
    return events;
  }

  /**
   * `_x.ai/task_backgrounded` is the only frame carrying `tool_call_id` AND
   * `task_id` together, so it is the cleanest join between a tool call and the
   * task it started.
   */
  private taskBackgrounded(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const taskId = update["task_id"];
    const command = update["command"];
    if (typeof taskId !== "string" || taskId.length === 0 || typeof command !== "string") {
      return [];
    }
    const toolUseId = typeof update["tool_call_id"] === "string" ? update["tool_call_id"] : undefined;
    const description = typeof update["description"] === "string" ? update["description"] : undefined;
    const outputFile = typeof update["output_file"] === "string" ? update["output_file"] : undefined;
    const turnId = this.deps.activeTurnId();
    if (this.tasks.has(taskId)) {
      const existing = this.tasks.get(taskId)!;
      existing.toolUseId ??= toolUseId;
      return [];
    }
    this.tasks.set(taskId, {
      taskId,
      command,
      description,
      status: "running",
      toolUseId,
      outputFile,
      turnId
    });
    return [
      this.event(
        "task.started",
        {
          taskId,
          taskType: "shell",
          agentKind: "background",
          agentId: taskId,
          title: description ?? command,
          description: description ?? command,
          ...(toolUseId === undefined ? {} : { toolUseId }),
          ...(outputFile === undefined ? {} : { outputFile })
        },
        turnId,
        raw
      )
    ];
  }

  /** The `BackgroundTaskStarted` discriminant on a completing tool call. */
  private backgroundFromToolCall(
    toolCallId: string,
    rawInput: unknown,
    rawOutput: unknown,
    status: ToolCallStatus | undefined
  ): RuntimeEvent[] {
    void rawInput;
    if (rawOutput === null || typeof rawOutput !== "object") {
      return [];
    }
    const record = rawOutput as Record<string, unknown>;
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
      {
        source: ACP_RAW_SOURCE,
        method: "session/update:tool_call_update",
        payload: { toolCallId, rawOutput }
      }
    );
  }

  /**
   * `task_completed` — a background shell finished, with its whole snapshot:
   * exit code, signal, `explicitly_killed`, output. It closes the roster row
   * `task_backgrounded` / `background_tasks` opened (observation 37: every one
   * seen was for a shell a turn waited on, `block_waited`, that woke the
   * agent, `will_wake`, or that the agent killed — none came for the detached
   * `sleep 25` of observation 29). A shell this session never put on the
   * roster, or already closed, is nothing to close.
   */
  private taskCompleted(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const snapshot = update["task_snapshot"];
    const record =
      snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? (snapshot as Record<string, unknown>)
        : undefined;
    const taskId = nonEmptyText(record?.["task_id"]);
    const track = taskId === undefined ? undefined : this.tasks.get(taskId);
    if (record === undefined || taskId === undefined || track === undefined) {
      return [];
    }
    this.tasks.delete(taskId);
    this.finishedTaskIds.add(taskId);
    if (this.finishedTaskIds.size > MAX_FINISHED_TASK_IDS) {
      const oldest = this.finishedTaskIds.values().next().value;
      if (oldest !== undefined) {
        this.finishedTaskIds.delete(oldest);
      }
    }
    const exit = record["exit_code"];
    const exitCode = typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
    const status: RuntimeTaskCompletedStatus =
      record["explicitly_killed"] === true
        ? "stopped"
        : exitCode !== undefined
          ? exitCode === 0
            ? "completed"
            : "failed"
          : nonEmptyText(record["signal"]) !== undefined
            ? "failed"
            : "completed";
    return [
      this.event(
        "task.completed",
        {
          taskId,
          taskType: "shell",
          agentKind: "background",
          agentId: taskId,
          title: track.description ?? track.command,
          status,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(track.toolUseId === undefined ? {} : { toolUseId: track.toolUseId }),
          ...(track.outputFile === undefined ? {} : { outputFile: track.outputFile })
        },
        track.turnId,
        raw
      )
    ];
  }

  // -------------------------------------------------------------- subagents

  /**
   * `subagent_spawned` — one of a goal's planner, worker, skeptics or
   * summarizer, or a subagent the model launched with `spawn_subagent`
   * (observation 37). Each is its own task on the roster, as Claude's and
   * Codex's agents are: `taskType: "subagent"` under the agent's own id, which
   * ingestion stamps an agent. A resumed subagent arrives under a NEW id
   * (`resumed_from` names the old one), so a resume is simply another agent.
   */
  private subagentSpawned(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const taskId = nonEmptyText(update["subagent_id"]);
    if (taskId === undefined) {
      this.deps.debug?.("grok: subagent_spawned without a subagent_id; dropped");
      return [];
    }
    if (this.subagents.has(taskId)) {
      return [];
    }
    const description = nonEmptyText(update["description"]);
    const role = nonEmptyText(update["role"]) ?? nonEmptyText(update["subagent_type"]);
    const model = nonEmptyText(update["model"]);
    const launch = this.claimSpawnCall(taskId, description);
    const linkage: SubagentTrack["linkage"] = {
      taskType: "subagent",
      agentKind: "agent",
      agentId: taskId,
      ...(description === undefined ? {} : { title: description }),
      ...(role === undefined ? {} : { role }),
      ...(model === undefined ? {} : { model }),
      ...(launch === undefined ? {} : { toolUseId: launch.toolCallId })
    };
    const turnId = this.deps.activeTurnId();
    this.subagents.set(taskId, { taskId, linkage, turnId });
    this.subagentsThisTurn = true;
    return [
      this.event(
        "task.started",
        {
          taskId,
          ...(description === undefined ? {} : { description }),
          ...(launch?.background === undefined ? {} : { isBackgrounded: launch.background }),
          ...linkage
        },
        turnId,
        raw
      )
    ];
  }

  /**
   * The model's `spawn_subagent` call behind a subagent. Naming it lets the
   * timeline show the agent row instead of both rows. The spawn frame names
   * no call; the call names its subagent in its result text, and in the real
   * session that result came FIRST for 14 of 27 model-launched subagents —
   * the call closed, and gone from the tool map, before `subagent_spawned`.
   * So: the call whose result named this id ({@link noteSpawnResult}); else
   * the OLDEST still-open call with the same description that no subagent
   * has claimed. `undefined` for the goal engine's own agents, which no tool
   * call launches.
   */
  private claimSpawnCall(taskId: string, description: string | undefined): SpawnCall | undefined {
    const finished = this.spawnResults.get(taskId);
    if (finished !== undefined) {
      this.spawnResults.delete(taskId);
      return finished;
    }
    if (description === undefined) {
      return undefined;
    }
    for (const track of this.tools.values()) {
      const input = track.rawInput;
      if (
        track.vendorName !== "spawn_subagent" ||
        track.launchedTaskId !== undefined ||
        input === null ||
        typeof input !== "object" ||
        (input as Record<string, unknown>)["description"] !== description
      ) {
        continue;
      }
      track.launchedTaskId = taskId;
      const background = (input as Record<string, unknown>)["run_in_background"];
      return { toolCallId: track.toolCallId, ...(typeof background === "boolean" ? { background } : {}) };
    }
    return undefined;
  }

  /**
   * A `spawn_subagent` call finished: its result text names the subagent it
   * started (`Subagent started in background.\nsubagent_id: <id>\n…`, in both
   * `rawOutput.text` and the content). Remembered by that id for
   * `subagent_spawned` to claim, because the call is about to leave the tool
   * map. Nothing is remembered for a call the description pairing already
   * gave to a subagent — even one the result does not name: a mis-assigned
   * call must not end up shared by two subagents. Entries go on claim, the
   * oldest past {@link MAX_SPAWN_RESULTS}.
   */
  private noteSpawnResult(track: ToolTrack): void {
    const output = track.rawOutput;
    const outputText =
      output !== null && typeof output === "object" && typeof (output as { text?: unknown }).text === "string"
        ? (output as { text: string }).text
        : undefined;
    const subagentId =
      SPAWN_RESULT_SUBAGENT_ID.exec(outputText ?? "")?.[1] ??
      SPAWN_RESULT_SUBAGENT_ID.exec(toolContentText(track.content) ?? "")?.[1];
    if (subagentId === undefined || track.launchedTaskId !== undefined) {
      return;
    }
    const input = track.rawInput;
    const background =
      input !== null && typeof input === "object"
        ? (input as Record<string, unknown>)["run_in_background"]
        : undefined;
    this.spawnResults.set(subagentId, {
      toolCallId: track.toolCallId,
      ...(typeof background === "boolean" ? { background } : {})
    });
    if (this.spawnResults.size > MAX_SPAWN_RESULTS) {
      const oldest = this.spawnResults.keys().next().value;
      if (oldest !== undefined) {
        this.spawnResults.delete(oldest);
      }
    }
  }

  /**
   * `subagent_finished` — the agent's end, with its output (or the CLI's
   * reason when it did not finish) and its own counters. Completes the task
   * in the turn that spawned it. A finish with no spawn this session saw — a
   * subagent that outlived a restart — still completes its task: the roster
   * folds a completion without a start, and the result is not lost.
   */
  private subagentFinished(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const taskId = nonEmptyText(update["subagent_id"]);
    if (taskId === undefined) {
      this.deps.debug?.("grok: subagent_finished without a subagent_id; dropped");
      return [];
    }
    const track = this.subagents.get(taskId);
    this.subagents.delete(taskId);
    const status = subagentCompletionStatus(update["status"], this.deps.debug);
    const output = nonEmptyText(update["output"]);
    const error = nonEmptyText(update["error"]);
    const summary = status === "completed" ? (output ?? error) : (error ?? output);
    const totalTokens = nonNegativeCount(update["tokens_used"]);
    const toolUses = nonNegativeCount(update["tool_calls"]);
    const durationMs = nonNegativeCount(update["duration_ms"]);
    const usage: RuntimeTaskUsage | undefined =
      totalTokens === undefined
        ? undefined
        : {
            totalTokens,
            ...(toolUses === undefined ? {} : { toolUses }),
            ...(durationMs === undefined ? {} : { durationMs })
          };
    return [
      this.event(
        "task.completed",
        {
          taskId,
          status,
          ...(summary === undefined ? {} : { summary }),
          ...(usage === undefined ? {} : { usage }),
          ...(track?.linkage ?? { taskType: "subagent", agentKind: "agent", agentId: taskId })
        },
        track?.turnId,
        raw
      )
    ];
  }

  // ---------------------------------------------------------------- retries

  /**
   * `retry_state` — the CLI retrying a failed model request, attempt `n` of
   * `max_retries` (15). Claude's `api_retry` precedent: a transport retry is a
   * heartbeat, never a timeline row and never a warning. So it is
   * `session.state.changed {running}`, which ingestion folds into the state
   * the turn already has — nothing is written — while the host's turn
   * watchdog sees the activity. ONE per retry episode: an episode is one
   * request's attempts and ends when a later frame restarts the count (each
   * observed episode recovered, its next frame model output, within 3
   * minutes). Between turns it is nothing: an idle session must not read as
   * running, and a background agent's failure reports itself when it ends.
   */
  private retryState(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const turnId = this.deps.activeTurnId();
    if (turnId === undefined) {
      return [];
    }
    const attempt = nonNegativeCount(update["attempt"]) ?? 1;
    const fresh = this.retryAttempt === undefined || attempt <= this.retryAttempt;
    this.retryAttempt = attempt;
    if (!fresh) {
      return [];
    }
    const max = nonNegativeCount(update["max_retries"]);
    const reason = nonEmptyText(update["reason"]);
    return [
      this.event(
        "session.state.changed",
        {
          state: "running",
          reason: `retry_state:${attempt}${max === undefined ? "" : `/${max}`}`,
          ...(reason === undefined ? {} : { detail: { reason } })
        },
        turnId,
        raw
      )
    ];
  }

  /**
   * Close every live background task and subagent. Called before
   * `session.exited`, because a running state must never outlive its process
   * (§3.1) — and because Grok may never report a completion of its own accord.
   */
  stopBackgroundTasks(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [taskId, track] of [...this.subagents.entries()]) {
      this.subagents.delete(taskId);
      events.push(this.event("task.completed", { taskId, status: "stopped", ...track.linkage }, track.turnId));
    }
    for (const [taskId, track] of [...this.tasks.entries()]) {
      this.tasks.delete(taskId);
      events.push(
        this.event(
          "task.completed",
          {
            taskId,
            taskType: "shell",
            agentKind: "background",
            agentId: taskId,
            title: track.description ?? track.command,
            status: "stopped"
          },
          track.turnId
        )
      );
    }
    return events;
  }

  /** Every live tool call, failed. Same rule, for the item rows. */
  failOpenTools(reason: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const [toolCallId, track] of [...this.tools.entries()]) {
      this.tools.delete(toolCallId);
      if (!track.started) {
        continue;
      }
      events.push(
        this.eventWithItem(
          "item.completed",
          {
            itemType: track.itemType,
            status: "failed",
            ...(track.title === undefined ? {} : { title: track.title }),
            detail: reason
          },
          toolCallId
        )
      );
    }
    events.push(...this.closeAssistantSegment());
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
    const usage = turnTokenUsage(
      outcome.usage,
      this.tasks.size > 0 || this.subagents.size > 0 || this.subagentsThisTurn
    );
    // Reset here, not in `beginTurn`: a steer re-opens the SAME turn.
    this.subagentsThisTurn = false;
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
}

/** A string with something in it, as sent. */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function nonNegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `subagent_finished.status` → how the task ended. Observed: `completed`, and
 * `cancelled` with `error: "Subagent was cancelled"` (the goal engine cancels
 * the skeptics it no longer needs). A finish in words this adapter does not
 * know is still a finish: `completed`, the roster's own default, with a debug
 * line.
 */
function subagentCompletionStatus(
  status: unknown,
  debug: ((message: string, detail?: unknown) => void) | undefined
): RuntimeTaskCompletedStatus {
  const normalized = normalizeTaskStatus(typeof status === "string" ? status : undefined);
  switch (normalized) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      debug?.("grok: unknown subagent_finished status; reading it as completed", { status });
      return "completed";
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
