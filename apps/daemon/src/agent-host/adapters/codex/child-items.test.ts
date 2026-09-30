/**
 * Codex adapter — a collab child's own calls are its rows: items, output and
 * all (plan `2026-09-24-follow-ups-adapters-output-composer-history`, Task 3).
 *
 * A child's `item/*` used to become only the roster's `task.progress` tick and
 * its `outputDelta`s were dropped as chatter, so a Codex drill-in showed
 * progress ticks and never a command, let alone its output. A child's items
 * now become item events owned by the child — its thread id on the envelope
 * AND the payload, exactly as every other adapter's agent rows — under ids
 * namespaced by the child's thread, because a child's `call_1` must never be
 * the parent's `call_1`. Every row of one call rides the PARENT turn that was
 * live when the call started (AGENTS.md, "A call's rows are one owner's and
 * one turn's"); the child's own provider turn stays in `providerRefs`.
 *
 * No capture spawns a child (fixtures README observation 20), so these drive
 * the normaliser with frames typed against `_generated/protocol/v2/`, and the
 * last test runs them through ingestion, the real fold, the host's join and
 * the MCP transcript — the seams the drill-in reads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CodexProtocol } from "./_generated/index.ts";
import { foldCodexLog, ingestCodexDrafts } from "./fold-testing.ts";
import { CodexNormaliser, type RuntimeEventDraft } from "./normalise.ts";
import { CodexUsageTracker } from "./usage.ts";

const PARENT = "parent-thread";
const CHILD = "child-thread";
const CHILD_PATH = "/root/explorer";
const PARENT_TURN = "parent-turn";
const CHILD_TURN = "child-turn";
/** The same raw id in BOTH threads: the collision the child's namespace prevents. */
const CALL = "call_1";

function make(): CodexNormaliser {
  return new CodexNormaliser({ usage: new CodexUsageTracker(), ownThreadId: () => PARENT });
}

function turn(id: string, status: CodexProtocol.v2.TurnStatus): CodexProtocol.v2.Turn {
  return {
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null
  };
}

function turnStarted(n: CodexNormaliser, threadId: string, turnId: string): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.TurnStartedNotification = { threadId, turn: turn(turnId, "inProgress") };
  return n.notification("turn/started", params);
}

function turnCompleted(
  n: CodexNormaliser,
  threadId: string,
  turnId: string,
  status: CodexProtocol.v2.TurnStatus = "completed"
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.TurnCompletedNotification = { threadId, turn: turn(turnId, status) };
  return n.notification("turn/completed", params);
}

/** The parent's launch record for the child, then the child's own first turn. */
function launchChild(n: CodexNormaliser, childTurn = CHILD_TURN): RuntimeEventDraft[] {
  const launch: CodexProtocol.v2.ItemCompletedNotification = {
    item: { type: "subAgentActivity", id: "sub-launch", kind: "started", agentThreadId: CHILD, agentPath: CHILD_PATH },
    threadId: PARENT,
    turnId: PARENT_TURN,
    completedAtMs: 0
  };
  return [...n.notification("item/completed", launch), ...turnStarted(n, CHILD, childTurn)];
}

function commandItem(
  id: string,
  status: CodexProtocol.v2.CommandExecutionStatus,
  aggregatedOutput: string | null
): CodexProtocol.v2.ThreadItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: "pnpm test",
    cwd: "/w/p",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 5 : null
  };
}

/** A child's MCP call as the protocol reports it. */
function mcpItem(id: string, status: CodexProtocol.v2.McpToolCallStatus): CodexProtocol.v2.ThreadItem {
  return {
    type: "mcpToolCall",
    id,
    server: "serena",
    tool: "search",
    status,
    arguments: {},
    appContext: null,
    pluginId: null,
    readOnlyHint: true,
    result: null,
    error: null,
    durationMs: null
  };
}

function mcpProgress(n: CodexNormaliser, itemId: string, message: string): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.McpToolCallProgressNotification = {
    threadId: CHILD,
    turnId: CHILD_TURN,
    itemId,
    message
  };
  return n.notification("item/mcpToolCall/progress", params);
}

