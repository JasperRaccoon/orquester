/**
 * Agent chat — layer 1 of 3: thread items → timeline entries (spec §7.2).
 *
 * Ported from T3 Code (MIT): `apps/web/src/session-logic.ts`
 * (`WorkLogEntry`, `deriveWorkLogEntries`, `collapseDerivedWorkLogEntries`,
 * `deriveTimelineEntriesWithState`).
 *
 * Three rules carry the weight here:
 *
 * 1. **Items stamped with an `agentId` never render in the parent timeline**
 *    (§7.2). A subagent's own tool calls and progress ticks are re-homed to the
 *    roster; the parent keeps its narrative plus at most one row per spawned
 *    agent. Without this a single `Agent` call floods the thread.
 * 2. **An answered question folds out of the message list** and re-renders as
 *    an activity row whose expansion shows the question-and-answer history
 *    (§7.3). Leaving the answer in place duplicates it.
 * 3. **Identity preservation is the performance story** (§7.2, React 18, no
 *    compiler): one streamed token must change one entry object and leave every
 *    other one `===`.
 *
 * No React import.
 */

import type { ThreadActivityItem, ThreadItem, ThreadMessageItem } from "@orquester/api/agent-chat";

import type {
  CompactionMarkerState,
  WorkLogEntry,
  WorkLogToolLifecycleStatus
} from "./contracts";
import { normalizeCompactToolLabel } from "./presentation.logic";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A plan proposal, folded from `turn.proposed.*` activities (§7.3). */
export interface ProposedPlanEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  turnId: string | null;
  planMarkdown: string;
  /**
   * Set once a later user message carries the §7.3 implementation prefix. The
   * proposal is retired **by the turn that implements it**, not by the click.
   *
   * *differs from T3:* T3 persists `implementedAt` on a server-side
   * proposed-plan aggregate; we have no such aggregate, so it is derived from
   * the message log.
   */
  implementedAt: string | null;
}

export type TimelineEntry =
  | { kind: "message"; id: string; createdAt: string; message: ThreadMessageItem }
  | { kind: "proposed-plan"; id: string; createdAt: string; proposedPlan: ProposedPlanEntry }
  | { kind: "work"; id: string; createdAt: string; entry: WorkLogEntry };

export interface TimelineEntriesProjection {
  readonly messages: readonly ThreadMessageItem[];
  readonly proposedPlans: readonly ProposedPlanEntry[];
  readonly workEntries: readonly WorkLogEntry[];
  readonly entries: TimelineEntry[];
}

/** The §7.3 prefix a plan-implementing turn carries. *T3: `proposedPlan.ts:73`.* */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

// ---------------------------------------------------------------------------
// Payload readers (the §5.6 allow-list, and nothing else)
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Item/task status → the status a work-log row shows.
 *
 * *T3: `presentation.ts:371-394` (`extractWorkLogToolLifecycleStatus`); differs:
 * T3 has a fifth `"stopped"` value, which F's `WorkLogToolLifecycleStatus`
 * does not, so `cancelled`/`interrupted` map to `failed` — a stopped tool is
 * still a call that did not deliver.*
 */
export function toolLifecycleStatusFromPayload(
  payload: Record<string, unknown> | null
): WorkLogToolLifecycleStatus | undefined {
  switch (payload?.status) {
    case "pending":
    case "running":
    case "waiting":
    case "inProgress":
      return "inProgress";
    case "cancelled":
    case "interrupted":
      return "failed";
    case "idle":
      // A batch becomes idle when its parent turn ends; other idle tasks resume.
      return payload.taskType === "subagent_batch" ? "failed" : undefined;
    case "completed":
    case "failed":
    case "declined":
      return payload.status;
    default:
      return undefined;
  }
}

