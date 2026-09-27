/**
 * Grok adapter — the normaliser's shared state, the envelope every row it
 * emits is built with, and the helpers its functions share: the frame readers
 * `textArgument` and `asRecord`, and `evictOldest` for its bounded memories.
 *
 * `GrokNormalizer` (`normalize.ts`) routes the provider's frames; what a frame
 * does to the work the normaliser tracks is a function over this state — one
 * object for all of them, so a subagent's end can close its calls and its
 * shells, and a tool call's answer can end a subagent. What none of these
 * functions touch stays on the class: the replayed history and the
 * session-level readings — the catalog, the mode and model, the context
 * meter, the turn's usage, the hooks, the request counters and the
 * permission-denied flag.
 */

import type { AgentGoal, RuntimeEvent, RuntimeEventRaw, RuntimeEventRawSource } from "@orquester/api/agent-chat";

import type { BackgroundTrack, ENDED_TASKS_REMEMBERED, EndedTask } from "./background-tasks.ts";
import type { LoopTrack, scheduledTask } from "./loops.ts";
import type { GrokNormalizer } from "./normalize.ts";
import type { PlanPathHost } from "./plan.ts";
import type { ChildSession, subagentFromToolCall, SubagentLaunch, SubagentTrack } from "./subagents.ts";
import type { FINISHED_CALLS_REMEMBERED, FinishedCall, ToolTrack } from "./tool-calls.ts";

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
   * This launch's nonce — the session passes the first 8 hex digits of its
   * launch id. Loop runs are numbered by the normaliser, which every launch
   * builds afresh, so their launch ids carry it: a loop a later launch
   * reports again (a CLI restoring it on `session/load`) opens a run the
   * roster reopens its row for, never a late delivery of the run a deploy
   * ended (`loops.ts`).
   */
  readonly launchNonce: string;
  /**
   * The goal the thread shows (`StartSessionInput.knownGoal`, goals §5.3), so
   * a goal row goes out only for a real change (goals §6).
   */
  readonly knownGoal?: AgentGoal | null;
  /** The clock the goal `progress` throttle reads (goals §6). Default `Date.now`. */
  now?(): number;
  /** Frames this adapter drops on purpose say why here, never in a warning. */
  debug?(message: string, detail?: unknown): void;
}

/**
 * What the normaliser's functions share: the work it tracks — tool calls,
 * background tasks, loops, subagents and their child sessions — and
 * the assistant segmentation and plan-mode state around it. One per
 * normaliser ({@link createNormalizerState}), held by `GrokNormalizer`.
 */
export interface GrokNormalizerState {
  readonly deps: GrokNormalizerDeps;

  /** Assistant-message segmentation state (§4.5). */
  readonly runtimeId: string;
  nextSegmentIndex: number;
  activeAssistantItemId: string | undefined;
  /** The `_meta.promptId` of the chunk that opened the active segment, when it named one. */
  activeAssistantPromptId: string | undefined;
  assistantUpdatesOpen: boolean;

  readonly tools: Map<string, ToolTrack>;
  /**
   * Calls that reached a terminal status → their row type and who ended them,
   * bounded by {@link FINISHED_CALLS_REMEMBERED}.
   */
  readonly finishedCalls: Map<string, FinishedCall>;
  readonly tasks: Map<string, BackgroundTrack>;
  /**
   * Background task ids (lower-cased) whose end was written — a shell's, and
   * every id that named an ended subagent run — and who wrote it, bounded by
   * {@link ENDED_TASKS_REMEMBERED}; see `shellReport` (`background-tasks.ts`).
   * A snapshot entry's status may be terminal, so a finished shell can still
   * be listed, and that listing started it again under its id, put it back in
   * the liveness registry as a watch loop, and ended it a second time when it
   * dropped out.
   */
  readonly endedTasks: Map<string, EndedTask>;
  /** Scheduled prompts, by scheduler task id; see {@link scheduledTask}. */
  readonly loops: Map<string, LoopTrack>;
  /** Roster agents, by task id; see {@link subagentFromToolCall}. */
  readonly subagents: Map<string, SubagentTrack>;
  /** `spawn_subagent` calls, by call id. */
  readonly subagentLaunches: Map<string, SubagentLaunch>;
  /** A subagent id (lower-cased) → the roster task it is, for `resume_from`. */
  readonly subagentIds: Map<string, string>;
  /**
   * Child sessions (lower-cased id) → the agent they are. Learned from
   * `subagent_spawned`, which precedes every frame of the child (fixtures
   * 15–23); bounded like the other subagent memories, a live one never
   * forgotten.
   */
  readonly children: Map<string, ChildSession>;
  /**
   * The turn the latest subagent launch ran in (`TurnTokenUsage.hasSubagents`).
   * A turn id, not a per-turn flag: a steer re-runs
   * {@link GrokNormalizer.beginTurn} inside the same turn.
   */
  lastSubagentTurnId: string | undefined;

