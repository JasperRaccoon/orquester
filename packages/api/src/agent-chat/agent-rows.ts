/**
 * Agent chat — on-demand agent rows: what a cold snapshot may leave out, and
 * how the client puts it back (opt-in `?agentRows=on-demand`, wire.ts
 * {@link AGENT_ROWS_QUERY_PARAM}).
 *
 * On a subagent-heavy thread nearly all of a snapshot is the agents' own rows
 * (97% of the biggest real one: 3.9 of 4.1 MiB) — their tool calls and their
 * words, which only that agent's drill-in renders. So a snapshot that opted in
 * leaves out the ON-DEMAND rows ({@link onDemandRowOwner}) of every agent its
 * own roster shows SETTLED ({@link isOnDemandAgent}), lists those agents
 * ({@link ThreadSnapshotPayload.omittedAgentIds}), and the client loads one
 * agent's rows when its drill-in opens or it comes back to life: the host
 * writes them into the client's own stream as one {@link AgentRowsFrame}, in
 * order with its events ({@link agentRowsFrameOf}), and the client replaces
 * that agent's on-demand rows with them ({@link applyAgentRows}).
 *
 * An on-demand row is one nothing but the drill-in reads — never one the
 * parent's view or the fold's own derivations read:
 *
 * - a message an agent wrote (`agentId` set): the parent's timeline drops it
 *   (`splitThreadItems`), and the head, the prompt list, the MCP's replies and
 *   the re-emitted-copy repair read the parent's alone;
 * - an agent's own tool call rows ({@link ON_DEMAND_AGENT_ACTIVITY_KINDS},
 *   `agentId` set): agent-internal to the parent (`isAgentInternalActivity`);
 * - an older log's unstamped output chunk of such a call: it inherits the
 *   call's owner on the read side (`callOwnersOf` in the UI's
 *   `entries.logic.ts`), and only while the call's own rows are there — so it
 *   goes and comes back with them, or the parent's timeline would show it as a
 *   stray "Tool output" row.
 *
 * Never left out: every `task.*` and `tool.progress` row (the roster is
 * rebuilt from them, and an agent's launch and terminal rows place it in the
 * parent's timeline), every request row (pending is derived from them, and a
 * snapshot re-tombstones from them), every other kind (goal, plan, compaction,
 * warning rows, …: not drill-in-only, or not worth the doubt), a call a pending
 * approval names (its card joins the call's rows), a background shell's or a
 * monitor's rows (their drill-in is one row and the roster reads their output),
 * a loop's or a goal's, and the rows of an agent the roster does not list.
 *
 * Pure, no Node APIs: shared by the host (omission, the frame) and the browser
 * (the replacement). The fold, `state.json`, the log and the index are never
 * touched: the omission is the snapshot's projection only.
 */

import {
  CALL_CLOSER_KINDS,
  CALL_OPENER_KINDS
} from "./open-work.ts";
import type { ThreadFoldState } from "./fold.ts";
import {
  ACTIVE_SUBAGENT_STATUSES,
  type PendingRequests,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadSnapshotPayload
} from "./thread.ts";
import type { AgentRowsFrame } from "./wire.ts";

/** The activity kinds of an agent's own rows that its drill-in alone renders. */
export const ON_DEMAND_AGENT_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.output",
  "tool.denied"
]);

const CALL_LIFECYCLE_KINDS: ReadonlySet<string> = new Set([...CALL_OPENER_KINDS, ...CALL_CLOSER_KINDS]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-blank id, as written: views compare ids verbatim. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Whether the roster row is an agent whose on-demand rows a snapshot may leave
 * out at all ({@link isOnDemandAgent} adds that it is settled): an agent, not
 * a background shell or monitor, and not a loop or a goal, which drive work
 * and do none.
 */
export function mayOmitAgentRows(row: Pick<RuntimeSubagent, "agentKind" | "kind">): boolean {
  return row.agentKind === "agent" && row.kind !== "loop" && row.kind !== "goal";
}

/**
 * A SETTLED agent per the roster: not at work — `pending`, `running` and
 * `waiting` are, the notion every client reader shares
 * (`MessageStreamingContext.activeAgentIds`, `ACTIVE_SUBAGENT_STATUSES`). A
 * row the session-death pass already turned `interrupted` is settled, and so
 * is an `idle` one: when it runs again its first live row loads it back.
 */
export function isOnDemandAgent(row: Pick<RuntimeSubagent, "agentKind" | "kind" | "status">): boolean {
  return mayOmitAgentRows(row) && !ACTIVE_SUBAGENT_STATUSES.has(row.status);
}

/**
 * `toolUseId` → the agent that owns the call, read off its lifecycle rows —
 * exactly the UI's `callOwnersOf` (`entries.logic.ts`): the last owned
 * lifecycle row of a call in list order names its owner, top-level `agentId`
 * first, then `payload.agentId`.
 */
export function agentCallOwnersOf(items: readonly ThreadItem[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "activity" || !CALL_LIFECYCLE_KINDS.has(item.activityKind)) continue;
    const payload = asRecord(item.payload);
    const callId = trimmed(payload?.toolUseId);
    const owner = nonBlank(item.agentId) ?? nonBlank(payload?.agentId);
    if (callId !== undefined && owner !== undefined) owners.set(callId, owner);
  }
  return owners;
}