/** `agentKind` is stamped host-side once; an unstamped row is background. *T3: `:110-112`.* */
function isBackgroundTaskPayload(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

const TASK_KINDS = new Set(["task.started", "task.progress", "task.updated", "task.completed"]);

// ---------------------------------------------------------------------------
// activity → WorkLogEntry
// ---------------------------------------------------------------------------

/** Extra fields the derivation carries but the public record does not need. */
interface DerivedWorkLogEntry extends WorkLogEntry {
  sourceActivityKind: string;
  /** Collapse key for a subagent lifecycle row — one row per agent. */
  collapseKey?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell / monitor / plan tasks: ordinary rows, never spawn rows. */
  isBackgroundTask?: boolean;
}

const derivedByActivity = new WeakMap<ThreadActivityItem, DerivedWorkLogEntry>();

/**
 * The single normalised record. Memoised by activity identity, so a fold that
 * returns the same activity object returns the same entry object — which is
 * what the row layers' `===` fast paths rest on.
 */
export function workLogEntryFromActivity(activity: ThreadActivityItem): WorkLogEntry {
  return derivedWorkLogEntry(activity);
}

function derivedWorkLogEntry(activity: ThreadActivityItem): DerivedWorkLogEntry {
  const cached = derivedByActivity.get(activity);
  if (cached) {
    return cached;
  }
  const payload = asRecord(activity.payload);
  const isTaskActivity = TASK_KINDS.has(activity.activityKind);

  const taskSummary = isTaskActivity ? asTrimmedString(payload?.summary) : undefined;
  const taskDetailAsLabel =
    isTaskActivity && !taskSummary ? asTrimmedString(payload?.detail) : undefined;
  const taskLabel = taskSummary ?? taskDetailAsLabel;
  const detail = isTaskActivity
    ? taskDetailAsLabel
      ? undefined
      : asTrimmedString(payload?.detail)
    : asTrimmedString(payload?.detail);

  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel ?? activity.summary,
    // `task.progress` ticks read as thinking; an approval is informational,
    // never a red row — the decision lives in the docked banner (§7.3).
    tone:
      activity.activityKind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    sourceActivityKind: activity.activityKind
  };

  // A streamed output chunk rides `delta`, not `detail`, and it is NOT
  // trimmed: a command's output is its whitespace, and `joinLifecycleDetails`
  // concatenates the chunks verbatim onto the row that owns the call.
  const outputChunk =
    activity.activityKind === "tool.output" &&
    typeof payload?.delta === "string" &&
    payload.delta.length > 0
      ? payload.delta
      : undefined;
  if (outputChunk !== undefined) {
    entry.detail = outputChunk;
  } else if (detail) {
    entry.detail = detail;
  } else if (
    activity.activityKind === "runtime.error" ||
    activity.activityKind === "runtime.warning"
  ) {
    const message = asTrimmedString(payload?.message);
    if (message && message !== activity.summary) {
      entry.detail = message;
    }
  }

  const command = asTrimmedString(payload?.command);
  if (command) {
    entry.command = command;
  }
  const changedFiles = asStringArray(payload?.changedFiles);
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  const title = asTrimmedString(payload?.title);
  if (title) {
    entry.toolTitle = title;
  }
  const itemType = payload?.itemType;
  if (typeof itemType === "string") {
    entry.itemType = itemType as WorkLogEntry["itemType"];
  }
  const requestKind = payload?.requestKind;
  if (typeof requestKind === "string") {
    entry.requestKind = requestKind as WorkLogEntry["requestKind"];
  }
  // `toolUseId` is stable across the in-progress and completed updates of ONE
  // call (§7.2); task rows use `taskId` instead and must never share the key.
  const toolUseId = isTaskActivity ? undefined : asTrimmedString(payload?.toolUseId);
  if (toolUseId) {
    entry.toolCallId = toolUseId;
  }
  // Promoted by §5.1 so the presentation layer can nest a hook run or a
  // CLI-side denial under the call that triggered it (fix-wave R7-10).
  if (activity.parentToolUseId) {
    entry.parentToolUseId = activity.parentToolUseId;
  }
  if (activity.activityKind === "mcp_tool_call" || entry.itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);
    if (data) {
      entry.toolData = data.item ?? data;
    }
  }

  let toolLifecycleStatus =
    toolLifecycleStatusFromPayload(payload) ??
    (activity.status === undefined ? undefined : (activity.status as WorkLogToolLifecycleStatus));
  if (!toolLifecycleStatus && activity.activityKind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }
  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }

  const questionAnswer = asRecord(payload?.questionAnswer);
  if (
    questionAnswer &&
    typeof questionAnswer.requestId === "string" &&
    asRecord(questionAnswer.answers)
  ) {
    entry.questionAnswer = {
      requestId: questionAnswer.requestId,
      answers: questionAnswer.answers as Record<string, unknown>,
      ...(asRecord(questionAnswer.questionTextById)
        ? { questionTextById: questionAnswer.questionTextById as Record<string, string> }
        : {})
    };
  }

  if (isTaskActivity && payload) {
    const taskId = asTrimmedString(payload.taskId);
    if (taskId) {
      entry.taskId = taskId;
    }
    const role = asTrimmedString(payload.role);
    if (role) {
      entry.agentRole = role;
    }
    if (payload.taskType === "local_workflow" || asTrimmedString(payload.workflowName)) {
      entry.isWorkflowCoordinator = true;
    }
    if (isBackgroundTaskPayload(payload)) {
      entry.isBackgroundTask = true;
    }
  }

  // Gates the row's "Load full output": the rest is behind
  // `GET …/items/:itemId` (§5.6, §6.3).
  if (payload?.truncated === true) {
    entry.truncated = true;
  }

  if (isCompactionActivity(activity)) {
    const compactionPayload = asRecord(activity.payload);
    const error = asTrimmedString(compactionPayload?.error);
    // The provider's summary of everything the compaction dropped. Not
    // trimmed into a `detail`: it is markdown, it is pages long, and the
    // marker reveals it whole behind its own toggle.
    const summary =
      typeof compactionPayload?.summary === "string" && compactionPayload.summary.trim().length > 0
        ? compactionPayload.summary
        : undefined;
    entry.compaction = {
      state: compactionMarkerState(activity),
      ...compactionTokens(activity),
      ...(error ? { error } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(summary !== undefined && compactionPayload?.truncated === true
        ? { summaryTruncated: true }
        : {})
    };
  }

  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  derivedByActivity.set(activity, entry);
  return entry;
}

