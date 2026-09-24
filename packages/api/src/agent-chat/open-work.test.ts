/**
 * The work a thread still has running (`open-work.ts`): the definitions the
 * fold's retention trim (`activitiesToDrop`), the host and the GUI share —
 * which tool calls and background tasks are open, their opening rows, and how
 * recently each was active.
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as api from "../index.ts";
import * as agentChat from "./index.ts";
import { CALL_CLOSER_KINDS, CALL_OPENER_KINDS, openWorkOf } from "./open-work.ts";
import type { ThreadActivityItem } from "./thread.ts";
import { activity, agentTask, resetActivityIds } from "./test-helpers.ts";

/** A lifecycle row of the call `toolUseId`, as ingestion writes it. */
function toolRow(kind: string, toolUseId: unknown, over: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  return activity(kind, { itemType: "command_execution", toolUseId, title: "npm test" }, { tone: "tool", ...over });
}

/** One streamed output chunk of the call `toolUseId` (ingestion's `emitToolOutput`). */
function chunk(toolUseId: string, over: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  return activity("tool.output", { toolUseId, streamKind: "command_output", delta: "line\n" }, {
    tone: "tool",
    summary: "Tool output",
    ...over
  });
}

/** A background task's row: a shell, stamped `agentKind: "background"` as ingestion stamps one. */
function shellRow(kind: string, taskId: unknown, over: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  return activity(kind, { taskId, agentKind: "background", taskType: "local_bash", description: "npm run dev" }, over);
}

test("a call opens with tool.started or tool.updated and closes with tool.completed or tool.denied", () => {
  assert.deepEqual([...CALL_OPENER_KINDS].sort(), ["tool.started", "tool.updated"]);
  assert.deepEqual([...CALL_CLOSER_KINDS].sort(), ["tool.completed", "tool.denied"]);
});

test("a call: its opening row is its first opener, its latest lifecycle its newest opener, its last activity its newest tool row, a chunk included", () => {
  resetActivityIds();
  const rows = [
    toolRow("tool.started", "c1"),
    chunk("c1"),
    toolRow("tool.updated", "c1"),
    // A call the list only ever saw close is no open call.
    toolRow("tool.completed", "c0"),
    chunk("c1"),
    toolRow("tool.started", "c2", { agentId: "a1" }),
    // Any `tool.*` row of a call is activity: an agent's heartbeat names the call it runs.
    activity("tool.progress", { taskId: "a1", toolUseId: "c2", toolName: "Bash" }, { id: "tool-progress:a1", agentId: "a1" }),
    // A task row is not the call's activity, though it names the call that launched it.
    activity("task.progress", agentTask("a1", { toolUseId: "c1" }))
  ];
  assert.deepEqual(openWorkOf(rows), {
    calls: [
      { toolUseId: "c1", opening: rows[0], openingIndex: 0, latestLifecycle: rows[2], lastActiveIndex: 4 },
      { toolUseId: "c2", opening: rows[5], openingIndex: 5, latestLifecycle: rows[5], lastActiveIndex: 6 }
    ],
    tasks: []
  });
  // The very rows of the list, not copies: the fold keeps a row by identity.
  assert.equal(openWorkOf(rows).calls[0]!.opening, rows[0]);
});

test("a chunk before a call's first opener is its activity, but never its opening row", () => {
  resetActivityIds();
  const rows = [chunk("c1"), toolRow("tool.updated", "c1"), toolRow("tool.updated", "c1")];
  assert.deepEqual(openWorkOf(rows).calls, [
    { toolUseId: "c1", opening: rows[1], openingIndex: 1, latestLifecycle: rows[2], lastActiveIndex: 2 }
  ]);
});

test("a closer closes a call for good: a completion or a denial, wherever it sits, and a call that only printed never opened", () => {
  resetActivityIds();
  const rows = [
    toolRow("tool.started", "done"),
    chunk("done"),
    toolRow("tool.completed", "done"),
    toolRow("tool.started", "denied"),
    toolRow("tool.denied", "denied"),
    // A late update after the completion does not reopen the call.
    toolRow("tool.completed", "late"),
    toolRow("tool.updated", "late"),
    chunk("only-chunks"),
    toolRow("tool.started", "open")
  ];
  assert.deepEqual(
    openWorkOf(rows).calls.map((call) => call.toolUseId),
    ["open"]
  );
});

