// Ported from T3 Code (MIT): apps/server/src/orchestration/ThreadLiveEventCoalescer.ts:18-94
// and apps/server/src/orchestration/ActivityPayloadProjection.ts:505-643
/**
 * `tool.updated` coalescing and the two snapshot-time drops (spec §5.6).
 *
 * Coalescing: `item.updated` coalesces to the latest per stable tool-call id
 * **within the same turn** inside a 50 ms window, capped at 512 pending rows;
 * a call with no stable id passes through unchanged (labels are not unique
 * under parallel tool use), and any non-update event closes the window
 * immediately so ordering is preserved.
 *
 * Snapshot drops: on a snapshot, a `tool.updated` row that a later
 * `tool.completed` **in the same turn** supersedes is dropped outright, and
 * all but the newest `context-window.updated` per turn are dropped. Both
 * matchings are per turn because a live `thread.reverted` makes the client
 * discard whole turns, and a completion in a different turn could vanish and
 * leave the dropped update unrepresented.
 */

import { slimActivityPayload, type ThreadActivityItem } from "@orquester/api/agent-chat";

/** §5.6: the coalescing window. */
export const COALESCE_WINDOW_MS = 50;
/** §5.6: past this many pending rows the window is closed early. */
export const MAX_PENDING_UPDATES = 512;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The stable tool-call identity a coalescing run keys on. Only a real id
 * counts: labels are not unique when tools execute in parallel, so an
 * anonymous call must pass through rather than swallow its siblings.
 */
export function stableToolCallId(activity: ThreadActivityItem): string | null {
  const payload = asRecord(activity.payload);
  if (payload === null) {
    return null;
  }
  const nested = asRecord(payload.data);
  return asTrimmedString(payload.toolUseId) ?? asTrimmedString(nested?.toolUseId) ?? null;
}

function coalesceKey(activity: ThreadActivityItem, identity: string): string {
  return `${activity.turnId ?? ""}\u0000${identity}`;
}

/**
 * Retain only the latest in-flight update for each stable tool-call id in one
 * run. Anonymous calls pass through. Survivors stay in arrival order.
 */
export function coalesceToolUpdates(
  activities: readonly ThreadActivityItem[]
): ThreadActivityItem[] {
  const seen = new Set<string>();
  const latest: ThreadActivityItem[] = [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    const identity = stableToolCallId(activity);
    if (identity === null) {
      latest.push(activity);
      continue;
    }
    const key = coalesceKey(activity, identity);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    latest.push(activity);
  }
  latest.reverse();
  return latest;
}

// ---------------------------------------------------------------------------
// Snapshot-time drops (§5.6)
// ---------------------------------------------------------------------------

/**
 * Matches the validity rule the client's context meter uses: rows without a
 * finite, non-negative `usedTokens` are skipped during its backward walk, so
 * they must not shadow an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: ThreadActivityItem): boolean {
  if (activity.activityKind !== "context-window.updated") {
    return false;
  }
  const usedTokens = asRecord(activity.payload)?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drop all but the last resolvable `context-window.updated` per turn. Clients
 * only ever read the latest usage value, so shipping the full history buys
 * nothing. Malformed rows pass through untouched rather than shadowing a valid
 * earlier row.
 */
export function dropStaleContextWindowActivities(
  activities: readonly ThreadActivityItem[]
): ThreadActivityItem[] {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities as ThreadActivityItem[];
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index
  );
}

/**
 * Identity used to retain only the newest lifecycle row for each call.
 * Prefer the stable `toolUseId`, then the nested one, and finally the
 * itemType/label/detail triple. Rows with no identity are left untouched.
 *
 * The label normalisation mirrors the clients' `normalizeCompactToolLabel`: a
 * completion's title may gain a trailing "complete"/"completed" the in-flight
 * updates lack.
 */
export function toolLifecycleIdentity(activity: ThreadActivityItem): string | null {
  const payload = asRecord(activity.payload);
  if (payload === null) {
    return null;
  }
  const toolUseId = stableToolCallId(activity);
  if (toolUseId !== null) {
    return `id:${toolUseId}`;
  }
  const itemType = asTrimmedString(payload.itemType) ?? "";
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("");
}

/**
 * Drop `tool.updated` rows a later `tool.completed` in the same turn already
 * supersedes: an update is the in-flight snapshot of a call, and once the call
 * completes the completion carries the final state. The completion must come
 * **after** the update within the turn — a later update belongs to a
 * subsequent call reusing the same identity and is still in flight.
 */
export function dropSupersededToolUpdatedActivities(
  activities: readonly ThreadActivityItem[]
): ThreadActivityItem[] {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.activityKind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (identity === null) {
      continue;
    }
    const key = `${activity.turnId ?? ""}\u0000${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices !== undefined) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities as ThreadActivityItem[];
  }
  return activities.filter((activity, index) => {
    if (activity.activityKind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (identity === null) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""}\u0000${identity}`);
    return !(indices?.some((completionIndex) => completionIndex > index) ?? false);
  });
}

/**
 * §5.6 slimming for one activity row, on the way OUT. The full payload stays
 * on disk; `GET …/items/:itemId` is the one read that serves it unslimmed, and
 * is what the UI's "load full output" affordance fetches.
 *
 * A `tool.updated` row was already slimmed at write time (§5.6's one
 * exception), and `slimActivityPayload` returns its argument by reference when
 * nothing needed slimming — so a row that is already small costs no
 * allocation and keeps its identity, which the client's row memoisation
 * depends on.
 *
 * Never throws: W2 owns the slimmer, and a failure there must cost the row its
 * size, not its existence.
 */
export function slimActivity(activity: ThreadActivityItem): ThreadActivityItem {
  try {
    const payload = slimActivityPayload(activity.payload);
    return payload === activity.payload ? activity : { ...activity, payload };
  } catch {
    return activity;
  }
}

/**
 * §5.6 slimming for a whole domain event, on the way out. Anything that is not
 * an activity row passes through by reference.
 *
 * This is the hook the LIVE stream needs (`server/stream.ts`): without it the
 * per-stream byte budget is charged the full persisted payload, so a client on
 * a slow link is cut with "the live event buffer is full" on ordinary tool
 * output, and `payload.truncated` never reaches the UI so "load full output"
 * can never appear (R5 #1).
 */
export function slimActivityEvent<TEvent extends { type: string; payload: unknown }>(
  event: TEvent
): TEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  const payload = event.payload as { activity?: ThreadActivityItem } | null;
  const activity = payload?.activity;
  if (activity === undefined || activity.kind !== "activity") {
    return event;
  }
  const slimmed = slimActivity(activity);
  return slimmed === activity
    ? event
    : ({ ...event, payload: { ...payload, activity: slimmed } } as TEvent);
}

/**
 * The §5.6 read projection: the two snapshot-time drops, then slimming.
 *
 * This is T3's "single choke point every read passes through"
 * (`ActivityPayloadProjection.ts:645-689`, `projectThreadDetailSnapshot`),
 * which applies `projectActivityPayload` alongside the drops rather than
 * leaving the second half to each caller. Slimming last is deliberate: the
 * drops match on `toolUseId`, `itemType`, `title` and `detail`, and the
 * allow-list rebuild can elide a `detail` — dropping first keeps the matching
 * honest.
 */
export function projectSnapshotActivities(
  activities: readonly ThreadActivityItem[]
): ThreadActivityItem[] {
  return dropStaleContextWindowActivities(
    dropSupersededToolUpdatedActivities(activities)
  ).map(slimActivity);
}
