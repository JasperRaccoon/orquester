/**
 * Batch retention (design `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B).
 *
 * The rules are today's, at today's limits; what changed is WHEN they run. A
 * class may grow past its limit by its slack, and the step that takes it past
 * limit + slack cuts EVERY class back to its limit in one pass. The core check
 * here is a reference model written from the rules alone: it follows the
 * window event by event, recounts the droppable rows from scratch after each
 * step, and when its trigger fires applies today's `activitiesToDrop` and
 * message cut — copied below as they stood before batching — to the pre-trim
 * window. The fold must agree with it at every step: same rows, same objects,
 * same dropped rows.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent } from "./domain-events.ts";
import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  AGENT_ACTIVITY_RETENTION_LIMIT,
  AGENT_ACTIVITY_RETENTION_SLACK,
  AGENT_ACTIVITY_TOTAL_LIMIT,
  AGENT_ACTIVITY_TOTAL_SLACK,
  MESSAGE_RETENTION_LIMIT,
  MESSAGE_RETENTION_SLACK,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  itemPositionOf,
  itemsDroppedByRetention
} from "./fold.ts";
import type { ThreadFoldState } from "./fold.ts";
import { deserializeFoldState, serializeFoldState } from "./fold-snapshot.ts";
import {
  AGENT_CEILING_WEIGHTS,
  AGENT_WEIGHTS,
  FLEET_WEIGHTS,
  MESSAGE_WEIGHTS,
  fleetLog
} from "./fold-logs.test-support.ts";
import type { ThreadActivityItem, ThreadItem } from "./thread.ts";
import {
  activity,
  agentTask,
  created,
  ev,
  resetActivityIds,
  resetSeq,
  session
} from "./test-helpers.ts";

function reset(): void {
  resetSeq();
  resetActivityIds();
}

// ---------------------------------------------------------------------------
// The reference: today's rules, verbatim, and a window that follows the log
// ---------------------------------------------------------------------------

function isAnchor(row: ThreadActivityItem): boolean {
  return (
    (row.activityKind === "task.started" || row.activityKind === "task.completed") &&
    (row.payload as { agentKind?: unknown } | null)?.agentKind === "agent"
  );
}

function ownerOf(row: ThreadActivityItem): string | null {
  return typeof row.agentId === "string" && row.agentId.length > 0 ? row.agentId : null;
}

/**
 * `activitiesToDrop` as it stood before batch retention — the cross-agent
 * ceiling still sorting with `localeCompare`, which orders the ISO-8601 stamps
 * these logs carry exactly as the fold's `<` does, ties included.
 */
function referenceActivitiesToDrop(activities: readonly ThreadActivityItem[]): Set<ThreadActivityItem> {
  if (activities.length <= ACTIVITY_RETENTION_LIMIT) {
    return new Set();
  }
  const pendingById = new Map<string, ThreadActivityItem>();
  const parentRows: ThreadActivityItem[] = [];
  const agentRows = new Map<string, ThreadActivityItem[]>();
  for (const row of activities) {
    const payload = row.payload as Record<string, unknown> | null;
    const requestId = payload?.requestId;
    if (typeof requestId === "string") {
      if (row.activityKind === "user-input.requested" && payload?.responseMode === "message") {
        pendingById.set(requestId, row);
      } else if (row.activityKind === "user-input.resolved") {
        pendingById.delete(requestId);
      }
    }
    const owner = ownerOf(row);
    if (owner === null) {
      parentRows.push(row);
    } else {
      const rows = agentRows.get(owner);
      if (rows) rows.push(row);
      else agentRows.set(owner, [row]);
    }
  }
  const retainedByQuestion = new Set(pendingById.values());
  const drop = new Set<ThreadActivityItem>();
  const parentStart = parentRows.length - ACTIVITY_RETENTION_LIMIT;
  for (let index = 0; index < parentStart; index += 1) {
    const row = parentRows[index]!;
    if (retainedByQuestion.has(row) || isAnchor(row) || row.activityKind === "context-compaction") {
      continue;
    }
    drop.add(row);
  }
  const survivingAgentRows: ThreadActivityItem[] = [];
  for (const rows of agentRows.values()) {
    const start = rows.length - AGENT_ACTIVITY_RETENTION_LIMIT;
    rows.forEach((row, index) => {
      if (index < start && !isAnchor(row)) drop.add(row);
      else survivingAgentRows.push(row);
    });
  }
  if (survivingAgentRows.length > AGENT_ACTIVITY_TOTAL_LIMIT) {
    survivingAgentRows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const excess = survivingAgentRows.length - AGENT_ACTIVITY_TOTAL_LIMIT;
    let dropped = 0;
    for (const row of survivingAgentRows) {
      if (dropped === excess) break;
      if (isAnchor(row)) continue;
      drop.add(row);
      dropped += 1;
    }
  }
  return drop;
}

