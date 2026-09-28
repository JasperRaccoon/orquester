/**
 * The work a thread still has running (`open-work.ts`): the definitions the
 * fold's retention trim (`activitiesToDrop`), the host and the GUI share —
 * which tool calls and background tasks are open, their opening rows, and how
 * recently each was active.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openWorkOf } from "./open-work.ts";
import type { ThreadActivityItem } from "./thread.ts";
import { activity, resetActivityIds } from "./test-helpers.ts";

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
