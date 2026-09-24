/**
 * Agent chat — the shared thread fold (spec §5.1).
 *
 * The host projects `meta.json` and the §6.3 snapshot with this, and the
 * client applies the same reducer to stream frames, so there is exactly one
 * definition of "what the thread looks like after these events".
 *
 * Ported from T3 Code (MIT): `apps/server/src/orchestration/projector.ts`
 * (the thread arms, `retainThreadActivities`, `retainThreadMessagesAfterRevert`
 * and the `thread.session-set` turn settlement).
 *
 * Rules (§5.1), restated here because both callers depend on them:
 * - a `thread.message-sent` with `streaming: true` **appends** its text to the
 *   existing id; with `streaming: false`, empty text keeps the accumulated
 *   body and non-empty text replaces it;
 * - a turn is settled **by session status**, not by `turn.completed`, so a
 *   late checkpoint or diff never extends the recorded duration;
 * - the fold retains the last {@link ACTIVITY_RETENTION_LIMIT} parent-visible
 *   activities (agent-owned rows have their own window, see
 *   {@link AGENT_ACTIVITY_RETENTION_LIMIT}),
 *   plus every unresolved async question and any long-lived singleton row
 *   regardless of age — in BATCHES: a class grows past its limit by its slack
 *   before one pass cuts every class back to its limit (design
 *   `2026-09-23-fold-performance-design.md`, B);
 * - a revert (§5.5) keeps the first `turnCount` STARTED turns, by turn ORDER
 *   (`turns.ts`) — the checkpoint list decides only for a log that recorded no
 *   started turn at all, the legacy fallback;
 * - the thread's goal is the last `goal.updated` row that parses (goals §4.4),
 *   and neither retention nor a revert touches it;
 * - a malformed line truncates the fold at that point rather than discarding
 *   the file (the reader's job — this fold only ever sees decoded events).
 *
 * **No Node APIs, no I/O, deterministic, structurally sharing.** An event
 * changes only the objects it touches: the UI's row memoisation depends on
 * identity, so every unchanged array, item and sub-model keeps its reference
 * and `applyDomainEvent` returns `state` itself when nothing moved.
 *
 * **What the fold derives to go fast lives beside the state, never on it**
 * (design A1/A2): the id → position index, the retention counters and the
 * roster engine are kept per state in a module-level `WeakMap`, built from the
 * arrays the first time a state without them is folded onto (a snapshot, a
 * deserialized file, a hand-built test state), and never mutated once a state
 * can reach them. So `deepEqual` between states, `serializeFoldState` and the
 * wire shape never see them, and two events folded onto one state give two
 * independent, correct states.
 */

import { isCompactionActivity } from "./compaction.ts";
import type {
  DomainEvent,
  ThreadMessageSentPayload,
  ThreadTurnDiffCompletedPayload
} from "./domain-events.ts";
import { GOAL_ACTIVITY_KIND, parseGoalUpdatedPayload } from "./goal.ts";
import type { ThreadGoal } from "./goal.ts";
import { derivePendingRequests } from "./pending.ts";
import {
  createRosterEngine,
  foldSubagentActivities,
  rosterEngineAppend,
  rosterEngineReplace,
  rosterFromEngine
} from "./roster.ts";
import type { RosterEngine } from "./roster.ts";
import type {
  Checkpoint,
  PendingRequests,
  RuntimeSubagent,
  ThreadActivityItem,
  ThreadHead,
  ThreadItem,
  ThreadMessageItem,
  ThreadSessionStatus,
  ThreadSnapshotPayload,
  Turn
} from "./thread.ts";
import { REQUEST_ACTIVITY_KINDS } from "./pending.ts";
import { applySessionStatusToTurn, isSettledTurnState } from "./turn-state.ts";
import { startedTurns } from "./turns.ts";

/** §5.1: the fold retains this many activities per thread. */
export const ACTIVITY_RETENTION_LIMIT = 500;
/**
 * Rows an agent owns (`agentId` set: a subagent's own tool calls, a shell's
 * output) are retained PER AGENT, outside the parent window — they render
 * only in that agent's drill-in, and counting them against the parent's 500
 * evicted the parent's own rows within minutes on a subagent-heavy thread.
 * The launch and terminal rows of an agent (`task.started` / `task.completed`
 * with `agentKind: "agent"`) are never evicted: they anchor the agent's row in
 * the timeline, and an anchor that ages out re-anchors the row on whatever
 * progress tick survived — at the bottom of the conversation, days later.
 */
export const AGENT_ACTIVITY_RETENTION_LIMIT = 200;
/** Across every agent, so a thousand short-lived shells still bound memory. */
export const AGENT_ACTIVITY_TOTAL_LIMIT = 2_000;
/** §5.1 (T3 `projector.ts:59-60`): message and checkpoint retention. */
export const MESSAGE_RETENTION_LIMIT = 2_000;
export const CHECKPOINT_RETENTION_LIMIT = 500;

/**
 * Batch retention (design `2026-09-23-fold-performance-design.md`). A class is
 * trimmed back to its limit only once it holds more than its limit PLUS its
 * slack in rows retention may drop — so the expensive trim runs once per
 * slack's worth of rows instead of on every append, and the window measures
 * between the limit and limit + slack (exempt rows aside) between trims.
 * The limits above are what a trim cuts back to; these are how far past them
 * a class may grow first.
 */
export const ACTIVITY_RETENTION_SLACK = 50;
export const AGENT_ACTIVITY_RETENTION_SLACK = 50;
export const AGENT_ACTIVITY_TOTAL_SLACK = 200;
export const MESSAGE_RETENTION_SLACK = 200;

/**
 * What retention has ever dropped from a fold. Serialized with the state (it
 * is a function of the log, not of the retained rows), never cleared — a
 * revert does not bring an evicted row back. The host reads it to tell "the
 * window holds more than its limit" apart from "the window has lost rows":
 * only the second has anything older to page in.
 */
export interface FoldEvictions {
  /** At least one activity row was dropped by retention. */
  activities: boolean;
  /** At least one message was dropped by retention. */
  messages: boolean;
}

/**
 * Everything a thread fold accumulates. `head` is `null` until
 * `thread.created` lands, so a truncated or empty log is representable rather
 * than an error.
 *
 * Only the thread's own state: the id → position index that makes a streaming
 * delta cheap used to ride here as `itemIndex`, and copying it per appended row
 * was a fifth of a big thread's fold. It now lives in the fold's side table
 * with the other caches ({@link itemPositionOf} reads it).
 */
export interface ThreadFoldState {
  head: ThreadHead | null;
  /** Timeline order: messages and activities interleaved by arrival. */
  items: ThreadItem[];
  /**
   * The activity subset of {@link items}, same objects, same order. Kept
   * beside `items` because both derivations (§5.1 pending, §7.6 roster) and
   * the retention window are activity-only, and walking a 2 500-row
   * interleaved list per append is the one thing this fold cannot afford.
   */
  activities: ThreadActivityItem[];
  turns: Turn[];
  checkpoints: Checkpoint[];
  /** Derived from the activity fold, never stored separately (§5.1). */
  pending: PendingRequests;
  roster: RuntimeSubagent[];
  /**
   * The provider's goal as the last `goal.updated` row that parsed left it
   * (goals §4.4), `null` when the thread has none. The provider's state, not
   * the conversation's: retention and a revert never touch it, and the
   * provider's next update corrects it. Optional so a state built by an older
   * constructor still folds; `undefined` reads as `null`.
   */
  goal?: ThreadGoal | null;
  /** Request ids closed by a `*.resolved` row (the tombstone set). */
  closedRequestIds: Set<string>;
  /**
   * When each tombstoned request was resolved, so a tombstone can be applied
   * in order: it closes the request that PRECEDES it, while a request stamped
   * later is a different one and opens fresh (a provider may recycle an id —
   * E2E R2-1). Optional so a state built by an older constructor still folds;
   * without a stamp the tombstone closes unconditionally, as it used to.
   */
  closedRequestAt?: Map<string, string>;
  /** Highest `seq` applied. */
  seq: number;
  /** True once `thread.deleted` has been applied. */
  deleted: boolean;
  /** Absent until retention first drops something ({@link FoldEvictions}). */
  evicted?: FoldEvictions;
}

const EMPTY_PENDING: PendingRequests = { approvals: [], userInputs: [] };