/** Today's retention pass: the activity rules and the message cut, over one window. */
function referenceTrim(
  items: readonly ThreadItem[],
  activities: readonly ThreadActivityItem[]
): { items: ThreadItem[]; activities: ThreadActivityItem[]; dropped: ThreadItem[] } {
  const dropActivities = referenceActivitiesToDrop(activities);
  let messagesToDrop = Math.max(0, items.length - activities.length - MESSAGE_RETENTION_LIMIT);
  const kept: ThreadItem[] = [];
  const dropped: ThreadItem[] = [];
  for (const item of items) {
    const drop =
      item.kind === "message" ? messagesToDrop-- > 0 : dropActivities.has(item);
    (drop ? dropped : kept).push(item);
  }
  return {
    items: kept,
    activities: activities.filter((row) => !dropActivities.has(row)),
    dropped
  };
}

type TrimReason = "parent" | "agent" | "agents" | "messages";

/** The trigger, recounted from scratch: which classes are past limit + slack. */
function referenceTrigger(
  items: readonly ThreadItem[],
  activities: readonly ThreadActivityItem[]
): TrimReason[] {
  const reasons: TrimReason[] = [];
  if (items.length - activities.length > MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK) {
    reasons.push("messages");
  }
  if (activities.length <= ACTIVITY_RETENTION_LIMIT) {
    return reasons;
  }
  let parent = 0;
  let agentTotal = 0;
  const agents = new Map<string, number>();
  for (const row of activities) {
    if (isAnchor(row)) continue;
    const owner = ownerOf(row);
    if (owner === null) {
      // Open questions count here too (design B): only the trim exempts them.
      if (row.activityKind !== "context-compaction") parent += 1;
    } else {
      agents.set(owner, (agents.get(owner) ?? 0) + 1);
      agentTotal += 1;
    }
  }
  if (parent > ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK) reasons.push("parent");
  if ([...agents.values()].some((count) => count > AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK)) {
    reasons.push("agent");
  }
  if (agentTotal > AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK) reasons.push("agents");
  return reasons;
}

/** A window following the log with the fold's identity rules, trimming by the reference. */
class ReferenceWindow {
  items: ThreadItem[] = [];
  activities: ThreadActivityItem[] = [];
  /** Each id's last position in `items`, rebuilt whenever rows leave. */
  private positions = new Map<string, number>();

