import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadItem } from "@orquester/api/agent-chat";

import { omitSupersededLifecycleMarkers } from "../../../lib/agent-chat/presentation.logic";
import { joinLifecycleDetails } from "../timeline/row-chrome";
import { backgroundShellDisclosureIds, backgroundShellRows } from "./background-shell";

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

/** What `WorkRow` actually renders: the row's entries after both row filters. */
function rendered(items: readonly ThreadItem[]): ReturnType<typeof joinLifecycleDetails> {
  const rows = backgroundShellRows(items, TASK);
  assert.equal(rows.length, 1, "a shell's own items are one row");
  const row = rows[0]!;
  assert.equal(row.kind, "work");
  if (row.kind !== "work") throw new Error("unreachable");
  return joinLifecycleDetails(omitSupersededLifecycleMarkers(row.groupedEntries, (entry) => entry));
}

test("the shell's own item survives the filter that hides it from the parent timeline", () => {
  // Every one of these carries `agentId`, which `deriveWorkLogEntries` treats
  // as "internal" so the parent timeline stays quiet (§7.2). Inside the
  // shell's OWN view that filter has already been applied by the agent id, so
  // dropping them here is what left the drill-in saying nothing was reported.
  const entries = rendered([started(), output("compiling…\n", "o1"), completed(0)]);
  assert.equal(entries.length, 1, "one command, one row");
  assert.equal(entries[0]?.itemType, "command_execution");
});

test("the command comes off the Bash input, so the monospace block is never empty", () => {
  const entries = rendered([started(), completed(0)]);
  assert.equal(entries[0]?.command, "pnpm test --watch");
});

test("streamed output chunks become the row's output, in arrival order", () => {
  const entries = rendered([
    started(),
    output("one\n", "o1"),
    output("two\n", "o2"),
    completed(0)
  ]);
  assert.equal(entries.length, 1, "chunks are the inside of the row, not sibling rows");
  assert.equal(entries[0]?.detail, "one\ntwo\n");
});

test("output that arrives before the command settles is already visible", () => {
  const entries = rendered([started(), output("one\n", "o1")]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.detail, "one\n");
  assert.equal(entries[0]?.command, "pnpm test --watch");
});

test("the row keeps the first frame's id, so a streaming row cannot close itself", () => {
  const live = backgroundShellRows([started(), output("one\n", "o1")], TASK);
  const settled = backgroundShellRows(
    [started(), output("one\n", "o1"), completed(0)],
    TASK
  );
  const idOf = (rows: typeof live): string | undefined =>
    rows[0]?.kind === "work" ? rows[0].groupedEntries[0]?.id : undefined;
  assert.equal(idOf(live), "started");
  assert.equal(idOf(settled), "started", "the disclosure key is the row's identity");
  assert.equal(live[0]?.id, settled[0]?.id, "and so is the row id React keys on");
});

test("the disclosure seed names every row the shell view renders", () => {
  const rows = backgroundShellRows([started(), output("one\n", "o1"), completed(0)], TASK);
  assert.ok(
    backgroundShellDisclosureIds(rows).includes("started"),
    "seeding this id is what opens the row without a click"
  );
});

test("another agent's items are not this shell's output", () => {
  const foreign = activity(
    "tool.completed",
    { toolUseId: "other", itemType: "command_execution", detail: "rm -rf /" },
    { agentId: "someone-else", id: "foreign" }
  );
  const rows = backgroundShellRows([foreign], TASK);
  assert.deepEqual(rows, [], "no rows at all, so the view says 'No output yet.'");
});

test("a shell that has printed nothing yet has no rows", () => {
  assert.deepEqual(backgroundShellRows([], TASK), []);
});