/**
 * Subagent lifecycle rows collapse by agent identity: one row per agent,
 * progress ticks fold into it, the terminal row wins the label.
 *
 * *T3: `session-logic.ts:868-890`.*
 */
function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (entry.taskId) {
    return `task:${entry.taskId}`;
  }
  if (!entry.toolCallId) {
    return undefined;
  }
  return `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`;
}

// ---------------------------------------------------------------------------
// The quiet-timeline guarantee (§7.2)
// ---------------------------------------------------------------------------

function isAgentTaskStartedActivity(activity: ThreadActivityItem): boolean {
  const payload = asRecord(activity.payload);
  if (!payload || typeof payload.taskId !== "string") {
    return false;
  }
  return !isBackgroundTaskPayload(payload);
}

/**
 * Rows owned by an agent, or synthesised child rows carrying `timelineBypass`,
 * are internal — except an agent (non-background) task row, which stays
 * visible so it can anchor a spawn row.
 *
 * *T3: `session-logic.ts:411-449`.*
 */
export function isAgentInternalActivity(activity: ThreadActivityItem): boolean {
  const payload = asRecord(activity.payload);
  const ownedByAgent =
    (typeof activity.agentId === "string" && activity.agentId.trim().length > 0) ||
    (typeof payload?.agentId === "string" && payload.agentId.trim().length > 0);
  const bypassed = payload?.timelineBypass === true;

  if (TASK_KINDS.has(activity.activityKind)) {
    if (ownedByAgent || bypassed) {
      const isAgentTaskRow =
        activity.activityKind !== "task.updated" &&
        typeof payload?.taskId === "string" &&
        !isBackgroundTaskPayload(payload);
      return !isAgentTaskRow;
    }
    return false;
  }
  if (bypassed) {
    return true;
  }
  return ownedByAgent;
}

/** Activity kinds that never become a work-log row. */
const DROPPED_ACTIVITY_KINDS = new Set([
  // A `tool.started` row has no output and is always followed by an update.
  "tool.started",
  // Fold input only; a status patch is not narrative.
  "task.updated",
  "tool.progress",
  // Their own surfaces: the meter, the composer checklist, the plan card.
  "context-window.updated",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed"
]);

/**
 * Adapters forward unknown wire-only frames as runtime warnings. A row with no
 * displayable text carries nothing a user can act on.
 *
 * *T3: `session-logic.ts:517-526`.*
 */
function isNoContentRuntimeWarning(activity: ThreadActivityItem): boolean {
  return (
    activity.activityKind === "runtime.warning" &&
    activity.summary.endsWith("(no displayable text content)")
  );
}

