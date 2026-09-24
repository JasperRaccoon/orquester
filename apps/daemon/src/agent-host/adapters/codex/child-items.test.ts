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

import {
  slimActivityPayload,
  toThreadSnapshot,
  type ThreadActivityItem,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { transcriptEntries } from "../../../mcp/transcript.ts";
import { joinToolOutput } from "../../store/tool-output.ts";
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
const CHILD_CALL = `codex-child:${CHILD}:${CALL}`;

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
    const chunks = [
      ...outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 1\n"),
      ...outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 2\n")
    ];
    const completed = itemCompleted(n, CHILD, CHILD_TURN, commandItem(CALL, "completed", "ok 1\nok 2\n"));

    assert.deepEqual(callRows([...started, ...chunks, ...completed]), [
      ["item.started", CHILD_CALL, CHILD, PARENT_TURN],
      ["content.delta", CHILD_CALL, CHILD, PARENT_TURN],
      ["content.delta", CHILD_CALL, CHILD, PARENT_TURN],
      ["item.completed", CHILD_CALL, CHILD, PARENT_TURN]
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
    // The roster's tick stays: what the agent is doing, and its last tool.
    const ticks = [...started, ...completed].filter((draft) => draft.type === "task.progress");
    assert.equal(ticks.length, 2);
    for (const tick of ticks) {
      assert.equal(tick.agentId, CHILD);
      assert.equal(payloadOf(tick).lastToolName, "command_execution");
      assert.equal(payloadOf(tick).description, "pnpm test");
    }
  });

  it("the parent's own item under the same raw id stays the parent's: its id, no owner", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    itemStarted(n, CHILD, CHILD_TURN, commandItem(CALL, "inProgress", null));

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
    assert.deepEqual(n.openItemIds(), [CHILD_CALL]);
  });

  it("every row of a call rides the parent turn it started in; a call started between parent turns has none", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    itemStarted(n, CHILD, CHILD_TURN, commandItem("call_a", "inProgress", null));

    // The parent's turn settles while the child works on (§3.1: background
    // work outlives the turn): it closes the parent's calls, not the child's.
    const settled = turnCompleted(n, PARENT, PARENT_TURN);
    assert.equal(
      settled.some((draft) => draft.itemId === `codex-child:${CHILD}:call_a`),
      false,
      "a child's call is the child's to end"
    );

    const late = [
      ...outputDelta(n, CHILD, CHILD_TURN, "call_a", "late\n"),
      ...itemStarted(n, CHILD, CHILD_TURN, commandItem("call_b", "inProgress", null)),
      ...itemCompleted(n, CHILD, CHILD_TURN, commandItem("call_a", "completed", "late\n")),
      ...itemCompleted(n, CHILD, CHILD_TURN, commandItem("call_b", "completed", "b\n"))
    ];
    assert.deepEqual(callRows(late), [
      ["content.delta", `codex-child:${CHILD}:call_a`, CHILD, PARENT_TURN],
      ["item.started", `codex-child:${CHILD}:call_b`, CHILD, undefined],
      ["item.completed", `codex-child:${CHILD}:call_a`, CHILD, PARENT_TURN],
      ["item.completed", `codex-child:${CHILD}:call_b`, CHILD, undefined]
    ]);
  });

  it("the child's own turn/completed closes the calls it abandoned, before its task row; thread/closed closes the rest", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    itemStarted(n, CHILD, CHILD_TURN, commandItem("call_a", "inProgress", null));

    // `turn/interrupt` abandons an in-progress item with no `item/completed`
    // of its own (fixtures README observation 5) — a child's as well.
    const interrupted = turnCompleted(n, CHILD, CHILD_TURN, "interrupted");
    assert.deepEqual(
      interrupted.map((draft) => [draft.type, draft.itemId, draft.agentId, draft.turnId]),
      [
        ["item.completed", `codex-child:${CHILD}:call_a`, CHILD, PARENT_TURN],
        ["task.updated", undefined, CHILD, undefined]
      ]
    );
    assert.deepEqual(payloadOf(interrupted[0]), {
      itemType: "command_execution",
      status: "failed",
      agentId: CHILD
    });

    turnStarted(n, CHILD, "child-turn-2");
    itemStarted(n, CHILD, "child-turn-2", commandItem("call_b", "inProgress", null));
    const closedThread: CodexProtocol.v2.ThreadClosedNotification = { threadId: CHILD };
    const closed = n.notification("thread/closed", closedThread);
    assert.deepEqual(
      closed.map((draft) => [draft.type, draft.itemId, draft.agentId]),
      [
        ["item.completed", `codex-child:${CHILD}:call_b`, CHILD],
        ["task.completed", undefined, CHILD]
      ]
    );
    assert.equal(payloadOf(closed[0]).status, "failed");
    assert.deepEqual(n.openItemIds(), []);
  });

  it("a child's turn that COMPLETED closes a call it left open as completed, as the parent's rule does", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    itemStarted(n, CHILD, CHILD_TURN, commandItem("call_a", "inProgress", null));
    const settled = turnCompleted(n, CHILD, CHILD_TURN, "completed");
    assert.deepEqual(
      settled.map((draft) => [draft.type, draft.itemId, draft.agentId]),
      [
        ["item.completed", `codex-child:${CHILD}:call_a`, CHILD],
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
    itemStarted(n, CHILD, CHILD_TURN, mcpItem("call_m", "inProgress"));
    const progress = mcpProgress(n, "call_m", "indexing 3/9");
    const id = `codex-child:${CHILD}:call_m`;
    assert.deepEqual(callRows(progress), [["tool.progress", id, CHILD, PARENT_TURN]]);
    assert.deepEqual(payloadOf(progress[0]), {
      toolUseId: id,
      toolName: "serena: search",
      summary: "indexing 3/9",
      taskId: CHILD
    });
    assert.deepEqual(progress[0]!.providerRefs, { providerTurnId: CHILD_TURN, providerItemId: "call_m" });
  });

  it("Stop and exit close a child's running call; a turn-scoped close of the parent's turn does not", () => {
    const n = make();
    turnStarted(n, PARENT, PARENT_TURN);
    launchChild(n);
    itemStarted(n, CHILD, CHILD_TURN, commandItem(CALL, "inProgress", null));
    assert.deepEqual(n.openItemIds(), [CHILD_CALL], "a child's running call is an open item");

    assert.deepEqual(n.closeOpenItems("completed", PARENT_TURN), []);

    // Both a session-scoped Stop and the process's exit close with no turn.
    const closed = n.closeOpenItems("failed");
    assert.deepEqual(callRows(closed), [["item.completed", CHILD_CALL, CHILD, PARENT_TURN]]);
    assert.deepEqual(payloadOf(closed[0]), { itemType: "command_execution", status: "failed", agentId: CHILD });
    assert.deepEqual(n.openItemIds(), []);
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

    const id = `codex-child:${CHILD}:call_f`;
    assert.deepEqual(callRows([...started, ...update, ...chunk]), [
      ["item.started", id, CHILD, PARENT_TURN],
      ["item.updated", id, CHILD, PARENT_TURN],
      ["content.delta", id, CHILD, PARENT_TURN]
    ]);
    assert.equal(payloadOf(update[0]).itemType, "file_change");
    assert.equal(payloadOf(update[0]).agentId, CHILD);
    assert.equal(payloadOf(chunk[0]).streamKind, "file_change_output");
  });

  it("a child's message and reasoning items stay roster ticks, never item rows", () => {
    // Only a call is a row: the child's own text streams are still dropped
    // (its deltas are chatter), so its message items would be empty rows.
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
    assert.deepEqual(
      drafts.map((draft) => draft.type),
      ["task.progress", "task.progress"]
    );
  });
});

