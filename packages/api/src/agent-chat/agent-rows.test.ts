/** On-demand agent rows: what a snapshot leaves out, the frame that brings it back, and its replacement. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRowsFrameOf,
  applyAgentRows,
  isOnDemandAgent,
  omitOnDemandAgentRows,
  onDemandRowOwner,
  agentCallOwnersOf
} from "./agent-rows.ts";
import type { DomainEvent } from "./domain-events.ts";
import { applyDomainEvent, foldThread, toThreadSnapshot, type ThreadFoldState } from "./fold.ts";
import type { ThreadActivityItem, ThreadItem, ThreadSnapshotPayload } from "./thread.ts";
import { activity, agentTask, created, ev, resetActivityIds, resetSeq, session } from "./test-helpers.ts";

function reset(): void {
  resetSeq();
  resetActivityIds();
}

/** One activity's event, the row stamped when its event was (as ingestion stamps it: arrival order). */
function row(item: ThreadActivityItem): DomainEvent {
  const event = ev("thread.activity-appended", { activity: item });
  event.payload.activity = { ...item, createdAt: event.occurredAt, updatedAt: event.occurredAt };
  return event;
}

function words(messageId: string, text: string, agentId?: string, streaming = false): DomainEvent {
  return ev("thread.message-sent", {
    messageId,
    role: "assistant",
    text,
    streaming,
    turnId: "t1",
    ...(agentId !== undefined ? { agentId } : {})
  });
}

/** One agent's own call: start, output, completion — owned by `agentId`. */
function call(agentId: string, callId: string): DomainEvent[] {
  return [
    row(activity("tool.started", { toolUseId: callId, title: "Bash" }, { id: `${callId}-start`, agentId, turnId: "t1" })),
    row(activity("tool.output", { toolUseId: callId, delta: "out" }, { id: `${callId}-out`, agentId, turnId: "t1" })),
    row(activity("tool.completed", { toolUseId: callId, title: "Bash" }, { id: `${callId}-done`, agentId, turnId: "t1" }))
  ];
}

/**
 * A fleet: a settled agent `done` (calls, words, a nested agent's launch it
 * owns, an older log's unstamped chunk), a running agent `live`, a background
 * shell `sh`, an interrupted agent `cut` with a call a pending approval names,
 * and the parent's own rows between them all.
 */
function fleet(): DomainEvent[] {
  return [
    created(),
    ev("thread.session-set", { session: session("running", "t1") }),
    words("p1", "Starting the fleet"),
    row(activity("task.started", agentTask("done", { title: "Done", prompt: "do it", toolUseId: "launch-done" }), { id: "done-launch", turnId: "t1" })),
    row(activity("task.started", agentTask("live", { title: "Live" }), { id: "live-launch", turnId: "t1" })),
    row(activity("task.started", { taskId: "sh", agentKind: "background", title: "npm test" }, { id: "sh-launch", turnId: "t1" })),
    row(activity("task.started", agentTask("cut", { title: "Cut" }), { id: "cut-launch", turnId: "t1" })),
    ...call("done", "d1"),
    words("dw1", "Looking at the code", "done"),
    row(activity("tool.output", { toolUseId: "sh-1", delta: "PASS" }, { id: "sh-out", agentId: "sh", turnId: "t1" })),
    ...call("live", "l1"),
    row(activity("task.progress", agentTask("done", { summary: "reading", lastToolName: "Read" }), { id: "done-progress", agentId: "done", turnId: "t1" })),
    row(activity("tool.progress", { toolUseId: "d2", taskId: "done", toolName: "Read" }, { id: "d2-progress", agentId: "done", turnId: "t1" })),
    ...call("done", "d2"),
    // An older host's chunk of `done`'s call with no owner of its own.
    row(activity("tool.output", { toolUseId: "d2", delta: "late" }, { id: "d2-unstamped", turnId: "t1" })),
    row(activity("task.started", agentTask("nested", { title: "Nested", parentAgentId: "done" }), { id: "nested-launch", agentId: "done", turnId: "t1" })),
    row(activity("tool.started", { toolUseId: "c1", title: "Edit" }, { id: "c1-start", agentId: "cut", turnId: "t1" })),
    row(activity("approval.requested", { requestId: "r1", requestType: "file_change_approval", toolUseId: "c1" }, { id: "r1-req", agentId: "cut", turnId: "t1" })),
    ...call("cut", "c2"),
    words("p2", "Waiting on the agents"),
    words("dw2", "All done", "done"),
    row(activity("task.completed", agentTask("done", { status: "completed", summary: "done" }), { id: "done-end", turnId: "t1" })),
    row(activity("task.completed", agentTask("nested", { status: "completed" }), { id: "nested-end", agentId: "done", turnId: "t1" })),
    row(activity("task.completed", agentTask("cut", { status: "stopped" }), { id: "cut-end", turnId: "t1" })),
    words("lw1", "Still working", "live", true)
  ];
}

