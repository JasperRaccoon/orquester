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
   * The tool's own name: `_meta["x.ai/tool"].name`, else the FIRST frame's
   * title — every captured call's first frame is titled with the tool's name,
   * and every later one rewrites the title (and the completion drops the
   * vendor block altogether).
   */
  toolName?: string;
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
  /** The turn the run started in, for the rows that close it after that turn. */
  turnId?: string;
  /** A `background_tasks` snapshot listed it (see {@link GrokNormalizer.foldBackgroundTasks}). */
  listed: boolean;
}

/** One `spawn_subagent` call, keyed by its call id. */
interface SubagentLaunch {
  readonly taskId: string;
  /** `background: true` — the call answers with the subagent's id at once. */
  readonly background: boolean;
  /** The call started or reopened the run, so its failure is the run's. */
  readonly opensRun: boolean;
  /** Ids the launch's own input named: never taken for its subagent's. */
  readonly inputIds: ReadonlySet<string>;
  settled: boolean;
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

function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

/**
 * The tool that launches a subagent — the CLI's embedded docs and its own
 * Claude-compat tool table (`Agent` → `spawn_subagent`); no capture holds a
 * call (fixtures README observation 36).
 */
export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

/**
 * How many launches, agents and subagent ids the normaliser remembers for
 * `resume_from`, oldest forgotten first (a live agent never is). A resume of a
 * forgotten id starts a row of its own — the same as after a host restart.
 */
export const SUBAGENTS_REMEMBERED = 512;

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
  "task_backgrounded"
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
   * Calls that reached a terminal status → the row type they had, bounded by
   * {@link FINISHED_CALLS_REMEMBERED}.
   */
  private readonly finishedCalls = new Map<string, ToolTrack["itemType"]>();
  private readonly tasks = new Map<string, BackgroundTrack>();
  /** Roster agents, by task id; see {@link subagentFromToolCall}. */
  private readonly subagents = new Map<string, SubagentTrack>();
  /** `spawn_subagent` calls, by call id. */
  private readonly subagentLaunches = new Map<string, SubagentLaunch>();
  /** A subagent id (lower-cased) → the roster task it is, for `resume_from`. */
  private readonly subagentIds = new Map<string, string>();
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

  /** The ACP session's id — never a subagent's (see {@link learnSubagentIds}). */
  private readonly sessionId: string;

  constructor(deps: GrokNormalizerDeps, sessionId: string) {
    this.deps = deps;
    this.sessionId = sessionId.toLowerCase();
    // Unique per NORMALISER instance, not per session: a `session/load` reuses
    // the session id, and an item id that collided across the restart would
    // merge two different assistant bubbles.
    this.runtimeId = `${sessionId}:${deps.uuid()}`;
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
    this.resetTurnUsage();
  }

