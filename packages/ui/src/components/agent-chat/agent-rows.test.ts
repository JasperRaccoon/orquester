import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadItem } from "@orquester/api/agent-chat";

import { deriveAgentDrillInRows, workLogEntryForActivity } from "./agent-rows.ts";

const at = "2026-09-21T10:00:00.000Z";

const activity = (over: Partial<Extract<ThreadItem, { kind: "activity" }>> = {}) =>
  ({
    kind: "activity",
    id: "act1",
    tone: "tool",
    activityKind: "tool.started",
    summary: "Reading src/app.ts",
    payload: {},
    turnId: "t1",
    createdAt: at,
    updatedAt: at,
    ...over
  }) as Extract<ThreadItem, { kind: "activity" }>;

const message = (over: Partial<Extract<ThreadItem, { kind: "message" }>> = {}) =>
  ({
    kind: "message",
    id: "msg1",
    role: "user",
    text: "find the bug",
    turnId: "t1",
    streaming: false,
    createdAt: at,
    updatedAt: at,
    ...over
  }) as Extract<ThreadItem, { kind: "message" }>;

test("only the named agent's items are projected", () => {
  const entries: ThreadItem[] = [
    activity({ id: "parent" }),
    activity({ id: "mine", agentId: "ag1" }),
    activity({ id: "other", agentId: "ag2" })
  ];
  assert.deepEqual(
    deriveAgentDrillInRows(entries, "ag1").map((r) => r.id),
    ["mine"]
  );
});

test("order is preserved and both item kinds are projected", () => {
  const entries: ThreadItem[] = [
    message({ id: "prompt", agentId: "ag1" }),
    activity({ id: "a", agentId: "ag1" }),
    activity({ id: "b", agentId: "ag1" })
  ];
  const rows = deriveAgentDrillInRows(entries, "ag1");
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id]),
    [
      ["message", "prompt"],
      ["work", "a"],
      ["work", "b"]
    ]
  );
});

test("a drill-in message carries no assistant meta and no revert affordance", () => {
  const rows = deriveAgentDrillInRows([message({ agentId: "ag1", role: "assistant" })], "ag1");
  const row = rows[0];
  assert.equal(row.kind, "message");
  if (row.kind === "message") {
    assert.equal(row.showAssistantMeta, false);
    assert.equal(row.revertTurnCount, undefined);
  }
});

test("the work-log entry reads only the allow-listed payload fields", () => {
  const entry = workLogEntryForActivity(
    activity({
      status: "completed",
      payload: {
        itemType: "tool",
        toolUseId: "tu-1",
        title: "Read",
        detail: "42 lines",
        command: "cat src/app.ts",
        changedFiles: ["src/app.ts"],
        taskId: "task-7",
        // Not in the allow-list: must not appear on the entry.
        secret: "nope"
      }
    })
  );
  assert.equal(entry.toolCallId, "tu-1");
  assert.equal(entry.label, "Read");
  assert.equal(entry.detail, "42 lines");
  assert.equal(entry.command, "cat src/app.ts");
  assert.deepEqual(entry.changedFiles, ["src/app.ts"]);
  assert.equal(entry.taskId, "task-7");
  assert.equal(entry.toolLifecycleStatus, "completed");
  assert.equal((entry as unknown as Record<string, unknown>).secret, undefined);
});

test("a missing title falls back to the summary, and a junk payload is survivable", () => {
  assert.equal(workLogEntryForActivity(activity({ payload: null })).label, "Reading src/app.ts");
  assert.equal(workLogEntryForActivity(activity({ payload: [1, 2] })).label, "Reading src/app.ts");
  assert.equal(workLogEntryForActivity(activity({ payload: "x" })).label, "Reading src/app.ts");
});

test("an approval raised by a child reads as information in its own timeline", () => {
  // The card that can act on it lives in the parent's banner dock.
  assert.equal(workLogEntryForActivity(activity({ tone: "approval" })).tone, "info");
  assert.equal(workLogEntryForActivity(activity({ tone: "error" })).tone, "error");
});