  /**
   * Applies one event; returns the trim it ran, if any, with the trigger
   * recounted on what the trim left. A rewind is the one event it does not
   * model: its turn rules are `fold.test.ts`'s. It only REMOVES rows, so it can
   * never trip the trigger — the caller checks that and hands the model the
   * fold's rewound window through {@link adopt}.
   */
  apply(
    event: DomainEvent
  ): { reasons: TrimReason[]; dropped: ThreadItem[]; after: TrimReason[] } | null {
    if (event.type === "thread.message-sent") {
      const at = this.positions.get(event.payload.messageId);
      if (at !== undefined && this.items[at]!.kind === "message") {
        this.items = this.items.slice();
        this.items[at] = { ...(this.items[at] as ThreadItem & { kind: "message" }) };
      } else {
        this.append({
          kind: "message",
          id: event.payload.messageId,
          role: event.payload.role,
          text: "",
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt
        });
      }
    } else if (event.type === "thread.activity-appended") {
      const row = event.payload.activity;
      const at = this.positions.get(row.id);
      const existing = at === undefined ? undefined : this.items[at];
      if (existing !== undefined && existing.kind === "activity") {
        this.items = this.items.slice();
        this.items[at!] = row;
        this.activities = this.activities.slice();
        this.activities[this.activities.indexOf(existing)] = row;
      } else {
        this.append(row);
        this.activities = [...this.activities, row];
      }
    } else {
      // Nothing else touches the window, and only a window change is followed
      // by the trigger.
      return null;
    }
    const reasons = referenceTrigger(this.items, this.activities);
    if (reasons.length === 0) {
      return null;
    }
    const trimmed = referenceTrim(this.items, this.activities);
    this.adopt(trimmed);
    return { reasons, dropped: trimmed.dropped, after: referenceTrigger(this.items, this.activities) };
  }

  adopt(window: { items: ThreadItem[]; activities: ThreadActivityItem[] }): void {
    this.items = window.items;
    this.activities = window.activities;
    this.positions = new Map(this.items.map((item, position) => [item.id, position]));
  }

  private append(item: ThreadItem): void {
    this.items = [...this.items, item];
    this.positions.set(item.id, this.items.length - 1);
  }
}

const keyOf = (item: ThreadItem): string => `${item.kind}:${item.id}`;

/** The same rows: activities as the very same objects, messages by id. */
function sameRows(left: readonly ThreadItem[], right: readonly ThreadItem[]): number {
  if (left.length !== right.length) {
    return Math.min(left.length, right.length);
  }
  for (let position = 0; position < left.length; position += 1) {
    const a = left[position]!;
    const b = right[position]!;
    if (a.kind === "activity" ? a !== b : b.kind !== "message" || a.id !== b.id) {
      return position;
    }
  }
  return -1;
}

type Cut = "parent" | "agent" | "message";

interface ReferenceRun {
  mismatch: string | null;
  /** Trims by the class whose trigger fired (several may fire at once). */
  trims: Record<TrimReason, number>;
  /** Trims by the class that lost rows: every trim cuts every class at once. */
  cuts: Record<Cut, number>;
  trimSteps: number;
}

/**
 * Folds `events` one at a time beside the reference; returns the first
 * disagreement (or null) and what the trims were.
 */
