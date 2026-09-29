import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
type AgentChatStreamFrame
} from "@orquester/api/agent-chat";

import {
applyFrame,
createReducerState,
foldStateFromSnapshot
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
    assert.deepEqual(foldStateFromSnapshot(snapshot({ goal, seq: 3 })).goal, goal);
    assert.equal(foldStateFromSnapshot(snapshot({ goal: null, seq: 3 })).goal, null);
    // A host that predates goals sends none at all.
    assert.equal(foldStateFromSnapshot(snapshot({ seq: 3 })).goal, null);
    // Verify this boundary validates once; individual schema rules live in the API tests.
    assert.equal(
      foldStateFromSnapshot(snapshot({ goal: { ...goal, status: "done" } as never, seq: 3 })).goal,
      null
    );
  });
});
