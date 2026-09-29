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
import {
  anchorsCall,
  CALL_CLOSER_KINDS,
  CALL_OPENER_KINDS,
  commandDisplayDetail,
  compactionMarkerState,
  IDENTITY_CHANGED_ACTIVITY_KIND,
  isAgentOwnedActivity,
  isCompactionActivity,
  isPlanImplementationMessage,
  reEmittedAssistantCopies
} from "@orquester/api/agent-chat";

import type { WorkLogEntry, WorkLogToolLifecycleStatus } from "./contracts";
import { goalMarkerOf, goalUpdateOf, isHiddenGoalActivity } from "./goal.logic";
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
  /**
   * The wire cut `planMarkdown` at 16 KiB (§5.6); `GET …/items/:id` holds the
   * whole plan, and Implement must send that one.
   */
  truncated?: true;
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
function toolLifecycleStatusFromPayload(
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
  const data = asRecord(payload?.data);
  const isTaskActivity = TASK_KINDS.has(activity.activityKind);

  const taskSummary = isTaskActivity ? asTrimmedString(payload?.summary) : undefined;
  const taskDetailAsLabel =
    isTaskActivity && !taskSummary ? asTrimmedString(payload?.detail) : undefined;
  const taskLabel = taskSummary ?? taskDetailAsLabel;
  const detail = isTaskActivity
    ? taskDetailAsLabel
      ? undefined
      : asTrimmedString(payload?.detail)
    : CALL_LIFECYCLE_KINDS.has(activity.activityKind)
      ? callRowDetail(asTrimmedString(payload?.detail), asTrimmedString(data?.toolName))
      : asTrimmedString(payload?.detail);
  const command = asTrimmedString(payload?.command) ?? asTrimmedString(data?.command);
  // A command row shows the output its provider data carries where `detail`
  // only echoes the command or repeats the title — one rule in
  // `@orquester/api` (`command-output.ts`), shared with the MCP's transcript.
  // It is given the detail kept above: a task row's may have become its label.
  const displayDetail = commandDisplayDetail(payload, { detail });

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
  } else if (displayDetail) {
    entry.detail = displayDetail;
  } else if (
    activity.activityKind === "runtime.error" ||
    activity.activityKind === "runtime.warning"
  ) {
    const message = asTrimmedString(payload?.message);
    if (message && message !== activity.summary) {
      entry.detail = message;
    }
  }

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
  // A chunk of a command's streamed output: the call's whole output is the
  // host's join of such chunks (`streamedOutput`). A file change streams its
  // result text too, which is no command's output. A Claude background
  // shell's lifecycle rows say so with no chunk in view: its output only ever
  // streams (`isBackgroundShellCall`).
  if (
    toolUseId &&
    ((outputChunk !== undefined && isCommandOutputChunk(payload)) ||
      (CALL_LIFECYCLE_KINDS.has(activity.activityKind) &&
        isBackgroundShellCall(toolUseId) &&
        payload?.itemType !== "file_change"))
  ) {
    entry.streamedOutput = true;
  }
  // Promoted by §5.1 so the presentation layer can nest a hook run or a
  // CLI-side denial under the call that triggered it (fix-wave R7-10).
  if (activity.parentToolUseId) {
    entry.parentToolUseId = activity.parentToolUseId;
  }
  if (activity.activityKind === "mcp_tool_call" || entry.itemType === "mcp_tool_call") {
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

  // Gates the row's ITEM read ("Load full output" where §5.6 cut the payload):
  // the rest is behind `GET …/items/:itemId` (§5.6, §6.3). Never a start's:
  // what the read cut there is the call's input, not its output — the MCP
  // names no start as a call's `outputItemId` for a cut payload either. A
  // start of a command whose output streamed does offer "Load full output",
  // through `streamedOutput`: it reads the call's join, never the start's item
  // (the GUI spec's §6.3 note on `GET …/items/:itemId/output`). Nor a task
  // row's: a launch's cut is its prompt, which the drill-in's prompt row reads
  // whole ("Show full prompt", in a viewer titled "Prompt"), and no task row
  // is a tool's output — the spawn row it merges into would have offered its
  // payload as JSON.
  if (payload?.truncated === true && activity.activityKind !== "tool.started" && !isTaskActivity) {
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

  // Goals §8.4: a goal update is a marker, read through the shared parser. A
  // row that does not parse gets no `goal` and stays the generic row, with the
  // summary the host wrote (goals §9).
  const goalUpdate = goalUpdateOf(activity);
  if (goalUpdate !== null) {
    entry.goal = goalMarkerOf(goalUpdate);
  }

  // §3.4's account switch: ids only, the label resolves at render time.
  if (activity.activityKind === IDENTITY_CHANGED_ACTIVITY_KIND) {
    const identity = asRecord(activity.payload);
    if (identity && typeof identity.accountId === "string") {
      const previousAccountId = asTrimmedString(identity.previousAccountId);
      entry.accountSwitch = {
        accountId: identity.accountId,
        ...(previousAccountId ? { previousAccountId } : {})
      };
    }
  }

  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  derivedByActivity.set(activity, entry);
  return entry;
}

/**
 * A lifecycle row's detail. Claude names a call's tool with its input echoed
 * — `summarizeToolRequest(name, input)` — and its start frame does so before
 * any of that input has streamed: "Write: {}". The call's first update comes
 * only once the input parses whole, seconds later for a `Write` or a
 * subagent's prompt, and never for a tool that takes no arguments: its start
 * is its only row until its result, and its completion echoes the same empty
 * input. The empty input names nothing, so a lifecycle row of the call
 * (start, update, completion) keeps the tool's name alone — "Write", "Agent",
 * "mcp__x__list": a start reads it meanwhile, and a no-argument call's label
 * never gains ": {}" as it completes. Only an echo of the row's OWN tool, the
 * `data.toolName` Claude writes on every row of a call: another provider's
 * detail can be the tool's own output — OpenCode's completion is — and an
 * output that reads "config: {}" is kept whole. A nested (subagent) frame
 * carries its whole input from the start.
 */
function callRowDetail(detail: string | undefined, toolName: string | undefined): string | undefined {
  const echo = detail === undefined ? null : /^([^\s:]+): \{\}$/.exec(detail);
  return echo !== null && echo[1] === toolName ? echo[1] : detail;
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
  // The ownership half is `@orquester/api`'s: the conversation's compaction
  // marker is decided by the same test on the host and in the MCP.
  const ownedByAgent = isAgentOwnedActivity(activity);
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

// ---------------------------------------------------------------------------
// Older logs: a subagent's output chunk written without its owner
// ---------------------------------------------------------------------------

/**
 * Claude wrote a subagent's command and file-change output with no agent id
 * while every other row of the call carried one (fixture claude/07); the
 * adapter stamps the chunk now, but a log keeps what a host from before that
 * wrote, and an older host surviving a deploy writes such chunks until its
 * drain-restart. Read as it stands, such a chunk is the PARENT's: a stray
 * "Tool output" row in the parent timeline, and nothing in the agent's
 * drill-in. So, on the read side only — the fold, its retention
 * and the history bridge keep mirroring the log — an UNSTAMPED `tool.output`
 * row inherits the owner of its call's lifecycle rows (`tool.started`,
 * `tool.updated`, `tool.completed`, `tool.denied` of the same `toolUseId`
 * with a non-blank `agentId`) found in the same derivation input. A chunk
 * whose call has no owned row there stays the parent's, as before.
 */
const CALL_LIFECYCLE_KINDS: ReadonlySet<string> = new Set([...CALL_OPENER_KINDS, ...CALL_CLOSER_KINDS]);

/** A non-blank agent id as written: views compare ids verbatim (`ownedByAgent`). */
const nonBlankId = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** `toolUseId` → the agent that owns the call, read off its lifecycle rows. */
function callOwnersOf(items: readonly ThreadItem[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "activity" || !CALL_LIFECYCLE_KINDS.has(item.activityKind)) {
      continue;
    }
    const payload = asRecord(item.payload);
    const callId = asTrimmedString(payload?.toolUseId);
    const owner = nonBlankId(item.agentId) ?? nonBlankId(payload?.agentId);
    if (callId !== undefined && owner !== undefined) {
      owners.set(callId, owner);
    }
  }
  return owners;
}

/** A `tool.output` row that names no owner of its own. */
function isUnstampedOutputChunk(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity" && item.activityKind === "tool.output" && !isAgentOwnedActivity(item);
}

/** The agent an unstamped chunk's call belongs to, if the input holds an owned row of it. */
function inheritedChunkOwner(
  chunk: ThreadActivityItem,
  callOwners: ReadonlyMap<string, string>
): string | undefined {
  const callId = asTrimmedString(asRecord(chunk.payload)?.toolUseId);
  return callId === undefined ? undefined : callOwners.get(callId);
}

// ---------------------------------------------------------------------------
// A started call's own row
// ---------------------------------------------------------------------------

/**
 * A call's `tool.started` is its row while the derivation input holds no other
 * lifecycle row of the call (`tool.updated`, `tool.completed`, `tool.denied`):
 * each of those says at least what the start says, and supersedes it. T3 drops
 * every start ("always followed by an update"), which holds for none of
 * Codex's commands — a start, output chunks, then the completion — nor for a
 * Claude tool whose input is empty, so a running command showed no title, only
 * the text of its latest chunk. The fold keeps a running call's opening row
 * whatever its age, within a cap (`open-work.ts`), and the rows of one call
 * are derived together wherever they lie — the history's pages and bridge are
 * one input, and a window row of a call the history began joins it, its
 * denial included (`splitLiveItems`) — so the row that closes a call is in
 * its start's input whenever both are loaded. The fold's own limit aside: a
 * close written in another owner's window can age out before the opening row
 * it closes (`open-work.ts`), and the call then reads as running again.
 *
 * Still dropped: an unkeyed start, which nothing ties to its call; and a start
 * with neither a turn nor an owner. The Claude normaliser writes none any
 * more, but a log written before 2026-09-28 holds them: a PARENT call
 * registered while no turn was open outside a held message — the tail of an
 * interrupted message, and every woken call before the held opening message —
 * emitted its start and any early input update turnless, and the turn that
 * opened adopted it with one update on it (the since-removed
 * `adoptedToolEvent`), the running call's live row. A rewind of that
 * turn leaves the turnless rows as all there is of the call, and none reads
 * as running: the start is dropped here (superseded by the update, else as
 * turnless and ownerless — a start that does not anchor its call,
 * `anchorsCall` in `@orquester/api`), and a turnless update still in
 * progress is a neutral row a group hides (`workEntryIsVisibleInGroup`). The
 * MCP's transcript builds no entry from them either, and a host's first load
 * writes them no closer, which would bring the call back as a failed row.
 */
function startIsCallRow(activity: ThreadActivityItem, supersededCalls: ReadonlySet<string>): boolean {
  const callId = asTrimmedString(asRecord(activity.payload)?.toolUseId);
  if (callId === undefined || supersededCalls.has(callId)) {
    return false;
  }
  return anchorsCall(activity);
}

// ---------------------------------------------------------------------------
// A chunk headed like its call
// ---------------------------------------------------------------------------

/** What a call's lifecycle rows name it: the latest command and title they give. */
interface CallHeading {
  command?: string;
  title?: string;
}

function noteCallHeading(
  headings: Map<string, CallHeading>,
  callId: string,
  payload: Record<string, unknown> | null
): void {
  const command = asTrimmedString(payload?.command) ?? asTrimmedString(asRecord(payload?.data)?.command);
  const title = asTrimmedString(payload?.title);
  if (command === undefined && title === undefined) {
    return;
  }
  const heading = headings.get(callId) ?? {};
  if (command !== undefined) {
    heading.command = command;
  }
  if (title !== undefined) {
    heading.title = title;
  }
  headings.set(callId, heading);
}

const headedChunkByActivity = new WeakMap<
  ThreadActivityItem,
  { readonly heading: CallHeading; readonly entry: DerivedWorkLogEntry }
>();

/**
 * A streamed chunk carrying its call's command and title, as the input's
 * lifecycle rows of the call give them. Absorbed into its call's row it adds
 * nothing; rendered apart — a row that splits a running command's group, say
 * — its row is headed like the call's (`workEntryDisplayLabel`), never with
 * its text. Memoised per activity and heading, so a derivation that names the
 * same call returns the same object.
 */
function headedChunk(activity: ThreadActivityItem, heading: CallHeading): DerivedWorkLogEntry {
  const cached = headedChunkByActivity.get(activity);
  if (cached && cached.heading.command === heading.command && cached.heading.title === heading.title) {
    return cached.entry;
  }
  const entry: DerivedWorkLogEntry = {
    ...derivedWorkLogEntry(activity),
    ...(heading.command !== undefined ? { command: heading.command } : {}),
    ...(heading.title !== undefined ? { toolTitle: heading.title } : {})
  };
  headedChunkByActivity.set(activity, { heading: { ...heading }, entry });
  return entry;
}

// ---------------------------------------------------------------------------
// A call that streamed a command's output
// ---------------------------------------------------------------------------

/** A `tool.output` payload that is a command's printed output — never a file change's result text. */
function isCommandOutputChunk(payload: Record<string, unknown> | null): boolean {
  return payload?.streamKind === "command_output";
}

/**
 * The call id a Claude background shell's rows carry: the adapter names the
 * shell's own item `bgshell:<taskId>` (`backgroundShellItemId`,
 * `apps/daemon/src/agent-host/adapters/claude/normalize.ts`), and every
 * lifecycle row of it has that `toolUseId`. Such a call's output only ever
 * streams — the CLI writes it to a file the session tails into
 * `command_output` chunks, and its rows carry at most the command and an exit
 * code — so its rows say it streamed even with none of its chunks in view: in
 * a busy fleet the cross-agent ceiling can evict every chunk of a quiet shell
 * while retention keeps its start (open work). A shell that printed nothing
 * answers an empty join, and the viewer falls back to the item read.
 */
const BACKGROUND_SHELL_CALL_PREFIX = "bgshell:";

function isBackgroundShellCall(callId: string): boolean {
  return callId.startsWith(BACKGROUND_SHELL_CALL_PREFIX);
}

const streamedCallRowByActivity = new WeakMap<ThreadActivityItem, DerivedWorkLogEntry>();

/**
 * A lifecycle row of a call whose command output streamed, marked so
 * (`streamedOutput`): the call's whole output is the host's join of its
 * chunks (`GET …/items/:itemId/output`), which its row's "Load full output"
 * reads — whether or not its own payload was cut. Read off the derivation
 * input, never off the row's own group: a long command's early chunks age
 * out of the window while its later ones stay, and a row that splits the
 * run (a hoisted error, a message) can leave those in another group than the
 * call's row, where `joinLifecycleDetails` never meets them. The MCP's
 * transcript counts a call's chunks the same way, wherever they fall in its
 * view. A file change is never marked: its chunks are the tool's result
 * text. Memoised per activity, so a derivation that holds the call's output
 * returns the same object.
 */
function streamedCallRow(activity: ThreadActivityItem): DerivedWorkLogEntry {
  const base = derivedWorkLogEntry(activity);
  // A background shell's row says so on its own (`isBackgroundShellCall`).
  if (base.streamedOutput === true) {
    return base;
  }
  const cached = streamedCallRowByActivity.get(activity);
  if (cached) {
    return cached;
  }
  const entry: DerivedWorkLogEntry = { ...base, streamedOutput: true };
  streamedCallRowByActivity.set(activity, entry);
  return entry;
}

/** Whether `activity` is a lifecycle row of one of `streamedCalls`, and no file change. */
function isStreamedCallRow(activity: ThreadActivityItem, streamedCalls: ReadonlySet<string>): boolean {
  if (!CALL_LIFECYCLE_KINDS.has(activity.activityKind)) {
    return false;
  }
  const payload = asRecord(activity.payload);
  const callId = asTrimmedString(payload?.toolUseId);
  return callId !== undefined && streamedCalls.has(callId) && payload?.itemType !== "file_change";
}

/** Activity kinds that never become a work-log row. */
const DROPPED_ACTIVITY_KINDS = new Set([
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

/**
 * `ExitPlanMode` is a plan boundary, not a tool the user cares about. *T3:
 * `:528-540`; differs: a start is a row too (`startIsCallRow`), and Claude's
 * reads `ExitPlanMode: {}` until the plan streams into the call's input — and,
 * in a log written before 2026-09-28, the update that adopted a call before
 * its input parsed names the tool alone (the since-removed
 * `adoptedToolEvent`).*
 */
function isPlanBoundaryToolActivity(activity: ThreadActivityItem): boolean {
  if (
    activity.activityKind !== "tool.started" &&
    activity.activityKind !== "tool.updated" &&
    activity.activityKind !== "tool.completed"
  ) {
    return false;
  }
  const detail = asRecord(activity.payload)?.detail;
  return typeof detail === "string" && (detail === "ExitPlanMode" || detail.startsWith("ExitPlanMode:"));
}

/**
 * The compaction marker's activity kind, and which of its three states a row
 * is (§7.3). One rule in `@orquester/api` (`compaction.ts`), shared with the
 * host's thread index and the MCP; re-exported for this module's importers.
 */
export { compactionMarkerState, isCompactionActivity };

/** Before/after token counts, carried on the event and formatted client-side (§7.3). */
function compactionTokens(activity: ThreadActivityItem): {
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
   * quiet-timeline filter a second time and showed nothing. Its own task rows
   * (`payload.taskId` naming it — Codex, OpenCode and Grok stamp them with its
   * id) are the one exception: they are the agent itself, never a spawn row
   * inside its own view.
   */
  readonly ownerAgentId?: string;
}

function ownedByAgent(activity: ThreadActivityItem, agentId: string | undefined): boolean {
  if (agentId === undefined) {
    return false;
  }
  return activity.agentId === agentId || asRecord(activity.payload)?.agentId === agentId;
}

/** A task row OF the drill-in's own agent (`payload.taskId`), not of an agent it launched. */
function isOwnTaskRow(activity: ThreadActivityItem, agentId: string | undefined): boolean {
  return (
    agentId !== undefined &&
    TASK_KINDS.has(activity.activityKind) &&
    asTrimmedString(asRecord(activity.payload)?.taskId) === agentId
  );
}

export function deriveWorkLogEntries(
  activities: readonly ThreadActivityItem[],
  options?: DeriveWorkLogOptions
): WorkLogEntry[] {
  // A launch tool and its task lifecycle describe the same run. Only hide the
  // launch row once its tool-use id has an agent row to replace it.
  const agentLaunchToolIds = new Set<string>();
  // The calls whose start another of their lifecycle rows supersedes (`startIsCallRow`).
  const supersededCalls = new Set<string>();
  // What each call's lifecycle rows name it, for its chunks (`headedChunk`).
  const callHeadings = new Map<string, CallHeading>();
  // The calls whose command output streamed, for their rows (`streamedCallRow`).
  const streamedCalls = new Set<string>();
  for (const activity of activities) {
    if (CALL_LIFECYCLE_KINDS.has(activity.activityKind)) {
      const payload = asRecord(activity.payload);
      const toolUseId = asTrimmedString(payload?.toolUseId);
      if (toolUseId) {
        if (activity.activityKind !== "tool.started") {
          supersededCalls.add(toolUseId);
        }
        noteCallHeading(callHeadings, toolUseId, payload);
      }
      continue;
    }
    if (activity.activityKind === "tool.output") {
      const payload = asRecord(activity.payload);
      const toolUseId = asTrimmedString(payload?.toolUseId);
      if (toolUseId && isCommandOutputChunk(payload)) {
        streamedCalls.add(toolUseId);
      }
      continue;
    }
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

  // For an older log's unstamped chunk (see `callOwnersOf`). Built at the
  // first unstamped chunk — and the parent's own command output is unstamped
  // too, so that is nearly every thread: one more pass over the input.
  let callOwners: Map<string, string> | undefined;

  const derived: DerivedWorkLogEntry[] = [];
  for (const activity of activities) {
    // Hook notifications are provider bookkeeping. Keep failed or cancelled
    // completions, including those already present in persisted transcripts.
    if (activity.activityKind === "hook.started" || activity.activityKind === "hook.progress") {
      continue;
    }
    if (
      activity.activityKind === "hook.completed" &&
      asRecord(activity.payload)?.outcome === "success"
    ) {
      continue;
    }
    if (DROPPED_ACTIVITY_KINDS.has(activity.activityKind)) {
      continue;
    }
    if (activity.activityKind === "tool.started" && !startIsCallRow(activity, supersededCalls)) {
      continue;
    }
    // Goals §8.4: `progress` is the goal's heartbeat — it keeps the chip
    // current and is not narrative.
    if (isHiddenGoalActivity(activity)) {
      continue;
    }
    if (activity.activityKind === "task.started" && !isAgentTaskStartedActivity(activity)) {
      continue;
    }
    // A drill-in never lists its own agent as a spawn row. Codex, OpenCode
    // and Grok stamp an agent's own task rows with its id, so they are the
    // agent's rows too — but they describe the agent itself, which the
    // drill-in's header and the roster already say (R8).
    if (isOwnTaskRow(activity, options?.ownerAgentId)) {
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
    // An older log's unstamped chunk of an agent's call is that agent's, and
    // renders in its view alone (see `callOwnersOf`).
    if (isUnstampedOutputChunk(activity)) {
      callOwners ??= callOwnersOf(activities);
      const inherited = inheritedChunkOwner(activity, callOwners);
      if (inherited !== undefined && inherited !== options?.ownerAgentId) {
        continue;
      }
    }
    const heading =
      activity.activityKind === "tool.output"
        ? callHeadings.get(asTrimmedString(asRecord(activity.payload)?.toolUseId) ?? "")
        : undefined;
    const entry =
      heading !== undefined
        ? headedChunk(activity, heading)
        : isStreamedCallRow(activity, streamedCalls)
          ? streamedCallRow(activity)
          : derivedWorkLogEntry(activity);
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

export interface SplitThreadItemsOptions {
  /**
   * Drop the re-emitted assistant copies an old Claude log holds
   * (`reEmittedAssistantCopies`, `@orquester/api/agent-chat` — the one rule
   * the MCP applies too). Claude threads only: the store asks
   * `repairsReEmittedAssistantCopies` with the thread head's adapter.
   */
  readonly dropRepeatedAssistantMessages?: boolean;
}

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
  ownerAgentId?: string,
  options?: SplitThreadItemsOptions
): SplitThreadItems {
  const messages: ThreadMessageItem[] = [];
  const activities: ThreadActivityItem[] = [];
  const plansById = new Map<string, ProposedPlanEntry>();
  const planBuffers = new Map<string, string>();
  const reEmitted =
    options?.dropRepeatedAssistantMessages === true ? reEmittedAssistantCopies(items, ownerAgentId) : null;

  for (const item of items) {
    if (isMessage(item)) {
      const owner = item.agentId !== undefined && item.agentId.length > 0 ? item.agentId : undefined;
      if (owner !== ownerAgentId) {
        continue;
      }
      if (reEmitted !== null && reEmitted.has(item.id)) {
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
      const payload = asRecord(item.payload);
      const sent = asTrimmedString(payload?.planMarkdown);
      const planMarkdown = sent ?? planBuffers.get(item.turnId ?? item.id);
      if (planMarkdown) {
        plansById.set(item.id, {
          id: item.id,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          turnId: item.turnId,
          planMarkdown,
          implementedAt: null,
          ...(sent !== undefined && payload?.truncated === true ? { truncated: true as const } : {})
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
        isPlanImplementationMessage(message.text)
    );
    return implementing ? { ...plan, implementedAt: implementing.createdAt } : plan;
  });

  return { messages, activities, proposedPlans };
}

/**
 * Whether an item of `items` is `agentId`'s own: stamped with it, or an older
 * log's unstamped output chunk of one of its calls (see `callOwnersOf`). One
 * test per window, so a caller walking the window for more than the agent's
 * items (the drill-in's launches) does it in the same pass — beside one walk
 * of its own: the call-owner map, built at the first unstamped chunk.
 */
export function agentItemFilter(items: readonly ThreadItem[], agentId: string): (item: ThreadItem) => boolean {
  // Built at the first unstamped chunk; the parent's own output is one, so
  // nearly always.
  let callOwners: Map<string, string> | undefined;
  return (item) => {
    if (item.agentId === agentId) {
      return true;
    }
    if (!isUnstampedOutputChunk(item)) {
      return false;
    }
    callOwners ??= callOwnersOf(items);
    return inheritedChunkOwner(item, callOwners) === agentId;
  };
}

/**
 * The per-agent drill-in view: that agent's own items, in order (§7.6) — and
 * an older log's unstamped output chunks of this agent's calls, which are its
 * own too (see `callOwnersOf`).
 */
export function itemsForAgent(items: readonly ThreadItem[], agentId: string): ThreadItem[] {
  return items.filter(agentItemFilter(items, agentId));
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
  /** Set when re-emitted copies were dropped; part of the memo key. */
  readonly dropsRepeatedAssistantMessages?: boolean;
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
      plan.truncated === other.truncated &&
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
  options?: DeriveWorkLogOptions & SplitThreadItemsOptions
): ThreadTimelineProjection {
  const ownerAgentId = options?.ownerAgentId;
  const dropsRepeats = options?.dropRepeatedAssistantMessages === true;
  if (
    previous !== null &&
    previous.items === items &&
    previous.ownerAgentId === ownerAgentId &&
    (previous.dropsRepeatedAssistantMessages === true) === dropsRepeats
  ) {
    return previous;
  }
  const split = splitThreadItems(items, ownerAgentId, options);
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
    ...(ownerAgentId !== undefined ? { ownerAgentId } : {}),
    ...(dropsRepeats ? { dropsRepeatedAssistantMessages: true } : {})
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