function compareWithReference(events: readonly DomainEvent[]): ReferenceRun {
  const reference = new ReferenceWindow();
  const run: ReferenceRun = {
    mismatch: null,
    trims: { parent: 0, agent: 0, agents: 0, messages: 0 },
    cuts: { parent: 0, agent: 0, message: 0 },
    trimSteps: 0
  };
  let state = createEmptyThreadState();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    state = applyDomainEvent(state, event);
    const where = `event ${index} (${event.type})`;
    const dropped = itemsDroppedByRetention(state);
    if (event.type === "thread.reverted") {
      if (dropped.length > 0 || referenceTrigger(state.items, state.activities).length > 0) {
        return { ...run, mismatch: `${where}: a rewind tripped the trigger` };
      }
      reference.adopt(state);
      continue;
    }
    const trim = reference.apply(event);
    if (trim !== null) {
      run.trimSteps += 1;
      for (const reason of trim.reasons) run.trims[reason] += 1;
      const cut = new Set<Cut>(
        trim.dropped.map((item) =>
          item.kind === "message" ? "message" : item.agentId !== undefined ? "agent" : "parent"
        )
      );
      for (const kind of cut) run.cuts[kind] += 1;
    }
    const expectedDropped = trim?.dropped ?? [];
    if (sameRows(dropped, expectedDropped) !== -1) {
      return { ...run, mismatch: `${where}: dropped ${dropped.length} rows, expected ${expectedDropped.length}` };
    }
    const differsAt = sameRows(state.items, reference.items);
    if (differsAt !== -1) {
      return { ...run, mismatch: `${where}: the items differ at ${differsAt}` };
    }
    if (sameRows(state.activities, reference.activities) !== -1) {
      return { ...run, mismatch: `${where}: the activity list differs` };
    }
    // A step either stays within every class's limit plus slack or trims back
    // inside it, so between trims no class holds more (no log here keeps a
    // slack's worth of old open questions, the one exception).
    if (trim !== null && trim.after.length > 0) {
      return { ...run, mismatch: `${where}: left past its slack (${trim.after.join(", ")})` };
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// The fold against the reference, over logs that trim every class many times
// ---------------------------------------------------------------------------

test("a fleet-shaped log trims exactly as today's rules would, at exactly the batch trigger", () => {
  const events = fleetLog({ seed: 1, steps: 9_000, weights: FLEET_WEIGHTS });
  const run = compareWithReference(events);
  assert.equal(run.mismatch, null);
  // What the log really exercised. On a fleet the parent's rows fill its slack
  // first, and each of those trims also cuts the agents' rows and the messages
  // back to their limits — "cut back in one go" (design B).
  assert.ok(run.trimSteps >= 12, `trim steps: ${run.trimSteps}`);
  assert.ok(run.trims.parent >= 12, `parent-triggered trims: ${run.trims.parent}`);
  assert.ok(run.cuts.parent >= 12, `trims that cut parent rows: ${run.cuts.parent}`);
  assert.ok(run.cuts.agent >= 10, `trims that cut agent rows: ${run.cuts.agent}`);
  assert.ok(run.cuts.message >= 8, `trims that cut messages: ${run.cuts.message}`);
});

test("agents past their own windows trim exactly as today's rules would", () => {
  const events = fleetLog({ seed: 3, steps: 2_400, weights: AGENT_WEIGHTS, maxAgents: 5 });
  const run = compareWithReference(events);
  assert.equal(run.mismatch, null);
  assert.ok(run.trims.agent >= 5, `per-agent trims: ${run.trims.agent}`);
});

test("many agents past the ceiling across them trim exactly as today's rules would", () => {
  const events = fleetLog({ seed: 5, steps: 6_000, weights: AGENT_CEILING_WEIGHTS, maxAgents: 14 });
  const run = compareWithReference(events);
  assert.equal(run.mismatch, null);
  assert.ok(run.trims.agents >= 6, `ceiling-triggered trims: ${run.trims.agents}`);
  assert.equal(run.trims.agent, 0, "no agent ever passed its own window");
});

test("messages past their window trim exactly as today's rules would", () => {
  const events = fleetLog({ seed: 4, steps: 4_400, weights: MESSAGE_WEIGHTS });
  const run = compareWithReference(events);
  assert.equal(run.mismatch, null);
  assert.ok(run.trims.messages >= 6, `message-triggered trims: ${run.trims.messages}`);
});

// ---------------------------------------------------------------------------
// Each class: nothing until limit + slack, then exactly the limit
// ---------------------------------------------------------------------------

type ActivityAppended = Extract<DomainEvent, { type: "thread.activity-appended" }>;

function parentRow(index: number): ActivityAppended {
  return ev("thread.activity-appended", {
    activity: activity("tool.completed", { toolUseId: `p${index}` }, { id: `p-${index}` })
  });
}

function agentRow(agentId: string, index: number, createdAt?: string): DomainEvent {
  return ev("thread.activity-appended", {
    activity: activity("tool.completed", { toolUseId: `${agentId}-${index}` }, {
      id: `${agentId}-row-${index}`,
      agentId,
      ...(createdAt !== undefined ? { createdAt } : {})
    })
  });
}

function message(index: number): DomainEvent {
  return ev("thread.message-sent", {
    messageId: `m-${index}`,
    role: "assistant",
    text: `m${index}`,
    streaming: false,
    turnId: null
  });
}

/** Folds `events`, returning the state after each one. */
function statesOf(events: readonly DomainEvent[]): ThreadFoldState[] {
  const states: ThreadFoldState[] = [];
  let state = createEmptyThreadState();
  for (const event of events) {
    state = applyDomainEvent(state, event);
    states.push(state);
  }
  return states;
}

test("the parent window grows to its limit plus slack, then one trim cuts it to the limit", () => {
  reset();
  const events: DomainEvent[] = [created()];
  for (let index = 0; index <= ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(parentRow(index));
  }
  const states = statesOf(events);
  const beforeTrim = states.at(-2)!;
  assert.equal(beforeTrim.activities.length, ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK);
  assert.ok(
    states.slice(0, -1).every((state) => itemsDroppedByRetention(state).length === 0),
    "no step before the trigger drops anything"
  );
  assert.equal(beforeTrim.evicted, undefined, "nothing was ever evicted yet");

  const trimmed = states.at(-1)!;
  assert.equal(trimmed.activities.length, ACTIVITY_RETENTION_LIMIT);
  assert.deepEqual(
    itemsDroppedByRetention(trimmed).map((item) => item.id),
    Array.from({ length: ACTIVITY_RETENTION_SLACK + 1 }, (_, index) => `p-${index}`),
    "the oldest rows, in list order"
  );
  assert.equal(trimmed.activities[0]?.id, `p-${ACTIVITY_RETENTION_SLACK + 1}`);
  assert.deepEqual(trimmed.evicted, { activities: true, messages: false });
  assert.equal(itemPositionOf(trimmed, `p-${ACTIVITY_RETENTION_SLACK + 1}`), 0);
});

test("an agent's own window trims past 200 + 50 of its rows, keeping its anchors", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("task.started", agentTask("ag"), { id: "anchor-start" })
    }),
    // An anchor the agent owns itself (a nested agent's launch row) is exempt
    // in the agent's window too.
    ev("thread.activity-appended", {
      activity: activity("task.started", agentTask("nested"), { id: "anchor-nested", agentId: "ag" })
    })
  ];
  // Past the gate first, with parent rows that stay under their own trigger.
  for (let index = 0; index < 300; index += 1) events.push(parentRow(index));
  for (let index = 0; index <= AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(agentRow("ag", index));
  }
  const states = statesOf(events);
  const owned = (state: ThreadFoldState): ThreadActivityItem[] =>
    state.activities.filter((row) => row.agentId === "ag");
  assert.equal(owned(states.at(-2)!).length, AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK + 1);
  const trimmed = states.at(-1)!;
  assert.equal(
    owned(trimmed).length,
    AGENT_ACTIVITY_RETENTION_LIMIT + 1,
    "cut to its last 200 rows, plus its own anchor"
  );
  assert.equal(owned(trimmed)[0]?.id, "anchor-nested");
  assert.equal(owned(trimmed)[1]?.id, `ag-row-${AGENT_ACTIVITY_RETENTION_SLACK + 1}`);
  assert.ok(trimmed.activities.some((row) => row.id === "anchor-start"));
  assert.equal(
    trimmed.activities.filter((row) => row.agentId === undefined).length,
    301,
    "the parent rows are untouched: their class never passed its trigger"
  );
});