function itemStarted(
  n: CodexNormaliser,
  threadId: string,
  turnId: string,
  item: CodexProtocol.v2.ThreadItem
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.ItemStartedNotification = { item, threadId, turnId, startedAtMs: 0 };
  return n.notification("item/started", params);
}

function itemCompleted(
  n: CodexNormaliser,
  threadId: string,
  turnId: string,
  item: CodexProtocol.v2.ThreadItem
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.ItemCompletedNotification = { item, threadId, turnId, completedAtMs: 1 };
  return n.notification("item/completed", params);
}

function outputDelta(
  n: CodexNormaliser,
  threadId: string,
  turnId: string,
  itemId: string,
  delta: string
): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.CommandExecutionOutputDeltaNotification = { threadId, turnId, itemId, delta };
  return n.notification("item/commandExecution/outputDelta", params);
}

/** Every draft that is not the roster's progress tick, as `[type, itemId, agentId, turnId]`. */
function callRows(drafts: readonly RuntimeEventDraft[]): (string | undefined)[][] {
  return drafts
    .filter((draft) => draft.type !== "task.progress")
    .map((draft) => [draft.type, draft.itemId, draft.agentId, draft.turnId]);
}

function payloadOf(draft: RuntimeEventDraft | undefined): Record<string, unknown> {
  assert.ok(draft !== undefined);
  return draft.payload as unknown as Record<string, unknown>;
}

