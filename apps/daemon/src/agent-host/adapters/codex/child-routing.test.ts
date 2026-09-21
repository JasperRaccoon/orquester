/**
 * Codex adapter — collab-child notification routing (R3 finding 2).
 *
 * No capture spawns a child, so these drive the normaliser directly with
 * synthetic child frames. The property under test is the one the spec's "Trap"
 * states: a child must never touch the parent's turn, usage baseline or thread
 * state, and an UNKNOWN child method is passed to the parent rather than
 * dropped ("two shipped bugs came from a catch-all").
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHILD_AGENT_EVENT_METHODS,
  CHILD_CHATTER_METHODS,
  notificationThreadId,
  routeCodexChildNotification
} from "./child-routing.ts";
import { CodexNormaliser } from "./normalise.ts";
import { CodexUsageTracker } from "./usage.ts";

const PARENT = "parent-thread";
const CHILD = "child-thread";

function make(): { normaliser: CodexNormaliser; usage: CodexUsageTracker } {
  const usage = new CodexUsageTracker();
  const normaliser = new CodexNormaliser({ usage, ownThreadId: () => PARENT });
  return { normaliser, usage };
}

const turn = (id: string, status: string): unknown => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 0,
  completedAt: null,
  durationMs: null
});

const usageNotification = (threadId: string, turnId: string, total: number): unknown => ({
  threadId,
  turnId,
  tokenUsage: {
    total: {
      totalTokens: total,
      inputTokens: total,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0
    },
    last: {
      totalTokens: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0
    },
    modelContextWindow: 258_400
  }
});

describe("child routing — the three routes", () => {
  it("the agent-event and chatter sets do not overlap", () => {
    for (const method of CHILD_AGENT_EVENT_METHODS) {
      assert.equal(CHILD_CHATTER_METHODS.has(method), false, method);
    }
  });

  it("routes a child's lifecycle to agent-event", () => {
    for (const method of ["turn/started", "turn/completed", "item/started", "error"]) {
      assert.equal(routeCodexChildNotification(method), "agent-event", method);
    }
  });

  it("DROPS the child thread-lifecycle methods that would rewrite the parent", () => {
    // A child compacting or archiving must not rewrite the parent's state.
    for (const method of ["thread/compacted", "thread/archived", "thread/started"]) {
      assert.equal(routeCodexChildNotification(method), "drop", method);
    }
  });

  it("passes an UNKNOWN method to the parent, never drops it", () => {
    assert.equal(routeCodexChildNotification("some/futureNotification"), "parent");
    assert.equal(routeCodexChildNotification("serverRequest/resolved"), "parent");
  });
});

describe("notificationThreadId", () => {
  it("reads thread/started's nested thread.id", () => {
    assert.equal(notificationThreadId("thread/started", { thread: { id: "t-1" } }), "t-1");
  });

  it("reads the flat threadId everywhere else", () => {
    assert.equal(notificationThreadId("turn/started", { threadId: "t-2" }), "t-2");
  });

  it("answers null for a connection-scoped notification", () => {
    // `account/rateLimits/updated` is not thread-scoped at all.
    assert.equal(notificationThreadId("account/rateLimits/updated", { rateLimits: {} }), null);
    assert.equal(notificationThreadId("turn/started", null), null);
    assert.equal(notificationThreadId("turn/started", { threadId: "" }), null);
  });
});

describe("a collab child never hijacks the parent's turn", () => {
  it("a child's turn/started does not become the parent's active turn", () => {
    const { normaliser } = make();
    normaliser.notification("turn/started" as never, {
      threadId: PARENT,
      turn: turn("parent-turn", "inProgress")
    });
    assert.equal(normaliser.currentTurnId, "parent-turn");

    const events = normaliser.notification("turn/started" as never, {
      threadId: CHILD,
      turn: turn("child-turn", "inProgress")
    });

    assert.equal(
      normaliser.currentTurnId,
      "parent-turn",
      "the child must not overwrite activeTurnId"
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["task.progress"],
      "a child's turn is a roster row, never a turn row"
    );
  });

  it("a child's turn/completed does not settle the parent's live turn", () => {
    const { normaliser } = make();
    normaliser.notification("turn/started" as never, {
      threadId: PARENT,
      turn: turn("parent-turn", "inProgress")
    });
    const events = normaliser.notification("turn/completed" as never, {
      threadId: CHILD,
      turn: turn("child-turn", "completed")
    });

    assert.equal(
      events.filter((event) => event.type === "turn.completed").length,
      0,
      "a child completing must not emit the parent's turn.completed"
    );
    assert.equal(normaliser.currentTurnId, "parent-turn");
    assert.equal(normaliser.hasSettled("parent-turn"), false);
  });

  it("a child's token usage does not reset the parent's baseline", () => {
    const { normaliser, usage } = make();
    normaliser.notification("turn/started" as never, {
      threadId: PARENT,
      turn: turn("parent-turn", "inProgress")
    });
    normaliser.notification("thread/tokenUsage/updated" as never, usageNotification(PARENT, "parent-turn", 100));
    // The child burns a lot of tokens on its own thread.
    normaliser.notification(
      "thread/tokenUsage/updated" as never,
      usageNotification(CHILD, "child-turn", 99_999)
    );
    normaliser.notification("thread/tokenUsage/updated" as never, usageNotification(PARENT, "parent-turn", 150));

    const settled = usage.completeTurn("parent-turn");
    assert.equal(settled.usageStatus, "complete");
    assert.equal(settled.inputTokens, 150, "the child's 99999 never entered the parent's ledger");
  });

  it("a child's thread/compacted does not rewrite the parent's thread state", () => {
    const { normaliser } = make();
    const events = normaliser.notification("thread/compacted" as never, { threadId: CHILD });
    assert.deepEqual(events, [], "dropped, not folded onto the parent");
  });

  it("a child's thread/started does not emit a second thread.started", () => {
    const { normaliser } = make();
    const events = normaliser.notification("thread/started" as never, {
      thread: { id: CHILD }
    });
    assert.deepEqual(events, []);
  });

  it("an unknown child method still reaches the parent and is surfaced", () => {
    const { normaliser } = make();
    const events = normaliser.notification("some/futureNotification" as never, {
      threadId: CHILD
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["runtime.warning"],
      "surfaced, never silently dropped (§10)"
    );
  });

  it("tracks the child's live turn so Stop can reach the fleet", () => {
    const { normaliser } = make();
    normaliser.notification("turn/started" as never, {
      threadId: CHILD,
      turn: turn("child-turn", "inProgress")
    });
    assert.deepEqual(normaliser.liveChildTurns(), [[CHILD, "child-turn"]]);

    normaliser.notification("turn/completed" as never, {
      threadId: CHILD,
      turn: turn("child-turn", "completed")
    });
    assert.deepEqual(normaliser.liveChildTurns(), [], "a finished child is not interruptible");
  });

  it("forgetAgents clears the fleet bookkeeping", () => {
    const { normaliser } = make();
    normaliser.notification("turn/started" as never, {
      threadId: CHILD,
      turn: turn("child-turn", "inProgress")
    });
    normaliser.forgetAgents();
    assert.deepEqual(normaliser.liveChildTurns(), []);
  });

  it("with no own thread id yet, everything is ours", () => {
    // Before `thread/start` answers, no child can exist by construction.
    const usage = new CodexUsageTracker();
    const normaliser = new CodexNormaliser({ usage });
    const events = normaliser.notification("turn/started" as never, {
      threadId: "anything",
      turn: turn("t", "inProgress")
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["turn.started"]
    );
  });
});

describe("in-progress items are closed when a turn settles (R3 finding 1)", () => {
  const startItem = (threadId: string, turnId: string, itemId: string): unknown => ({
    item: {
      type: "commandExecution",
      id: itemId,
      pluginId: null,
      scriptPath: null,
      command: "sleep 30",
      cwd: "/tmp",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null
    },
    threadId,
    turnId,
    startedAtMs: 0
  });

  it("an interrupted turn closes its dangling items as failed, before the turn row", () => {
    const { normaliser } = make();
    normaliser.notification("turn/started" as never, {
      threadId: PARENT,
      turn: turn("t1", "inProgress")
    });
    normaliser.notification("item/started" as never, startItem(PARENT, "t1", "call_1"));
    assert.deepEqual(normaliser.openItemIds(), ["call_1"]);

    const events = normaliser.notification("turn/completed" as never, {
      threadId: PARENT,
      turn: turn("t1", "interrupted")
    });

    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["item.completed", "turn.completed"], "the item closes FIRST");
    assert.equal((events[0]!.payload as { status: string }).status, "failed");
    assert.equal(events[0]!.itemId, "call_1");
    assert.deepEqual(normaliser.openItemIds(), [], "and is forgotten, so the map cannot grow");
  });

  it("a completed turn closes its dangling items as completed", () => {
    const { normaliser } = make();
    normaliser.notification("turn/started" as never, {
      threadId: PARENT,
      turn: turn("t1", "inProgress")
    });
    normaliser.notification("item/started" as never, startItem(PARENT, "t1", "call_1"));
    const events = normaliser.notification("turn/completed" as never, {
      threadId: PARENT,
      turn: turn("t1", "completed")
    });
    assert.equal((events[0]!.payload as { status: string }).status, "completed");
  });

  it("a settling turn does not reap a DIFFERENT turn's items", () => {
    const { normaliser } = make();
    normaliser.notification("item/started" as never, startItem(PARENT, "t1", "call_1"));
    normaliser.notification("item/started" as never, startItem(PARENT, "t2", "call_2"));
    normaliser.notification("turn/completed" as never, {
      threadId: PARENT,
      turn: turn("t1", "completed")
    });
    assert.deepEqual(normaliser.openItemIds(), ["call_2"]);
  });

  it("closeOpenItems with no turn closes everything (the child is gone)", () => {
    const { normaliser } = make();
    normaliser.notification("item/started" as never, startItem(PARENT, "t1", "call_1"));
    normaliser.notification("item/started" as never, startItem(PARENT, "t2", "call_2"));
    const events = normaliser.closeOpenItems("failed");
    assert.equal(events.length, 2);
    assert.deepEqual(normaliser.openItemIds(), []);
  });
});

describe("a settled turn is never re-activated (Q1 finding 3)", () => {
  it("hasSettled reports a turn turn/completed already closed", () => {
    const { normaliser } = make();
    assert.equal(normaliser.hasSettled("t1"), false);
    normaliser.notification("turn/completed" as never, {
      threadId: PARENT,
      turn: turn("t1", "completed")
    });
    assert.equal(normaliser.hasSettled("t1"), true);
    assert.equal(normaliser.hasSettled("t2"), false);
  });
});