/** `ExitPlanMode` is a plan boundary, not a tool the user cares about. *T3: `:528-540`.* */
function isPlanBoundaryToolActivity(activity: ThreadActivityItem): boolean {
  if (activity.activityKind !== "tool.updated" && activity.activityKind !== "tool.completed") {
    return false;
  }
  const detail = asRecord(activity.payload)?.detail;
  return typeof detail === "string" && detail.startsWith("ExitPlanMode:");
}

/** The compaction marker's activity kind. */
export function isCompactionActivity(activity: ThreadActivityItem): boolean {
  if (activity.activityKind === "context-compaction") {
    return true;
  }
  return (
    activity.activityKind === "thread.state.changed" &&
    asRecord(activity.payload)?.state === "compacted"
  );
}

/**
 * Which of the three compaction markers this activity is (§7.3).
 *
 * **Anything unreadable is `compacted`.** An old log only ever recorded the
 * settled marker — a `context-compaction` activity with no `state`, or the
 * legacy `thread.state.changed` one — and reading an unknown spelling as an
 * in-flight phase would leave a resumed thread shimmering "Compacting
 * context…" against a provider that finished months ago.
 */
export function compactionMarkerState(activity: ThreadActivityItem): CompactionMarkerState {
  const state = asRecord(activity.payload)?.state;
  return state === "compacting" || state === "compaction-failed" ? state : "compacted";
}

/** Before/after token counts, carried on the event and formatted client-side (§7.3). */
export function compactionTokens(activity: ThreadActivityItem): {
  beforeTokens?: number;
  afterTokens?: number;
} {
  const payload = asRecord(activity.payload);
  const before = payload?.beforeTokens;
  const after = payload?.afterTokens;
  return {
    ...(typeof before === "number" && Number.isFinite(before) ? { beforeTokens: before } : {}),
    ...(typeof after === "number" && Number.isFinite(after) ? { afterTokens: after } : {})
  };
}

/**
 * Activities → work-log rows, with the quiet-timeline guarantee and the
 * lifecycle / spawn collapses.
 *
 * *T3: `session-logic.ts:453-513`.*
 */
export interface DeriveWorkLogOptions {
  /**
   * The drill-in's own agent (§7.6): its rows are agent-internal to the
   * PARENT timeline and must stay out of it, but inside the agent's own view
   * they are the whole point. Without this the drill-in applied the parent's
   * quiet-timeline filter a second time and showed nothing.
   */
  readonly ownerAgentId?: string;
}

function ownedByAgent(activity: ThreadActivityItem, agentId: string | undefined): boolean {
  if (agentId === undefined) {
    return false;
  }
  return activity.agentId === agentId || asRecord(activity.payload)?.agentId === agentId;
}

export function deriveWorkLogEntries(
  activities: readonly ThreadActivityItem[],
  options?: DeriveWorkLogOptions
): WorkLogEntry[] {
  // A launch tool and its task lifecycle describe the same run. Only hide the
  // launch row once its tool-use id has an agent row to replace it.
  const agentLaunchToolIds = new Set<string>();
  for (const activity of activities) {
    if (
      (activity.activityKind === "task.started" ||
        activity.activityKind === "task.progress" ||
        activity.activityKind === "task.completed") &&
      isAgentTaskStartedActivity(activity)
    ) {
      const toolUseId = asTrimmedString(asRecord(activity.payload)?.toolUseId);
      if (toolUseId) {
        agentLaunchToolIds.add(toolUseId);
      }
    }
  }

  const derived: DerivedWorkLogEntry[] = [];
  for (const activity of activities) {
    if (DROPPED_ACTIVITY_KINDS.has(activity.activityKind)) {
      continue;
    }
    if (activity.activityKind === "task.started" && !isAgentTaskStartedActivity(activity)) {
      continue;
    }
    if (isNoContentRuntimeWarning(activity)) {
      continue;
    }
    if (isPlanBoundaryToolActivity(activity)) {
      continue;
    }
    if (isAgentInternalActivity(activity) && !ownedByAgent(activity, options?.ownerAgentId)) {
      continue;
    }
    const entry = derivedWorkLogEntry(activity);
    // A native agent launch gets its visible row from `task.started`; defer
    // its own in-progress tool row so a second launch cannot duplicate the batch.
    if (
      entry.toolCallId &&
      agentLaunchToolIds.has(entry.toolCallId) &&
      entry.tone !== "error" &&
      entry.toolLifecycleStatus !== "failed"
    ) {
      continue;
    }
    derived.push(entry);
  }
  return collapseDerivedWorkLogEntries(derived);
}