/** A `tool.output` row with no owner of its own (`isUnstampedOutputChunk` in the UI). */
function isUnstampedChunk(activity: ThreadActivityItem): boolean {
  return (
    activity.activityKind === "tool.output" &&
    nonBlank(activity.agentId) === undefined &&
    nonBlank(asRecord(activity.payload)?.agentId) === undefined
  );
}

/**
 * The agent `item` is an on-demand row of, or null when it is no on-demand
 * row: a message the agent wrote, one of its own call rows, or an unstamped
 * chunk of one of its calls (`callOwners`, {@link agentCallOwnersOf} over the
 * same list). Ownership is the drill-in's own (`agentItemFilter`): the
 * top-level `agentId`, verbatim.
 */
export function onDemandRowOwner(item: ThreadItem, callOwners: ReadonlyMap<string, string>): string | null {
  if (item.kind === "message") {
    return nonBlank(item.agentId) ?? null;
  }
  if (!ON_DEMAND_AGENT_ACTIVITY_KINDS.has(item.activityKind)) return null;
  const owner = nonBlank(item.agentId);
  if (owner !== undefined) return owner;
  if (!isUnstampedChunk(item)) return null;
  const callId = trimmed(asRecord(item.payload)?.toolUseId);
  return callId === undefined ? null : (callOwners.get(callId) ?? null);
}

/** The calls a pending approval names: their rows stay, the card joins them. */
function callsPendingApproval(pending: PendingRequests | undefined): ReadonlySet<string> {
  const calls = new Set<string>();
  for (const approval of pending?.approvals ?? []) {
    const callId = trimmed(approval.toolUseId);
    if (callId !== undefined) calls.add(callId);
  }
  return calls;
}

function callIdOf(item: ThreadItem): string | undefined {
  return item.kind === "activity" ? trimmed(asRecord(item.payload)?.toolUseId) : undefined;
}

/**
 * The snapshot an opted-in read sends: `snapshot` without the on-demand rows
 * of every settled agent its own roster lists ({@link isOnDemandAgent}), and
 * those agents in `omittedAgentIds` (sorted; only the ones that had a row left
 * out). The same object when nothing is left out. Applied to the snapshot as
 * it goes on the wire — after slimming, as one step of the projection — so
 * a full read stays byte-identical.
 */
export function omitOnDemandAgentRows(snapshot: ThreadSnapshotPayload): ThreadSnapshotPayload {
  const settled = new Set<string>();
  for (const row of snapshot.roster) {
    if (isOnDemandAgent(row)) settled.add(row.id);
  }
  if (settled.size === 0) return snapshot;
  const callOwners = agentCallOwnersOf(snapshot.items);
  const pendingCalls = callsPendingApproval(snapshot.pending);
  const omitted = new Set<string>();
  const items: ThreadItem[] = [];
  for (const item of snapshot.items) {
    const owner = onDemandRowOwner(item, callOwners);
    if (owner !== null && settled.has(owner)) {
      const callId = callIdOf(item);
      if (callId === undefined || !pendingCalls.has(callId)) {
        omitted.add(owner);
        continue;
      }
    }
    items.push(item);
  }
  if (omitted.size === 0) return snapshot;
  return { ...snapshot, items, omittedAgentIds: [...omitted].sort() };
}

/**
 * The {@link AgentRowsFrame} of `agentIds` over the host's window at `seq`:
 * every on-demand row those agents own, in list order, each with its
 * placement — the nearest row before it that every opted-in client holds. A
 * row no snapshot ever leaves out is one; an on-demand row of an agent a
 * snapshot may leave out ({@link mayOmitAgentRows}, whatever its status now)
 * is not, since that client may not hold it. `items` must be the snapshot's
 * own projection of the window (slimmed), and `roster` the fold's.
 */
export function agentRowsFrameOf(input: {
  readonly items: readonly ThreadItem[];
  readonly roster: readonly RuntimeSubagent[];
  readonly seq: number;
  readonly agentIds: readonly string[];
}): AgentRowsFrame {
  const requested = new Set(input.agentIds);
  const omittable = new Set<string>();
  for (const row of input.roster) {
    if (mayOmitAgentRows(row)) omittable.add(row.id);
  }
  const callOwners = agentCallOwnersOf(input.items);
  const items: ThreadItem[] = [];
  const after: Array<string | null> = [];
  let anchor: string | null = null;
  for (const item of input.items) {
    const owner = onDemandRowOwner(item, callOwners);
    if (owner !== null && requested.has(owner)) {
      items.push(item);
      after.push(anchor);
    } else if (owner === null || !omittable.has(owner)) {
      anchor = item.id;
    }
  }
  return { kind: "agent-rows", seq: input.seq, agentIds: [...requested].sort(), items, after };
}

