/**
 * The drill-in body of a **background shell** (§7.6).
 *
 * A Claude shell's output arrives as ordinary tool-lifecycle activities
 * attributed to the shell itself (`agentId === <taskId>`): one
 * `command_execution` item — `tool.started` → `tool.updated`* →
 * `tool.completed` under a single `toolUseId` — plus `tool.output` chunks as
 * it prints. A Grok shell has no command item: its rows are its own TASK rows
 * (a start, a monitor's lines, an end with its last output line), which fold
 * into one command row too (`shellTaskEntry`). This module turns either stream
 * into the ONE timeline row the drill-in renders, and it exists as its own
 * projection rather than reusing the shared one for two reasons:
 *
 *  - **The shared derivation hides these rows on purpose.** §7.2's
 *    quiet-timeline rule (`isAgentInternalActivity`) drops every activity
 *    stamped with an `agentId` so a child's work never clutters the parent
 *    timeline. Inside the child's own view that filter has already been
 *    applied — by the agent id — so applying it again leaves the view empty,
 *    which is exactly what "This agent has not reported anything yet." was
 *    reporting on a shell that had printed plenty.
 *  - **A shell is one command, not a turn.** The shared projection would fold
 *    it behind a turn fold and a "+N more" group toggle, two clicks away from
 *    the output the user opened the row to read.
 *
 * What it deliberately does NOT do: format anything. The row it returns is an
 * ordinary `work` row, so `WorkRow` renders it with the same `ToolEntryRow`
 * as every other tool call — including `joinLifecycleDetails`, which folds the
 * `tool.output` chunks into the owning row's output.
 *
 * The drill-in holds it ({@link projectBackgroundShell}): the thread's items
 * change on every token of any stream, and a row rebuilt for each of them
 * joined the shell's whole output again every time.
 */

import type { ThreadActivityItem, ThreadItem } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow, WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { itemsForAgent, workLogEntryFromActivity } from "../../../lib/agent-chat/entries.logic";

/** The three frames of one tool call's lifecycle; they are one row. */
const LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed"
]);

/** A task's own rows: its start, its progress and patches, its end. */
const TASK_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed"
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The command, from the tool call's own input.
 *
 * `workLogEntryFromActivity` promotes a top-level `payload.command`; a Bash
 * call carries it inside `data.input.command`, and without this the row's
 * monospace command block renders empty — the user would see output with no
 * way to tell which command produced it.
 */
function commandFromToolInput(payload: Record<string, unknown> | null): string | undefined {
  const input = asRecord(asRecord(payload?.data)?.input);
  const command = input?.command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
}

/**
 * Later frames win, **except identity**: the first frame's id is the row's
 * disclosure key, and a key that moved mid-stream would collapse a row the
 * user had opened (or, once seeded, re-open one they closed).
 */
function mergeLifecycleFrames(previous: WorkLogEntry, next: WorkLogEntry): WorkLogEntry {
  return { ...previous, ...next, id: previous.id, createdAt: previous.createdAt };
}

/**
 * A shell's own task row as its command: a Grok shell has no command item —
 * the shell stamps its task rows with itself (the Grok adapter's
 * `shellLinkage`), a start naming it, progress (a monitor's lines), patches,
 * and an end carrying its last output line and its exit code. They are its one
 * command row, never rows of their own: the title heads the row (the roster's,
 * `displayLabel`), the latest summary is its output, the latest status the
 * row's. Its exit code is the header's (the status chip, the metrics line).
 */
function shellTaskEntry(
  previous: WorkLogEntry | undefined,
  next: WorkLogEntry,
  payload: Record<string, unknown> | null
): WorkLogEntry {
  const summary =
    typeof payload?.summary === "string" && payload.summary.trim().length > 0 ? payload.summary : undefined;
  const title = next.toolTitle ?? previous?.toolTitle;
  const detail = summary ?? previous?.detail;
  const status = next.toolLifecycleStatus ?? previous?.toolLifecycleStatus;
  // The first row's identity: the row's disclosure key must not move.
  const entry: WorkLogEntry = { ...(previous ?? next), itemType: "command_execution" };
  entry.label = title ?? previous?.label ?? next.label;
  if (title !== undefined) entry.toolTitle = title;
  // Only a summary is output: a start's detail is its description, the title.
  if (detail !== undefined) entry.detail = detail;
  else delete entry.detail;
  if (status !== undefined) entry.toolLifecycleStatus = status;
  return entry;
}

