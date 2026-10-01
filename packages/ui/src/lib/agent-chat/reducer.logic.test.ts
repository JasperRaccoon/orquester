import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
type AgentChatStreamFrame
} from "@orquester/api/agent-chat";

import {
applyFrame,
createReducerState
} from "./reducer.logic";
import { activity,ev,resetBuilders,snapshot,stamp } from "./test-helpers";

const eventFrame = (event: ReturnType<typeof ev>): AgentChatStreamFrame => ({
  kind: "event",
  seq: event.seq,
  event
});

beforeEach(() => {
  resetBuilders();
});

describe("applyFrame — snapshots", () => {

  it("re-tombstones resolved requests so a replayed request cannot reopen a card", () => {
    const resolved = activity("approval.resolved", { requestId: "r1" }, { createdAt: stamp(3) });
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: snapshot({ items: [resolved], seq: 3 })
    });
    const request = (createdAt: string, seq: number) => eventFrame(ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "r1", requestType: "command_execution_approval"
      }, { createdAt })
    }, { seq }));
    state = applyFrame(state, request(stamp(2), 4));
    assert.deepEqual(state.slice.pending.approvals, [], "an older request stays resolved after reload");
    state = applyFrame(state, request(stamp(5), 5));
    assert.deepEqual(state.slice.pending.approvals.map((request) => request.requestId), ["r1"],
      "a new request recycling the id must still be answerable");
  });

  it("adopts the snapshot's goal, validated, and reads a missing one as none (goals §4.4)", () => {
    const goal = {
      objective: "Make CI green",
      status: "active" as const,
      rounds: 1,
      lastCheck: "lint still fails",
      updatedAt: stamp(3)
    };
    const goalFrom = (thread: ReturnType<typeof snapshot>) =>
      applyFrame(createReducerState("s1"), { kind: "snapshot", thread }).slice.goal;
    assert.deepEqual(goalFrom(snapshot({ goal, seq: 3 })), goal);
    assert.equal(goalFrom(snapshot({ goal: null, seq: 3 })), null);
    // A host that predates goals sends none at all.
    assert.equal(goalFrom(snapshot({ seq: 3 })), null);
    // Verify this boundary validates once; individual schema rules live in the API tests.
    assert.equal(
      goalFrom(snapshot({ goal: { ...goal, status: "done" } as never, seq: 3 })),
      null
    );
  });
});

describe("applyFrame — history replay progress", () => {
  it("shows a replay until it is done, and drops a stale one on (re)synchronizing", () => {
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: snapshot({ seq: 1 })
    });
    state = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1" });
    assert.equal(state.slice.historyImport, null);

    state = applyFrame(state, {
      kind: "history-import",
      progress: { phase: "importing", done: 100, total: 400 }
    });
    assert.deepEqual(state.slice.historyImport, { phase: "importing", done: 100, total: 400 });

    const done = applyFrame(state, {
      kind: "history-import",
      progress: { phase: "done", done: 400, total: 400 }
    });
    assert.equal(done.slice.historyImport, null);

    // The stream dropped mid-replay and came back after it ended: the host
    // announces nothing, so the marker alone must clear the old progress.
    const reconnecting = { ...state, slice: { ...state.slice, connection: "reconnecting" as const } };
    const resynced = applyFrame(reconnecting, { kind: "synchronized", hostInstanceId: "h1" });
    assert.equal(resynced.slice.historyImport, null);
  });
});