/** Whether `item` is a launch or an anchor row of one of `agentIds` (a kept row, never on demand). */
function isLaunchRowOf(item: ThreadItem, agentIds: ReadonlySet<string>): boolean {
  if (item.kind !== "activity") return false;
  if (item.activityKind !== "task.started" && item.activityKind !== "task.completed") return false;
  const taskId = trimmed(asRecord(item.payload)?.taskId);
  return (taskId !== undefined && agentIds.has(taskId)) || (item.agentId !== undefined && agentIds.has(item.agentId));
}

/**
 * The client's fold once an {@link AgentRowsFrame} landed: the frame's agents'
 * on-demand rows ({@link onDemandRowOwner}, over the client's own window) and
 * any row the frame carries again are replaced by the frame's `items`, each
 * placed after its `after` row. The frame is the host's state at the very
 * position the client has applied (it rides the stream in order), so this is
 * what a full snapshot at that position would hold for these agents — rows
 * the host's retention evicted meanwhile go, a message streaming meanwhile is
 * whole.
 *
 * A placement row this client does not hold — its own retention trims at
 * other moments than the host's, with fewer rows — falls back to the previous
 * row's place, and for the first row to the agent's latest launch or anchor
 * row created before it (kept rows, never on demand), else the window's head;
 * placements never move backwards, so the agent's own rows keep the host's
 * order. Past its placement row a row also goes after the other agents'
 * on-demand rows this client holds that were created before it (the host
 * names no such row as a placement: a client may lack it). So what can
 * differ from the host's window is only where its rows sit among OTHER
 * agents' rows, and only where the log's arrival order and `createdAt` disagree.
 *
 * Nothing else moves: turns, checkpoints, pending, the roster (no on-demand
 * row feeds them) and `seq`. The fold's caches are rebuilt from the new lists
 * on first use, and its retention runs on the next step as on any other — a
 * frame larger or smaller than what it replaced keeps the per-agent limits,
 * since it is what the host's fold already trimmed to.
 */
export function applyAgentRows(state: ThreadFoldState, frame: Pick<AgentRowsFrame, "agentIds" | "items" | "after">): ThreadFoldState {
  const requested = new Set(frame.agentIds);
  if (requested.size === 0) return state;
  const frameIds = new Set(frame.items.map((item) => item.id));
  const callOwners = agentCallOwnersOf(state.items);
  const kept: ThreadItem[] = [];
  let removed = 0;
  for (const item of state.items) {
    const owner = onDemandRowOwner(item, callOwners);
    if (frameIds.has(item.id) || (owner !== null && requested.has(owner))) {
      removed += 1;
      continue;
    }
    kept.push(item);
  }
  if (removed === 0 && frame.items.length === 0) return state;
  const positions = new Map<string, number>();
  kept.forEach((item, index) => positions.set(item.id, index));
  // Where each frame row goes: after `kept[slot]`, -1 for the head.
  const slots: number[] = [];
  let previous: number | null = null;
  frame.items.forEach((item, index) => {
    const anchor = frame.after[index] ?? null;
    let slot: number;
    if (anchor === null) {
      slot = -1;
    } else {
      const found = positions.get(anchor);
      if (found !== undefined) {
        slot = found;
      } else if (previous !== null) {
        slot = previous;
      } else {
        slot = -1;
        for (let at = kept.length - 1; at >= 0; at -= 1) {
          const candidate = kept[at]!;
          if (candidate.createdAt <= item.createdAt && isLaunchRowOf(candidate, requested)) {
            slot = at;
            break;
          }
        }
      }
    }
    if (previous !== null && slot < previous) slot = previous;
    // The placement row is the nearest one EVERY client holds, so other
    // agents' on-demand rows this client holds may follow it: the row goes
    // after those created before it, as the log wrote them in arrival order.
    while (slot + 1 < kept.length) {
      const following = kept[slot + 1]!;
      if (onDemandRowOwner(following, callOwners) === null || following.createdAt > item.createdAt) break;
      slot += 1;
    }
    slots.push(slot);
    previous = slot;
  });
  const items: ThreadItem[] = [];
  let next = 0;
  while (next < frame.items.length && slots[next] === -1) {
    items.push(frame.items[next]!);
    next += 1;
  }
  for (let at = 0; at < kept.length; at += 1) {
    items.push(kept[at]!);
    while (next < frame.items.length && slots[next] === at) {
      items.push(frame.items[next]!);
      next += 1;
    }
  }
  const activities = items.filter((item): item is ThreadActivityItem => item.kind === "activity");
  return { ...state, items, activities };
}