test("the gate: 400 activities of one agent fold losslessly — a history page never trims", () => {
  reset();
  // A history page folds up to 400 activities (`HISTORY_PAGE_ACTIVITIES`) and
  // must be lossless. One agent's 400 rows are far past that agent's own
  // trigger, but nothing may trim while the list holds at most 500 rows.
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", { activity: activity("task.started", agentTask("solo"), { id: "anchor" }) })
  ];
  for (let index = 0; index < 400; index += 1) events.push(agentRow("solo", index));
  for (let index = 0; index < 99; index += 1) events.push(parentRow(index));
  const states = statesOf(events);
  assert.ok(states.every((state) => itemsDroppedByRetention(state).length === 0));
  const last = states.at(-1)!;
  assert.equal(last.activities.length, ACTIVITY_RETENTION_LIMIT, "400 + 99 + the anchor, all kept");
  assert.equal(last.evicted, undefined);

  // One row more opens the gate, and the agent's window trims at once.
  const opened = applyDomainEvent(last, parentRow(99));
  assert.equal(
    opened.activities.filter((row) => row.agentId === "solo").length,
    AGENT_ACTIVITY_RETENTION_LIMIT
  );
  assert.equal(itemsDroppedByRetention(opened).length, 400 - AGENT_ACTIVITY_RETENTION_LIMIT);
});

