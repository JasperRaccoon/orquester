import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  itemPositionOf,
  itemsDroppedByRetention,
  type AgentChatStreamFrame
} from "@orquester/api/agent-chat";

import {
  applyFrame,
  applyFrames,
  createReducerState,
  foldStateFromSnapshot,
  needsResync,
  patchSlice,
  type AgentChatReducerState
} from "./reducer.logic";
import { activity, ev, head, historyPage, message, resetBuilders, snapshot, stamp } from "./test-helpers";

const eventFrame = (event: ReturnType<typeof ev>): AgentChatStreamFrame => ({
  kind: "event",
  seq: event.seq,
  event
});

beforeEach(() => {
  resetBuilders();
});

describe("applyFrame — events", () => {
  it("folds a created thread and its messages in wire order", () => {
    let state = createReducerState("s1");
    state = applyFrames(state, [
      eventFrame(
        ev("thread.created", {
          projectPath: "/w/p",
          cwd: "/w/p",
          title: "New thread",
          adapter: "claude",
          refId: "claude",
          accountId: "acc-1",
          home: "account",
          modelSelection: { model: "sonnet" },
          runtimeMode: "approval-required"
        })
      ),
      eventFrame(
        ev("thread.message-sent", {
          messageId: "m1",
          role: "user",
          text: "hello",
          streaming: false,
          turnId: null
        })
      )
    ]);
    assert.equal(state.slice.head?.title, "New thread");
    assert.equal(state.slice.entries.length, 1);
    assert.equal(state.slice.seq, 2);
  });

  it("drops an event at or below the cursor — the overlapping windows of §6.6", () => {
    let state = createReducerState("s1");
    const created = ev("thread.created", {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "t",
      adapter: "claude",
      refId: "claude",
      accountId: "a",
      home: "account",
      modelSelection: { model: "m" },
      runtimeMode: "approval-required"
    });
    state = applyFrame(state, eventFrame(created));
    const before = state;
    // The same frame arriving again — a replay window overlapping the live one.
    state = applyFrame(state, eventFrame(created));
    assert.equal(state, before, "a replayed event must be dropped by identity");
  });

  it("returns the same state object when the fold does not move", () => {
    let state = createReducerState("s1");
    state = applyFrame(
      state,
      eventFrame(ev("thread.meta-updated", { title: "x" }, { seq: 1 }))
    );
    const before = state;
    // A second meta-update to the same title changes nothing in the fold.
    const after = applyFrame(
      before,
      eventFrame(ev("thread.meta-updated", { title: "x" }, { seq: 2 }))
    );
    assert.equal(after.slice.entries, before.slice.entries);
  });
});

describe("applyFrame — snapshots", () => {
  it("replaces loaded history rather than merging into it", () => {
    let state = createReducerState("s1");
    state = applyFrame(state, {
      kind: "snapshot",
      thread: snapshot({ items: [message("user", "one"), message("assistant", "two")], seq: 5 })
    });
    assert.equal(state.slice.entries.length, 2);
    assert.equal(state.historyEpoch, 1);

    // A revert truncated the thread; the next snapshot has fewer rows and the
    // reverted turn has no event left to remove it.
    state = applyFrame(state, {
      kind: "snapshot",
      thread: snapshot({ items: [message("user", "one")], seq: 9 })
    });
    assert.equal(state.slice.entries.length, 1, "a snapshot replaces, never merges");
    assert.equal(state.slice.seq, 9);
    assert.equal(state.historyEpoch, 2);
  });

  it("re-tombstones resolved requests so a replayed request cannot reopen a card", () => {
    const resolved = activity("approval.resolved", { requestId: "r1" });
    const fold = foldStateFromSnapshot(snapshot({ items: [resolved], seq: 3 }));
    assert.ok(fold.closedRequestIds.has("r1"));
    assert.equal(fold.activities.length, 1);
    assert.equal(itemPositionOf(fold, resolved.id), 0);
  });

  it("a snapshot's seq is the floor a resume continues from", () => {
    let state = createReducerState("s1");
    state = applyFrame(state, { kind: "snapshot", thread: snapshot({ seq: 42 }) });
    assert.equal(state.slice.seq, 42);
    // Everything at or below the floor is dropped, so a resume cannot skip.
    const before = state;
    state = applyFrame(state, eventFrame(ev("thread.reverted", { turnCount: 1 }, { seq: 42 })));
    assert.equal(state, before);
  });
});