describe("a collab child's calls are its own rows (Task 3)", () => {
  it("a child's command is item.started, its output chunks and item.completed — owned by the child, under a namespaced id", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);

    const started = itemStarted(n, CHILD, CHILD_TURN, commandItem(CALL, "inProgress", null));
    const childCall = started.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof childCall, "string");
    assert.notEqual(childCall, CALL, "the child cannot collide with the parent's raw item id");
    const chunks = [
      ...outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 1\n"),
      ...outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 2\n")
    ];
    const completed = itemCompleted(n, CHILD, CHILD_TURN, commandItem(CALL, "completed", "ok 1\nok 2\n"));

    assert.deepEqual(callRows([...started, ...chunks, ...completed]), [
      ["item.started", childCall, CHILD, PARENT_TURN],
      ["content.delta", childCall, CHILD, PARENT_TURN],
      ["content.delta", childCall, CHILD, PARENT_TURN],
      ["item.completed", childCall, CHILD, PARENT_TURN]
    ]);
    for (const draft of [...started, ...completed].filter((d) => d.type.startsWith("item."))) {
      assert.equal(payloadOf(draft).agentId, CHILD, `${draft.type}: the owner rides the payload too`);
      assert.equal(payloadOf(draft).itemType, "command_execution");
    }
    for (const draft of chunks) {
      assert.deepEqual(payloadOf(draft), {
        streamKind: "command_output",
        delta: draft === chunks[0] ? "ok 1\n" : "ok 2\n"
      });
    }
    // The provider's own ids stay beside ours, for correlating a capture.
    for (const draft of [...started, ...chunks, ...completed].filter((d) => d.type !== "task.progress")) {
      assert.deepEqual(draft.providerRefs, { providerTurnId: CHILD_TURN, providerItemId: CALL });
    }
  });

  it("the parent's own item under the same raw id stays the parent's: its id, no owner", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const childStart = itemStarted(n, CHILD, CHILD_TURN, commandItem(CALL, "inProgress", null));
    const childCall = childStart.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof childCall, "string");
    assert.notEqual(childCall, CALL);

    const own = [
      ...itemStarted(n, PARENT, PARENT_TURN, commandItem(CALL, "inProgress", null)),
      ...outputDelta(n, PARENT, PARENT_TURN, CALL, "mine\n"),
      ...itemCompleted(n, PARENT, PARENT_TURN, commandItem(CALL, "completed", "mine\n"))
    ];
    assert.deepEqual(callRows(own), [
      ["item.started", CALL, undefined, PARENT_TURN],
      ["content.delta", CALL, undefined, PARENT_TURN],
      ["item.completed", CALL, undefined, PARENT_TURN]
    ]);
    for (const draft of own.filter((d) => d.type.startsWith("item."))) {
      assert.equal("agentId" in payloadOf(draft), false);
    }
    // The parent's completion closed the parent's call, never the child's.
    const childEnd = turnCompleted(n, CHILD, CHILD_TURN);
    assert.deepEqual(childEnd.filter((draft) => draft.type === "item.completed").map((draft) => draft.itemId), [childCall]);
  });

  it("every row of a call rides the parent turn it started in; a call started between parent turns has none", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const first = itemStarted(n, CHILD, CHILD_TURN, commandItem("call_a", "inProgress", null));
    const firstId = first.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof firstId, "string");

    // The parent's turn settles while the child works on (§3.1: background
    // work outlives the turn): it closes the parent's calls, not the child's.
    const settled = turnCompleted(n, PARENT, PARENT_TURN);
    assert.equal(
      settled.some((draft) => draft.itemId === firstId),
      false,
      "a child's call is the child's to end"
    );

    const late = [
      ...outputDelta(n, CHILD, CHILD_TURN, "call_a", "late\n"),
      ...itemStarted(n, CHILD, CHILD_TURN, commandItem("call_b", "inProgress", null)),
      ...itemCompleted(n, CHILD, CHILD_TURN, commandItem("call_a", "completed", "late\n")),
      ...itemCompleted(n, CHILD, CHILD_TURN, commandItem("call_b", "completed", "b\n"))
    ];
    const secondId = late.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof secondId, "string");
    assert.notEqual(secondId, firstId);
    assert.deepEqual(callRows(late), [
      ["content.delta", firstId, CHILD, PARENT_TURN],
      ["item.started", secondId, CHILD, undefined],
      ["item.completed", firstId, CHILD, PARENT_TURN],
      ["item.completed", secondId, CHILD, undefined]
    ]);
  });

  it("the child's own turn/completed closes the calls it abandoned, before its task row; thread/closed closes the rest", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const first = itemStarted(n, CHILD, CHILD_TURN, commandItem("call_a", "inProgress", null));
    const firstId = first.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof firstId, "string");

    // `turn/interrupt` abandons an in-progress item with no `item/completed`
    // of its own (fixtures README observation 5) — a child's as well.
    const interrupted = turnCompleted(n, CHILD, CHILD_TURN, "interrupted");
    assert.deepEqual(
      interrupted.map((draft) => [draft.type, draft.itemId, draft.agentId, draft.turnId]),
      [
        ["item.completed", firstId, CHILD, PARENT_TURN],
        ["task.updated", undefined, CHILD, undefined]
      ]
    );
    assert.deepEqual(payloadOf(interrupted[0]), {
      itemType: "command_execution",
      status: "failed",
      agentId: CHILD
    });

    turnStarted(n, CHILD, "child-turn-2");
    const second = itemStarted(n, CHILD, "child-turn-2", commandItem("call_b", "inProgress", null));
    const secondId = second.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof secondId, "string");
    const closedThread: CodexProtocol.v2.ThreadClosedNotification = { threadId: CHILD };
    const closed = n.notification("thread/closed", closedThread);
    assert.deepEqual(
      closed.map((draft) => [draft.type, draft.itemId, draft.agentId]),
      [
        ["item.completed", secondId, CHILD],
        ["task.completed", undefined, CHILD]
      ]
    );
    assert.equal(payloadOf(closed[0]).status, "failed");
  });

  it("a child's turn that COMPLETED closes a call it left open as completed, as the parent's rule does", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const first = itemStarted(n, CHILD, CHILD_TURN, commandItem("call_a", "inProgress", null));
    const firstId = first.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof firstId, "string");
    const settled = turnCompleted(n, CHILD, CHILD_TURN, "completed");
    assert.deepEqual(
      settled.map((draft) => [draft.type, draft.itemId, draft.agentId]),
      [
        ["item.completed", firstId, CHILD],
        ["task.updated", undefined, CHILD]
      ]
    );
    assert.equal(payloadOf(settled[0]).status, "completed");
    assert.equal(payloadOf(settled[1]).status, "idle");
  });

  it("a child's MCP progress is the child's: its namespaced call, its task, the call's turn", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const started = itemStarted(n, CHILD, CHILD_TURN, mcpItem("call_m", "inProgress"));
    const id = started.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof id, "string");
    const progress = mcpProgress(n, "call_m", "indexing 3/9");
    assert.deepEqual(callRows(progress), [["tool.progress", id, CHILD, PARENT_TURN]]);
    assert.deepEqual(payloadOf(progress[0]), {
      toolUseId: id,
      toolName: "serena: search",
      summary: "indexing 3/9",
      taskId: CHILD
    });
    assert.deepEqual(progress[0]!.providerRefs, { providerTurnId: CHILD_TURN, providerItemId: "call_m" });
  });

  it("a child's file change: its patch updates and its output are the child's too", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const changes: CodexProtocol.v2.FileUpdateChange[] = [
      { path: "/w/p/a.ts", kind: { type: "add" }, diff: "+a\n" }
    ];
    const started = itemStarted(n, CHILD, CHILD_TURN, {
      type: "fileChange",
      id: "call_f",
      changes,
      status: "inProgress"
    });
    const patched: CodexProtocol.v2.FileChangePatchUpdatedNotification = {
      threadId: CHILD,
      turnId: CHILD_TURN,
      itemId: "call_f",
      changes
    };
    const update = n.notification("item/fileChange/patchUpdated", patched);
    const output: CodexProtocol.v2.FileChangeOutputDeltaNotification = {
      threadId: CHILD,
      turnId: CHILD_TURN,
      itemId: "call_f",
      delta: "Success. Updated the following files:\nA a.ts\n"
    };
    const chunk = n.notification("item/fileChange/outputDelta", output);

    const id = started.find((draft) => draft.type === "item.started")!.itemId;
    assert.equal(typeof id, "string");
    assert.deepEqual(callRows([...started, ...update, ...chunk]), [
      ["item.started", id, CHILD, PARENT_TURN],
      ["item.updated", id, CHILD, PARENT_TURN],
      ["content.delta", id, CHILD, PARENT_TURN]
    ]);
    assert.equal(payloadOf(update[0]).itemType, "file_change");
    assert.equal(payloadOf(update[0]).agentId, CHILD);
    assert.equal(payloadOf(chunk[0]).streamKind, "file_change_output");
  });

  it("a child's message and reasoning items are neither item rows nor roster ticks", () => {
    // Only a call is a row: the child's own text streams are still dropped
    // (its deltas are chatter), so its message items would be empty rows. Nor
    // are they ticks: a tick is the agent's one progress row, and one that
    // names no call would blank its last tool.
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    const drafts = [
      ...itemStarted(n, CHILD, CHILD_TURN, { type: "reasoning", id: "rs_1", summary: [], content: [] }),
      ...itemCompleted(n, CHILD, CHILD_TURN, {
        type: "agentMessage",
        id: "msg_1",
        text: "done",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null
      })
    ];
    assert.deepEqual(drafts, []);
  });
});