test("the ceiling across agents trims past 2 000 + 200 of their rows, oldest first, ties in list order", () => {
  reset();
  const events: DomainEvent[] = [created()];
  const agents = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  for (const id of agents) {
    events.push(ev("thread.activity-appended", { activity: activity("task.started", agentTask(id), { id: `start-${id}` }) }));
  }
  // Round robin, every agent's row of one round stamped with the same instant:
  // the ceiling sorts by `createdAt`, and a tie must keep the list's order.
  let round = 0;
  while (events.length < 1 + agents.length + AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK + 1) {
    const stamp = new Date(Date.UTC(2026, 5, 1) + round * 1000).toISOString();
    for (const id of agents) events.push(agentRow(id, round, stamp));
    round += 1;
  }
  const states = statesOf(events);
  const trimStep = states.findIndex((state) => itemsDroppedByRetention(state).length > 0);
  assert.notEqual(trimStep, -1);
  const agentRows = (state: ThreadFoldState): number =>
    state.activities.filter((row) => row.agentId !== undefined).length;
  assert.equal(agentRows(states[trimStep - 1]!), AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK);
  assert.equal(agentRows(states[trimStep]!), AGENT_ACTIVITY_TOTAL_LIMIT, "cut to exactly the ceiling");
  // Exactly today's rules over the pre-trim window: the window before the step
  // plus the row it appended.
  const appended = (events[trimStep] as ActivityAppended).payload.activity;
  const reference = referenceTrim(
    [...states[trimStep - 1]!.items, appended],
    [...states[trimStep - 1]!.activities, appended]
  );
  assert.deepEqual(itemsDroppedByRetention(states[trimStep]!), reference.dropped);
  assert.deepEqual(states[trimStep]!.items, reference.items);
  // The dropped rows are the oldest rounds, and within the last round cut the
  // agents in list order.
  const dropped = itemsDroppedByRetention(states[trimStep]!).map((item) => item.id);
  const expected: string[] = [];
  for (let r = 0; expected.length < AGENT_ACTIVITY_TOTAL_SLACK + 1; r += 1) {
    for (const id of agents) {
      if (expected.length < AGENT_ACTIVITY_TOTAL_SLACK + 1) expected.push(`${id}-row-${r}`);
    }
  }
  assert.deepEqual([...dropped].sort(), [...expected].sort());
  assert.ok(
    states[trimStep]!.activities.every((row) => row.agentId !== undefined || row.id.startsWith("start-")),
    "the anchors all stay"
  );
});

test("messages trim past 2 000 + 200 without touching the activities, pending or roster", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.session-set", { session: session("running", "T-1") }),
    ev("thread.activity-appended", { activity: activity("task.started", agentTask("ag"), { id: "anchor" }) }),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", { requestId: "r1", requestType: "command_execution_approval" })
    })
  ];
  for (let index = 0; index < MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK; index += 1) {
    events.push(message(index));
  }
  const before = foldThread(events);
  const after = applyDomainEvent(before, message(MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK));
  assert.equal(after.items.length - after.activities.length, MESSAGE_RETENTION_LIMIT);
  assert.equal(itemsDroppedByRetention(after).length, MESSAGE_RETENTION_SLACK + 1);
  assert.ok(itemsDroppedByRetention(after).every((item) => item.kind === "message"));
  assert.equal(after.activities, before.activities, "the activity list is shared");
  assert.equal(after.pending, before.pending, "pending keeps its identity");
  assert.equal(after.roster, before.roster, "the roster keeps its identity");
  assert.deepEqual(after.evicted, { activities: false, messages: true });
});