const ids = (items: readonly ThreadItem[]): string[] => items.map((item) => item.id);

function fullSnapshot(events: readonly DomainEvent[]): { fold: ThreadFoldState; snapshot: ThreadSnapshotPayload } {
  const fold = foldThread(events);
  return { fold, snapshot: toThreadSnapshot(fold) };
}

/** The client fold a snapshot frame rebuilds (the reducer's own inverse, enough for these tests). */
function clientFold(snapshot: ThreadSnapshotPayload, events: readonly DomainEvent[]): ThreadFoldState {
  const base = foldThread(events);
  return {
    ...base,
    items: snapshot.items,
    activities: snapshot.items.filter((item): item is ThreadActivityItem => item.kind === "activity")
  };
}

test("only a settled agent's own calls, words and their unstamped chunks are left out, and the agents are listed", () => {
  reset();
  const events = fleet();
  const { snapshot } = fullSnapshot(events);
  const status = Object.fromEntries(snapshot.roster.map((entry) => [entry.id, entry.status]));
  assert.equal(status.done, "completed");
  assert.equal(status.live, "running");
  assert.equal(status.cut, "interrupted");
  const omitted = omitOnDemandAgentRows(snapshot);
  assert.deepEqual(omitted.omittedAgentIds, ["cut", "done"]);
  const left = new Set(ids(snapshot.items).filter((id) => !ids(omitted.items).includes(id)));
  assert.deepEqual(
    [...left].sort(),
    ["c2-done", "c2-out", "c2-start", "d1-done", "d1-out", "d1-start", "d2-done", "d2-out", "d2-start", "d2-unstamped", "dw1", "dw2"].sort()
  );
  // Kept: every launch and ending, the roster's progress rows, the request,
  // the call the pending approval names, the live agent's and the shell's rows.
  for (const id of ["done-launch", "done-end", "done-progress", "d2-progress", "nested-launch", "nested-end", "r1-req", "c1-start", "l1-start", "lw1", "sh-out", "cut-end"]) {
    assert.ok(ids(omitted.items).includes(id), id);
  }
  // Nothing else of the snapshot moved.
  assert.equal(omitted.roster, snapshot.roster);
  assert.equal(omitted.pending, snapshot.pending);
  assert.equal(omitted.seq, snapshot.seq);
});

test("a snapshot with no settled agent is the same object, without the field", () => {
  reset();
  const events = [
    created(),
    ev("thread.session-set", { session: session("running", "t1") }),
    row(activity("task.started", agentTask("a"), { id: "a-launch" })),
    ...call("a", "a1")
  ];
  const { snapshot } = fullSnapshot(events);
  const same = omitOnDemandAgentRows(snapshot);
  assert.equal(same, snapshot);
  assert.equal("omittedAgentIds" in same, false);
});

test("a loop, a goal and a background shell are never on demand; idle and failed agents are", () => {
  const base = { agentKind: "agent" as const, kind: "subagent" as const };
  assert.equal(isOnDemandAgent({ ...base, status: "idle" }), true);
  assert.equal(isOnDemandAgent({ ...base, status: "failed" }), true);
  assert.equal(isOnDemandAgent({ ...base, status: "waiting" }), false);
  assert.equal(isOnDemandAgent({ ...base, status: "pending" }), false);
  assert.equal(isOnDemandAgent({ agentKind: "background", kind: "subagent", status: "completed" }), false);
  assert.equal(isOnDemandAgent({ agentKind: "agent", kind: "loop", status: "completed" }), false);
  assert.equal(isOnDemandAgent({ agentKind: "agent", kind: "goal", status: "completed" }), false);
});

test("an unstamped chunk is an agent's only while its call's owned rows are in the same list", () => {
  reset();
  const chunk = activity("tool.output", { toolUseId: "x" }, { id: "chunk" });
  const owned = activity("tool.started", { toolUseId: "x" }, { id: "start", agentId: "a" });
  assert.equal(onDemandRowOwner(chunk, agentCallOwnersOf([owned, chunk])), "a");
  assert.equal(onDemandRowOwner(chunk, agentCallOwnersOf([chunk])), null);
  // Stamped only in its payload: no drill-in shows it, nothing leaves it out.
  const payloadOnly = activity("tool.output", { toolUseId: "x", agentId: "a" }, { id: "payload-only" });
  assert.equal(onDemandRowOwner(payloadOnly, agentCallOwnersOf([owned, payloadOnly])), null);
});