/** The shell's own items → command entries, in arrival order. */
function shellEntriesOf(own: readonly ThreadItem[], agentId: string): WorkLogEntry[] {
  const entries: WorkLogEntry[] = [];
  const lifecycleRowByCallId = new Map<string, number>();
  let taskEntryAt: number | undefined;

  for (const item of own) {
    if (item.kind !== "activity") continue;
    const activity = item as ThreadActivityItem;
    const payload = asRecord(activity.payload);
    const base = workLogEntryFromActivity(activity);

    if (TASK_KINDS.has(activity.activityKind) && payload?.taskId === agentId) {
      // The shell's own task rows (a Grok shell's): its one command row.
      if (taskEntryAt === undefined) {
        taskEntryAt = entries.length;
        entries.push(shellTaskEntry(undefined, base, payload));
      } else {
        entries[taskEntryAt] = shellTaskEntry(entries[taskEntryAt], base, payload);
      }
      continue;
    }

    if (activity.activityKind === "tool.output") {
      // The chunk's text rides `delta`; the shared record reads `detail`, and
      // `joinLifecycleDetails` reads it off the entry — so the mapping happens
      // here or the streamed output is silently dropped. NOT trimmed: a
      // command's output is its whitespace.
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (delta.length === 0) continue;
      entries.push({ ...base, detail: delta });
      continue;
    }

    if (!LIFECYCLE_KINDS.has(activity.activityKind)) {
      // Anything else the host attributed to this shell (a runtime warning,
      // say) is still its own row: a view that drops what it does not
      // recognise is how output goes missing.
      entries.push(base);
      continue;
    }

    const command = base.command ?? commandFromToolInput(payload);
    const entry: WorkLogEntry = command === undefined ? base : { ...base, command };
    const callId = entry.toolCallId;
    const existing = callId === undefined ? undefined : lifecycleRowByCallId.get(callId);
    if (existing === undefined) {
      if (callId !== undefined) lifecycleRowByCallId.set(callId, entries.length);
      entries.push(entry);
      continue;
    }
    entries[existing] = mergeLifecycleFrames(entries[existing]!, entry);
  }

  return entries;
}

/**
 * The drill-in's rows for a background shell: one `work` row, or none at all
 * when the shell has printed nothing yet (so the timeline's own empty copy
 * shows instead of an empty row).
 *
 * `fallbackTitle` — the shell's roster row title (`AgentDrillIn` passes it):
 * its description, or the command itself when it has none — labels the row
 * when no lifecycle frame of the shell's call is left to name it: retention
 * keeps a running call's opening row only among the most recently active
 * ones (`OPEN_WORK_RETENTION_LIMIT`). Its chunks alone are still one row,
 * `joinLifecycleDetails` folding them into the first; without the title that
 * row read as the first line of the output. A title that is only the shell's
 * own id — the roster's fallback when nothing ever named the task — names
 * nothing, and is no title.
 */
function shellRowsOf(own: readonly ThreadItem[], agentId: string, fallbackTitle?: string): AgentChatTimelineRow[] {
  const groupedEntries = shellEntriesOf(own, agentId);
  if (groupedEntries.length === 0) return [];
  const given = fallbackTitle?.trim() ?? "";
  const title = given === agentId ? "" : given;
  const framed = groupedEntries.some((entry) => LIFECYCLE_KINDS.has(entry.sourceActivityKind ?? ""));
  return [
    {
      kind: "work",
      // Fixed, not derived from an entry: the row's identity must not move
      // when the first frame ages out of retention.
      id: `background-shell:${agentId}`,
      createdAt: groupedEntries[0]!.createdAt,
      groupedEntries,
      isExpandedToolGroup: false,
      ...(!framed && title.length > 0 ? { displayLabel: title } : {})
    }
  ];
}

/** A shell's drill-in rows, with what they were derived from. */
export interface BackgroundShellProjection {
  readonly agentId: string;
  readonly title: string | undefined;
  /** The shell's own items (`itemsForAgent`): everything its rows read but the title. */
  readonly own: readonly ThreadItem[];
  readonly rows: AgentChatTimelineRow[];
}

/**
 * The shell's command rows, held: `previous` itself while the shell's own
 * items are the same objects, in the same order, under the same title. The
 * thread's items change on every token of any stream — the parent's answer,
 * another agent's thought — and a row rebuilt for each of them made `WorkRow`
 * join the shell's whole output again every time (a dev server's log: ~0.8 ms
 * and a fresh ~780 KiB string per token, final review C's M1). A chunk of the
 * shell's own, or a row the store replaced, is a new item: the rows are
 * derived again. What the rows are held with is what they read, so a held row
 * is exactly the row a fresh derivation would make.
 */
export function projectBackgroundShell(
  previous: BackgroundShellProjection | null,
  items: readonly ThreadItem[],
  agentId: string,
  fallbackTitle?: string
): BackgroundShellProjection {
  const own = itemsForAgent(items, agentId);
  if (
    previous !== null &&
    previous.agentId === agentId &&
    previous.title === fallbackTitle &&
    sameItems(previous.own, own)
  ) {
    return previous;
  }
  return { agentId, title: fallbackTitle, own, rows: shellRowsOf(own, agentId, fallbackTitle) };
}

function sameItems(left: readonly ThreadItem[], right: readonly ThreadItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * The ids the drill-in seeds into its disclosures so a shell's rows open
 * without a click — the output IS the reason the row was clicked.
 */
export function backgroundShellDisclosureIds(
  rows: readonly AgentChatTimelineRow[]
): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind !== "work") continue;
    for (const entry of row.groupedEntries) ids.push(entry.id);
  }
  return ids;
}