test("a trim cuts every class at once, whichever one tripped it", () => {
  reset();
  // Messages past their LIMIT but inside their slack, parent rows past their
  // LIMIT but inside theirs: the parent trigger fires, and the one trim cuts
  // both back to their limits.
  const events: DomainEvent[] = [created()];
  for (let index = 0; index < MESSAGE_RETENTION_LIMIT + 100; index += 1) events.push(message(index));
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(parentRow(index));
  }
  const before = foldThread(events);
  assert.equal(before.evicted, undefined, "no class passed its slack yet");
  const last = parentRow(ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK);
  const after = applyDomainEvent(before, last);
  assert.equal(after.activities.length, ACTIVITY_RETENTION_LIMIT);
  assert.equal(after.items.length - after.activities.length, MESSAGE_RETENTION_LIMIT);
  assert.deepEqual(after.evicted, { activities: true, messages: true });
  // Exactly today's rules over the pre-trim window.
  const row = last.payload.activity;
  const reference = referenceTrim([...before.items, row], [...before.activities, row]);
  assert.deepEqual(itemsDroppedByRetention(after), reference.dropped);
  assert.deepEqual(after.items, reference.items);
  assert.deepEqual(after.activities, reference.activities);
});

test("more open questions than the slack keep the trigger on without dropping them — time, never correctness", () => {
  reset();
  const events: DomainEvent[] = [created()];
  // 60 open message-mode questions, then enough rows to pass the trigger.
  for (let index = 0; index < ACTIVITY_RETENTION_SLACK + 10; index += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity(
          "user-input.requested",
          {
            requestId: `q-${index}`,
            responseMode: "message",
            questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
          },
          { id: `ask-${index}` }
        )
      })
    );
  }
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT; index += 1) events.push(parentRow(index));
  const states = statesOf(events);
  const last = states.at(-1)!;
  // The questions count toward the trigger (60 + 500 > 550) but the trim keeps
  // them, and it finds nothing else old enough to drop: the arrays stay shared
  // and nothing reads as evicted.
  assert.ok(states.every((state) => itemsDroppedByRetention(state).length === 0));
  assert.equal(last.activities.length, ACTIVITY_RETENTION_SLACK + 10 + ACTIVITY_RETENTION_LIMIT);
  assert.equal(last.evicted, undefined);
  assert.equal(last.pending.userInputs.length, ACTIVITY_RETENTION_SLACK + 10);
  const next = applyDomainEvent(last, parentRow(ACTIVITY_RETENTION_LIMIT));
  assert.deepEqual(
    itemsDroppedByRetention(next).map((item) => item.id),
    ["p-0"],
    "each further row now trims the oldest droppable one, exactly as per-event retention did"
  );
  assert.equal(next.pending.userInputs.length, ACTIVITY_RETENTION_SLACK + 10);
});

test("compaction markers are exempt in the parent window only", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("context-compaction", { state: "compacted" }, { id: "parent-marker" })
    }),
    ev("thread.activity-appended", {
      activity: activity("context-compaction", { state: "compacted" }, { id: "agent-marker", agentId: "ag" })
    })
  ];
  for (let index = 0; index < 300; index += 1) events.push(parentRow(index));
  for (let index = 0; index <= AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK - 1; index += 1) {
    events.push(agentRow("ag", index));
  }
  const state = foldThread(events);
  assert.ok(state.activities.some((row) => row.id === "parent-marker"), "the parent's marker stays");
  assert.ok(
    !state.activities.some((row) => row.id === "agent-marker"),
    "an agent-owned marker is an ordinary row of its agent's window"
  );
});

// ---------------------------------------------------------------------------
// `evicted` and `itemsDroppedByRetention`
// ---------------------------------------------------------------------------