test("loading every omitted agent, one frame at a time, gives back the full window in the host's order", () => {
  reset();
  const events = fleet();
  const { fold, snapshot } = fullSnapshot(events);
  const omitted = omitOnDemandAgentRows(snapshot);
  let client = clientFold(omitted, events);
  for (const agentId of omitted.omittedAgentIds ?? []) {
    const frame = agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: [agentId] });
    assert.equal(frame.kind, "agent-rows");
    assert.equal(frame.seq, fold.seq);
    assert.deepEqual(frame.agentIds, [agentId]);
    assert.equal(frame.after.length, frame.items.length);
    client = applyAgentRows(client, frame);
  }
  assert.deepEqual(ids(client.items), ids(snapshot.items));
  assert.deepEqual(client.items, snapshot.items);
  assert.deepEqual(ids(client.activities), ids(fold.activities));
});

test("a frame places each row after the nearest row every client holds", () => {
  reset();
  const events = fleet();
  const { fold, snapshot } = fullSnapshot(events);
  const frame = agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: ["done"] });
  const placement = Object.fromEntries(frame.items.map((item, index) => [item.id, frame.after[index]]));
  // After the launches (kept), never after another omittable agent's row.
  assert.equal(placement["d1-start"], "cut-launch");
  assert.equal(placement["d1-out"], "cut-launch");
  assert.equal(placement["dw1"], "cut-launch");
  // The shell's row is held by every client: a placement.
  assert.equal(placement["d2-start"], "d2-progress");
  assert.equal(placement["d2-unstamped"], "d2-progress");
  // So is a parent's message; the live agent's rows are never one (an omittable agent's).
  assert.equal(placement["dw2"], "p2");
  assert.ok(!Object.values(placement).some((anchor) => anchor !== null && /^l1-/.test(anchor)));
});

test("the replacement drops the rows the host no longer holds and takes a streamed message whole", () => {
  reset();
  const events = [
    created(),
    ev("thread.session-set", { session: session("running", "t1") }),
    row(activity("task.started", agentTask("a"), { id: "a-launch" })),
    ...call("a", "a1"),
    words("aw", "Hel", "a", true)
  ];
  const { fold, snapshot } = fullSnapshot(events);
  // The client applied a delta of a message it did not hold: a partial message at the end.
  const partial = applyDomainEvent(
    clientFold({ ...snapshot, items: snapshot.items.filter((item) => item.agentId !== "a") }, events),
    words("aw", "lo", "a", true)
  );
  const hostAfter = applyDomainEvent(fold, words("aw", "lo", "a", true, ));
  assert.equal(partial.items.find((item) => item.id === "aw")?.kind, "message");
  const frame = agentRowsFrameOf({
    items: hostAfter.items,
    roster: hostAfter.roster,
    seq: hostAfter.seq,
    agentIds: ["a"]
  });
  const loaded = applyAgentRows(partial, frame);
  const message = loaded.items.find((item) => item.id === "aw");
  assert.equal(message?.kind === "message" ? message.text : null, "Hello");
  assert.equal(loaded.items.filter((item) => item.id === "aw").length, 1, "one message, never two");
  assert.deepEqual(ids(loaded.items), ids(hostAfter.items));
  // A frame smaller than what the client holds: the rows it no longer names go.
  const smaller = applyAgentRows(loaded, { agentIds: ["a"], items: frame.items.slice(-1), after: frame.after.slice(-1) });
  assert.deepEqual(
    ids(smaller.items).filter((id) => id.startsWith("a1")),
    [],
    "the host evicted them"
  );
  assert.ok(ids(smaller.items).includes("a-launch"), "a kept row is never touched");
});

test("a placement the client does not hold falls back to the agent's launch", () => {
  reset();
  const events = fleet();
  const { fold, snapshot } = fullSnapshot(events);
  const omitted = omitOnDemandAgentRows(snapshot);
  // This client's own retention dropped the rows `done`'s first rows are placed after.
  const trimmed = clientFold({ ...omitted, items: omitted.items.filter((item) => item.id !== "cut-launch") }, events);
  const frame = agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: ["done"] });
  const loaded = applyAgentRows(trimmed, frame);
  const order = ids(loaded.items);
  assert.ok(order.indexOf("done-launch") < order.indexOf("d1-start"), "after its launch");
  assert.ok(order.indexOf("d1-start") < order.indexOf("d1-out"), "in the host's order");
  assert.ok(order.indexOf("d1-out") < order.indexOf("dw1"));
  assert.deepEqual(
    order.filter((id) => frame.items.some((item) => item.id === id)),
    ids(frame.items),
    "the agent's own rows keep the host's order"
  );
});

test("an empty frame of an agent with nothing on demand changes nothing", () => {
  reset();
  const events = fleet();
  const { fold, snapshot } = fullSnapshot(events);
  const client = clientFold(snapshot, events);
  const frame = agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: ["nobody"] });
  assert.deepEqual(frame.items, []);
  assert.equal(applyAgentRows(client, frame), client);
});

