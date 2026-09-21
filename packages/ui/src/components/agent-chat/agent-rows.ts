import type {
  ThreadActivityItem,
  ThreadActivityPayloadFields,
  ThreadItem,
  ThreadMessageItem
} from "@orquester/api/agent-chat";

import type {
  AgentChatTimelineRow,
  WorkLogEntry,
  WorkLogTone,
  WorkLogToolLifecycleStatus
} from "../../lib/agent-chat/contracts";

/**
 * The drill-in projection (spec §7.6): one subagent's own items, filtered by
 * `agentId`, rendered with the same row components as the parent timeline.
 *
 * It exists as a separate, deliberately small function because §7.2's rule —
 * *items stamped with an `agentId` never render in the parent timeline* — means
 * the parent's row projection has already dropped exactly these items. Nothing
 * upstream produces them, so the drill-in has to build its own.
 *
 * It is a **flat** projection on purpose: no grouping, no collapse, no live
 * toggle rows. The drill-in is read-only (§7.6: "the child view dispatches no
 * commands"), so the row kinds that carry interaction — `work-toggle`,
 * `work-live`, `activity-group`, `queued-message`, `proposed-plan` — have
 * nothing to do there.
 */

/** Activity tone → the work-log tone the row components colour from. */
const TONE: Record<ThreadActivityItem["tone"], WorkLogTone> = {
  info: "info",
  tool: "tool",
  // An approval the child raised reads as information in its own timeline: the
  // card that can act on it lives in the parent's banner dock, never here.
  approval: "info",
  error: "error"
};

const LIFECYCLE: Record<string, WorkLogToolLifecycleStatus> = {
  inProgress: "inProgress",
  completed: "completed",
  failed: "failed",
  declined: "declined"
};

/** Read the §5.6 allow-listed payload fields; anything else is out of bounds. */
function payloadFields(payload: unknown): ThreadActivityPayloadFields {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as ThreadActivityPayloadFields)
    : {};
}

/** One activity item as the single normalised record §7.2 describes. */
export function workLogEntryForActivity(item: ThreadActivityItem): WorkLogEntry {
  const fields = payloadFields(item.payload);
  const entry: WorkLogEntry = {
    id: item.id,
    createdAt: item.createdAt,
    turnId: item.turnId,
    label: fields.title ?? item.summary,
    tone: TONE[item.tone] ?? "info",
    sourceActivityKind: item.activityKind
  };
  if (fields.toolUseId !== undefined) entry.toolCallId = fields.toolUseId;
  if (fields.detail !== undefined) entry.detail = fields.detail;
  if (fields.command !== undefined) entry.command = fields.command;
  if (fields.changedFiles !== undefined) entry.changedFiles = fields.changedFiles;
  if (fields.title !== undefined) entry.toolTitle = fields.title;
  if (fields.taskId !== undefined) entry.taskId = fields.taskId;
  if (fields.requestKind !== undefined) entry.requestKind = fields.requestKind;
  if (fields.questionAnswer !== undefined) entry.questionAnswer = fields.questionAnswer;
  if (fields.agentSpawn !== undefined) entry.agentSpawn = fields.agentSpawn;
  const status = item.status ? LIFECYCLE[item.status] : undefined;
  if (status !== undefined) entry.toolLifecycleStatus = status;
  return entry;
}

/**
 * Every item owned by `agentId`, in order, as timeline rows. The agent's own
 * prompt — the first message it was given — is included so the drill-in opens
 * on "what this agent was asked", which is §7.6's stated layout.
 */
export function deriveAgentDrillInRows(
  entries: readonly ThreadItem[],
  agentId: string
): AgentChatTimelineRow[] {
  const rows: AgentChatTimelineRow[] = [];
  for (const item of entries) {
    if (item.agentId !== agentId) {
      continue;
    }
    if (item.kind === "message") {
      const message: ThreadMessageItem = item;
      rows.push({
        kind: "message",
        id: message.id,
        createdAt: message.createdAt,
        message,
        durationStart: message.createdAt,
        // Token/duration meta belongs to the parent turn, not to a child's
        // re-homed message, and nothing here can revert.
        showAssistantMeta: false
      });
      continue;
    }
    rows.push({
      kind: "work",
      id: item.id,
      createdAt: item.createdAt,
      groupedEntries: [workLogEntryForActivity(item)],
      isExpandedToolGroup: false
    });
  }
  return rows;
}