test("a background task: its first task.started that is no agent's, its last activity its newest task row or the newest row it owns", () => {
  resetActivityIds();
  const rows = [
    shellRow("task.started", "sh1"),
    toolRow("tool.started", "bgshell:sh1", { agentId: "sh1" }),
    chunk("bgshell:sh1", { agentId: "sh1" }),
    shellRow("task.updated", "sh1"),
    toolRow("tool.completed", "other"),
    // The shell's own output rows are its activity: they carry its id as their owner.
    chunk("bgshell:sh1", { agentId: "sh1" }),
    // An unstamped task row is background by definition, as the roster reads it.
    activity("task.started", { taskId: "sh2", description: "tail -f log" }),
    // A second start of the same task: the first one is its opening row.
    shellRow("task.started", "sh1"),
    activity("task.progress", { taskId: "sh2", summary: "still tailing" })
  ];
  const work = openWorkOf(rows);
  assert.deepEqual(work.tasks, [
    { taskId: "sh1", start: rows[0], startIndex: 0, lastActiveIndex: 7 },
    { taskId: "sh2", start: rows[6], startIndex: 6, lastActiveIndex: 8 }
  ]);
  assert.deepEqual(work.calls, [
    { toolUseId: "bgshell:sh1", opening: rows[1], openingIndex: 1, latestLifecycle: rows[1], lastActiveIndex: 5 }
  ]);
});

test("a task.completed closes a background task, and an agent's task is never one", () => {
  resetActivityIds();
  const rows = [
    shellRow("task.started", "done"),
    shellRow("task.completed", "done"),
    // An agent never ended is still no background task: its launch is an anchor the fold keeps anyway.
    activity("task.started", agentTask("a1", { title: "Explore" })),
    activity("task.progress", agentTask("a1", { summary: "reading" })),
    toolRow("tool.output", "x", { agentId: "a1" }),
    // A task the list saw only progress for never started here.
    activity("task.progress", { taskId: "sh3", agentKind: "background" })
  ];
  assert.deepEqual(openWorkOf(rows).tasks, []);
});

test("blank ids are ignored, and so is a row whose payload is not a record", () => {
  resetActivityIds();
  const rows = [
    toolRow("tool.started", ""),
    toolRow("tool.started", "   "),
    toolRow("tool.started", undefined),
    toolRow("tool.started", 42),
    shellRow("task.started", ""),
    shellRow("task.started", "  "),
    shellRow("task.started", null),
    activity("tool.started", null),
    activity("tool.started", ["c1"]),
    activity("task.started", "sh1"),
    chunk("c9", { agentId: "" })
  ];
  assert.deepEqual(openWorkOf(rows), { calls: [], tasks: [] });
  assert.deepEqual(openWorkOf([]), { calls: [], tasks: [] });
});

test("pure: it reads the list and never writes to it, and answers the same twice", () => {
  resetActivityIds();
  const rows = [shellRow("task.started", "sh1"), toolRow("tool.started", "c1"), chunk("c1")];
  for (const row of rows) Object.freeze(row);
  Object.freeze(rows);
  const first = openWorkOf(rows);
  assert.deepEqual(openWorkOf(rows), first);
  assert.notEqual(openWorkOf(rows).calls, first.calls, "fresh arrays every time");
});

test("both barrels export the definitions: @orquester/api and @orquester/api/agent-chat", () => {
  assert.equal(api.openWorkOf, openWorkOf);
  assert.equal(api.CALL_OPENER_KINDS, CALL_OPENER_KINDS);
  assert.equal(api.CALL_CLOSER_KINDS, CALL_CLOSER_KINDS);
  assert.equal(agentChat.openWorkOf, openWorkOf);
  assert.equal(agentChat.CALL_OPENER_KINDS, CALL_OPENER_KINDS);
  assert.equal(agentChat.CALL_CLOSER_KINDS, CALL_CLOSER_KINDS);
});