  planModeActive: boolean;
  lastProposedPlan: { markdown: string; turnId: string | undefined } | undefined;

  /**
   * The ACP session's id — never a subagent's: see `learnSubagentIds`
   * (`subagents.ts`). The session learns it only from `session/new`'s answer,
   * after the normaliser exists: {@link GrokNormalizer.bindSession}.
   */
  sessionId: string;
}

/** The state a new normaliser starts with. */
export function createNormalizerState(deps: GrokNormalizerDeps, sessionId: string): GrokNormalizerState {
  return {
    deps,
    // Unique per NORMALISER instance, not per session: a `session/load` reuses
    // the session id, and an item id that collided across the restart would
    // merge two different assistant bubbles.
    runtimeId: `${sessionId}:${deps.uuid()}`,
    nextSegmentIndex: 0,
    activeAssistantItemId: undefined,
    activeAssistantPromptId: undefined,
    assistantUpdatesOpen: false,
    tools: new Map<string, ToolTrack>(),
    finishedCalls: new Map<string, FinishedCall>(),
    tasks: new Map<string, BackgroundTrack>(),
    endedTasks: new Map<string, EndedTask>(),
    loops: new Map<string, LoopTrack>(),
    subagents: new Map<string, SubagentTrack>(),
    subagentLaunches: new Map<string, SubagentLaunch>(),
    subagentIds: new Map<string, string>(),
    children: new Map<string, ChildSession>(),
    lastSubagentTurnId: undefined,
    planModeActive: false,
    lastProposedPlan: undefined,
    sessionId: sessionId.toLowerCase()
  };
}

/** Build an event of any arm of the union with the shared envelope. */
export function event(
  state: GrokNormalizerState,
  type: RuntimeEvent["type"],
  payload: unknown,
  turnId?: string,
  raw?: RuntimeEventRaw
): RuntimeEvent {
  const stamp = state.deps.stamp();
  const resolvedTurn = turnId ?? state.deps.activeTurnId();
  return {
    eventId: stamp.eventId,
    threadId: state.deps.threadId,
    createdAt: stamp.createdAt,
    ...(resolvedTurn === undefined ? {} : { turnId: resolvedTurn }),
    ...(raw === undefined ? {} : { raw }),
    type,
    payload
  } as RuntimeEvent;
}

export function eventWithItem(
  state: GrokNormalizerState,
  type: RuntimeEvent["type"],
  payload: unknown,
  itemId: string,
  raw?: RuntimeEventRaw
): RuntimeEvent {
  return { ...event(state, type, payload, undefined, raw), itemId } as RuntimeEvent;
}

/**
 * A subagent's own row: owned on the envelope (`agentId`, where ingestion
 * reads a row's author) and stamped with the EXPLICIT turn it rides —
 * `undefined` is turnless, never "whatever turn is live now".
 */
export function ownedEvent(
  state: GrokNormalizerState,
  type: RuntimeEvent["type"],
  payload: unknown,
  agentId: string,
  turnId: string | undefined,
  itemId?: string,
  raw?: RuntimeEventRaw
): RuntimeEvent {
  const stamp = state.deps.stamp();
  return {
    eventId: stamp.eventId,
    threadId: state.deps.threadId,
    createdAt: stamp.createdAt,
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
    agentId,
    ...(raw === undefined ? {} : { raw }),
    type,
    payload
  } as RuntimeEvent;
}

export function textArgument(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Drop the oldest entries a map may lose until it is back within `limit`. */
export function evictOldest<K, V>(
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