test("evicted: absent until a trim drops something, then only ever grows, and survives a rewind", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.message-sent", { messageId: "u1", role: "user", text: "go", streaming: false, turnId: null }),
    ev("thread.turn-start-requested", { turnId: null, messageId: "u1", interactionMode: "default" }),
    ev("thread.session-set", { session: session("running", "T-1") })
  ];
  // Rows of the running turn, so the rewind below has something to remove.
  const turnRow = (index: number): DomainEvent =>
    ev("thread.activity-appended", {
      activity: activity("tool.completed", { toolUseId: `p${index}` }, { id: `p-${index}`, turnId: "T-1" })
    });
  for (let index = 0; index <= ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(turnRow(index));
  }
  const states = statesOf(events);
  assert.equal(createEmptyThreadState().evicted, undefined);
  assert.ok(states.slice(0, -1).every((state) => state.evicted === undefined));
  const evicted = states.at(-1)!.evicted;
  assert.deepEqual(evicted, { activities: true, messages: false });

  // A later trim of the same kind keeps the very object; a message trim adds.
  let state = states.at(-1)!;
  for (let index = 0; index <= ACTIVITY_RETENTION_SLACK; index += 1) {
    state = applyDomainEvent(state, turnRow(1_000 + index));
  }
  assert.ok(itemsDroppedByRetention(state).length > 0, "a second trim ran");
  assert.equal(state.evicted, evicted, "nothing new: the same object");
  for (let index = 0; index <= MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK; index += 1) {
    state = applyDomainEvent(state, message(index));
  }
  assert.deepEqual(state.evicted, { activities: true, messages: true });

  // A rewind removes rows, but it is not retention: nothing reads as dropped by
  // it, and what retention evicted stays evicted.
  const rewound = applyDomainEvent(state, ev("thread.reverted", { turnCount: 0 }));
  assert.ok(rewound.activities.length < state.activities.length, "the rewind removed rows");
  assert.deepEqual(itemsDroppedByRetention(rewound), []);
  assert.deepEqual(rewound.evicted, { activities: true, messages: true });

  // It rides the snapshot; the side table does not.
  const restored = deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state))));
  assert.deepEqual(restored?.evicted, { activities: true, messages: true });
  assert.deepEqual(itemsDroppedByRetention(restored!), []);
});

test("itemsDroppedByRetention: exactly the rows the step's trim removed, in list order, and stable", () => {
  reset();
  // Every row is appended once and never updated, so each one must either be
  // in the final window or have been dropped by exactly one step — the
  // dropped rows, step by step, then the window, are the whole log in order.
  const events: DomainEvent[] = [created()];
  const appended: string[] = [];
  for (let index = 0; index < 1_400; index += 1) {
    if (index % 3 === 0) {
      events.push(message(index));
      appended.push(`message:m-${index}`);
    } else {
      events.push(parentRow(index));
      appended.push(`activity:p-${index}`);
    }
  }
  const dropped: string[] = [];
  let state = createEmptyThreadState();
  for (const event of events) {
    const next = applyDomainEvent(state, event);
    const rows = itemsDroppedByRetention(next);
    assert.equal(itemsDroppedByRetention(next), rows, "the same array every time: no recomputation");
    if (rows.length > 0) {
      // Every dropped row was in the previous window, and is gone now.
      for (const item of rows) {
        assert.ok(state.items.includes(item), "a dropped row comes from the window it left");
        assert.ok(!next.items.includes(item));
      }
    }
    dropped.push(...rows.map(keyOf));
    state = next;
  }
  assert.ok(dropped.length > 0);
  const activitiesDropped = dropped.filter((key) => key.startsWith("activity:"));
  const messagesKept = state.items.filter((item) => item.kind === "message").map(keyOf);
  // Activities leave oldest first, and so, separately, do messages.
  assert.deepEqual(
    [...activitiesDropped, ...state.activities.map(keyOf)],
    appended.filter((key) => key.startsWith("activity:"))
  );
  assert.deepEqual(
    [...dropped.filter((key) => key.startsWith("message:")), ...messagesKept],
    appended.filter((key) => key.startsWith("message:"))
  );
  assert.deepEqual(itemsDroppedByRetention(createEmptyThreadState()), []);
});