/** A fresh, empty fold state. */
export function createEmptyThreadState(): ThreadFoldState {
  return {
    head: null,
    items: [],
    activities: [],
    turns: [],
    checkpoints: [],
    pending: EMPTY_PENDING,
    roster: [],
    goal: null,
    closedRequestIds: new Set(),
    closedRequestAt: new Map(),
    seq: 0,
    deleted: false
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A session is live while a provider process is attached to it. `idle` means
 * "no session yet", so it is NOT live — orphaned background work must not read
 * as working (§7.6).
 */
function isSessionLive(status: ThreadSessionStatus | undefined): boolean {
  return status === "starting" || status === "ready" || status === "running";
}

/** The kinds whose arrival can change the pending set (§5.1 tombstones). */
function touchesPending(activityKind: string): boolean {
  return REQUEST_ACTIVITY_KINDS.has(activityKind);
}

/** The kinds the roster fold reads (§7.6). */
function touchesRoster(activityKind: string): boolean {
  return (
    activityKind === "task.started" ||
    activityKind === "task.progress" ||
    activityKind === "task.updated" ||
    activityKind === "task.completed" ||
    activityKind === "tool.progress"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The retention window (§5.1): the last {@link ACTIVITY_RETENTION_LIMIT}
 * activities, plus every unresolved async question regardless of age, so a
 * chatty turn cannot scroll a still-open question out of the pending set.
 *
 * Every rule at its EXACT limit: batch retention changes when this runs (the
 * trigger, {@link retentionTriggered}), never what it drops (design B).
 *
 * A compaction marker — {@link isCompactionActivity}, the one rule
 * `compaction.ts` shares with the UI, the MCP and the thread index — is exempt
 * from the parent window (§4.6.5, §7.3). It is structure, not chatter: it is
 * where the provider's memory of the conversation begins, which "rewind to
 * here" reads to withhold the messages before it (§5.5) and the timeline
 * reads to draw the divider. There is one per compaction, so keeping them all
 * costs nothing — and a 500-row window on a busy thread evicted the marker
 * within minutes, after which every pre-compaction message was offered for a
 * rewind the adapter could only refuse. Both spellings: an older log wrote
 * the settled marker as `thread.state.changed {state: "compacted"}`, which
 * the window evicted like any row until `FOLD_SNAPSHOT_VERSION` 3. In an
 * agent's own window a marker is an ordinary row.
 *
 * *T3: `projector.ts:63-87` (`retainThreadActivities`).*
 */
function activitiesToDrop(activities: readonly ThreadActivityItem[]): Set<ThreadActivityItem> {
  if (activities.length <= ACTIVITY_RETENTION_LIMIT) {
    return new Set();
  }
  const pendingById = new Map<string, ThreadActivityItem>();
  const parentRows: ThreadActivityItem[] = [];
  const agentRows = new Map<string, ThreadActivityItem[]>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const requestId = payload?.requestId;
    if (typeof requestId === "string") {
      if (activity.activityKind === "user-input.requested" && payload?.responseMode === "message") {
        pendingById.set(requestId, activity);
      } else if (activity.activityKind === "user-input.resolved") {
        pendingById.delete(requestId);
      }
    }
    const owner = ownerOf(activity);
    if (owner === null) {
      parentRows.push(activity);
    } else {
      const rows = agentRows.get(owner);
      if (rows) rows.push(activity);
      else agentRows.set(owner, [activity]);
    }
  }
  const retainedByQuestion = new Set(pendingById.values());
  const drop = new Set<ThreadActivityItem>();

  // The parent window: the last ACTIVITY_RETENTION_LIMIT rows the parent
  // timeline renders, plus every open async question, every agent anchor and
  // every compaction marker.
  const parentStart = parentRows.length - ACTIVITY_RETENTION_LIMIT;
  for (let index = 0; index < parentStart; index += 1) {
    const activity = parentRows[index]!;
    if (
      retainedByQuestion.has(activity) ||
      isAgentAnchorRow(activity) ||
      isCompactionActivity(activity)
    ) {
      continue;
    }
    drop.add(activity);
  }

  // Each agent's window, then the ceiling across all of them (oldest first).
  const survivingAgentRows: ThreadActivityItem[] = [];
  for (const rows of agentRows.values()) {
    const start = rows.length - AGENT_ACTIVITY_RETENTION_LIMIT;
    for (let index = 0; index < rows.length; index += 1) {
      const activity = rows[index]!;
      if (index < start && !isAgentAnchorRow(activity)) {
        drop.add(activity);
      } else {
        survivingAgentRows.push(activity);
      }
    }
  }
  if (survivingAgentRows.length > AGENT_ACTIVITY_TOTAL_LIMIT) {
    // A plain code-point comparison, not `localeCompare` (design B): ISO-8601
    // stamps order lexicographically, ICU collation is the slow way to learn
    // that, and `sort` is stable, so ties keep the order built above.
    survivingAgentRows.sort((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
    );
    const excess = survivingAgentRows.length - AGENT_ACTIVITY_TOTAL_LIMIT;
    let dropped = 0;
    for (const activity of survivingAgentRows) {
      if (dropped === excess) break;
      if (isAgentAnchorRow(activity)) continue;
      drop.add(activity);
      dropped += 1;
    }
  }
  return drop;
}

/**
 * The rows that anchor an agent's presence — its launch and its terminal
 * state — as stamped by the host (`agentKind: "agent"`). Background shells
 * and watch loops are not anchors: their rows are ordinary work-log rows.
 */
function isAgentAnchorRow(activity: ThreadActivityItem): boolean {
  if (activity.activityKind !== "task.started" && activity.activityKind !== "task.completed") {
    return false;
  }
  return asRecord(activity.payload)?.agentKind === "agent";
}

/** The agent that owns a row (its own window), or `null` for a parent row. */
function ownerOf(activity: ThreadActivityItem): string | null {
  return typeof activity.agentId === "string" && activity.agentId.length > 0
    ? activity.agentId
    : null;
}

// ---------------------------------------------------------------------------
// Batch retention (design `2026-09-23-fold-performance-design.md`, B)
// ---------------------------------------------------------------------------

/**
 * The trim: every retention rule at its exact limit, in one pass —
 * {@link activitiesToDrop} over the activities and the oldest messages past
 * {@link MESSAGE_RETENTION_LIMIT} — so the result is exactly what per-event
 * retention would have cut this window to. Messages and activities are capped
 * independently even though they share one interleaved list.
 *
 * `null` when it drops nothing (the trigger counts old open questions the trim
 * keeps), so the arrays stay shared.
 */
function trimWindow(
  items: readonly ThreadItem[],
  activities: ThreadActivityItem[]
): {
  items: ThreadItem[];
  activities: ThreadActivityItem[];
  /** The rows removed, in list order; never empty. */
  dropped: ThreadItem[];
} | null {
  const dropActivities = activitiesToDrop(activities);
  let messagesToDrop = Math.max(0, items.length - activities.length - MESSAGE_RETENTION_LIMIT);
  if (dropActivities.size === 0 && messagesToDrop === 0) {
    return null;
  }
  const nextItems: ThreadItem[] = [];
  const dropped: ThreadItem[] = [];
  for (const item of items) {
    let drop: boolean;
    if (item.kind === "message") {
      // The oldest messages go first, in list order.
      drop = messagesToDrop > 0;
      if (drop) messagesToDrop -= 1;
    } else {
      drop = dropActivities.has(item);
    }
    (drop ? dropped : nextItems).push(item);
  }
  const nextActivities =
    dropActivities.size > 0
      ? activities.filter((activity) => !dropActivities.has(activity))
      : activities;
  return { items: nextItems, activities: nextActivities, dropped };
}

/** Parent rows: the parent window's class ({@link retentionClassOf}). */
const PARENT_CLASS: unique symbol = Symbol("parent");

/**
 * The window a row counts in for the trigger: {@link PARENT_CLASS}, its owning
 * agent's id, or `null` for a row no rule ever drops (an agent anchor anywhere,
 * a compaction marker of either spelling in the parent window) — mirroring the
 * exemptions of {@link activitiesToDrop}.
 *
 * An open message-mode question counts in its class although the trim keeps
 * it: whether it is still open depends on rows anywhere in the list, and a
 * class must be a property of the row alone for the counts to move by one per
 * row. Worst case — more than a slack's worth of open questions in the old
 * part of the window — the trim runs without dropping them: time, never
 * correctness (design B).
 */
type RetentionClass = typeof PARENT_CLASS | string | null;

function retentionClassOf(activity: ThreadActivityItem): RetentionClass {
  if (isAgentAnchorRow(activity)) {
    return null;
  }
  const owner = ownerOf(activity);
  if (owner !== null) {
    return owner;
  }
  return isCompactionActivity(activity) ? null : PARENT_CLASS;
}

/** One agent holding more droppable rows than this trips the trigger. */
const AGENT_TRIGGER = AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK;

/**
 * What the trigger reads: the droppable rows per class, a pure function of
 * `activities` ({@link countsFrom}) that the fold keeps in step instead of
 * recounting the window per event. Messages need no counter: they are
 * `items.length - activities.length`.
 */
interface RetentionCounts {
  readonly parent: number;
  /** Per owning agent; an agent with no droppable row has no entry. */
  readonly agents: ReadonlyMap<string, number>;
  /** The sum of {@link agents}. */
  readonly agentTotal: number;
  /** How many entries of {@link agents} are past {@link AGENT_TRIGGER}. */
  readonly agentsPastTrigger: number;
}

function countsFrom(activities: readonly ThreadActivityItem[]): RetentionCounts {
  let parent = 0;
  let agentTotal = 0;
  const agents = new Map<string, number>();
  for (const activity of activities) {
    const cls = retentionClassOf(activity);
    if (cls === PARENT_CLASS) {
      parent += 1;
    } else if (cls !== null) {
      agents.set(cls, (agents.get(cls) ?? 0) + 1);
      agentTotal += 1;
    }
  }
  return { parent, agents, agentTotal, agentsPastTrigger: agentsPastTriggerIn(agents) };
}

function agentsPastTriggerIn(agents: ReadonlyMap<string, number>): number {
  let past = 0;
  for (const count of agents.values()) {
    if (count > AGENT_TRIGGER) past += 1;
  }
  return past;
}

/**
 * `counts` after one row joined (`delta` 1) or left (`delta` -1) class `cls`.
 * The agents map is small (one entry per agent) and copied on write.
 */
function countsWith(counts: RetentionCounts, cls: RetentionClass, delta: 1 | -1): RetentionCounts {
  if (cls === null) {
    return counts;
  }
  if (cls === PARENT_CLASS) {
    return { ...counts, parent: counts.parent + delta };
  }
  const before = counts.agents.get(cls) ?? 0;
  const after = before + delta;
  const agents = new Map(counts.agents);
  if (after > 0) agents.set(cls, after);
  else agents.delete(cls);
  return {
    parent: counts.parent,
    agents,
    agentTotal: counts.agentTotal + delta,
    agentsPastTrigger:
      counts.agentsPastTrigger + (after > AGENT_TRIGGER ? 1 : 0) - (before > AGENT_TRIGGER ? 1 : 0)
  };
}

/** `counts` after a trim removed `dropped`: O(dropped), at most one copy of the agents map. */
function countsWithout(counts: RetentionCounts, dropped: readonly ThreadItem[]): RetentionCounts {
  let parent = counts.parent;
  let agentTotal = counts.agentTotal;
  let agents: Map<string, number> | null = null;
  for (const item of dropped) {
    if (item.kind !== "activity") {
      continue;
    }
    const cls = retentionClassOf(item);
    if (cls === PARENT_CLASS) {
      parent -= 1;
    } else if (cls !== null) {
      agents ??= new Map(counts.agents);
      const left = (agents.get(cls) ?? 0) - 1;
      if (left > 0) agents.set(cls, left);
      else agents.delete(cls);
      agentTotal -= 1;
    }
  }
  if (agents === null) {
    return parent === counts.parent ? counts : { ...counts, parent };
  }
  return { parent, agents, agentTotal, agentsPastTrigger: agentsPastTriggerIn(agents) };
}

/**
 * The trigger (design B), evaluated after every step that changed the window:
 * more messages than their limit plus slack, or — past today's gate
 * (`activities.length > ACTIVITY_RETENTION_LIMIT`, which is what keeps a
 * history page of ≤ 400 activities lossless) — an activity class holding more
 * droppable rows than its limit plus slack.
 *
 * A function of the state alone, never of history such as "rows since the
 * last trim": a snapshot at any seq, folded forward through the tail, must
 * trim exactly where the whole-log fold does.
 */
function retentionTriggered(
  items: readonly ThreadItem[],
  activities: readonly ThreadActivityItem[],
  counts: RetentionCounts
): boolean {
  if (items.length - activities.length > MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK) {
    return true;
  }
  return (
    activities.length > ACTIVITY_RETENTION_LIMIT &&
    (counts.parent > ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK ||
      counts.agentsPastTrigger > 0 ||
      counts.agentTotal > AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK)
  );
}

// ---------------------------------------------------------------------------
// Per-state caches (design A1/A2)
// ---------------------------------------------------------------------------

/**
 * Each item id → its LAST position in `items`, persistently. `base` maps the
 * ids of the first `baseLength` rows; it is shared by every state since it was
 * built and never mutated. The overlay is the rest of the list: positions move
 * only when rows leave it — a trim or a revert, which rebuild the index — while
 * an append adds a row at the end and an in-place replacement keeps its id and
 * position. So the rows appended since the base was built ARE the overlay,
 * already copied on write with `items`: a lookup walks that tail newest first
 * (so the last position wins) before asking the base, and an append costs the
 * index nothing until the tail passes {@link INDEX_TAIL_LIMIT} and is compacted
 * into a new base. Copying the whole map per appended row was a fifth of a
 * fleet thread's fold; a separate overlay map, copied per append, still left
 * the fleet benchmark half again slower than walking the tail.
 */
interface PositionIndex {
  readonly base: ReadonlyMap<string, number>;
  readonly baseLength: number;
}

/**
 * The longest tail a lookup walks before it is compacted into a new base.
 * Measured on the fleet benchmark between 64 and 1 024: longer tails trade
 * compactions for walks, and a trim rebuilds the index anyway, so it hardly
 * matters above ~256.
 */
const INDEX_TAIL_LIMIT = 256;

function indexFrom(items: readonly ThreadItem[]): PositionIndex {
  const base = new Map<string, number>();
  for (let position = 0; position < items.length; position += 1) {
    base.set(items[position]!.id, position);
  }
  return { base, baseLength: items.length };
}

/** `id`'s last position in `items`, the list `index` was kept for. */
function positionOf(
  index: PositionIndex,
  items: readonly ThreadItem[],
  id: string
): number | undefined {
  for (let position = items.length - 1; position >= index.baseLength; position -= 1) {
    if (items[position]!.id === id) {
      return position;
    }
  }
  return index.base.get(id);
}

/** The index once a row was appended to `items`: itself, until the tail is due for compaction. */
function indexAfterAppend(index: PositionIndex, items: readonly ThreadItem[]): PositionIndex {
  if (items.length - index.baseLength <= INDEX_TAIL_LIMIT) {
    return index;
  }
  const base = new Map(index.base);
  for (let position = index.baseLength; position < items.length; position += 1) {
    base.set(items[position]!.id, position);
  }
  return { base, baseLength: items.length };
}

/**
 * What the fold keeps per state beside it. Immutable, like everything a state
 * can reach: a step that changes the window builds new caches from its
 * predecessor's, and a step that does not shares them.
 */
interface FoldCaches {
  readonly index: PositionIndex;
  readonly counts: RetentionCounts;
  /**
   * The incremental roster (design A4), standing for `activities`. `null`
   * until a step first derives a roster, and again after a change it cannot
   * take incrementally (a trim, a revert, a replacement the engine refuses):
   * the next derive builds it from the list, which is the same roster by the
   * engine's contract.
   */
  readonly roster: RosterEngine | null;
}

const cachesByState = new WeakMap<ThreadFoldState, FoldCaches>();

function buildCaches(
  items: readonly ThreadItem[],
  activities: readonly ThreadActivityItem[]
): FoldCaches {
  return { index: indexFrom(items), counts: countsFrom(activities), roster: null };
}

/** `state`'s caches, built from its arrays the first time a state without any is folded onto. */
function cachesOf(state: ThreadFoldState): FoldCaches {
  let caches = cachesByState.get(state);
  if (caches === undefined) {
    caches = buildCaches(state.items, state.activities);
    cachesByState.set(state, caches);
  }
  return caches;
}

/**
 * How a reducer changed `items`/`activities`, which is all `commit` needs to
 * carry the caches forward without walking the window: a row appended at the
 * end (of both lists, for an activity), a row replaced in place (same id, same
 * positions), or anything else — the caches are then rebuilt from the arrays.
 */
type WindowChange =
  | { readonly kind: "appended"; readonly item: ThreadItem }
  | { readonly kind: "replaced"; readonly previous: ThreadItem; readonly next: ThreadItem }
  | { readonly kind: "rebuilt" };

function cachesAfterChange(
  previous: FoldCaches,
  change: Exclude<WindowChange, { kind: "rebuilt" }>,
  items: readonly ThreadItem[]
): FoldCaches {
  if (change.kind === "appended") {
    const item = change.item;
    const index = indexAfterAppend(previous.index, items);
    if (item.kind === "message") {
      return { index, counts: previous.counts, roster: previous.roster };
    }
    return {
      index,
      counts: countsWith(previous.counts, retentionClassOf(item), 1),
      roster: previous.roster === null ? null : rosterEngineAppend(previous.roster, item)
    };
  }
  const { previous: before, next: after } = change;
  if (before.kind !== "activity" || after.kind !== "activity") {
    // A message merged in place: same id, same position, no class, no roster.
    return previous;
  }
  // Both rows' classes count: a replacement may move a row to another owner,
  // or make it an anchor.
  const beforeClass = retentionClassOf(before);
  const afterClass = retentionClassOf(after);
  return {
    index: previous.index,
    counts:
      beforeClass === afterClass
        ? previous.counts
        : countsWith(countsWith(previous.counts, beforeClass, -1), afterClass, 1),
    roster: previous.roster === null ? null : rosterEngineReplace(previous.roster, before, after)
  };
}

function checkpointKey(turnId: string | null, turnCount: number): string {
  return turnId !== null ? `t:${turnId}` : `n:${turnCount}`;
}

/** A `missing` placeholder never clobbers a captured `ready` checkpoint (§5.4). */
function foldCheckpoint(checkpoints: Checkpoint[], next: Checkpoint): Checkpoint[] {
  const key = checkpointKey(next.turnId, next.checkpointTurnCount);
  const existing = checkpoints.find(
    (entry) => checkpointKey(entry.turnId, entry.checkpointTurnCount) === key
  );
  if (existing && existing.status !== "missing" && next.status === "missing") {
    return checkpoints;
  }
  return [
    ...checkpoints.filter(
      (entry) => checkpointKey(entry.turnId, entry.checkpointTurnCount) !== key
    ),
    next
  ]
    .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
    .slice(-CHECKPOINT_RETENTION_LIMIT);
}

/**
 * The turn-less prompts the turn rows name through `Turn.userMessageId`,
 * split by a revert: a live prompt is persisted before the provider mints its
 * turn id, so the row it opened is its only link to that turn.
 */
interface RevertPromptClaims {
  /** Named by a retained turn: kept by the first pass. */
  retained: ReadonlySet<string>;
  /** Named by a started turn the revert drops: never a fallback candidate. */
  dropped: ReadonlySet<string>;
}

/**
 * The §5.5 message passes, by turn ORDER. The first keeps a message whose
 * `turnId` is retained, and a turn-less one a retained turn names as its
 * `userMessageId`. The second pass: a revert must never leave the thread
 * showing fewer turns than it reverted to, so up to `turnCount` user messages
 * and up to `turnCount` assistant messages are restored in `createdAt` order
 * when the first pass retained fewer.
 *
 * The second pass is for the turn-less messages NO turn claims — a `/compact`
 * prompt its synthesised turn cannot name, a replayed history turn whose
 * prompt came back `""`, a turn row that predates `userMessageId`. A prompt a
 * dropped turn claims is never a candidate: the bound alone cannot keep it
 * out when a retained turn simply has no prompt to restore.
 *
 * *T3: `projector.ts:209-277` (`retainThreadMessagesAfterRevert`).*
 */
function retainMessagesAfterRevert(
  messages: readonly ThreadMessageItem[],
  retainedTurnIds: ReadonlySet<string>,
  prompts: RevertPromptClaims,
  turnCount: number
): Set<string> {
  const retained = new Set<string>();
  for (const message of messages) {
    if (
      message.turnId !== null
        ? retainedTurnIds.has(message.turnId)
        : prompts.retained.has(message.id)
    ) {
      retained.add(message.id);
    }
  }

  const byCreatedAt = (left: ThreadMessageItem, right: ThreadMessageItem): number =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

  // The fallback pass. A message persisted before the provider minted its turn
  // id carries `turnId: null`, and unless a turn names it, it is invisible to
  // the pass above — without this a revert would leave the thread showing
  // fewer turns than it reverted to, and the user's own prompts would vanish.
  // Bounded at `turnCount` per role so it restores the turns that survived,
  // never the ones it undid.
  for (const role of ["user", "assistant"] as const) {
    const have = messages.filter(
      (message) => message.role === role && retained.has(message.id)
    ).length;
    const missing = Math.max(0, turnCount - have);
    if (missing === 0) continue;
    const fallback = messages
      .filter(
        (message) =>
          message.role === role &&
          !retained.has(message.id) &&
          (message.turnId === null
            ? !prompts.dropped.has(message.id)
            : retainedTurnIds.has(message.turnId))
      )
      .slice()
      .sort(byCreatedAt)
      .slice(0, missing);
    for (const message of fallback) {
      retained.add(message.id);
    }
  }

  return retained;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

type Mutation = {
  head?: ThreadHead | null;
  items?: ThreadItem[];
  activities?: ThreadActivityItem[];
  /** How `items`/`activities` changed: set exactly when either of them is. */
  change?: WindowChange;
  /**
   * There is deliberately no `turns` here: every turn change goes through
   * {@link turnsAfterEvent}, the code {@link applyTurnEvent} runs too. A reducer
   * says only what its turn arm needs from the rest of the fold.
   */
  turnContext?: TurnEventContext;
  checkpoints?: Checkpoint[];
  deleted?: boolean;
  /** Re-derive `pending` from the (possibly new) activity list. */
  rederivePending?: boolean;
  /** Re-derive `roster` from the (possibly new) activity list. */
  rederiveRoster?: boolean;
  /** The goal after this event (goals §4.4); `undefined` means unchanged. */
  goal?: ThreadGoal | null;
};

/**
 * Apply one persisted event. Pure with respect to `event`, and returns `state`
 * unchanged (same reference) when the event changes nothing, so the client's
 * memoised row layers can take their fast path (§7.2).
 *
 * Events with `seq <= state.seq` are dropped — that is what makes the
 * overlapping snapshot/replay/live windows of §6.6 safe.
 *
 * An event whose `type` this build does not know folds to a no-op and still
 * advances `seq` (§8): the log outlives a rollback, so a newer host's event
 * type must be inert here, never fatal and never a reason to stop folding.
 */
export function applyDomainEvent(
  state: ThreadFoldState,
  event: DomainEvent
): ThreadFoldState {
  if (event.seq <= state.seq) {
    return state;
  }
  // A thread's log is its own; an event for another thread is not this fold's.
  if (state.head !== null && event.threadId !== state.head.id) {
    return state;
  }

  const mutation = reduce(state, event);
  return commit(state, event, mutation);
}

function commit(
  state: ThreadFoldState,
  event: DomainEvent,
  mutation: Mutation
): ThreadFoldState {
  let items = mutation.items ?? state.items;
  let activities = mutation.activities ?? state.activities;
  // Undefined for a state nothing has folded onto yet: built on first need.
  let caches = cachesByState.get(state);

  // Retention can drop an open approval or a live roster row on an append that
  // has nothing to do with either, so a drop is its own re-derive trigger —
  // gating only on the INCOMING row's kind left `pending`/`roster` pointing at
  // rows the fold no longer holds until some later event happened to touch
  // them (R5 #18).
  let retentionDropped = false;
  let dropped: ThreadItem[] = [];
  let evicted = state.evicted;
  if (mutation.change !== undefined) {
    caches =
      mutation.change.kind === "rebuilt"
        ? buildCaches(items, activities)
        : cachesAfterChange(cachesOf(state), mutation.change, items);
    // Batch retention (design B): nothing is trimmed until a class holds more
    // than its limit plus its slack, and then every class is cut back to its
    // limit at once.
    if (retentionTriggered(items, activities, caches.counts)) {
      const trimmed = trimWindow(items, activities);
      if (trimmed !== null) {
        retentionDropped = trimmed.activities !== activities;
        items = trimmed.items;
        activities = trimmed.activities;
        dropped = trimmed.dropped;
        evicted = withEvictions(evicted, dropped);
        // Positions moved, so the index is rebuilt; the counts lose exactly
        // the dropped rows; and a dropped activity always re-derives the
        // roster below, which rebuilds the engine from the trimmed list.
        caches = {
          index: indexFrom(items),
          counts: countsWithout(caches.counts, dropped),
          roster: retentionDropped ? null : caches.roster
        };
      }
    }
  }

  const nextSessionStatus = (mutation.head ?? state.head)?.session.status;
  const sessionLiveChanged =
    mutation.head !== undefined &&
    isSessionLive(state.head?.session.status) !== isSessionLive(nextSessionStatus);

  // The tombstone set is updated BEFORE pending is derived from it: a
  // `*.resolved` row must close its request in the same step it arrives, and
  // it must keep closing it after retention drops it (§5.1).
  const closed =
    mutation.rederivePending === true
      ? closedIdsFrom(
          mutation.activities ?? state.activities,
          state.closedRequestIds,
          state.closedRequestAt
        )
      : { ids: state.closedRequestIds, at: state.closedRequestAt };
  const closedRequestIds = closed.ids;
  const closedRequestAt = closed.at;

  const pending =
    mutation.rederivePending === true || retentionDropped
      ? derivePendingRequests(activities, { closed: closedRequestIds, closedAt: closedRequestAt })
      : state.pending;
  // Re-derived exactly when it always was — a task row, a session-liveness
  // change, a dropped activity — and otherwise kept by identity. What changed
  // is the cost: the engine carries each task's fold from step to step, so a
  // task row no longer refolds the whole list (design A4).
  let roster = state.roster;
  if (mutation.rederiveRoster === true || sessionLiveChanged || retentionDropped) {
    const current = caches ?? cachesOf(state);
    const engine = current.roster ?? createRosterEngine(activities);
    roster = rosterFromEngine(engine, { sessionLive: isSessionLive(nextSessionStatus) });
    caches = engine === current.roster ? current : { ...current, roster: engine };
  }

  // Only a `goal.updated` row moves the goal (goals §4.4); every other step —
  // a trim and a revert included — carries it by identity, and a state built
  // before goals keeps none until a goal row lands.
  const goal = mutation.goal !== undefined ? mutation.goal : state.goal;

  const head = mutation.head !== undefined ? mutation.head : state.head;
  const nextHead =
    head === null
      ? null
      : { ...head, seq: event.seq, updatedAt: event.occurredAt };

  const next: ThreadFoldState = {
    head: nextHead,
    items,
    activities,
    turns: turnsAfterEvent(state.turns, event, mutation.turnContext ?? NO_TURN_CONTEXT),
    checkpoints: mutation.checkpoints ?? state.checkpoints,
    pending,
    roster,
    ...(goal !== undefined ? { goal } : {}),
    closedRequestIds,
    ...(closedRequestAt !== undefined ? { closedRequestAt } : {}),
    seq: event.seq,
    deleted: mutation.deleted ?? state.deleted,
    ...(evicted !== undefined ? { evicted } : {})
  };
  if (caches !== undefined) {
    cachesByState.set(next, caches);
  }
  if (dropped.length > 0) {
    droppedByStep.set(next, dropped);
  }
  return next;
}

/** The evictions after a trim that removed `dropped` (unchanged when it removed none). */
function withEvictions(
  previous: FoldEvictions | undefined,
  dropped: readonly ThreadItem[]
): FoldEvictions | undefined {
  if (dropped.length === 0) return previous;
  const activities = previous?.activities === true || dropped.some((item) => item.kind === "activity");
  const messages = previous?.messages === true || dropped.some((item) => item.kind === "message");
  if (previous !== undefined && previous.activities === activities && previous.messages === messages) {
    return previous;
  }
  return { activities, messages };
}

/**
 * The rows retention removed in the step that produced a state, by state. A
 * side table rather than a field: it describes one transition, not the
 * thread, so it must neither be serialized nor compared, and a state built any
 * other way (a snapshot, a deserialized file) simply has none.
 */
const droppedByStep = new WeakMap<ThreadFoldState, readonly ThreadItem[]>();

const NO_DROPPED: readonly ThreadItem[] = [];

/**
 * The rows retention dropped in the {@link applyDomainEvent} call that
 * returned `state`, in list order — empty when it dropped none, and for any
 * state that was not produced by a trimming step. The client keeps these when
 * it has older history pages loaded, so the rows between the pages and the
 * window never vanish from the screen (design 2026-09-23 fold performance).
 */
export function itemsDroppedByRetention(state: ThreadFoldState): readonly ThreadItem[] {
  return droppedByStep.get(state) ?? NO_DROPPED;
}

/**
 * The position of item `id` in `state.items` — its LAST one, should a message
 * and an activity share an id — or undefined (tests, diagnostics).
 */
export function itemPositionOf(state: ThreadFoldState, id: string): number | undefined {
  const position = positionOf(cachesOf(state).index, state.items, id);
  return position !== undefined && state.items[position]?.id === id ? position : undefined;
}

/**
 * **Test-only.** Design A2's invariant, checked: how the caches the fold keeps
 * for `state` differ from caches rebuilt from its arrays — a description of
 * the first mismatches, or `null` when they agree or when none are kept yet (a
 * state nothing has folded onto builds them on first use). The roster engine
 * is compared through its output under both liveness readings, which refolds
 * the whole activity list: `{ roster: false }` skips it.
 */
export function __foldCacheConsistency(
  state: ThreadFoldState,
  options: { readonly roster?: boolean } = {}
): string | null {
  const caches = cachesByState.get(state);
  if (caches === undefined) {
    return null;
  }
  const problems: string[] = [];

  // The index: the base must map every id of its rows to that id's LAST
  // position among them, and nothing else; the tail past it is walked, so it
  // only has to be short. Checked without building a map: every row's id must
  // point at a row at or after it with the same id (so at its last one), and
  // exactly one row per distinct id — its last — points at itself.
  const { base, baseLength } = caches.index;
  if (baseLength > state.items.length || state.items.length - baseLength > INDEX_TAIL_LIMIT) {
    problems.push(`index base covers ${baseLength} of ${state.items.length} rows`);
  } else {
    let lastPositions = 0;
    for (let position = 0; position < baseLength; position += 1) {
      const id = state.items[position]!.id;
      const at = base.get(id);
      if (at === undefined || at < position || at >= baseLength || state.items[at]!.id !== id) {
        problems.push(`index puts ${id} (row ${position}) at ${String(at)}`);
        break;
      }
      if (at === position) lastPositions += 1;
    }
    if (problems.length === 0 && base.size !== lastPositions) {
      problems.push(`index base holds ${base.size} ids, its rows ${lastPositions}`);
    }
  }

  const counts = countsFrom(state.activities);
  for (const field of ["parent", "agentTotal", "agentsPastTrigger"] as const) {
    if (caches.counts[field] !== counts[field]) {
      problems.push(`counts.${field} is ${caches.counts[field]}, the window says ${counts[field]}`);
    }
  }
  const agents = new Set([...caches.counts.agents.keys(), ...counts.agents.keys()]);
  for (const agent of agents) {
    if (caches.counts.agents.get(agent) !== counts.agents.get(agent)) {
      problems.push(
        `counts for agent ${agent}: ${String(caches.counts.agents.get(agent))}, the window says ${String(counts.agents.get(agent))}`
      );
      break;
    }
  }

  if (options.roster !== false && caches.roster !== null) {
    for (const sessionLive of [true, false]) {
      if (
        !sameJsonValue(
          rosterFromEngine(caches.roster, { sessionLive }),
          foldSubagentActivities(state.activities, { sessionLive })
        )
      ) {
        problems.push(`the roster engine disagrees with the activity list (sessionLive ${sessionLive})`);
      }
    }
  }
  return problems.length === 0 ? null : problems.join("; ");
}

/** Structural equality of JSON-shaped values, key order aside (the roster rows). */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameJsonValue(leftRecord[key], rightRecord[key])
    )
  );
}

/**
 * The tombstone set (§5.1), with the stamp that makes it order-aware.
 *
 * Ids accumulate and never shrink, including across a revert, so a request
 * whose closing row has aged out of the retention window stays closed (R5 #4).
 * The stamp is what keeps that from swallowing a *newer* request that happens
 * to reuse the id (E2E R2-1): the tombstone closes rows at or before the
 * resolution it records, and a row stamped later opens as its own request.
 */
function closedIdsFrom(
  activities: readonly ThreadActivityItem[],
  previous: ReadonlySet<string>,
  previousAt: ReadonlyMap<string, string> | undefined
): { ids: Set<string>; at: Map<string, string> } {
  const ids = new Set(previous);
  const at = new Map(previousAt ?? []);
  for (const activity of activities) {
    if (
      activity.activityKind !== "approval.resolved" &&
      activity.activityKind !== "user-input.resolved"
    ) {
      continue;
    }
    const requestId = asRecord(activity.payload)?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      continue;
    }
    ids.add(requestId);
    // The LATEST resolution wins: a recycled id resolved twice must not have
    // its second request suppressed by the first resolution's stamp.
    const known = at.get(requestId);
    if (known === undefined || activity.createdAt > known) {
      at.set(requestId, activity.createdAt);
    }
  }
  return { ids, at };
}

function reduce(state: ThreadFoldState, event: DomainEvent): Mutation {
  switch (event.type) {
    case "thread.created": {
      const payload = event.payload;
      const head: ThreadHead = {
        id: event.threadId,
        projectPath: payload.projectPath,
        cwd: payload.cwd,
        title: payload.title,
        adapter: payload.adapter,
        refId: payload.refId,
        accountId: payload.accountId,
        home: payload.home,
        modelSelection: payload.modelSelection,
        runtimeMode: payload.runtimeMode,
        session: { status: "idle", activeTurnId: null },
        turnCount: 0,
        seq: event.seq,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt
      };
      return { head };
    }

    case "thread.meta-updated": {
      if (state.head === null) return {};
      const { title, modelSelection, accountId, home } = event.payload;
      if (
        title === undefined &&
        modelSelection === undefined &&
        accountId === undefined &&
        home === undefined
      ) {
        return {};
      }
      return {
        head: {
          ...state.head,
          ...(title !== undefined ? { title } : {}),
          ...(modelSelection !== undefined ? { modelSelection } : {}),
          // §3.4's account switch. Field-wise: a rename must not clear the
          // identity, and an identity change must not clear the title.
          ...(accountId !== undefined ? { accountId } : {}),
          ...(home !== undefined ? { home } : {})
        }
      };
    }

    case "thread.runtime-mode-set": {
      if (state.head === null || state.head.runtimeMode === event.payload.runtimeMode) {
        return state.head === null ? {} : { head: state.head };
      }
      return { head: { ...state.head, runtimeMode: event.payload.runtimeMode } };
    }

    case "thread.message-sent":
      return reduceMessageSent(state, event);

    case "thread.turn-start-requested":
      // The row itself is the turn arm's (`requestedTurn`); a turn start that
      // names no model inherits the head's.
      return { turnContext: { head: state.head } };

    case "thread.session-set":
      return reduceSessionSet(state, event);

    case "thread.activity-appended":
      return reduceActivityAppended(state, event);

    case "thread.turn-diff-completed":
      return reduceTurnDiffCompleted(state, event);

    case "thread.reverted":
      return reduceReverted(state, event);

    case "thread.deleted":
      return { deleted: true };

    // Commands that record intent and project nothing of their own: the
    // provider's answer arrives as an activity (§5.1), and an interrupt
    // settles its turn through `thread.session-set`.
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
      return {};

    default:
      // Unreachable for the closed union — `event` is `never` here, which is
      // the compiler proving every arm above is handled. It IS reachable at
      // runtime: §8 puts the thread log outside every rollback, so a log may
      // hold an event type a NEWER host wrote. Such an event folds to a no-op
      // and still advances the sequence, rather than truncating the thread.
      void (event as never);
      return {};
  }
}

function reduceMessageSent(
  state: ThreadFoldState,
  event: Extract<DomainEvent, { type: "thread.message-sent" }>
): Mutation {
  const payload = event.payload;
  const existingIndex = positionOf(cachesOf(state).index, state.items, payload.messageId);
  const existing = existingIndex === undefined ? undefined : state.items[existingIndex];

  if (existing !== undefined && existing.kind === "message") {
    const next: ThreadMessageItem = {
      ...existing,
      text: payload.streaming
        ? `${existing.text}${payload.text}`
        : payload.text.length > 0
          ? payload.text
          : existing.text,
      streaming: payload.streaming,
      turnId: payload.turnId,
      updatedAt: event.occurredAt,
      ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
      ...(payload.context !== undefined ? { context: payload.context } : {}),
      // Carried forward, never downgraded: a later delta that omits them (an
      // older adapter, or a flush that could not resolve the phase) must not
      // strip a badge the first event established.
      ...(payload.reasoningKind !== undefined ? { reasoningKind: payload.reasoningKind } : {}),
      ...(payload.messageKind !== undefined ? { messageKind: payload.messageKind } : {})
    };
    const items = state.items.slice();
    items[existingIndex!] = next;
    return {
      items,
      change: { kind: "replaced", previous: existing, next },
      // The MERGED row stamps the turn: its first role and owner, not the delta's.
      turnContext: { message: next }
    };
  }

  const message: ThreadMessageItem = {
    kind: "message",
    id: payload.messageId,
    role: payload.role,
    text: payload.text,
    turnId: payload.turnId,
    streaming: payload.streaming,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
    ...(payload.context !== undefined ? { context: payload.context } : {}),
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    ...(payload.reasoningKind !== undefined ? { reasoningKind: payload.reasoningKind } : {}),
    ...(payload.messageKind !== undefined ? { messageKind: payload.messageKind } : {})
  };
  return {
    // `concat` with an array argument takes V8's fast path, one exact-size
    // copy: measured at under half the cost of `[...items, row]` on a
    // fleet-sized window, and every appended row pays it.
    items: state.items.concat([message]),
    change: { kind: "appended", item: message },
    turnContext: { message }
  };
}

/**
 * The turn's `assistantMessageId` is what "rewind to here" (§5.5) and the
 * §5.4 diff card anchor on. First assistant message of the turn wins; a
 * checkpoint may overwrite it with the provider's own answer.
 */
function stampAssistantMessage(turns: Turn[], message: MessageStamp): Turn[] {
  if (message.role !== "assistant" || message.agentId !== undefined) {
    return turns;
  }
  const index = turns.findIndex(
    (turn) =>
      turn.assistantMessageId === null &&
      (message.turnId === null ? !isSettledTurnState(turn.state) : turn.turnId === message.turnId)
  );
  if (index === -1) {
    return turns;
  }
  const next = turns.slice();
  next[index] = { ...turns[index]!, assistantMessageId: message.id };
  return next;
}

function reduceSessionSet(
  state: ThreadFoldState,
  event: Extract<DomainEvent, { type: "thread.session-set" }>
): Mutation {
  // The resume cursor and the provider thread id OUTLIVE any one session
  // block: a `session-set` that names neither (a turn settling to `ready`, a
  // stop) must not erase what the start recorded. It did: the block was
  // replaced whole, the head lost its cursor, and the next host to start the
  // session — after a deploy's drain-restart — opened a FRESH provider
  // session with no memory of the conversation (2026-09-22, thread
  // c8979f6a). Only an explicit new value replaces the old one.
  const previous = state.head?.session;
  const incoming = event.payload.session;
  const session = {
    ...incoming,
    ...(incoming.resumeCursor === undefined && previous?.resumeCursor !== undefined
      ? { resumeCursor: previous.resumeCursor }
      : {}),
    ...(incoming.providerThreadId === undefined && previous?.providerThreadId !== undefined
      ? { providerThreadId: previous.providerThreadId }
      : {})
  };
  const head = state.head === null ? null : { ...state.head, session };
  // The turns move in the turn arm (`sessionSetTurns`), which reads only the
  // event: the status and the active turn id are the incoming block's, which
  // the carry-forward above never touches.
  return head !== null ? { head } : {};
}

/** The turn arm of `thread.session-set`: stamp the settled turn's numbers, then adopt or settle. */
function sessionSetTurns(
  turns: Turn[],
  event: Extract<DomainEvent, { type: "thread.session-set" }>
): Turn[] {
  const session = event.payload.session;
  // The provider's final numbers for the turn this event settles (E10). They
  // are stamped BEFORE settlement so `applySessionStatusToTurn`'s
  // already-settled short-circuit cannot drop them, and only onto the named
  // turn while it is still unsettled — a replayed terminal event never
  // rewrites a closed turn's cost.
  const turnResult = event.payload.turn;

  if (turnResult !== undefined) {
    const index = turns.findIndex((turn) => turn.turnId === turnResult.turnId);
    const turn = index === -1 ? undefined : turns[index];
    if (
      turn !== undefined &&
      !isSettledTurnState(turn.state) &&
      (turnResult.tokenUsage !== undefined || turnResult.totalCostUsd !== undefined)
    ) {
      const next = turns.slice();
      next[index] = {
        ...turn,
        ...(turnResult.tokenUsage !== undefined ? { tokenUsage: turnResult.tokenUsage } : {}),
        ...(turnResult.totalCostUsd !== undefined
          ? { totalCostUsd: turnResult.totalCostUsd }
          : {})
      };
      turns = next;
    }
  }

  if (session.status === "running" && session.activeTurnId !== null) {
    return adoptActiveTurn(turns, session.activeTurnId, event.occurredAt);
  }
  // Leaving `running` is the turn-end signal: settle every unsettled turn so
  // a duration reflects the whole turn (§5.1). Only the trailing run of
  // unsettled turns can exist, but walking them all is what keeps a lost
  // `turn.started` from stranding a pending row forever.
  let changed = false;
  const next = turns.map((turn) => {
    const settled = applySessionStatusToTurn(turn, session.status, event.occurredAt);
    if (settled !== turn) changed = true;
    return settled;
  });
  return changed ? next : turns;
}

/**
 * Bind the provider's own turn id to the row the `/turn` command opened. The
 * turn id is the provider's, never host-minted (§5.1), so a pending row adopts
 * the first id the session reports while it is still unsettled.
 */
function adoptActiveTurn(turns: Turn[], activeTurnId: string, at: string): Turn[] {
  const byId = turns.findIndex((turn) => turn.turnId === activeTurnId);
  if (byId !== -1) {
    const turn = turns[byId]!;
    if (turn.state === "running" && turn.startedAt !== null) {
      return turns;
    }
    const next = turns.slice();
    next[byId] = {
      ...turn,
      state: isSettledTurnState(turn.state) ? turn.state : "running",
      startedAt: turn.startedAt ?? at
    };
    return next;
  }

  const pending = turns.findIndex((turn) => turn.turnId === null && turn.state === "pending");
  if (pending !== -1) {
    const next = turns.slice();
    next[pending] = {
      ...turns[pending]!,
      turnId: activeTurnId,
      state: "running",
      startedAt: turns[pending]!.startedAt ?? at
    };
    return next;
  }

  // A turn the host never saw a command for (a continuation after restart, or
  // a provider-initiated turn): record it rather than lose it.
  return [
    ...turns,
    {
      turnId: activeTurnId,
      state: "running",
      turnCount: null,
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      assistantMessageId: null
    }
  ];
}

function reduceActivityAppended(
  state: ThreadFoldState,
  event: Extract<DomainEvent, { type: "thread.activity-appended" }>
): Mutation {
  const activity = event.payload.activity;
  const existingIndex = positionOf(cachesOf(state).index, state.items, activity.id);
  const existing = existingIndex === undefined ? undefined : state.items[existingIndex];

  const mutationFlags = {
    rederivePending: touchesPending(activity.activityKind),
    rederiveRoster: touchesRoster(activity.activityKind),
    ...goalAfterActivity(activity)
  };

  if (existing !== undefined && existing.kind === "activity") {
    const items = state.items.slice();
    items[existingIndex!] = activity;
    const activities = state.activities.slice();
    const activityAt = activityPositionOf(state.activities, existing, existingIndex!);
    if (activityAt !== -1) {
      activities[activityAt] = activity;
      return {
        items,
        activities,
        change: { kind: "replaced", previous: existing, next: activity },
        ...mutationFlags
      };
    }
    // The two lists disagree (only a hand-built state can): the row is
    // appended to the activities, as it always was, and nothing incremental
    // can describe that, so the caches are rebuilt.
    activities.push(activity);
    return { items, activities, change: { kind: "rebuilt" }, ...mutationFlags };
  }

  return {
    // `concat`, not a spread: see `reduceMessageSent`.
    items: state.items.concat([activity]),
    activities: state.activities.concat([activity]),
    change: { kind: "appended", item: activity },
    ...mutationFlags
  };
}

const NO_GOAL_CHANGE: Pick<Mutation, "goal"> = {};

/**
 * Goals §4.4: a `goal.updated` row whose payload parses sets the thread's
 * goal — `null` included — stamped with the row's own `updatedAt`. Any other
 * row, and one that does not parse, leaves it alone; either way the row itself
 * is appended as usual. The row alone decides: O(1), never a walk of the
 * window.
 */
function goalAfterActivity(activity: ThreadActivityItem): Pick<Mutation, "goal"> {
  if (activity.activityKind !== GOAL_ACTIVITY_KIND) {
    return NO_GOAL_CHANGE;
  }
  const payload = parseGoalUpdatedPayload(activity.payload);
  if (payload === null) {
    return NO_GOAL_CHANGE;
  }
  return {
    goal: payload.goal === null ? null : { ...payload.goal, updatedAt: activity.updatedAt }
  };
}

/**
 * Where `row`, at `itemPosition` in `items`, sits in `activities`. The
 * activities are the activity subset of the items in the same order, so the
 * row is at or before its item position: walking back from there visits at
 * most the messages before it or the activities after it, whichever is fewer,
 * instead of every activity from the start. A miss falls back to the whole
 * list, so a hand-built state finds the row wherever it is, as before.
 */
function activityPositionOf(
  activities: readonly ThreadActivityItem[],
  row: ThreadActivityItem,
  itemPosition: number
): number {
  const at = activities.lastIndexOf(row, Math.min(itemPosition, activities.length - 1));
  return at !== -1 ? at : activities.indexOf(row);
}

function reduceTurnDiffCompleted(
  state: ThreadFoldState,
  event: Extract<DomainEvent, { type: "thread.turn-diff-completed" }>
): Mutation {
  const payload = event.payload;
  const checkpoint: Checkpoint = {
    turnId: payload.turnId,
    checkpointTurnCount: payload.turnCount,
    checkpointRef: payload.ref,
    status: payload.status,
    files: payload.files,
    assistantMessageId: payload.assistantMessageId,
    completedAt: payload.completedAt
  };
  const checkpoints = foldCheckpoint(state.checkpoints, checkpoint);
  if (checkpoints === state.checkpoints) {
    // Refused (§5.4): nothing moves, the turns included.
    return { turnContext: { checkpointRefused: true } };
  }

  const head =
    state.head === null || state.head.turnCount >= payload.turnCount
      ? undefined
      : { ...state.head, turnCount: payload.turnCount };

  return { checkpoints, ...(head !== undefined ? { head } : {}) };
}

/**
 * The turn arm of `thread.turn-diff-completed`. The turn keeps its own
 * settlement (session status decides that, §5.1); the checkpoint only stamps
 * the turn count and the anchor message.
 */
function checkpointTurns(turns: Turn[], payload: ThreadTurnDiffCompletedPayload): Turn[] {
  if (payload.turnId === null) {
    return turns;
  }
  const index = turns.findIndex((turn) => turn.turnId === payload.turnId);
  if (index === -1) {
    return turns;
  }
  const turn = turns[index]!;
  const next: Turn = {
    ...turn,
    turnCount: payload.turnCount,
    assistantMessageId: payload.assistantMessageId ?? turn.assistantMessageId
  };
  if (next.turnCount === turn.turnCount && next.assistantMessageId === turn.assistantMessageId) {
    return turns;
  }
  const stamped = turns.slice();
  stamped[index] = next;
  return stamped;
}

/**
 * §5.5 truncation, by turn ORDER. `turnCount` is the number of STARTED turns
 * kept (`startedTurns`, `turns.ts`): their ids are the retained set, and every
 * message, activity, turn row and checkpoint follows its `turnId` — never a
 * timestamp. A turn-less prompt follows the turn that names it as its
 * `userMessageId`. Activities with `turnId: null` survive, as does a
 * turn-less checkpoint within the target count, and the fallback pass
 * restores up to `target` user and assistant messages no turn claims, so a
 * revert never leaves the thread showing fewer turns than it reverted to.
 *
 * The checkpoint list is not the numbering, which is where this departs from
 * T3: it is sparse exactly where a rewind matters (a non-git project captures
 * nothing, a failed capture skips a turn, a resumed history has no checkpoint
 * for any turn it replayed), and an older host numbered it densely — the
 * checkpoint counted 1 may belong to the 27th turn — so "the checkpoints at or
 * below the target" retained the wrong turns. That rule survives only as the
 * legacy fallback, for a log with no started turn at all (written before turns
 * were recorded).
 *
 * *T3: `projector.ts:985-1030`.*
 */
function reduceReverted(
  state: ThreadFoldState,
  event: Extract<DomainEvent, { type: "thread.reverted" }>
): Mutation {
  const target = event.payload.turnCount;
  // Which turns survive, and with them which checkpoints. The turn rows are
  // the turn arm's (`turnsAfterEvent`), computed from the same plan.
  const { retainedTurnIds, checkpoints } = planRevert(state.turns, state.checkpoints, target);

  // Only a STARTED turn's claim is judged: a row that never got an id (a send
  // that failed before the provider answered) is neither retained nor dropped
  // by turn order, so its prompt stays an ordinary fallback candidate.
  const retainedPrompts = new Set<string>();
  const droppedPrompts = new Set<string>();
  for (const turn of state.turns) {
    if (turn.turnId === null || turn.userMessageId === undefined) {
      continue;
    }
    (retainedTurnIds.has(turn.turnId) ? retainedPrompts : droppedPrompts).add(
      turn.userMessageId
    );
  }

  const messages = state.items.filter(
    (item): item is ThreadMessageItem => item.kind === "message"
  );
  const retainedMessageIds = retainMessagesAfterRevert(
    messages,
    retainedTurnIds,
    { retained: retainedPrompts, dropped: droppedPrompts },
    target
  );

  const items = state.items.filter((item) =>
    item.kind === "message"
      ? retainedMessageIds.has(item.id)
      : item.turnId === null || retainedTurnIds.has(item.turnId)
  );
  const activities = items.filter(
    (item): item is ThreadActivityItem => item.kind === "activity"
  );

  const head =
    state.head === null ? undefined : { ...state.head, turnCount: target };

  return {
    items,
    activities,
    // Rows left from anywhere in the list: every position may have moved.
    change: { kind: "rebuilt" },
    // The legacy fallback and the latest-turn synthesis read the checkpoints.
    turnContext: { checkpoints: state.checkpoints },
    checkpoints,
    rederivePending: true,
    rederiveRoster: true,
    ...(head !== undefined ? { head } : {})
  };
}

/** What a rewind to `target` started turns keeps (§5.5). */
interface RevertPlan {
  retainedTurnIds: ReadonlySet<string>;
  checkpoints: Checkpoint[];
  /** The retained rows, in start order and whole — `userMessageId` included. */
  turns: Turn[];
}

/**
 * The turn-order half of {@link reduceReverted}, shared with the turn arm so
 * the fold and {@link applyTurnEvent} keep the same turns. Pure: `turns` and
 * `checkpoints` are the state before the rewind.
 */
function planRevert(
  turns: readonly Turn[],
  checkpoints: readonly Checkpoint[],
  target: number
): RevertPlan {
  const started = startedTurns(turns);

  const retainedTurnIds = new Set<string>();
  if (started.length === 0 && checkpoints.length > 0) {
    // Legacy: no turn row to order, so the checkpoints at or below the target
    // name the retained turns, as they did for every log before turn order.
    for (const checkpoint of checkpoints) {
      if (checkpoint.turnId !== null && checkpoint.checkpointTurnCount <= target) {
        retainedTurnIds.add(checkpoint.turnId);
      }
    }
  } else {
    // Clamped: a negative target keeps nothing, rather than `slice`'s
    // count-from-the-end reading of it.
    for (const turn of started.slice(0, Math.max(0, target))) {
      retainedTurnIds.add(turn.turnId);
    }
  }

  // A checkpoint goes with its turn — never with its count, which an older
  // host assigned densely. Only a turn-less one is judged by its count.
  const keptCheckpoints = checkpoints
    .filter((entry) =>
      entry.turnId !== null
        ? retainedTurnIds.has(entry.turnId)
        : entry.checkpointTurnCount <= target
    )
    .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
    .slice(-CHECKPOINT_RETENTION_LIMIT);

  let keptTurns = turns.filter(
    (turn) => turn.turnId !== null && retainedTurnIds.has(turn.turnId)
  );
  // `latestTurn` is recomputed from the last surviving checkpoint (§5.5): if
  // that checkpoint has no turn row left, synthesise one so every ambient
  // surface still reads a settled turn rather than nothing. Only the legacy
  // fallback gets here — a retained turn always keeps its own row — and a row
  // that exists is never moved: with a sparse checkpoint list the last
  // checkpoint is rarely the last turn, and moving its row to the end would
  // reorder the started turns under every later rewind.
  const latestCheckpoint =
    keptCheckpoints.length > 0 ? keptCheckpoints[keptCheckpoints.length - 1]! : null;
  if (
    latestCheckpoint !== null &&
    latestCheckpoint.turnId !== null &&
    !keptTurns.some((turn) => turn.turnId === latestCheckpoint.turnId)
  ) {
    keptTurns = [
      ...keptTurns,
      {
        turnId: latestCheckpoint.turnId,
        state: latestCheckpoint.status === "error" ? "failed" : "completed",
        turnCount: latestCheckpoint.checkpointTurnCount,
        requestedAt: latestCheckpoint.completedAt,
        startedAt: latestCheckpoint.completedAt,
        completedAt: latestCheckpoint.completedAt,
        assistantMessageId: latestCheckpoint.assistantMessageId
      }
    ];
  }

  return { retainedTurnIds, checkpoints: keptCheckpoints, turns: keptTurns };
}

// ---------------------------------------------------------------------------
// The turn arms
// ---------------------------------------------------------------------------

/** What `stampAssistantMessage` reads of a message row. */
type MessageStamp = Pick<ThreadMessageItem, "id" | "role" | "turnId" | "agentId">;

/**
 * What a turn arm reads from OUTSIDE `turns`: the rest of the fold as it
 * stands when the event lands. Each reducer fills in what its arm needs;
 * {@link applyTurnEvent} has none of it, and its doc says what that changes.
 */
interface TurnEventContext {
  /** The head: a turn start that names no model inherits the head's. */
  readonly head?: ThreadHead | null;
  /**
   * The row a `thread.message-sent` produced. A delta merges onto an existing
   * row, and that row's role and owner — the first event's — decide the stamp.
   */
  readonly message?: MessageStamp;
  /**
   * The checkpoint fold refused the capture (a `missing` placeholder never
   * clobbers a `ready` one, §5.4), so no turn moves either.
   */
  readonly checkpointRefused?: boolean;
  /** The checkpoints before a rewind: the legacy fallback and the latest-turn synthesis read them. */
  readonly checkpoints?: readonly Checkpoint[];
}

const NO_TURN_CONTEXT: TurnEventContext = {};

/**
 * Every change the fold makes to `turns`, and the only place it makes one:
 * `commit` runs this for every event, and {@link applyTurnEvent} is this with
 * no context. Returns `turns` itself when the event touches no turn.
 */
function turnsAfterEvent(turns: Turn[], event: DomainEvent, context: TurnEventContext): Turn[] {
  switch (event.type) {
    case "thread.turn-start-requested":
      return [...turns, requestedTurn(event, context.head)];

    case "thread.message-sent":
      return stampAssistantMessage(turns, context.message ?? messageStampOf(event.payload));

    case "thread.session-set":
      return sessionSetTurns(turns, event);

    case "thread.turn-diff-completed":
      return context.checkpointRefused === true ? turns : checkpointTurns(turns, event.payload);

    case "thread.reverted":
      return planRevert(turns, context.checkpoints ?? [], event.payload.turnCount).turns;

    case "thread.created":
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.activity-appended":
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.deleted":
      return turns;

    default:
      // As in `reduce`: `never` for the closed union, so a new event type must
      // decide here whether it moves a turn; inert at runtime for a type a
      // newer host wrote (§8).
      void (event as never);
      return turns;
  }
}

/**
 * The turn arm of `thread.turn-start-requested`: the row the request opens.
 * A turn replayed from the provider's transcript arrives already over, and
 * must never be settled from session status the way a live turn is — that
 * would settle whatever turn is actually running (E6).
 */
function requestedTurn(
  event: Extract<DomainEvent, { type: "thread.turn-start-requested" }>,
  head: ThreadHead | null | undefined
): Turn {
  const payload = event.payload;
  const settled = payload.settled;
  return {
    turnId: payload.turnId,
    state: settled?.state ?? (payload.turnId === null ? "pending" : "running"),
    turnCount: null,
    requestedAt: event.occurredAt,
    startedAt: payload.turnId === null ? null : event.occurredAt,
    completedAt: settled?.completedAt ?? null,
    assistantMessageId: settled?.assistantMessageId ?? null,
    // The prompt that opened the turn. A replayed turn whose prompt the
    // projection could not name carries `""`, which is no id at all.
    ...(payload.messageId.length > 0 ? { userMessageId: payload.messageId } : {}),
    ...(settled?.tokenUsage !== undefined ? { tokenUsage: settled.tokenUsage } : {}),
    interactionMode: payload.interactionMode,
    ...(payload.modelSelection?.model !== undefined
      ? { model: payload.modelSelection.model }
      : head?.modelSelection.model !== undefined
        ? { model: head.modelSelection.model }
        : {})
  };
}

/** The row a `thread.message-sent` opens when no row has its id yet. */
function messageStampOf(payload: ThreadMessageSentPayload): MessageStamp {
  return {
    id: payload.messageId,
    role: payload.role,
    turnId: payload.turnId,
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {})
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Fold a whole log. Equivalent to reducing {@link applyDomainEvent} from empty. */
export function foldThread(events: Iterable<DomainEvent>): ThreadFoldState {
  let state = createEmptyThreadState();
  for (const event of events) {
    state = applyDomainEvent(state, event);
  }
  return state;
}

/**
 * The turn-only reducer: the change {@link applyDomainEvent} makes to `turns`
 * for `event`, from `turns` and `event` alone — the fold's own turn arms, not
 * a copy of them. The thread index numbers turns with it (design
 * `2026-09-23-thread-index-and-lazy-boot-design.md`): ids, order, state,
 * timestamps and prompts — what the index reads — agree with the fold's on
 * every log but the legacy one below.
 *
 * Four arms also read the rest of the fold, which only the fold has. Without
 * it they do this, and this is exactly where the fold's `turns` differ:
 * - a turn start that names no model records none (the fold: the head's);
 * - a message stamps a turn's anchor by the event's own role and owner (the
 *   fold: by those of the row a delta merges onto, set by its first event);
 * - a checkpoint always stamps its turn (the fold moves nothing for a capture
 *   it refuses — a `missing` placeholder over a `ready` one, §5.4);
 * - a rewind on a log with no started turn keeps none (the fold's legacy
 *   fallback reads the checkpoints and synthesises the latest turn).
 *
 * No sequence or thread guard, unlike {@link applyDomainEvent}: feed it one
 * thread's log, in order, once. Never writes to `turns`, and returns it as-is
 * when the event touches no turn.
 */
export function applyTurnEvent(turns: readonly Turn[], event: DomainEvent): Turn[] {
  // The arms never write to the array they are given; typing it mutable only
  // lets them hand it back unchanged, which is what keeps identity stable.
  return turnsAfterEvent(turns as Turn[], event, NO_TURN_CONTEXT);
}

/**
 * Project a fold state onto the §6.3 read shape. `seq` is the floor, not the
 * ceiling (§6.3): every projection here is folded to the same sequence, so it
 * is the state's own.
 *
 * Throws for a state with no `thread.created` — the §6.3 read shape requires a
 * head, and a headless directory is a thread the host must mark `error`
 * (§5.1) rather than serve.
 */
export function toThreadSnapshot(state: ThreadFoldState): ThreadSnapshotPayload {
  if (state.head === null) {
    throw new Error("agent-chat: cannot snapshot a thread with no thread.created event");
  }
  return {
    head: state.head,
    items: state.items,
    turns: state.turns,
    checkpoints: state.checkpoints,
    pending: state.pending,
    roster: state.roster,
    seq: state.seq,
    goal: state.goal ?? null
  };
}