  /**
   * The turn settled: close any open assistant bubble so the UI never keeps a
   * dangling in-progress row, and stop accepting late chunks.
   *
   * A FOREGROUND subagent whose launching call is still open was cut with the
   * turn: its call blocks the turn, so the turn cannot end with it running,
   * and a `session/cancel` leaves an in-flight call with no terminal frame at
   * all (fixture 05's `write`) while the CLI cancels a foreground child with
   * its parent's turn. It is closed `stopped` here, or it would read running —
   * and hold the tab "working" — until the process exits. A background one
   * outlives the turn by design.
   */
  endTurn(): RuntimeEvent[] {
    this.assistantUpdatesOpen = false;
    const events = this.closeAssistantSegment();
    for (const track of this.subagents.values()) {
      const owner = this.subagentLaunches.get(track.owner);
      if (!track.live || owner === undefined || owner.background || owner.settled) {
        continue;
      }
      owner.settled = true;
      events.push(this.closeSubagent(track, "stopped"));
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
    // A frame of a call that already FINISHED. A status-less (or still
    // in-progress) one has no lifecycle left to report: emitted, it opened the
    // finished call again as a new `item.started`, re-registered it as live,
    // and the exit sweep (`failOpenTools`) then failed a call that had
    // completed. It is dropped. A terminal one restates the end, as before,
    // under the row type the call had, and nothing else: the side effects of
    // the end (plan mode, a background task, a subagent) ran on the first.
    const finishedItemType =
      previous === undefined ? this.finishedCalls.get(toolCallId) : undefined;
    const restatesEnd = finishedItemType !== undefined;
    if (restatesEnd && !isTerminalToolStatus(update.status)) {
      return [];
    }
    const vendor = xaiToolMeta(update._meta);
    const firstTitle =
      method === "tool_call" && typeof update.title === "string" ? update.title.trim() : "";
    const toolName =
      vendor?.name ?? previous?.toolName ?? (firstTitle.length > 0 ? firstTitle : undefined);
    const spawnsSubagent = toolName === SPAWN_SUBAGENT_TOOL;
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
        finishedItemType ??
        (spawnsSubagent
          ? "collab_agent_tool_call"
          : itemTypeFromToolKind(acpKindFromVendorKind(vendor?.kind) ?? kind ?? undefined)),
      ...(toolName === undefined ? {} : { toolName }),
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
      this.tools.delete(toolCallId);
      this.rememberFinishedCall(toolCallId, next.itemType);
    } else {
      this.tools.set(toolCallId, next);
    }
    if (restatesEnd) {
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

    const raw: RuntimeEventRaw = {
      source: ACP_RAW_SOURCE,
      method: `session/update:${method}`,
      payload: params
    };
    events.push(
      ...(spawnsSubagent
        ? this.subagentFromToolCall(toolCallId, rawInput, update, status, raw)
        : this.backgroundFromToolCall(toolCallId, rawInput, rawOutput, status))
    );
    return events;
  }

  /** Oldest first out, so the memory stays within {@link FINISHED_CALLS_REMEMBERED}. */
  private rememberFinishedCall(toolCallId: string, itemType: ToolTrack["itemType"]): void {
    this.finishedCalls.delete(toolCallId);
    this.finishedCalls.set(toolCallId, itemType);
    evictOldest(this.finishedCalls, FINISHED_CALLS_REMEMBERED);
  }

  // ------------------------------------------------------------- subagents

  /**
   * A `spawn_subagent` call → a roster agent (§7.6), built from the call
   * alone: it is the one thing about a subagent the client observably gets.
   * The CLI's `_x.ai` vocabulary also names `subagent_spawned`,
   * `subagent_progress`, `subagent_finished` and a `x.ai/task_completed`
   * notification, but no capture holds one, so they stay unmapped — a
   * `runtime.warning` — rather than guessed (fixtures README observation 36).
   *
   * - The call's first frame STARTS the agent: `task.started`, agent-kind
   *   (`taskType: "subagent"`), stamped with its own id like every Grok task,
   *   launched by the call (`toolUseId`), so the GUI hides the launch row
   *   behind the agent's the way it hides a Claude `Agent` call.
   * - A foreground call's end is the agent's end, with the call's result (the
   *   text the parent model reads) as the agent's. A failed call fails it.
   * - A `background: true` call answers at once with the subagent's id; the
   *   agent works on, and no observable frame reports its end. It stays live
   *   while the parent session lives — Stop, the session's stop and the
   *   process's exit close it `stopped` ({@link stopBackgroundTasks}) — unless
   *   a background-task frame that joins it reports one
   *   ({@link foldBackgroundTasks}).
   * - `resume_from` re-launches a completed subagent. The relaunch contract
   *   (AGENTS.md, "Agent rows must survive resumes and retention", rule 1):
   *   the SAME task starts again under the NEW call, before any row of the
   *   run, so the roster reopens it; the task is found by the subagent id the
   *   source launch reported ({@link learnSubagentIds}); an id no launch
   *   reported (a host restart since) names a task of its own.
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
    // The documented parameter is `background`; the rewritten input spells a
    // tool's own flag `is_background` (fixture 11).
    const background = input?.["background"] === true || input?.["is_background"] === true;
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
      listed: false
    };
    track.toolUseId = toolCallId;
    track.title = title;
    track.description = description ?? track.description;
    if (role !== undefined) {
      track.role = role;
    }
    if (opensRun) {
      track.owner = toolCallId;
      track.live = true;
      track.turnId = this.deps.activeTurnId();
      track.listed = false;
    }
    this.subagents.delete(taskId);
    this.subagents.set(taskId, track);
    evictOldest(this.subagents, SUBAGENTS_REMEMBERED, (entry) => !entry.live);

    const launch: SubagentLaunch = {
      taskId,
      background,
      opensRun,
      inputIds: new Set(uuidsIn(input)),
      settled: false
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
   * The launch's call reached its end. Only a run's OWN launch ends it: a
   * resume the CLI refused (its source still running) fails the call and
   * never the agent it named; a foreground resume that returned proves the
   * earlier run over, whatever this adapter had seen of it.
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
      return track.live
        ? [this.closeSubagent(track, "failed", toolContentText(update.content), raw)]
        : [];
    }
    this.learnSubagentIds(launch, update);
    if (launch.background || !track.live) {
      return [];
    }
    return [this.closeSubagent(track, "completed", toolContentText(update.content), raw)];
  }

  /**
   * Remember the subagent id(s) a launch reported, for a later `resume_from`.
   * Read shape-free — the UUIDs in what the call returned: the CLI's subagent
   * ids are UUIDv7, and the result is the one place the parent model learns
   * the id it later passes to `resume_from` (a background launch "returns
   * immediately with a subagent ID", the docs say; a foreground result's
   * `rawOutput` is the `SubagentCompleted` output, whose fields include
   * `subagent_id`, per the binary).
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

  private subagentLinkage(track: SubagentTrack): {
    taskId: string;
    taskType: string;
    agentId: string;
    title: string;
    role?: string;
    toolUseId: string;
  } {
    return {
      taskId: track.taskId,
      taskType: "subagent",
      agentId: track.taskId,
      title: track.title,
      ...(track.role === undefined ? {} : { role: track.role }),
      toolUseId: track.toolUseId
    };
  }

  /** `task.completed` for a live agent, and out of the live set. */
  private closeSubagent(
    track: SubagentTrack,
    status: "completed" | "failed" | "stopped",
    summary?: string,
    raw?: RuntimeEventRaw
  ): RuntimeEvent {
    track.live = false;
    // The rows that close a run after its turn name the turn it ran in, as a
    // shell's closers do; a foreground end within its own turn is that turn.
    return this.event(
      "task.completed",
      { ...this.subagentLinkage(track), status, ...(summary === undefined ? {} : { summary }) },
      track.turnId,
      raw
    );
  }

  private get hasLiveSubagents(): boolean {
    for (const track of this.subagents.values()) {
      if (track.live) {
        return true;
      }
    }
    return false;
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
   * The catch (observation 29): no frame reporting a task's end was ever
   * captured — the one capture was stopped 22 s into its `sleep 25` — and the
   * `x.ai/task_completed` the CLI names has no captured shape. So a task seen
   * `running` may never be heard from again, and §3.1's liveness registry
   * needs its own expiry or the thread reads "monitoring" forever. That is a
   * host-side concern; the adapter's duty is to stop claiming the task is live
   * once the session ends, which {@link stopBackgroundTasks} does.
   *
   * An entry whose id a `spawn_subagent` launch reported is that subagent
   * (not captured: whether the CLI lists subagents here at all): its end, or
   * its dropping out once listed, is the agent's end — the one way a
   * background subagent's end could be observed.
   */
  private foldBackgroundTasks(tasks: ReadonlyArray<XaiBackgroundTask>, raw: RuntimeEventRaw): RuntimeEvent[] {
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
    for (const track of this.subagents.values()) {
      if (track.live && track.listed && !listedSubagents.has(track.taskId)) {
        events.push(this.closeSubagent(track, "completed", undefined, raw));
      }
    }
    return events;
  }

  /** A snapshot entry of a subagent's: its terminal status ends the agent. */
  private subagentFromSnapshot(
    taskId: string,
    status: RuntimeTaskStatus,
    raw: RuntimeEventRaw
  ): RuntimeEvent[] {
    const track = this.subagents.get(taskId);
    if (track === undefined || !track.live) {
      return [];
    }
    track.listed = true;
    switch (status) {
      case "completed":
        return [this.closeSubagent(track, "completed", undefined, raw)];
      case "failed":
        return [this.closeSubagent(track, "failed", undefined, raw)];
      case "cancelled":
      case "interrupted":
        return [this.closeSubagent(track, "stopped", undefined, raw)];
      default:
        return [];
    }
  }

  /**
   * `_x.ai/task_backgrounded` is the only frame carrying `tool_call_id` AND
   * `task_id` together, so it is the cleanest join between a tool call and the
   * task it started.
   */
  private taskBackgrounded(update: Record<string, unknown>, raw: RuntimeEventRaw): RuntimeEvent[] {
    const taskId = update["task_id"];
    const command = update["command"];
    if (typeof taskId !== "string" || taskId.length === 0) {
      return [];
    }
    const toolUseId = typeof update["tool_call_id"] === "string" ? update["tool_call_id"] : undefined;
    // A task a `spawn_subagent` call backgrounded is that subagent, already on
    // the roster — never a shell row of its own. Not captured: whether the CLI
    // backgrounds a subagent through this frame at all (observation 36).
    if (this.subagentOfBackgroundTask(taskId, toolUseId) !== undefined) {
      return [];
    }
    if (typeof command !== "string") {
      return [];
    }
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
   * Close every live background task and every live subagent. Called before
   * `session.exited`, on the session's stop and on a session-scoped Stop,
   * because a running state must never outlive its process (§3.1) — and
   * because no frame that reports such an end is mapped.
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
      events.push(this.closeSubagent(track, "stopped"));
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
      this.rememberFinishedCall(toolCallId, track.itemType);
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
      this.tasks.size > 0 || this.lastSubagentTurnId === turnId || this.hasLiveSubagents
    );
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