// ---------------------------------------------------------------------------
// Through ingestion, the real fold, the host's join and the MCP transcript
// ---------------------------------------------------------------------------

/** The tool entries read_transcript serves, from the snapshot slimmed as every read is. */
function toolEntries(state: ThreadFoldState, agentId?: string): string[][] {
  const snap = toThreadSnapshot(state);
  const read = {
    ...snap,
    items: snap.items.map((item) =>
      item.kind === "activity" ? { ...item, payload: slimActivityPayload(item.payload) } : item
    )
  };
  return transcriptEntries(read, {
    turns: 5,
    ...(agentId !== undefined ? { agentId } : {}),
    include: new Set(["tools"] as const),
    maxChars: 100_000
  })
    .entries.filter((entry) => entry.kind === "tool")
    .map((entry) => [entry.tool!.type, entry.tool!.status, entry.agentId ?? "(parent)"]);
}

describe("a child's call through ingestion and the fold (Task 3)", () => {
  it("is ONE call in the child's drill-in with its output joined, and no row of the parent's", async () => {
    const n = make();
    // Each step is ingested on its own, so every chunk of output is a row.
    const events = await ingestCodexDrafts([
      turnStarted(n, PARENT, PARENT_TURN),
      launchChild(n),
      itemStarted(n, CHILD, CHILD_TURN, commandItem(CALL, "inProgress", null)),
      outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 1\n"),
      outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 2\n"),
      outputDelta(n, CHILD, CHILD_TURN, CALL, "ok 3\n"),
      itemCompleted(n, CHILD, CHILD_TURN, commandItem(CALL, "completed", "ok 1\nok 2\nok 3\n")),
      // The parent's own call under the same raw id: its row, not the child's.
      itemStarted(n, PARENT, PARENT_TURN, commandItem(CALL, "inProgress", null)),
      itemCompleted(n, PARENT, PARENT_TURN, commandItem(CALL, "completed", "mine\n"))
    ]);
    const state = foldCodexLog(events);
    const activities = state.items.filter((item): item is ThreadActivityItem => item.kind === "activity");
    const callOf = (activity: ThreadActivityItem): unknown =>
      (activity.payload as { toolUseId?: unknown } | null)?.toolUseId;

    const childRows = activities.filter((activity) => callOf(activity) === CHILD_CALL);
    assert.deepEqual(
      childRows.map((row) => row.activityKind),
      ["tool.started", "tool.output", "tool.output", "tool.output", "tool.completed"]
    );
    assert.deepEqual(
      [...new Set(childRows.map((row) => `${row.turnId}|${row.agentId}`))],
      [`${PARENT_TURN}|${CHILD}`],
      "one call, one turn key, one owner"
    );
    assert.equal(
      activities.filter((activity) => callOf(activity) === CALL).length,
      2,
      "the parent's own call keeps its own id and its own two rows"
    );

    // The host's join reads the child's output whole, from any row of the call.
    const completion = childRows.at(-1)!;
    assert.deepEqual(joinToolOutput(events, completion.id), {
      toolUseId: CHILD_CALL,
      output: "ok 1\nok 2\nok 3\n",
      complete: true,
      truncated: false
    });

    // read_transcript: the child's drill-in shows the call, once; the parent's
    // view shows only the parent's own.
    assert.deepEqual(toolEntries(state, CHILD), [["command_execution", "completed", CHILD]]);
    assert.deepEqual(toolEntries(state), [["command_execution", "completed", "(parent)"]]);
  });

  it("a child's MCP progress persists as the child's heartbeat and reaches its roster row", async () => {
    // Routed to the parent (as it was), the frame carried the child's raw item
    // id, no owner and no task: ingestion wrote nothing for it.
    const n = make();
    const events = await ingestCodexDrafts([
      turnStarted(n, PARENT, PARENT_TURN),
      launchChild(n),
      itemStarted(n, CHILD, CHILD_TURN, mcpItem("call_m", "inProgress")),
      mcpProgress(n, "call_m", "indexing 3/9")
    ]);
    const state = foldCodexLog(events);
    const heartbeats = state.items.flatMap((item) => {
      if (item.kind !== "activity" || item.activityKind !== "tool.progress") return [];
      const payload = item.payload as { toolUseId?: unknown; taskId?: unknown; toolName?: unknown };
      return [[item.agentId, payload.toolUseId, payload.taskId, payload.toolName]];
    });
    assert.deepEqual(heartbeats, [[CHILD, `codex-child:${CHILD}:call_m`, CHILD, "serena: search"]]);
    assert.equal(state.roster.find((agent) => agent.id === CHILD)?.lastToolName, "serena: search");
  });

  it("a child's call starting never ends the parent's thinking block", async () => {
    // Ingestion closes a thinking block when a tool of the SAME author starts,
    // and reads the author off the envelope's agentId: stamped on the payload
    // alone, the child's call would split the parent's block in two.
    const n = make();
    const thinking = (delta: string): RuntimeEventDraft[] => {
      const params: CodexProtocol.v2.ReasoningTextDeltaNotification = {
        threadId: PARENT,
        turnId: PARENT_TURN,
        itemId: "rs_1",
        delta,
        contentIndex: 0
      };
      return n.notification("item/reasoning/textDelta", params);
    };
    const events = await ingestCodexDrafts([
      turnStarted(n, PARENT, PARENT_TURN),
      launchChild(n),
      thinking("Waiting on the explorer. "),
      itemStarted(n, CHILD, CHILD_TURN, commandItem(CALL, "inProgress", null)),
      thinking("It is still running.")
    ]);
    const state = foldCodexLog(events);
    const blocks = state.items.flatMap((item) =>
      item.kind === "message" && item.role === "reasoning" ? [[item.text, item.agentId ?? "(parent)"]] : []
    );
    assert.deepEqual(blocks, [["Waiting on the explorer. It is still running.", "(parent)"]]);
  });
});