describe("applyFrame — synchronized", () => {
  it("marks the stream live and records the host instance", () => {
    let state = createReducerState("s1");
    state = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1" });
    assert.equal(state.slice.connection, "synchronized");
    assert.equal(state.hostInstanceId, "h1");
  });

  it("a changed host instance id is a resync, not a resume", () => {
    let state = createReducerState("s1");
    state = applyFrame(state, { kind: "synchronized", hostInstanceId: "h1" });
    const frame: AgentChatStreamFrame = { kind: "synchronized", hostInstanceId: "h2" };
    assert.equal(needsResync(state.hostInstanceId, frame), true);
    state = applyFrame(state, frame);
    assert.equal(state.slice.connection, "connecting", "the client must re-read, not resume");
    assert.equal(state.hostInstanceId, "h2");
  });

  it("the first synchronized frame is never a resync", () => {
    const state = createReducerState("s1");
    assert.equal(
      needsResync(state.hostInstanceId, { kind: "synchronized", hostInstanceId: "h1" }),
      false
    );
  });
});

describe("reconnect mid-stream", () => {
  it("loses nothing and duplicates nothing across a replay overlap", () => {
    const events = [1, 2, 3, 4, 5].map((seq) =>
      ev(
        "thread.message-sent",
        { messageId: `m${seq}`, role: "user", text: `t${seq}`, streaming: false, turnId: null },
        { seq }
      )
    );
    // The client applied 1..3, dropped, and the host replayed from its cursor
    // — which legitimately overlaps, because the cursor is inclusive-safe.
    let state = createReducerState("s1");
    state = applyFrame(
      state,
      eventFrame(
        ev("thread.created", {
          projectPath: "/w/p",
          cwd: "/w/p",
          title: "t",
          adapter: "claude",
          refId: "claude",
          accountId: "a",
          home: "account",
          modelSelection: { model: "m" },
          runtimeMode: "approval-required"
        }, { seq: 0 })
      )
    );
    state = applyFrames(state, events.slice(0, 3).map(eventFrame));
    assert.equal(state.slice.seq, 3);

    state = applyFrames(state, events.slice(1).map(eventFrame));
    assert.equal(state.slice.seq, 5);
    const ids = state.slice.entries.map((item) => item.id);
    assert.deepEqual(ids, ["m1", "m2", "m3", "m4", "m5"], "no loss and no duplicate");
  });
});

describe("applyFrame — the history bridge", () => {
  /** A window as full as the fold holds it untrimmed: the next row makes it drop some. */
  const fullWindow = (): AgentChatReducerState =>
    applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: snapshot({
        items: Array.from({ length: ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK }, (_, index) =>
          activity("tool.completed", { toolUseId: `c${index}` }, { id: `w${index}`, createdAt: stamp(index) })
        ),
        seq: 1_000
      })
    });

  /** Append rows until one step trims — however many rows it takes — and hand back what it dropped. */
  function untilTrim(state: AgentChatReducerState, visit: (next: AgentChatReducerState) => void) {
    const first = state.fold.seq + 1;
    for (let seq = first; seq < first + 2 * ACTIVITY_RETENTION_LIMIT; seq += 1) {
      state = applyFrame(
        state,
        eventFrame(
          ev("thread.activity-appended", {
            activity: activity("tool.completed", { toolUseId: `n${seq}` }, { id: `n${seq}`, createdAt: stamp(seq) })
          }, { seq })
        )
      );
      visit(state);
      const dropped = itemsDroppedByRetention(state.fold);
      if (dropped.length > 0) {
        return { state, dropped };
      }
    }
    throw new Error("the fold never trimmed");
  }

  it("never touches the history while nothing is loaded — the fast path is what it was", () => {
    const start = fullWindow();
    const history = start.slice.history;
    const { state } = untilTrim(start, (next) => assert.equal(next.slice.history, history));
    assert.equal(state.slice.history, history);
    assert.deepEqual(state.slice.history.bridge, []);
  });

  it("puts what a step dropped onto the bridge while a page is loaded", () => {
    const base = fullWindow();
    const start = patchSlice(base, { history: { ...base.slice.history, pages: [historyPage()] } });
    const { state, dropped } = untilTrim(start, () => {});
    assert.deepEqual(
      state.slice.history.bridge.map((item) => item.id),
      dropped.map((item) => item.id)
    );
  });
});

describe("patchSlice", () => {
  it("keeps identity when nothing moved", () => {
    const state = createReducerState("s1");
    assert.equal(patchSlice(state, { follow: true }), state);
    assert.notEqual(patchSlice(state, { follow: false }), state);
  });
});

describe("head-derived slice fields", () => {
  it("mirrors the session status", () => {
    let state = createReducerState("s1");
    state = applyFrame(state, {
      kind: "snapshot",
      thread: snapshot({
        head: head({ session: { status: "running", activeTurnId: "t1" } }),
        seq: 1
      })
    });
    assert.equal(state.slice.sessionStatus, "running");
  });
});
