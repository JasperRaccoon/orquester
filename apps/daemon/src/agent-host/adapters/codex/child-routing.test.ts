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
    // A child this session never saw launched (a resume after a host restart)
    // starts on its own turn, so the roster can reopen it
    // (`collab-relaunch.test.ts`).
    assert.deepEqual(
      events.map((event) => event.type),
      ["task.started", "task.progress"],
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

  it("a child's own goal never becomes the parent's (goals §6.2)", () => {
    // Collab children get the goal tools too (only review subagents do not),
    // and a tool-set goal is announced on the CHILD's thread id.
    const { normaliser } = make();
    const goal = {
      threadId: CHILD,
      objective: "the child's own objective",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1_789_950_000,
      updatedAt: 1_789_950_000
    };
    assert.deepEqual(
      normaliser.notification("thread/goal/updated" as never, {
        threadId: CHILD,
        turnId: "child-turn",
        goal
      }),
      []
    );
    assert.deepEqual(normaliser.notification("thread/goal/cleared" as never, { threadId: CHILD }), []);
    // …and the parent's goal is still unset: its first update is `set`.
    const [own] = normaliser.notification("thread/goal/updated" as never, {
      threadId: PARENT,
      turnId: null,
      goal: { ...goal, threadId: PARENT, objective: "the parent's objective" }
    });
    assert.equal((own?.payload as { change?: string } | undefined)?.change, "set");
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
    const second = normaliser.notification("turn/completed" as never, {
      threadId: PARENT,
      turn: turn("t2", "completed")
    });
    assert.deepEqual(second.filter((event) => event.type === "item.completed").map((event) => event.itemId), ["call_2"]);
  });
});

describe("an abandoned agentMessage is closed by the next item of its turn (fixtures README obs. 22)", () => {
  const startMessage = (threadId: string, turnId: string, itemId: string): unknown => ({
    item: {
      type: "agentMessage",
      id: itemId,
      text: "",
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
      questions: null
    },
    threadId,
    turnId,
    startedAtMs: 0
  });
  const startCommand = (threadId: string, turnId: string, itemId: string): unknown => ({
    item: {
      type: "commandExecution",
      id: itemId,
      pluginId: null,
      scriptPath: null,
      command: "ls",
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

  it("any new item of the turn closes it — a tool call too", () => {
    const { normaliser } = make();
    normaliser.notification("item/started" as never, startMessage(PARENT, "t1", "msg_a"));
    const events = normaliser.notification(
      "item/started" as never,
      startCommand(PARENT, "t1", "call_1")
    );
    assert.deepEqual(
      events.map((event) => [event.type, event.itemId]),
      [
        ["item.completed", "msg_a"],
        ["item.started", "call_1"]
      ]
    );
  });

  it("leaves another turn's message to that turn's own settle", () => {
    const { normaliser } = make();
    normaliser.notification("item/started" as never, startMessage(PARENT, "t1", "msg_a"));
    const events = normaliser.notification(
      "item/started" as never,
      startMessage(PARENT, "t2", "msg_b")
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["item.started"]
    );
  });

  it("a repeated item/started for the same message closes nothing", () => {
    const { normaliser } = make();
    normaliser.notification("item/started" as never, startMessage(PARENT, "t1", "msg_a"));
    const events = normaliser.notification(
      "item/started" as never,
      startMessage(PARENT, "t1", "msg_a")
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["item.started"]
    );
  });

  it("a collab child's item never closes the parent's message", () => {
    const { normaliser } = make();
    normaliser.notification("item/started" as never, startMessage(PARENT, "t1", "msg_a"));
    const events = normaliser.notification(
      "item/started" as never,
      startMessage(CHILD, "t1", "msg_child")
    );
    assert.ok(
      events.every((event) => event.type !== "item.completed"),
      "a child's traffic is task rows, never the parent's items"
    );
  });
});
