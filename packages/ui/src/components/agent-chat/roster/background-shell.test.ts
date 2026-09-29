import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadItem } from "@orquester/api/agent-chat";

import { omitSupersededLifecycleMarkers } from "../../../lib/agent-chat/presentation.logic";
import { joinLifecycleDetails } from "../timeline/row-chrome";
import { projectBackgroundShell } from "./background-shell";

const TASK = "task-bg-1";
const TOOL = `bgshell:${TASK}`;

let seq = 0;
function at(): string {
  seq += 1;
  return new Date(Date.UTC(2026, 8, 21, 10, 0, seq)).toISOString();
}

function activity(
  activityKind: string,
  payload: Record<string, unknown>,
  overrides: { agentId?: string; id?: string; summary?: string } = {}
): ThreadItem {
  const createdAt = at();
  return {
    kind: "activity",
    id: overrides.id ?? `a${seq}`,
    tone: "tool",
    activityKind,
    summary: overrides.summary ?? "Background shell",
    payload,
    turnId: "turn-1",
    createdAt,
    updatedAt: createdAt,
    ...(overrides.agentId === undefined ? {} : { agentId: overrides.agentId })
  } as ThreadItem;
}

const toolData = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  toolName: "Bash",
  input: { command: "pnpm test --watch", description: "run the suite" },
  background: true,
  ...extra
});

function started(): ThreadItem {
  return activity(
    "tool.started",
    {
      toolUseId: TOOL,
      itemType: "command_execution",
      title: "Background shell",
      detail: "pnpm test --watch",
      status: "running",
      data: toolData()
    },
    { agentId: TASK, id: "started" }
  );
}

function output(delta: string, id: string): ThreadItem {
  return activity(
    "tool.output",
    { toolUseId: TOOL, streamKind: "command_output", delta },
    { agentId: TASK, id, summary: "Tool output" }
  );
}

function completed(exitCode: number): ThreadItem {
  return activity(
    "tool.completed",
    {
      toolUseId: TOOL,
      itemType: "command_execution",
      title: "Background shell",
      detail: "pnpm test --watch",
      status: exitCode === 0 ? "completed" : "failed",
      data: toolData({ exitCode })
    },
    { agentId: TASK, id: "completed" }
  );
}

function entries(items: readonly ThreadItem[], agentId = TASK, title?: string) {
  const rows = projectBackgroundShell(null, items, agentId, title).rows;
  return rows.flatMap((row) => row.kind === "work"
    ? joinLifecycleDetails(omitSupersededLifecycleMarkers(row.groupedEntries, (entry) => entry))
    : []);
}

test("streamed output chunks become the row's output, in arrival order", () => {
  const result = entries([started(), output("one\n", "o1"), output("two\n", "o2"), completed(0)]);
  assert.equal(result[0]?.detail, "one\ntwo\n");
});

test("the row keeps the first frame's id, so a streaming row cannot close itself", () => {
  assert.equal(entries([started(), output("one\n", "o1")])[0]?.id, "started");
  assert.equal(entries([started(), output("one\n", "o1"), completed(0)])[0]?.id, "started");
});

test("with no lifecycle frame left, the shell is titled from its roster row, its whole output joined", () => {
  const chunks = [output("one\n", "o1"), output("two\n", "o2"), output("  three\n", "o3")];
  const row = projectBackgroundShell(null, chunks, TASK, "npm run dev").rows[0];
  assert.equal(row?.kind === "work" ? row.displayLabel : null, "npm run dev");
  assert.equal(entries(chunks)[0]?.detail, "one\ntwo\n  three\n");
});

function grokShell(activityKind: string, payload: Record<string, unknown>, id: string): ThreadItem {
  return activity(
    activityKind,
    { taskId: "sh1", taskType: "shell", agentKind: "background", agentId: "sh1", title: "npm run dev", ...payload },
    { agentId: "sh1", id, summary: activityKind }
  );
}

test("a Grok shell folds its task lifecycle into the command's output and status", () => {
  const result = entries([
    grokShell("task.started", { detail: "npm run dev" }, "gs-start"),
    grokShell("task.updated", { isBackgrounded: true }, "gs-bg"),
    grokShell("task.completed", { status: "completed", summary: "ready in 300ms", exitCode: 0 }, "gs-end")
  ], "sh1", "npm run dev");
  assert.equal(result[0]?.id, "gs-start");
  assert.equal(result[0]?.detail, "ready in 300ms");
  assert.equal(result[0]?.toolLifecycleStatus, "completed");
});

test("a running Grok shell has no output until it prints", () => {
  const result = entries([grokShell("task.started", { detail: "npm run dev" }, "gs-start")], "sh1");
  assert.equal(result[0]?.id, "gs-start");
  assert.equal(result[0]?.detail, undefined);
});

test("a Grok monitor's latest line is its output", () => {
  const result = entries([
    grokShell("task.started", { taskType: "monitor", detail: "watch the build" }, "m-start"),
    grokShell("task.progress", { taskType: "monitor", summary: "build 3 passed" }, "m-line")
  ], "sh1");
  assert.equal(result[0]?.detail, "build 3 passed");
});

test("a chunk of the shell's own updates the cached output", () => {
  const shell = [started(), output("ready\n", "c1")];
  const first = projectBackgroundShell(null, shell, TASK);
  const next = projectBackgroundShell(first, [...shell, output("GET / 200\n", "c2")], TASK);
  const row = next.rows[0];
  const joined = row?.kind === "work" ? joinLifecycleDetails(row.groupedEntries) : [];
  assert.equal(joined[0]?.detail, "ready\nGET / 200\n");
});