/**
 * Spawn-group key: workflow members and their coordinator share the
 * coordinator's group; direct spawns batch per turn.
 *
 * *T3: `session-logic.ts:894-906`.*
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) {
    return `wf:${taskId.slice(0, workflowSlot)}`;
  }
  if (entry.isWorkflowCoordinator) {
    return `wf:${taskId}`;
  }
  // No turn id means no batch signal at all: fall back to one group per task,
  // so unrelated turn-less spawns cannot collapse into one immortal row.
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

function lifecycleCollapseMapKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }
  return entry.toolCallId ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}` : undefined;
}

function shouldCollapseToolLifecycle(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry
): boolean {
  const lifecycleKinds = new Set(["tool.updated", "tool.completed"]);
  if (!lifecycleKinds.has(previous.sourceActivityKind)) {
    return false;
  }
  if (!lifecycleKinds.has(next.sourceActivityKind)) {
    return false;
  }
  if (previous.turnId !== next.turnId) {
    return false;
  }
  // A completed row is terminal: a later call with the same label is a new call.
  if (previous.sourceActivityKind === "tool.completed") {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function mergeDerived(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry
): DerivedWorkLogEntry {
  const changedFiles = [...new Set([...(previous.changedFiles ?? []), ...(next.changedFiles ?? [])])];
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {})
  };
}

/** *T3: `session-logic.ts:718-810`.* */
function collapseDerivedWorkLogEntries(
  entries: readonly DerivedWorkLogEntry[]
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by SPAWN GROUP, not adjacency: a batch of spawns is
  // one narrative event in the chat no matter how their progress interleaves.
  const spawnRowIndex = new Map<string, number>();
  // Batch membership is decided once, at the FIRST row seen for a taskId —
  // completions arriving under later synthetic turns must not splinter it.
  const groupKeyByTaskId = new Map<string, string>();
  const lifecycleRowIndex = new Map<string, number>();

  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      !entry.isBackgroundTask &&
      (entry.sourceActivityKind === "task.started" ||
        entry.sourceActivityKind === "task.progress" ||
        entry.sourceActivityKind === "task.completed");

    if (isTaskRow && entry.taskId !== undefined) {
      const remembered = groupKeyByTaskId.get(entry.taskId);
      const groupKey = remembered ?? agentSpawnGroupKey(entry);
      if (remembered === undefined) {
        groupKeyByTaskId.set(entry.taskId, groupKey);
      }
      const workflowId = groupKey.startsWith("wf:") ? groupKey.slice(3) : null;
      const existingIndex = spawnRowIndex.get(groupKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex]!;
        const agentTaskIds = existing.agentSpawn?.agentTaskIds.includes(entry.taskId)
          ? existing.agentSpawn.agentTaskIds
          : [...(existing.agentSpawn?.agentTaskIds ?? []), entry.taskId];
        collapsed[existingIndex] = {
          ...mergeDerived(existing, entry),
          // The spawn row keeps the group's ANCHOR identity, never the last
          // agent's, so it renders where the run launched instead of drifting
          // below the whole conversation as progress ticks arrive.
          id: existing.id,
          createdAt: existing.createdAt,
          turnId: existing.turnId ?? null,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
          label: existing.label,
          agentSpawn: { workflowId, agentTaskIds }
        };
        continue;
      }
      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push({ ...entry, agentSpawn: { workflowId, agentTaskIds: [entry.taskId] } });
      continue;
    }

    const lifecycleKey = lifecycleCollapseMapKey(entry);
    if (lifecycleKey !== undefined) {
      const matchingIndex = lifecycleRowIndex.get(lifecycleKey);
      const matching = matchingIndex === undefined ? undefined : collapsed[matchingIndex];
      if (matchingIndex !== undefined && matching && shouldCollapseToolLifecycle(matching, entry)) {
        collapsed[matchingIndex] = mergeDerived(matching, entry);
        continue;
      }
      lifecycleRowIndex.delete(lifecycleKey);
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycle(previous, entry)) {
      const previousIndex = collapsed.length - 1;
      const previousKey = lifecycleCollapseMapKey(previous);
      if (previousKey !== undefined) {
        lifecycleRowIndex.delete(previousKey);
      }
      const merged = mergeDerived(previous, entry);
      collapsed[previousIndex] = merged;
      const mergedKey = lifecycleCollapseMapKey(merged);
      if (mergedKey !== undefined) {
        lifecycleRowIndex.set(mergedKey, previousIndex);
      }
      continue;
    }
    collapsed.push(entry);
    if (lifecycleKey !== undefined) {
      lifecycleRowIndex.set(lifecycleKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

// ---------------------------------------------------------------------------
// Splitting a thread's items
// ---------------------------------------------------------------------------

export interface SplitThreadItems {
  messages: ThreadMessageItem[];
  activities: ThreadActivityItem[];
  proposedPlans: ProposedPlanEntry[];
}

const isMessage = (item: ThreadItem): item is ThreadMessageItem => item.kind === "message";

/**
 * Split the fold's items into the three source arrays the timeline merges.
 *
 * A message stamped with an `agentId` belongs to that subagent, not to the
 * thread, so the parent's view drops it (§7.2) — but its own drill-in is the
 * one place it must appear, exactly as `deriveWorkLogEntries`'
 * `ownerAgentId` does for activity rows. Dropping it there too is how a
 * drill-in showed an agent's tool calls with none of the words that chose
 * them. Pass the drill-in's own agent id to keep its messages; the parent
 * passes nothing. The item list itself is filtered by {@link itemsForAgent}.
 */
export function splitThreadItems(
  items: readonly ThreadItem[],
  ownerAgentId?: string
): SplitThreadItems {
  const messages: ThreadMessageItem[] = [];
  const activities: ThreadActivityItem[] = [];
  const plansById = new Map<string, ProposedPlanEntry>();
  const planBuffers = new Map<string, string>();

  for (const item of items) {
    if (isMessage(item)) {
      const owner = item.agentId !== undefined && item.agentId.length > 0 ? item.agentId : undefined;
      if (owner !== ownerAgentId) {
        continue;
      }
      messages.push(item);
      continue;
    }
    if (item.activityKind === "turn.proposed.delta") {
      const delta = asTrimmedString(asRecord(item.payload)?.delta);
      if (delta) {
        const key = item.turnId ?? item.id;
        planBuffers.set(key, `${planBuffers.get(key) ?? ""}${delta}`);
      }
      continue;
    }
    if (item.activityKind === "turn.proposed.completed") {
      const planMarkdown =
        asTrimmedString(asRecord(item.payload)?.planMarkdown) ??
        planBuffers.get(item.turnId ?? item.id);
      if (planMarkdown) {
        plansById.set(item.id, {
          id: item.id,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          turnId: item.turnId,
          planMarkdown,
          implementedAt: null
        });
      }
      continue;
    }
    activities.push(item);
  }

  // A plan is retired by the turn that implements it (§7.3): the first user
  // message after it carrying the implementation prefix.
  const proposedPlans = [...plansById.values()].map((plan) => {
    const implementing = messages.find(
      (message) =>
        message.role === "user" &&
        message.createdAt > plan.createdAt &&
        message.text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)
    );
    return implementing ? { ...plan, implementedAt: implementing.createdAt } : plan;
  });

  return { messages, activities, proposedPlans };
}

/** The per-agent drill-in view: that agent's own items, in order (§7.6). */
export function itemsForAgent(items: readonly ThreadItem[], agentId: string): ThreadItem[] {
  return items.filter((item) => item.agentId === agentId);
}

// ---------------------------------------------------------------------------
// Layer 1: sources → ordered timeline entries, with the streaming fast paths
// ---------------------------------------------------------------------------

function timelineEntryFromMessage(message: ThreadMessageItem): TimelineEntry {
  return { kind: "message", id: message.id, createdAt: message.createdAt, message };
}

function timelineEntryFromProposedPlan(proposedPlan: ProposedPlanEntry): TimelineEntry {
  return {
    kind: "proposed-plan",
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    proposedPlan
  };
}

function timelineEntryFromWork(entry: WorkLogEntry): TimelineEntry {
  return { kind: "work", id: entry.id, createdAt: entry.createdAt, entry };
}

function compareByCreatedAt(left: TimelineEntry, right: TimelineEntry): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function sourceOrder(entry: TimelineEntry): number {
  switch (entry.kind) {
    case "message":
      return 0;
    case "proposed-plan":
      return 1;
    case "work":
      return 2;
  }
}

function shouldTakePrevious(previous: TimelineEntry, suffix: TimelineEntry): boolean {
  const comparison = compareByCreatedAt(previous, suffix);
  if (comparison !== 0) {
    return comparison < 0;
  }
  return sourceOrder(previous) <= sourceOrder(suffix);
}

export function hasExactArrayPrefix<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous === next) {
    return true;
  }
  if (next.length < previous.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function mergeSuffix(
  previous: readonly TimelineEntry[],
  suffix: readonly TimelineEntry[]
): TimelineEntry[] {
  if (suffix.length === 0) {
    return [...previous];
  }
  const previousLast = previous.at(-1);
  let suffixIsOrdered = true;
  for (let index = 1; index < suffix.length; index += 1) {
    if (compareByCreatedAt(suffix[index - 1]!, suffix[index]!) > 0) {
      suffixIsOrdered = false;
      break;
    }
  }
  if (
    suffixIsOrdered &&
    (previousLast === undefined || shouldTakePrevious(previousLast, suffix[0]!))
  ) {
    return [...previous, ...suffix];
  }
  const merged: TimelineEntry[] = [];
  let previousIndex = 0;
  let suffixIndex = 0;
  while (previousIndex < previous.length || suffixIndex < suffix.length) {
    const previousEntry = previous[previousIndex];
    const suffixEntry = suffix[suffixIndex];
    if (
      previousEntry !== undefined &&
      (suffixEntry === undefined || shouldTakePrevious(previousEntry, suffixEntry))
    ) {
      merged.push(previousEntry);
      previousIndex += 1;
    } else if (suffixEntry !== undefined) {
      merged.push(suffixEntry);
      suffixIndex += 1;
    }
  }
  return merged;
}

const streamsText = (role: ThreadMessageItem["role"]): boolean =>
  role === "assistant" || role === "reasoning";

/** Text and update time do not change a streaming message's structure. *T3: `:1620-1631`.* */
export function isStreamingMessageTextUpdate(
  previous: ThreadMessageItem,
  next: ThreadMessageItem
): boolean {
  if (!streamsText(previous.role) || previous.role !== next.role) {
    return false;
  }
  if (!previous.streaming || !next.streaming) {
    return false;
  }
  return (
    previous.id === next.id &&
    previous.turnId === next.turnId &&
    previous.createdAt === next.createdAt &&
    previous.agentId === next.agentId &&
    previous.attachments === next.attachments &&
    previous.context === next.context
  );
}

function replaceStreamingTimelineMessages(
  messages: readonly ThreadMessageItem[],
  previous: TimelineEntriesProjection
): TimelineEntry[] | null {
  if (messages.length !== previous.messages.length) {
    return null;
  }
  const replacements = new Map<ThreadMessageItem, ThreadMessageItem>();
  for (const [index, message] of messages.entries()) {
    const previousMessage = previous.messages[index]!;
    if (message === previousMessage) {
      continue;
    }
    if (!isStreamingMessageTextUpdate(previousMessage, message)) {
      return null;
    }
    replacements.set(previousMessage, message);
  }
  if (replacements.size === 0) {
    return previous.entries;
  }
  return previous.entries.map((entry) => {
    const replacement = entry.kind === "message" ? replacements.get(entry.message) : undefined;
    return replacement ? timelineEntryFromMessage(replacement) : entry;
  });
}

/**
 * Reuse ordered entries across immutable stream updates; anything else keeps
 * the full sort. Three paths, cheapest first: a streaming-text replacement, a
 * strict-prefix append, then a rebuild.
 *
 * *T3: `session-logic.ts:1652-1715`.*
 */
export function deriveTimelineEntriesWithState(
  messages: readonly ThreadMessageItem[],
  proposedPlans: readonly ProposedPlanEntry[],
  workEntries: readonly WorkLogEntry[],
  previous: TimelineEntriesProjection | null = null
): TimelineEntriesProjection {
  if (
    previous !== null &&
    previous.proposedPlans.length === proposedPlans.length &&
    previous.workEntries.length === workEntries.length &&
    hasExactArrayPrefix(previous.proposedPlans, proposedPlans) &&
    hasExactArrayPrefix(previous.workEntries, workEntries)
  ) {
    const entries = replaceStreamingTimelineMessages(messages, previous);
    if (entries !== null) {
      return { messages, proposedPlans, workEntries, entries };
    }
  }

  // An answered question folds out of the message list (§7.3).
  const foldedAnswerMessageIds = new Set(
    workEntries.flatMap((entry) =>
      entry.questionAnswer ? [`async-answer:${entry.questionAnswer.requestId}`] : []
    )
  );
  const showMessage = (message: ThreadMessageItem): boolean =>
    message.role !== "user" || !foldedAnswerMessageIds.has(message.id);

  const canAppend =
    previous !== null &&
    // The append path must not reuse a projection that still contains a
    // message the fold has since folded away.
    !previous.entries.some((entry) => entry.kind === "message" && !showMessage(entry.message)) &&
    hasExactArrayPrefix(previous.messages, messages) &&
    hasExactArrayPrefix(previous.proposedPlans, proposedPlans) &&
    hasExactArrayPrefix(previous.workEntries, workEntries);

  if (canAppend) {
    const suffix = [
      ...messages.slice(previous.messages.length).filter(showMessage).map(timelineEntryFromMessage),
      ...proposedPlans.slice(previous.proposedPlans.length).map(timelineEntryFromProposedPlan),
      ...workEntries.slice(previous.workEntries.length).map(timelineEntryFromWork)
    ].sort(compareByCreatedAt);
    return {
      messages,
      proposedPlans,
      workEntries,
      entries: mergeSuffix(previous.entries, suffix)
    };
  }

  const entries = [
    ...messages.filter(showMessage).map(timelineEntryFromMessage),
    ...proposedPlans.map(timelineEntryFromProposedPlan),
    ...workEntries.map(timelineEntryFromWork)
  ].sort(compareByCreatedAt);
  return { messages, proposedPlans, workEntries, entries };
}

/** The projection kept between renders, with the inputs its fast paths compare. */
export interface ThreadTimelineProjection extends TimelineEntriesProjection {
  readonly items: readonly ThreadItem[];
  readonly activities: readonly ThreadActivityItem[];
  /** Set on a drill-in projection; part of the work-entries memo key. */
  readonly ownerAgentId?: string;
}

function sameByIdentity<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) {
    return true;
  }
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