describe("a child's call through ingestion and the fold (Task 3)", () => {
  it("a child's roster row keeps its launch's name through every tick, and carries its own usage", async () => {
    // Every tick used to put what the child was doing in `description`, which
    // ingestion makes the row's title: the roster read "agent <thread id>",
    // "unknown" or the command line instead of the agent's name, and the
    // child's own token usage was dropped (the Codex fleet of 2026-09-28).
    const n = make();
    const usage: CodexProtocol.v2.ThreadTokenUsageUpdatedNotification = {
      threadId: CHILD,
      turnId: CHILD_TURN,
      tokenUsage: {
        total: {
          totalTokens: 29685,
          inputTokens: 29620,
          cachedInputTokens: 14592,
          cacheWriteInputTokens: 0,
          outputTokens: 65,
          reasoningOutputTokens: 0
        },
        last: {
          totalTokens: 14877,
          inputTokens: 14847,
          cachedInputTokens: 14592,
          cacheWriteInputTokens: 0,
          outputTokens: 30,
          reasoningOutputTokens: 0
        },
        modelContextWindow: 258400
      }
    } as CodexProtocol.v2.ThreadTokenUsageUpdatedNotification;
    const events = await ingestCodexDrafts([
      turnStarted(n, PARENT, PARENT_TURN),
      launchChild(n),
      itemStarted(n, CHILD, CHILD_TURN, commandItem("call_1", "inProgress", null)),
      itemCompleted(n, CHILD, CHILD_TURN, commandItem("call_1", "completed", "ok\n")),
      n.notification("thread/tokenUsage/updated", usage)
    ]);
    const agent = foldCodexLog(events).roster.find((row) => row.id === CHILD);
    assert.equal(agent?.title, "explorer");
    assert.equal(agent?.lastToolName, "Shell");
    assert.deepEqual(agent?.usage, {
      totalTokens: 29685,
      inputTokens: 29620,
      cachedInputTokens: 14592,
      outputTokens: 65,
      reasoningOutputTokens: 0,
      toolUses: 1
    });
    assert.equal(agent?.status, "running");
  });

  it("a child's own launch record starts its agent, owned by the child", async () => {
    // A child spawning an agent of its own reports the launch on ITS thread;
    // it used to be only an "unknown" tick of the child, and the grandchild
    // had no start and no name.
    const n = make();
    const grandchild: CodexProtocol.v2.ThreadItem = {
      type: "subAgentActivity",
      id: "call_spawn",
      kind: "started",
      agentThreadId: "grandchild-thread",
      agentPath: `${CHILD_PATH}/timeline`
    };
    const events = await ingestCodexDrafts([
      turnStarted(n, PARENT, PARENT_TURN),
      launchChild(n),
      itemCompleted(n, CHILD, CHILD_TURN, grandchild),
      turnStarted(n, "grandchild-thread", "grandchild-turn")
    ]);
    const roster = foldCodexLog(events).roster;
    const row = roster.find((agent) => agent.id === "grandchild-thread");
    assert.equal(row?.title, "timeline");
    assert.equal(row?.parentAgentId, CHILD);
    assert.equal(row?.status, "running");
    assert.equal(roster.find((agent) => agent.id === CHILD)?.title, "explorer");
  });

  it("a child's end is ONE row, with its answer as the result, whichever order Codex sends it in", async () => {
    // Observed on 0.155.1 (fixtures README observation 24): the end record
    // comes twice, as item/started and item/completed, with the child's own
    // turn/completed between the two. That wrote two ends and an `idle`
    // between them, so the row read completed → idle → completed, and the
    // child's answer — its last message — was dropped.
    const endRecord = (kind: "completed" | "interrupted"): CodexProtocol.v2.ThreadItem => ({
      type: "subAgentActivity",
      id: `subagent-completed-${CHILD_TURN}`,
      kind,
      agentThreadId: CHILD,
      agentPath: CHILD_PATH
    });
    const answer: CodexProtocol.v2.ThreadItem = {
      type: "agentMessage",
      id: "msg_answer",
      text: "3 files, all clean.",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null
    };
    for (const kind of ["completed", "interrupted"] as const) {
      const n = make();
      const steps: RuntimeEventDraft[][] = [
        turnStarted(n, PARENT, PARENT_TURN),
        launchChild(n),
        itemCompleted(n, CHILD, CHILD_TURN, answer),
        itemStarted(n, PARENT, PARENT_TURN, endRecord(kind)),
        turnCompleted(n, CHILD, CHILD_TURN, kind === "completed" ? "completed" : "interrupted"),
        itemCompleted(n, PARENT, PARENT_TURN, endRecord(kind))
      ];
      const ends = steps
        .flat()
        .filter((draft) => draft.type === "task.completed" || draft.type === "task.updated");
      assert.equal(ends.length, 1, `${kind}: one end, no idle and no second copy`);
      const agent = foldCodexLog(await ingestCodexDrafts(steps)).roster.find((row) => row.id === CHILD);
      assert.equal(agent?.status, kind === "completed" ? "completed" : "interrupted");
      assert.equal(agent?.result, kind === "completed" ? "3 files, all clean." : null);
    }
  });
});
