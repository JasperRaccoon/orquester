import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
type AgentChatStreamFrame
} from "@orquester/api/agent-chat";

import {
applyFrame,
createReducerState
} from "./reducer.logic";
import { activity,ev,foldTurn,resetBuilders,snapshot,stamp } from "./test-helpers";

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

describe("applyFrame — requests answered elsewhere", () => {
  it("a snapshot's answers mark their requests answered until the resolution lands", () => {
    const opened = activity("user-input.requested", {
      requestId: "q1",
      dismissible: false,
      questions: [{ id: "q", header: "Q", question: "Which?", options: [{ label: "a", description: "" }] }]
    }, { createdAt: stamp(1) });
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: snapshot({
        items: [opened],
        pending: { approvals: [], userInputs: [{ requestId: "q1", createdAt: stamp(1), dismissible: false, questions: [] }] },
        answeredQuestions: [["q1", stamp(2)], ["junk"] as never],
        seq: 2
      })
    });
    assert.deepEqual(state.slice.answeredRequestIds, ["q1"]);
    // Another tab answers nothing new: the same list, by identity.
    const before = state.slice.answeredRequestIds;
    state = applyFrame(state, eventFrame(ev("thread.meta-updated", { title: "Renamed" }, { seq: 3 })));
    assert.equal(state.slice.answeredRequestIds, before);
    state = applyFrame(state, eventFrame(ev("thread.activity-appended", {
      activity: activity("user-input.resolved", { requestId: "q1", answers: { q: "a" } }, { createdAt: stamp(4) })
    }, { seq: 4 })));
    assert.deepEqual(state.slice.answeredRequestIds, []);
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

describe("applyFrame — on-demand agent rows", () => {
  it("a snapshot's omitted agents are read field-wise, and a later snapshot without them clears them", () => {
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 3 }), omittedAgentIds: ["b", "a", "b", "", 7] as unknown as string[] }
    });
    assert.deepEqual(state.slice.omittedAgentIds, ["a", "b"]);
    state = applyFrame(state, { kind: "snapshot", thread: snapshot({ seq: 4 }) });
    assert.equal(state.slice.omittedAgentIds, undefined);
    assert.equal("omittedAgentIds" in state.slice, false);
  });

  it("a frame loads its agents, and the last of them leaves nothing omitted", () => {
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 3 }), omittedAgentIds: ["a", "b"] }
    });
    const row = activity("tool.started", { toolUseId: "c1" }, { id: "a-row", agentId: "a" });
    state = applyFrame(state, { kind: "agent-rows", seq: 3, agentIds: ["a"], items: [row], after: [null] });
    assert.deepEqual(state.slice.omittedAgentIds, ["b"]);
    assert.deepEqual(state.slice.entries.map((item) => item.id), ["a-row"]);
    assert.equal(state.slice.entries, state.fold.items);
    state = applyFrame(state, { kind: "agent-rows", seq: 3, agentIds: ["b"], items: [], after: [] });
    assert.equal(state.slice.omittedAgentIds, undefined);
  });

  it("the stream's id comes with every synchronized marker, the live one's included", () => {
    let state = applyFrame(createReducerState("s1"), { kind: "snapshot", thread: snapshot({ seq: 3 }) });
    state = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1", streamId: "s-1" });
    assert.equal(state.streamId, "s-1");
    state = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1", streamId: "s-2" });
    assert.equal(state.streamId, "s-2", "a resumed connection names its own");
    const same = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1", streamId: "s-2" });
    assert.equal(same, state);
    state = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1" });
    assert.equal(state.streamId, null, "a host that names none");
  });
});

describe("applyFrame — on-demand agent rows across a new snapshot, and truncated frames", () => {
  const owned = (id: string, at: number) => activity("tool.completed", { toolUseId: id }, { id, agentId: "a", createdAt: stamp(at) });
  const launch = activity("task.started", { taskId: "a", agentKind: "agent" }, { id: "a-launch", createdAt: stamp(1) });
  const turn = (turnId: string) => ({ ...foldTurn(turnId), turnId });

  /** A client that loaded agent `a`'s rows at seq 5. */
  function loadedAt5() {
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 5, items: [launch], turns: [turn("t1")] }), omittedAgentIds: ["a"] }
    });
    state = applyFrame(state, { kind: "agent-rows", seq: 5, agentIds: ["a"], items: [owned("a1", 2), owned("a2", 3)], after: ["a-launch", "a-launch"] });
    assert.equal(state.slice.omittedAgentIds, undefined);
    return state;
  }

  it("a reconnect's snapshot that leaves a loaded agent out keeps its rows until the frame replaces them", () => {
    let state = applyFrame(loadedAt5(), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 9, items: [launch], turns: [turn("t1"), turn("t2")] }), omittedAgentIds: ["a"] }
    });
    assert.deepEqual(state.slice.omittedAgentIds, ["a"], "still asked for");
    assert.deepEqual(state.slice.revalidatingAgentIds, ["a"], "but not loading: its rows are shown meanwhile");
    assert.deepEqual(state.slice.entries.map((item) => item.id), ["a-launch", "a1", "a2"]);
    state = applyFrame(state, { kind: "agent-rows", seq: 9, agentIds: ["a"], items: [owned("a2", 3)], after: ["a-launch"] });
    assert.equal(state.slice.revalidatingAgentIds, undefined);
    assert.equal(state.slice.omittedAgentIds, undefined);
    assert.deepEqual(state.slice.entries.map((item) => item.id), ["a-launch", "a2"], "the host's rows replace them");
  });

  it("carries nothing over a snapshot that rewound a turn or went back, nor for an agent never loaded", () => {
    const rewound = applyFrame(loadedAt5(), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 9, items: [launch], turns: [turn("t9")] }), omittedAgentIds: ["a"] }
    });
    assert.equal(rewound.slice.revalidatingAgentIds, undefined);
    assert.deepEqual(rewound.slice.entries.map((item) => item.id), ["a-launch"]);
    const older = applyFrame(loadedAt5(), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 4, items: [launch], turns: [turn("t1")] }), omittedAgentIds: ["a"] }
    });
    assert.equal(older.slice.revalidatingAgentIds, undefined);
    const neverLoaded = applyFrame(
      applyFrame(createReducerState("s1"), {
        kind: "snapshot",
        thread: { ...snapshot({ seq: 5, items: [launch], turns: [turn("t1")] }), omittedAgentIds: ["a"] }
      }),
      { kind: "snapshot", thread: { ...snapshot({ seq: 9, items: [launch], turns: [turn("t1")] }), omittedAgentIds: ["a"] } }
    );
    assert.equal(neverLoaded.slice.revalidatingAgentIds, undefined);
  });

  it("a truncated frame marks its agent, a whole one clears the mark", () => {
    let state = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: { ...snapshot({ seq: 5, items: [launch] }), omittedAgentIds: ["a"] }
    });
    state = applyFrame(state, { kind: "agent-rows", seq: 5, agentIds: ["a"], items: [owned("a2", 3)], after: [null], truncated: true });
    assert.deepEqual(state.slice.truncatedAgentIds, ["a"]);
    state = applyFrame(state, { kind: "agent-rows", seq: 5, agentIds: ["a"], items: [owned("a1", 2), owned("a2", 3)], after: [null, null] });
    assert.equal(state.slice.truncatedAgentIds, undefined);
  });
});
