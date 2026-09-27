import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadItem } from "@orquester/api/agent-chat";

import { omitSupersededLifecycleMarkers } from "../../../lib/agent-chat/presentation.logic";
import { joinLifecycleDetails } from "../timeline/row-chrome";
import { backgroundShellDisclosureIds, backgroundShellRows, projectBackgroundShell } from "./background-shell";

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

test("the row says its output streamed, running or settled: the whole of it is the host's join, a read away", () => {
  const running = rendered([started(), output("one\n", "o1")]);
  assert.equal(running[0]?.streamedOutput, true);
  const settled = rendered([started(), output("one\n", "o1"), completed(0)]);
  assert.equal(settled[0]?.streamedOutput, true);
  assert.equal(settled[0]?.id, "started", "the read names the row's own item, which names the call");
});

test("a quiet shell whose every chunk aged out still offers the whole of its output", () => {
  // A busy fleet's cross-agent ceiling evicts the chunks; retention keeps the start of running work.
  const entries = rendered([started()]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.streamedOutput, true);
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

test("with no lifecycle frame left, the shell is ONE row titled from its roster row, its whole output joined", () => {
  // A running shell whose opening row aged out of its window — past the cap on running work's opening rows — so
  // only its output is left.
  const chunks = [output("one\n", "o1"), output("two\n", "o2"), output("  three\n", "o3")];
  const rows = backgroundShellRows(chunks, TASK, "npm run dev");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  if (row.kind !== "work") throw new Error("a shell's row is a work row");
  assert.equal(row.displayLabel, "npm run dev", "the roster's title, never the first line of its output");
  assert.deepEqual(
    joinLifecycleDetails(omitSupersededLifecycleMarkers(row.groupedEntries, (entry) => entry)).map((entry) => [entry.id, entry.detail]),
    [["o1", "one\ntwo\n  three\n"]],
    "one row, not one per chunk, and nothing lost"
  );
  // A frame of the call that is still there names the row itself, as it always has.
  const framed = backgroundShellRows([started(), ...chunks], TASK, "npm run dev")[0];
  assert.equal(framed?.kind === "work" ? framed.displayLabel : null, undefined);
  // And no title to fall back on leaves the row unlabelled.
  const untitled = backgroundShellRows(chunks, TASK)[0];
  assert.equal(untitled?.kind === "work" ? untitled.displayLabel : null, undefined);
});

test("a roster title that is only the shell's own id — the roster's fallback when none was given — names nothing", () => {
  const chunks = [output("one\n", "o1"), output("two\n", "o2")];
  const row = backgroundShellRows(chunks, TASK, TASK)[0];
  assert.equal(row?.kind === "work" ? row.displayLabel : null, undefined);
  const spaced = backgroundShellRows(chunks, TASK, `  ${TASK} `)[0];
  assert.equal(spaced?.kind === "work" ? spaced.displayLabel : null, undefined);
});

/**
 * A Grok background shell: its rows are its own TASK rows (Grok stamps them with
 * the shell itself, `shellLinkage`) — a start naming it, a completion carrying
 * its last output line and its exit code — and no command item at all.
 */
function grokShell(activityKind: string, payload: Record<string, unknown>, id: string): ThreadItem {
  return activity(
    activityKind,
    { taskId: "sh1", taskType: "shell", agentKind: "background", agentId: "sh1", title: "npm run dev", ...payload },
    { agentId: "sh1", id, summary: activityKind }
  );
}

test("a Grok shell is ONE command row: its start and its end, never two task rows", () => {
  const rows = backgroundShellRows(
    [
      grokShell("task.started", { detail: "npm run dev" }, "gs-start"),
      grokShell("task.updated", { isBackgrounded: true }, "gs-bg"),
      grokShell(
        "task.completed",
        { status: "completed", summary: "ready in 300ms", detail: "ready in 300ms", exitCode: 0 },
        "gs-end"
      )
    ],
    "sh1",
    "npm run dev"
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, "work");
  if (row.kind !== "work") throw new Error("unreachable");
  assert.equal(row.groupedEntries.length, 1, "one entry: the shell's command, its start and end folded in");
  const [entry] = row.groupedEntries;
  assert.equal(entry?.id, "gs-start", "keyed by its first row, so an opened row stays open");
  assert.equal(entry?.itemType, "command_execution", "the shell pane, as a Claude shell's");
  assert.equal(entry?.detail, "ready in 300ms", "its last output line is its output, once");
  assert.equal(entry?.toolLifecycleStatus, "completed");
  assert.equal(row.displayLabel, "npm run dev", "headed by its title");
  assert.deepEqual(backgroundShellDisclosureIds(rows), ["gs-start"], "and it opens itself");
});

test("a running Grok shell is its row already, with nothing printed yet", () => {
  const rows = backgroundShellRows([grokShell("task.started", { detail: "npm run dev" }, "gs-start")], "sh1", "npm run dev");
  const row = rows[0]!;
  assert.equal(row.kind === "work" ? row.groupedEntries.length : 0, 1);
  const entry = row.kind === "work" ? row.groupedEntries[0] : undefined;
  assert.equal(entry?.detail, undefined, "its title is not its output");
  assert.equal(row.kind === "work" ? row.displayLabel : null, "npm run dev");
});

test("a Grok monitor's latest line is its output", () => {
  const rows = backgroundShellRows(
    [
      grokShell("task.started", { taskType: "monitor", detail: "watch the build" }, "m-start"),
      grokShell("task.progress", { taskType: "monitor", summary: "build 3 passed" }, "m-line")
    ],
    "sh1",
    "watch the build"
  );
  const entry = rows[0]?.kind === "work" ? rows[0].groupedEntries : [];
  assert.equal(entry.length, 1);
  assert.equal(entry[0]?.detail, "build 3 passed");
});

/**
 * A shell's drill-in is held while its OWN items are unchanged (final review C, M1). The thread's items
 * change on every token of any stream — the parent's answer, another agent's thought — and the shell's
 * one row, rebuilt each time, made `WorkRow` join its whole output again (~780 KiB for a dev server's
 * log) on every one of them.
 */
function parentAnswer(text: string): ThreadItem {
  return {
    kind: "message",
    id: "parent-answer",
    role: "assistant",
    text,
    turnId: "turn-1",
    streaming: true,
    createdAt: "2026-09-21T10:05:00.000Z",
    updatedAt: "2026-09-21T10:05:00.000Z"
  } as ThreadItem;
}

test("a token of any other stream leaves the shell's projection, and its row object, as they were", () => {
  const shell = [started(), output("ready\n", "c1"), output("GET / 200\n", "c2")];
  const first = projectBackgroundShell(null, [...shell, parentAnswer("The")], TASK, "run the suite");
  const second = projectBackgroundShell(first, [...shell, parentAnswer("The server")], TASK, "run the suite");
  assert.equal(second, first, "the same projection");
  assert.equal(second.rows[0], first.rows[0], "the same row object: WorkRow's memo holds, its output is not joined again");
  const otherAgent = activity(
    "tool.output",
    { toolUseId: "call-other", streamKind: "command_output", delta: "elsewhere\n" },
    { agentId: "agent-2", id: "other-chunk" }
  );
  const third = projectBackgroundShell(second, [...shell, parentAnswer("The server is up"), otherAgent], TASK, "run the suite");
  assert.equal(third.rows, first.rows, "another agent's output is not this shell's either");
});

test("a chunk of the shell's own still moves its row, to exactly what a fresh projection derives", () => {
  const shell = [started(), output("ready\n", "c1")];
  const first = projectBackgroundShell(null, shell, TASK, "run the suite");
  const grown = [...shell, output("GET / 200\n", "c2")];
  const next = projectBackgroundShell(first, grown, TASK, "run the suite");
  assert.notEqual(next.rows[0], first.rows[0], "a new row: the output grew");
  assert.deepEqual(next.rows, backgroundShellRows(grown, TASK, "run the suite"));
  const row = next.rows[0]!;
  const joined = row.kind === "work" ? joinLifecycleDetails(row.groupedEntries) : [];
  assert.ok(joined.some((entry) => entry.detail?.includes("GET / 200")), "the new chunk is its output");
});

test("a row replaced in place, a new title or another shell derive the rows again", () => {
  const shell = [grokShell("task.started", { detail: "npm run dev" }, "gs-start")];
  const first = projectBackgroundShell(null, shell, "sh1", "npm run dev");
  const ended = grokShell("task.completed", { status: "completed", summary: "ready in 300ms", exitCode: 0 }, "gs-end");
  const settled = projectBackgroundShell(first, [...shell, ended], "sh1", "npm run dev");
  assert.notEqual(settled.rows, first.rows, "its end is its own row");
  const replaced = projectBackgroundShell(settled, [shell[0]!, { ...ended }], "sh1", "npm run dev");
  assert.notEqual(replaced.rows, settled.rows, "a row the store replaced is a change, even with the same id");
  assert.deepEqual(replaced.rows, settled.rows, "to the same content");
  const retitled = projectBackgroundShell(replaced, [shell[0]!, { ...ended }], "sh1", "the dev server");
  assert.notEqual(retitled.rows, replaced.rows, "the roster title labels the row");
  const other = projectBackgroundShell(retitled, [shell[0]!, { ...ended }], TASK, "run the suite");
  assert.deepEqual(other.rows, [], "another shell never reads this one's projection");
});