function samePlans(left: readonly ProposedPlanEntry[], right: readonly ProposedPlanEntry[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((plan, index) => {
    const other = right[index]!;
    return (
      plan.id === other.id &&
      plan.planMarkdown === other.planMarkdown &&
      plan.implementedAt === other.implementedAt &&
      plan.updatedAt === other.updatedAt
    );
  });
}

/**
 * The whole layer, from a fold's items.
 *
 * `splitThreadItems` allocates fresh arrays on every call, so the two derived
 * source arrays are compared against the previous projection **element-wise**
 * and reused when nothing moved. That is what keeps a streamed assistant token
 * — which changes one message object and nothing else — from rebuilding every
 * work-log row and defeating layer 2's `===` fast path (§7.2).
 */
export function deriveTimelineEntriesFromItems(
  items: readonly ThreadItem[],
  previous: ThreadTimelineProjection | null = null,
  options?: DeriveWorkLogOptions
): ThreadTimelineProjection {
  const ownerAgentId = options?.ownerAgentId;
  if (previous !== null && previous.items === items && previous.ownerAgentId === ownerAgentId) {
    return previous;
  }
  const split = splitThreadItems(items, ownerAgentId);
  const activities =
    previous !== null && sameByIdentity(previous.activities, split.activities)
      ? previous.activities
      : split.activities;
  const workEntries =
    activities === previous?.activities && previous.ownerAgentId === ownerAgentId
      ? previous.workEntries
      : deriveWorkLogEntries(activities, options);
  const proposedPlans =
    previous !== null && samePlans(previous.proposedPlans, split.proposedPlans)
      ? previous.proposedPlans
      : split.proposedPlans;
  const projection = deriveTimelineEntriesWithState(
    split.messages,
    proposedPlans,
    workEntries,
    previous
  );
  return {
    ...projection,
    items,
    activities,
    ...(ownerAgentId !== undefined ? { ownerAgentId } : {})
  };
}

export const EMPTY_TIMELINE_PROJECTION: ThreadTimelineProjection = {
  items: [],
  activities: [],
  messages: [],
  proposedPlans: [],
  workEntries: [],
  entries: []
};
