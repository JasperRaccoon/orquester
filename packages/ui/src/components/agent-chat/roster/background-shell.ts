/**
 * The drill-in body of a **background shell** (§7.6).
 *
 * A shell's output arrives as ordinary tool-lifecycle activities attributed to
 * the shell itself (`agentId === <taskId>`): one `command_execution` item —
 * `tool.started` → `tool.updated`* → `tool.completed` under a single
 * `toolUseId` — plus `tool.output` chunks as it prints. This module turns that
 * stream into the ONE timeline row the drill-in renders, and it exists as its
 * own projection rather than reusing the shared one for two reasons:
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

/** The shell's items → the entries one `work` row carries, in arrival order. */
export function backgroundShellEntries(
  items: readonly ThreadItem[],
  agentId: string
): WorkLogEntry[] {
  const entries: WorkLogEntry[] = [];
  const lifecycleRowByCallId = new Map<string, number>();

  for (const item of itemsForAgent(items, agentId)) {
    if (item.kind !== "activity") continue;
    const activity = item as ThreadActivityItem;
    const payload = asRecord(activity.payload);
    const base = workLogEntryFromActivity(activity);

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
 */
export function backgroundShellRows(
  items: readonly ThreadItem[],
  agentId: string
): AgentChatTimelineRow[] {
  const groupedEntries = backgroundShellEntries(items, agentId);
  if (groupedEntries.length === 0) return [];
  return [
    {
      kind: "work",
      // Fixed, not derived from an entry: the row's identity must not move
      // when the first frame ages out of retention.
      id: `background-shell:${agentId}`,
      createdAt: groupedEntries[0]!.createdAt,
      groupedEntries,
      isExpandedToolGroup: false
    }
  ];
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