test("the fold keeps folding and trimming after a replacement", () => {
  reset();
  const events = fleet();
  const { fold, snapshot } = fullSnapshot(events);
  const omitted = omitOnDemandAgentRows(snapshot);
  let client = applyAgentRows(
    clientFold(omitted, events),
    agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: ["cut", "done"] })
  );
  let host = fold;
  // 500 parent rows past the window's gate, then 260 more rows of `done`: past
  // its own window (200 + 50 slack), on both sides.
  for (let index = 0; index < 500; index += 1) {
    const event = row(activity("tool.completed", { toolUseId: `p${index}` }, { id: `p-${index}` }));
    client = applyDomainEvent(client, event);
    host = applyDomainEvent(host, event);
  }
  for (let index = 0; index < 260; index += 1) {
    const event = row(activity("tool.output", { toolUseId: "d9", delta: `${index}` }, { id: `d9-${index}`, agentId: "done" }));
    client = applyDomainEvent(client, event);
    host = applyDomainEvent(host, event);
  }
  const owned = (state: ThreadFoldState): string[] => ids(state.activities.filter((item) => item.agentId === "done"));
  assert.deepEqual(ids(client.items), ids(host.items));
  assert.ok(owned(client).length <= 200 + 50);
  assert.ok(host.evicted?.activities === true && client.evicted?.activities === true, "both trimmed");
  assert.deepEqual(client.roster, host.roster);
  assert.deepEqual(client.pending, host.pending);
});

test("with the parent's rows left to load older, each of a relaunched agent's runs lands after its own launch", () => {
  reset();
  const events = [
    created(),
    ev("thread.session-set", { session: session("running", "t1") }),
    row(activity("task.started", agentTask("a", { toolUseId: "first" }), { id: "launch-1", turnId: "t1" })),
    words("p1", "parent one"),
    ...call("a", "a1"),
    row(activity("task.completed", agentTask("a", { status: "completed" }), { id: "end-1", turnId: "t1" })),
    words("p2", "parent two"),
    row(activity("task.started", agentTask("a", { toolUseId: "second" }), { id: "launch-2", turnId: "t2" })),
    words("p3", "parent three"),
    ...call("a", "a2"),
    row(activity("task.completed", agentTask("a", { status: "completed" }), { id: "end-2", turnId: "t2" }))
  ];
  const { fold, snapshot } = fullSnapshot(events);
  const omitted = omitOnDemandAgentRows(snapshot);
  // A bounded snapshot kept none of the parent's words the frame is placed after.
  const bounded = { ...omitted, items: omitted.items.filter((item) => item.kind !== "message") };
  const loaded = applyAgentRows(
    clientFold(bounded, events),
    agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: ["a"] })
  );
  assert.deepEqual(ids(loaded.items), [
    "launch-1", "a1-start", "a1-out", "a1-done", "end-1",
    "launch-2", "a2-start", "a2-out", "a2-done", "end-2"
  ]);
});

test("a frame past its byte cap keeps the newest rows that fit, counted in UTF-8, and says it is truncated", () => {
  reset();
  const events = [
    created(),
    ev("thread.session-set", { session: session("running", "t1") }),
    row(activity("task.started", agentTask("a"), { id: "a-launch", turnId: "t1" })),
    ...[0, 1, 2, 3].map((n) => row(activity("tool.output", { toolUseId: `c${n}`, delta: "€".repeat(1_000) }, { id: `a-${n}`, agentId: "a", turnId: "t1" })))
  ];
  const { fold, snapshot } = fullSnapshot(events);
  const frameOf = (maxBytes?: number) =>
    agentRowsFrameOf({ items: snapshot.items, roster: fold.roster, seq: fold.seq, agentIds: ["a"], ...(maxBytes !== undefined ? { maxBytes } : {}) });
  const whole = frameOf();
  const bytes = new TextEncoder().encode(JSON.stringify(whole)).length;
  assert.equal(whole.truncated, undefined);
  assert.deepEqual(frameOf(bytes), whole, "exactly at the cap: the same frame");
  assert.equal(frameOf(bytes).truncated, undefined, "exactly at the cap: whole");
  // "€" is three bytes: 7 000 bytes hold two of the four rows, not seven.
  const cut = frameOf(7_000);
  assert.equal(cut.truncated, true);
  assert.deepEqual(ids(cut.items), ["a-2", "a-3"]);
  assert.equal(cut.after.length, cut.items.length);
  assert.ok(new TextEncoder().encode(JSON.stringify(cut)).length <= 7_000);
  assert.deepEqual(frameOf(10).items, [], "nothing fits: no row, still truncated");
  assert.equal(frameOf(10).truncated, true);
});
