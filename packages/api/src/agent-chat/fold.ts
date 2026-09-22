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
 *   regardless of age;
 * - a revert (§5.5) keeps the first `turnCount` STARTED turns, by turn ORDER
 *   (`turns.ts`) — the checkpoint list decides only for a log that recorded no
 *   started turn at all, the legacy fallback;
 * - a malformed line truncates the fold at that point rather than discarding
 *   the file (the reader's job — this fold only ever sees decoded events).
 *
 * **No Node APIs, no I/O, deterministic, structurally sharing.** An event
 * changes only the objects it touches: the UI's row memoisation depends on
 * identity, so every unchanged array, item and sub-model keeps its reference
 * and `applyDomainEvent` returns `state` itself when nothing moved.
 */

import type { DomainEvent } from "./domain-events.ts";
import { derivePendingRequests } from "./pending.ts";
import { foldSubagentActivities } from "./roster.ts";
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
 * Everything a thread fold accumulates. `head` is `null` until
 * `thread.created` lands, so a truncated or empty log is representable rather
 * than an error.
 */
export interface ThreadFoldState {
  head: ThreadHead | null;
  /** Timeline order: messages and activities interleaved by arrival. */
  items: ThreadItem[];
  /** Index into `items` by id, so a streaming delta is O(1). */
  itemIndex: Map<string, number>;
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
}

const EMPTY_PENDING: PendingRequests = { approvals: [], userInputs: [] };

/** A fresh, empty fold state. */
export function createEmptyThreadState(): ThreadFoldState {
  return {
    head: null,
    items: [],
    itemIndex: new Map(),
    activities: [],
    turns: [],
    checkpoints: [],
    pending: EMPTY_PENDING,
    roster: [],
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
    const owner = typeof activity.agentId === "string" && activity.agentId.length > 0 ? activity.agentId : null;
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
  // timeline renders, plus every open async question and every agent anchor.
  const parentStart = parentRows.length - ACTIVITY_RETENTION_LIMIT;
  for (let index = 0; index < parentStart; index += 1) {
    const activity = parentRows[index]!;
    if (retainedByQuestion.has(activity) || isAgentAnchorRow(activity)) continue;
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
    survivingAgentRows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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

/** Rebuild `itemIndex` from an items array. */
function indexItems(items: readonly ThreadItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < items.length; i += 1) {
    index.set(items[i]!.id, i);
  }
  return index;
}

/**
 * Apply both retention windows, returning the same arrays when nothing was
 * dropped. Messages and activities are capped independently even though they
 * share one interleaved list.
 */
function applyRetention(
  items: ThreadItem[],
  activities: ThreadActivityItem[]
): { items: ThreadItem[]; activities: ThreadActivityItem[]; itemIndex: Map<string, number> | null } {
  const messageCount = items.length - activities.length;
  const overActivities = activities.length > ACTIVITY_RETENTION_LIMIT;
  const overMessages = messageCount > MESSAGE_RETENTION_LIMIT;
  if (!overActivities && !overMessages) {
    return { items, activities, itemIndex: null };
  }

  const dropActivities = overActivities ? activitiesToDrop(activities) : new Set<ThreadActivityItem>();
  let messagesToDrop = overMessages ? messageCount - MESSAGE_RETENTION_LIMIT : 0;
  if (dropActivities.size === 0 && messagesToDrop === 0) {
    // Over the trigger but nothing to evict (agent-owned rows sit outside the
    // parent window): keep the arrays, so a streamed token still shares them.
    return { items, activities, itemIndex: null };
  }
  const dropMessages = new Set<ThreadItem>();
  if (messagesToDrop > 0) {
    for (const item of items) {
      if (messagesToDrop === 0) break;
      if (item.kind === "message") {
        dropMessages.add(item);
        messagesToDrop -= 1;
      }
    }
  }

  const nextItems = items.filter(
    (item) =>
      !(item.kind === "activity" && dropActivities.has(item)) && !dropMessages.has(item)
  );
  const nextActivities = dropActivities.size > 0
    ? activities.filter((activity) => !dropActivities.has(activity))
    : activities;
  return { items: nextItems, activities: nextActivities, itemIndex: indexItems(nextItems) };
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
  itemIndex?: Map<string, number>;
  turns?: Turn[];
  checkpoints?: Checkpoint[];
  deleted?: boolean;
  /** Re-derive `pending` from the (possibly new) activity list. */
  rederivePending?: boolean;
  /** Re-derive `roster` from the (possibly new) activity list. */
  rederiveRoster?: boolean;
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
  let itemIndex = mutation.itemIndex ?? state.itemIndex;

  // Retention can drop an open approval or a live roster row on an append that
  // has nothing to do with either, so a drop is its own re-derive trigger —
  // gating only on the INCOMING row's kind left `pending`/`roster` pointing at
  // rows the fold no longer holds until some later event happened to touch
  // them (R5 #18).
  let retentionDropped = false;
  if (mutation.items !== undefined || mutation.activities !== undefined) {
    const retained = applyRetention(items, activities);
    if (retained.itemIndex !== null) {
      items = retained.items;
      retentionDropped = retained.activities !== activities;
      activities = retained.activities;
      itemIndex = retained.itemIndex;
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
  const roster =
    mutation.rederiveRoster === true || sessionLiveChanged || retentionDropped
      ? foldSubagentActivities(activities, { sessionLive: isSessionLive(nextSessionStatus) })
      : state.roster;

  const head = mutation.head !== undefined ? mutation.head : state.head;
  const nextHead =
    head === null
      ? null
      : { ...head, seq: event.seq, updatedAt: event.occurredAt };

  return {
    head: nextHead,
    items,
    itemIndex,
    activities,
    turns: mutation.turns ?? state.turns,
    checkpoints: mutation.checkpoints ?? state.checkpoints,
    pending,
    roster,
    closedRequestIds,
    ...(closedRequestAt !== undefined ? { closedRequestAt } : {}),
    seq: event.seq,
    deleted: mutation.deleted ?? state.deleted
  };
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

    case "thread.turn-start-requested": {
      const payload = event.payload;
      // A turn replayed from the provider's transcript arrives already over,
      // and must never be settled from session status the way a live turn is
      // — that would settle whatever turn is actually running (E6).
      const settled = payload.settled;
      const turn: Turn = {
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
          : state.head?.modelSelection.model !== undefined
            ? { model: state.head.modelSelection.model }
            : {})
      };
      return { turns: [...state.turns, turn] };
    }

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
  const existingIndex = state.itemIndex.get(payload.messageId);
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
      turns: stampAssistantMessage(state.turns, next),
      itemIndex: state.itemIndex
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
  const items = [...state.items, message];
  const itemIndex = new Map(state.itemIndex);
  itemIndex.set(message.id, items.length - 1);
  return { items, itemIndex, turns: stampAssistantMessage(state.turns, message) };
}

/**
 * The turn's `assistantMessageId` is what "rewind to here" (§5.5) and the
 * §5.4 diff card anchor on. First assistant message of the turn wins; a
 * checkpoint may overwrite it with the provider's own answer.
 */
function stampAssistantMessage(turns: Turn[], message: ThreadMessageItem): Turn[] {
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
  // The provider's final numbers for the turn this event settles (E10). They
  // are stamped BEFORE settlement so `applySessionStatusToTurn`'s
  // already-settled short-circuit cannot drop them, and only onto the named
  // turn while it is still unsettled — a replayed terminal event never
  // rewrites a closed turn's cost.
  const turnResult = event.payload.turn;

  let turns = state.turns;
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
    turns = adoptActiveTurn(turns, session.activeTurnId, event.occurredAt);
  } else {
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
    if (changed) turns = next;
  }

  return { ...(head !== null ? { head } : {}), turns };
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
  const existingIndex = state.itemIndex.get(activity.id);
  const existing = existingIndex === undefined ? undefined : state.items[existingIndex];

  const mutationFlags = {
    rederivePending: touchesPending(activity.activityKind),
    rederiveRoster: touchesRoster(activity.activityKind)
  };

  if (existing !== undefined && existing.kind === "activity") {
    const items = state.items.slice();
    items[existingIndex!] = activity;
    const activities = state.activities.slice();
    const activityAt = activities.indexOf(existing);
    if (activityAt !== -1) {
      activities[activityAt] = activity;
    } else {
      activities.push(activity);
    }
    return { items, activities, itemIndex: state.itemIndex, ...mutationFlags };
  }

  const items = [...state.items, activity];
  const itemIndex = new Map(state.itemIndex);
  itemIndex.set(activity.id, items.length - 1);
  return {
    items,
    itemIndex,
    activities: [...state.activities, activity],
    ...mutationFlags
  };
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
    return {};
  }

  // The turn keeps its own settlement (session status decides that, §5.1); the
  // checkpoint only stamps the turn count and the anchor message.
  let turns = state.turns;
  if (payload.turnId !== null) {
    const index = turns.findIndex((turn) => turn.turnId === payload.turnId);
    if (index !== -1) {
      const turn = turns[index]!;
      const next: Turn = {
        ...turn,
        turnCount: payload.turnCount,
        assistantMessageId: payload.assistantMessageId ?? turn.assistantMessageId
      };
      if (next.turnCount !== turn.turnCount || next.assistantMessageId !== turn.assistantMessageId) {
        turns = turns.slice();
        turns[index] = next;
      }
    }
  }

  const head =
    state.head === null || state.head.turnCount >= payload.turnCount
      ? undefined
      : { ...state.head, turnCount: payload.turnCount };

  return { checkpoints, turns, ...(head !== undefined ? { head } : {}) };
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
  const started = startedTurns(state.turns);

  const retainedTurnIds = new Set<string>();
  if (started.length === 0 && state.checkpoints.length > 0) {
    // Legacy: no turn row to order, so the checkpoints at or below the target
    // name the retained turns, as they did for every log before turn order.
    for (const checkpoint of state.checkpoints) {
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
  const checkpoints = state.checkpoints
    .filter((entry) =>
      entry.turnId !== null
        ? retainedTurnIds.has(entry.turnId)
        : entry.checkpointTurnCount <= target
    )
    .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
    .slice(-CHECKPOINT_RETENTION_LIMIT);

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

  // The retained rows, in start order and whole — `userMessageId` included.
  let turns = state.turns.filter(
    (turn) => turn.turnId !== null && retainedTurnIds.has(turn.turnId)
  );
  // `latestTurn` is recomputed from the last surviving checkpoint (§5.5): if
  // that checkpoint has no turn row left, synthesise one so every ambient
  // surface still reads a settled turn rather than nothing. Only the legacy
  // fallback gets here — a retained turn always keeps its own row — and a row
  // that exists is never moved: with a sparse checkpoint list the last
  // checkpoint is rarely the last turn, and moving its row to the end would
  // reorder the started turns under every later rewind.
  const latestCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1]! : null;
  if (
    latestCheckpoint !== null &&
    latestCheckpoint.turnId !== null &&
    !turns.some((turn) => turn.turnId === latestCheckpoint.turnId)
  ) {
    turns = [
      ...turns,
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

  const head =
    state.head === null ? undefined : { ...state.head, turnCount: target };

  return {
    items,
    activities,
    itemIndex: indexItems(items),
    turns,
    checkpoints,
    rederivePending: true,
    rederiveRoster: true,
    ...(head !== undefined ? { head } : {})
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
    seq: state.seq
  };
}
