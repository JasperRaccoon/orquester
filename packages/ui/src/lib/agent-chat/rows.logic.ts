/**
 * Agent chat — layers 2 and 3: timeline entries → rows → stable rows (§7.2, §7.3).
 *
 * Ported from T3 Code (MIT):
 * `apps/web/src/components/chat/MessagesTimeline.logic.ts`
 * (`deriveMessagesTimelineRows`, `deriveTurnFolds`,
 * `attachTrailingToolGroupsToAssistant`, `replaceStreamingMessageRows`,
 * `computeStableMessagesTimelineRows` and its per-variant `isRowUnchanged`).
 *
 * **Activity-group boundaries are mechanical** (§7.3): a group starts at the
 * first reasoning row or plain tool row of a turn and runs until a non-grouping
 * entry, a turn-id change, or a row the user collapsed out. Errors, answered
 * questions, subagent-spawn rows, compaction markers and a goal's own rows
 * (goals §8.4) are hoisted out as their own rows — an error must never hide
 * inside a collapsed summary line — and a run with no reasoning row is a plain
 * tool group, not an activity group.
 *
 * `isRowUnchanged` is hand-written per variant on purpose: React 18 with no
 * compiler means identity preservation is the whole performance story, and a
 * deep equality here would cost more than the render it saves.
 *
 * A timeline split into the loaded history and the retained window (design
 * 2026-09-23) derives both parts here; `continuesBelow`, `activeTurnHeader`
 * and `liveActivityAbove` put a running turn's live rows exactly where one
 * whole timeline would — the live tail at the very end, the "Working…" header
 * after the last prompt, whichever part holds it.
 *
 * A message's liveness is `isMessageStreaming`'s (`@orquester/api/agent-chat`)
 * against the thread's context (`messageStreaming`), never its bare flag: the
 * log keeps `streaming: true` for good on words a dead host or an unclosed
 * agent left. The message row's `streaming` and the fold a streaming answer
 * keeps open read it. The streamed-text fast path and the (unrendered)
 * duration boundaries read the flag, which is what a delta merges on.
 *
 * No React import.
 */

import {
  GOAL_STATUS_ACTIVITY_KIND,
  isMessageStreaming,
  isProviderInternalUserText,
  isSettledTurnState,
  NOTHING_STREAMS,
  startedTurns,
  type Checkpoint,
  type LatestTurnSummary,
  type MessageStreamingContext,
  type ThreadMessageItem,
  type Turn
} from "@orquester/api/agent-chat";

import type {
  AgentChatTimelineRow,
  QueuedComposerMessage,
  WorkLogEntry
} from "./contracts";
import { agentPromptOf } from "./agent-prompt.logic";
import { isStreamingMessageTextUpdate, type TimelineEntry } from "./entries.logic";
import {
  omitSupersededLifecycleMarkers,
  singleToolCallLabel,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  withoutJoinedOutput,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIsActiveTurnActivity,
  workEntryIsVisibleInGroup,
  workLogEntryIsToolLike
} from "./presentation.logic";

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";
const WORKING_ROW_ID = "working-indicator-row";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** *T3: `packages/shared/src/orchestrationTiming.ts:14-31`.* */
export function formatWorkDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0ms";
  }
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ") || "0s";
}

function elapsedMs(from: string | null, to: string | null): number | null {
  if (!from || !to) {
    return null;
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  return end - start;
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.localeCompare(right) >= 0 ? left : right;
}

function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string {
  return entry.toolCallId
    ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`
    : timelineEntryId;
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string {
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`;
}

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[]
): Extract<AgentChatTimelineRow, { kind: "work" }> {
  return { kind: "work", id: `${groupId}:details`, createdAt, groupedEntries, isExpandedToolGroup: true };
}

function timelineEntryTurnId(entry: TimelineEntry): string | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" || entry.message.role === "reasoning"
      ? entry.message.turnId
      : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.entry.turnId;
}

function lastUserMessageIndex(entries: readonly TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "message" && entry.message.role === "user") {
      return index;
    }
  }
  return -1;
}

/** Codex commentary is a visible assistant message, but never the final answer. */
function isCommentaryAssistantMessage(message: ThreadMessageItem): boolean {
  return message.role === "assistant" && message.messageKind === "commentary";
}

function isGroupMessage(message: ThreadMessageItem): boolean {
  return message.role === "reasoning";
}

/**
 * The `/compact` the host persisted verbatim as a user message (§4.6.5(b)).
 *
 * "The user message is still persisted verbatim as `/compact` and **rendered
 * as a compaction marker rather than a bubble**" — so it is dropped from the
 * message rows here and the marker that the compaction activity produces is
 * the only thing the user sees. Re-recognised by string comparison at render
 * time, and the orchestrator stores the raw input, so it trims and lowercases
 * (fix-wave R2-4).
 *
 * *T3: `apps/web/src/components/ChatView.tsx:735-738` (`isCompactCommandMessage`).*
 */
function isCompactCommandMessage(message: ThreadMessageItem): boolean {
  return (
    message.role === "user" &&
    (message.attachments?.length ?? 0) === 0 &&
    message.text.trim().toLowerCase() === "/compact"
  );
}

/**
 * A `user` row the provider's own transcript wrote and nobody typed: the
 * Claude CLI records a slash command as `<command-name>…`, its output as
 * `<local-command-stdout>…`, a subagent's completion as `<task-notification>…`,
 * and a few notices as `<system-reminder>…` / `<local-command-caveat>…`. A
 * resumed history projects them as user messages (they are user-role turn
 * starts in the transcript), so they render as bubbles — but "rewind to here"
 * would return one of them to the composer as the user's own prompt, which
 * is never what a rewind means. Withheld, like the verbatim `/compact`.
 * The prefix list is `@orquester/api`'s (`isProviderInternalUserText`), the
 * one the right rail's prompt history filters by too.
 */
function isProviderInternalUserMessage(message: ThreadMessageItem): boolean {
  return message.role === "user" && isProviderInternalUserText(message.text);
}

/**
 * A group qualifies only when a message in it is reasoning;
 * a work row is excluded when it carries `agentSpawn` or
 * `questionAnswer`, is a compaction, or has `tone === "error"` (§7.3).
 *
 * *T3: `MessagesTimeline.logic.ts:317-327`.*
 */
function isGroupingEntry(entry: TimelineEntry): boolean {
  if (entry.kind === "message") {
    return isGroupMessage(entry.message);
  }
  if (entry.kind !== "work") {
    return false;
  }
  return (
    entry.entry.agentSpawn === undefined &&
    entry.entry.questionAnswer === undefined &&
    entry.entry.sourceActivityKind !== "context-compaction" &&
    entry.entry.sourceActivityKind !== "thread.state.changed" &&
    entry.entry.tone !== "error" &&
    !isGoalEntry(entry)
  );
}

function isCompactionEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === "work" &&
    (entry.entry.sourceActivityKind === "context-compaction" ||
      entry.entry.sourceActivityKind === "thread.state.changed")
  );
}

/** A goal's landmark (goals §8.4): its own `goal-marker` row, like a compaction. */
function isGoalMarkerEntry(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.goal !== undefined;
}

/**
 * A goal's own row — a marker, or the host's answer to a `/goal` (goals §5.1,
 * §8.4). Neither is ever grouped: a marker is a landmark, and a status answer
 * is what the user just asked for, which must not hide inside a collapsed
 * "Ran 3 commands" or a thinking group.
 */
function isGoalEntry(entry: TimelineEntry): boolean {
  return (
    isGoalMarkerEntry(entry) ||
    (entry.kind === "work" && entry.entry.sourceActivityKind === GOAL_STATUS_ACTIVITY_KIND)
  );
}

/** *T3: `MessagesTimeline.logic.ts:449-466`.* */
function computeMessageDurationStart(
  messages: readonly ThreadMessageItem[]
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }
  return result;
}

/**
 * The last answer of each response: of each fold key's rows ({@link timelineFoldKeys}),
 * else of each run of turnless rows between two prompts.
 *
 * *T3: `MessagesTimeline.logic.ts:509-533`; differs: keyed by the fold key, so a
 * drill-in run that shares its turn with another has an answer of its own.*
 */
function deriveTerminalAssistantMessageIds(
  entries: readonly TimelineEntry[],
  foldKeys: readonly (string | null)[]
): Set<string> {
  const lastByResponseKey = new Map<string, string>();
  const lastCommentaryByResponseKey = new Map<string, string>();
  let nullTurnIndex = 0;
  for (const [position, entry] of entries.entries()) {
    if (entry.kind !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      nullTurnIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const responseKey = message.turnId
      ? `turn:${foldKeys[position] ?? message.turnId}`
      : `unkeyed:${nullTurnIndex}`;
    // Commentary is not the turn's answer while the turn has one, so it
    // cannot be the terminal message whose metadata row closes the response.
    if (isCommentaryAssistantMessage(message)) {
      lastCommentaryByResponseKey.set(responseKey, message.id);
      continue;
    }
    lastByResponseKey.set(responseKey, message.id);
  }
  // A turn with no final answer at all (interrupted, or ended on a tool) ends
  // on its last commentary, as in T3. With no terminal message the fold hid
  // every word of the turn behind "Worked for".
  for (const [responseKey, messageId] of lastCommentaryByResponseKey) {
    if (!lastByResponseKey.has(responseKey)) {
      lastByResponseKey.set(responseKey, messageId);
    }
  }
  return new Set(lastByResponseKey.values());
}

/**
 * Each entry's fold key: the turn its fold groups it by, or null for an entry
 * with no turn. In the thread's timeline it is the turn id. In a drill-in, a
 * launch prompt starts a run, and an agent can be relaunched inside the
 * parent turn its previous run rode (a Claude resume, a Codex follow-up): the
 * rows after a prompt are keyed by their turn AND that prompt, so each run
 * folds and is timed on its own, under its own prompt, and its last answer is
 * terminal in its run. Stable as the list grows: a key names its turn and the
 * prompt above it, never a count.
 */
function timelineFoldKeys(entries: readonly TimelineEntry[]): (string | null)[] {
  let promptId: string | null = null;
  return entries.map((entry) => {
    if (entry.kind === "message" && agentPromptOf(entry.message) !== null) {
      promptId = entry.message.id;
      return null;
    }
    const turnId = timelineEntryTurnId(entry);
    if (turnId === null) {
      return null;
    }
    return promptId === null ? turnId : `${turnId}@${promptId}`;
  });
}

/** Each entry's fold key ({@link timelineFoldKeys}), with the entries they were read off. */
export interface TimelineFoldKeys {
  readonly entries: readonly TimelineEntry[];
  readonly keys: readonly (string | null)[];
}

export const EMPTY_TIMELINE_FOLD_KEYS: TimelineFoldKeys = { entries: [], keys: [] };

/**
 * `entries`' fold keys, reusing `previous`'s when every one of them holds.
 * A key after a launch prompt is a string built per turn-bearing entry, so
 * deriving them on every streamed token cost a prompted agent's drill-in a
 * third of its time per token (content review Minor 1). The held keys are
 * kept exactly when each position keeps its key ({@link keepsFoldKeys}) —
 * what the streamed-text path produces, and nothing a real change does.
 */
export function timelineFoldKeysWithState(
  entries: readonly TimelineEntry[],
  previous: TimelineFoldKeys | null
): TimelineFoldKeys {
  if (previous !== null) {
    if (previous.entries === entries) {
      return previous;
    }
    if (keepsFoldKeys(previous.entries, entries)) {
      return { entries, keys: previous.keys };
    }
  }
  return { entries, keys: timelineFoldKeys(entries) };
}

/**
 * Whether `next` has `previous`'s fold keys, position by position. A key is
 * read off a position's turn ({@link timelineEntryTurnId}) and the last launch
 * prompt above it (its message id), so it holds wherever the entry is the
 * same object, or a message with the same id, role and turn that is a prompt
 * on neither side — the only change the streamed-text path makes
 * (`isStreamingMessageTextUpdate`: a streaming answer or thought, whose text
 * and last write moved). Anything else — a length, a work row, a plan, a turn
 * or a prompt that moved — derives them again.
 */
function keepsFoldKeys(previous: readonly TimelineEntry[], next: readonly TimelineEntry[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before === after) {
      continue;
    }
    if (
      before.kind !== "message" ||
      after.kind !== "message" ||
      before.message.id !== after.message.id ||
      before.message.role !== after.message.role ||
      before.message.turnId !== after.message.turnId ||
      agentPromptOf(before.message) !== null ||
      agentPromptOf(after.message) !== null
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The session's running turn is authoritative when the latest turn briefly
 * lags behind it; folding must not flicker through that window.
 *
 * *T3: `MessagesTimeline.logic.ts:551-563`.*
 */
export function deriveUnsettledTurnId(
  latestTurn: LatestTurnSummary | null,
  runningTurnId: string | null
): string | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const settled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return settled ? null : latestTurn.turnId;
}

/** *T3: `MessagesTimeline.logic.ts:589-612`.* */
function deriveActiveVisualResponseTurnIds(input: {
  entries: readonly TimelineEntry[];
  unsettledTurnId: string | null;
  isWorking: boolean;
}): ReadonlySet<string> {
  const turnIds = new Set<string>();
  if (input.unsettledTurnId === null) {
    return turnIds;
  }
  turnIds.add(input.unsettledTurnId);
  if (!input.isWorking) {
    return turnIds;
  }
  for (let index = lastUserMessageIndex(input.entries) + 1; index < input.entries.length; index += 1) {
    const turnId = timelineEntryTurnId(input.entries[index]!);
    if (turnId !== null) {
      turnIds.add(turnId);
    }
  }
  return turnIds;
}

/**
 * A drill-in run's folds: the fold key of every row from `start` on. The run
 * unfolds them all, as a running response unfolds the turns after its prompt
 * — a turn it shares with the rows before it included.
 */
function foldKeysFrom(foldKeys: readonly (string | null)[], start: number): ReadonlySet<string> {
  const keys = new Set<string>();
  for (let index = start; index < foldKeys.length; index += 1) {
    const key = foldKeys[index];
    if (key !== null && key !== undefined) {
      keys.add(key);
    }
  }
  return keys;
}

/** *T3: `MessagesTimeline.logic.ts:614-620`.* */
export { workEntryIsActiveTurnActivity };

type WorkTimelineEntry = Extract<TimelineEntry, { kind: "work" }>;

/**
 * The live tool run from its last failing row on: a failure ends the run, as
 * its first row. It is judged by the rows it renders (`withoutJoinedOutput`):
 * a chunk of a call whose own row is in the run is that row's output, so a
 * line it prints never ends the run, and an orphan call's chunks are one row.
 * A cut can leave chunks behind without their call's row, an orphan row from
 * then on — so the rest is judged again, and the loop ends because every cut
 * shortens the run.
 */
function fromLastFailingRow(run: readonly WorkTimelineEntry[]): readonly WorkTimelineEntry[] {
  let from = run;
  for (;;) {
    const rows = withoutJoinedOutput(from, (entry) => entry.entry);
    let failing: WorkTimelineEntry | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (workEntryDisplayIndicatesToolFailure(rows[index]!.entry)) {
        failing = rows[index];
        break;
      }
    }
    const at = failing === undefined ? 0 : from.indexOf(failing);
    if (at <= 0) {
      return from;
    }
    from = from.slice(at);
  }
}

// ---------------------------------------------------------------------------
// Turn folds
// ---------------------------------------------------------------------------

interface TurnFold {
  /** Its fold key ({@link timelineFoldKeys}): the turn id in the thread's timeline. */
  turnId: string;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  /** How its rows time it; null when its turn's own start and completion do. */
  clock: TurnFoldClock | null;
}

/**
 * What the "Worked for …" of a fold its rows time reads: from `from` (its
 * prompt, else its first row) to the later of its terminal answer's last
 * write and its last row's end. The answer and the last row are named by
 * their POSITION in the timeline entries — a streamed token moves neither
 * (the fast path requires every entry to keep its place and its id) — so the
 * streamed-text fast path re-reads the label without walking the turn again.
 */
export interface TurnFoldClock {
  readonly from: string;
  /** The terminal answer's position, if the turn has one. */
  readonly terminalAt: number | null;
  /** The turn's last row's position. */
  readonly lastAt: number;
  /** The turn is the latest one, and the user stopped it. */
  readonly interrupted: boolean;
}

function foldLabel(durationMs: number | null, interrupted: boolean): string {
  const duration = durationMs !== null ? formatWorkDuration(durationMs) : null;
  if (interrupted) {
    return duration ? `You stopped after ${duration}` : "You stopped this response";
  }
  return duration ? `Worked for ${duration}` : "Worked";
}

/** The label `clock` reads off `entries` — the ones it was taken from, or the fast path's. */
function foldClockLabel(clock: TurnFoldClock, entries: readonly TimelineEntry[]): string {
  const last = entries[clock.lastAt]!;
  const lastEnd = last.kind === "message" ? last.message.updatedAt : last.createdAt;
  const terminal = clock.terminalAt === null ? undefined : entries[clock.terminalAt];
  const terminalEnd = terminal?.kind === "message" ? terminal.message.updatedAt : null;
  return foldLabel(elapsedMs(clock.from, maxIso(terminalEnd, lastEnd) ?? lastEnd), clock.interrupted);
}

/**
 * Settled turns fold activity before their terminal assistant message behind a
 * "Worked for …" row. A single ordinary activity after that message joins the
 * fold; larger groups and failures stay visible as a trailing summary.
 *
 * A settled turn works for its OWN duration: its start to its completion, as
 * the fold's turn row has them ({@link TimelineRowsInput.turns}). A row can
 * land in a turn long after it settled — a host's first-load closer rides the
 * turn its work started in (`leftover-work.ts`) — so the span to the turn's
 * last row read "Worked for 50h" for a turn of seconds. Only a turn with no
 * settled row to read — still running, or a caller that passes no turns — is
 * timed by its rows: from its prompt to the later of its answer's last write
 * and its last row. The drill-in passes none on purpose: a background agent
 * works long past the parent turn its rows ride, and its fold keeps the span
 * of the agent's own rows (`drill-in.logic.ts`). Such a fold keeps its
 * {@link TurnFoldClock}: its last row may be a thinking block still being
 * written — a thinking block never holds a fold open — and the streamed-text
 * fast path moves its label with every token. (A live agent's current run is
 * its running response and never folds, `agentRunStartIndex`; a drill-in's
 * fold is a settled agent's, or a run before the current one.)
 *
 * *T3: `MessagesTimeline.logic.ts:627-803`; differs: T3 times every turn but
 * the latest by its rows.*
 */
function deriveTurnFolds(input: {
  entries: readonly TimelineEntry[];
  /** Each entry's fold key ({@link timelineFoldKeys}); the fold's groups are keyed by it. */
  foldKeys: readonly (string | null)[];
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: LatestTurnSummary | null;
  /** The fold's turns: a settled one is timed by its own start and completion. */
  turns: readonly Turn[];
  /** The fold keys that do not fold: the running response's. */
  unfoldedTurnIds: ReadonlySet<string>;
  /** {@link TimelineRowsInput.messageStreaming}'s answer for a message. */
  isStreaming: (message: ThreadMessageItem) => boolean;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    /** The turn the group's rows ride. */
    turnId: string;
    entries: TimelineEntry[];
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    /** Positions in `input.entries`: the terminal answer's, the last row's. */
    terminalAt: number | null;
    lastAt: number;
    hasStreamingMessage: boolean;
    startBoundary: string | null;
  }
  const groups = new Map<string, TurnGroup>();
  let pendingUserBoundary: string | null = null;
  // A drill-in's launch prompt heads only the rows right after it: the first
  // entry after it — turnless or not — ends its reach. An agent's first rows
  // often ride no turn (a background agent writes after its parent's turn
  // ended), and a boundary carried past them timed a LATER turn's fold from
  // the launch ("Worked for 16m 49s" for 10 s of work). A thread's own prompt
  // keeps its boundary across turnless rows: a woken or synthetic turn can
  // have some between its prompt and the turn, and the thread's `turns` time
  // every settled one anyway.
  let promptReach = false;
  // First row per id wins, as `startedTurns` numbers them.
  const turnRows = new Map<string, Turn>();
  for (const turn of input.turns) {
    if (turn.turnId !== null && !turnRows.has(turn.turnId)) {
      turnRows.set(turn.turnId, turn);
    }
  }

  for (const [position, entry] of input.entries.entries()) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      promptReach = agentPromptOf(entry.message) !== null;
      continue;
    }
    const endsPromptReach = promptReach;
    promptReach = false;
    const turnId = timelineEntryTurnId(entry);
    const foldKey = input.foldKeys[position];
    if (!turnId || !foldKey || entry.kind === "proposed-plan") {
      if (endsPromptReach) {
        pendingUserBoundary = null;
      }
      continue;
    }
    let group = groups.get(foldKey);
    if (!group) {
      group = {
        turnId,
        entries: [],
        terminalEntry: null,
        terminalAt: null,
        lastAt: position,
        hasStreamingMessage: false,
        startBoundary: pendingUserBoundary
      };
      pendingUserBoundary = null;
      groups.set(foldKey, group);
    } else if (endsPromptReach) {
      // Its turn began before the prompt: the prompt heads none of it.
      pendingUserBoundary = null;
    }
    group.entries.push(entry);
    group.lastAt = position;
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
        group.terminalAt = position;
      }
      // An answer keeps its turn unfolded only while it can still be written
      // (`isStreaming`): one a dead host left keeps its flag for good and
      // reads as settled. A thinking block never holds a fold open.
      if (!isGroupMessage(entry.message) && input.isStreaming(entry.message)) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const folds = new Map<string, TurnFold>();
  for (const [foldKey, group] of groups) {
    if (input.unfoldedTurnIds.has(foldKey) || group.hasStreamingMessage) {
      continue;
    }
    const turnId = group.turnId;
    const hiddenEntryIds = new Set<string>();
    const terminalIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    // Thinking blocks do not count towards "one trailing activity", and
    // neither does a goal marker: it is never folded, so it must not change
    // what else is.
    const trailingEntryCount = group.entries.filter(
      (candidate, candidateIndex) =>
        candidateIndex > terminalIndex &&
        !(candidate.kind === "message" && isGroupMessage(candidate.message)) &&
        !isGoalMarkerEntry(candidate)
    ).length;

    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction = isCompactionEntry(entry);
      const isSingleTrailingActivity =
        trailingEntryCount === 1 &&
        entry.kind === "work" &&
        !workEntryDisplayIndicatesToolFailure(entry.entry);
      const isReasoning = entry.kind === "message" && isGroupMessage(entry.message);
      if (!isCompaction && !isReasoning && index > terminalIndex && !isSingleTrailingActivity) {
        continue;
      }
      // User input and subagent batches stay visible after their turn settles,
      // and so do a goal's markers (goals §8.4): the story of the goal — set,
      // checked, achieved — outlives the work it drove.
      if (
        entry.kind === "work" &&
        (entry.entry.questionAnswer !== undefined ||
          entry.entry.agentSpawn !== undefined ||
          entry.entry.goal !== undefined)
      ) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction (or a lone thinking block) stays visible on its own.
    const hidesFoldableWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !isCompactionEntry(entry) &&
        !(entry.kind === "message" && isGroupMessage(entry.message))
    );
    if (!hidesFoldableWork) {
      continue;
    }

    const firstEntry = group.entries[0];
    const firstHidden = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    if (!firstEntry || !firstHidden) {
      continue;
    }
    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    const turnRow = turnRows.get(turnId);
    const ownDurationMs =
      turnRow !== undefined && isSettledTurnState(turnRow.state)
        ? elapsedMs(turnRow.startedAt, turnRow.completedAt)
        : null;
    const latestTurn = input.latestTurn?.turnId === turnId ? input.latestTurn : null;
    let clock: TurnFoldClock | null = null;
    let label: string;
    if (ownDurationMs !== null) {
      label = foldLabel(ownDurationMs, isLatestInterruptedTurn);
    } else if (latestTurn?.startedAt && latestTurn.completedAt) {
      label = foldLabel(elapsedMs(latestTurn.startedAt, latestTurn.completedAt), isLatestInterruptedTurn);
    } else {
      clock = {
        from: group.startBoundary ?? firstEntry.createdAt,
        terminalAt: group.terminalAt,
        lastAt: group.lastAt,
        interrupted: isLatestInterruptedTurn
      };
      label = foldClockLabel(clock, input.entries);
    }

    folds.set(firstHidden.id, {
      turnId: foldKey,
      anchorEntryId: firstHidden.id,
      createdAt: firstHidden.createdAt,
      hiddenEntryIds,
      label,
      clock
    });
  }
  return folds;
}

// ---------------------------------------------------------------------------
// "Rewind to here" — by turn order (§5.5); checkpoints only feed the
// changed-files card below
// ---------------------------------------------------------------------------

/** A settled compaction: the provider no longer holds what came before it. */
function isCompactedMarkerEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === "work" &&
    isCompactionEntry(entry) &&
    entry.entry.compaction?.state === "compacted"
  );
}

/**
 * Which user messages offer "rewind to here", and the `targetTurnCount` each
 * one rewinds to.
 *
 * A message is numbered by the turn it OPENED — `Turn.userMessageId` — and
 * that turn's position among the started turns (`startedTurns`, the one
 * numbering the host's `/revert` speaks too). Rewinding to it keeps the turns
 * before it, so its `revertTurnCount` is that turn's 0-based index. It used to
 * be read off the checkpoint list, which is sparse exactly where a rewind
 * matters — a non-git project captures nothing, a resumed history has no
 * checkpoint at all, and a turn's `assistantMessageId` is often null — so on
 * real threads no row ever carried one.
 *
 * Withheld, rather than offered and refused:
 * - a message that opened no turn — a steer rides the running turn and has
 *   none of its own, and a pending turn's prompt has no ordinal until the
 *   provider starts it;
 * - the verbatim `/compact` (§4.6.5(b)), which renders as the marker, never as
 *   a bubble, and a `user` row the provider's transcript wrote itself
 *   (`isProviderInternalUserMessage`) — a command echo, a subagent's
 *   notification — which a rewind would hand back as the user's own prompt;
 * - every message before the thread's LAST settled compaction: the provider
 *   no longer holds those messages, so the adapter would refuse the rollback
 *   (§4.5, §5.5). A compaction still running, or one that failed, dropped
 *   nothing and withholds nothing.
 */
function buildRevertTurnCountByUserMessageId(input: {
  supportsConversationRollback: boolean;
  entries: readonly TimelineEntry[];
  turns: readonly Turn[];
}): Map<string, number> {
  const byUserMessageId = new Map<string, number>();
  if (!input.supportsConversationRollback || input.turns.length === 0) {
    return byUserMessageId;
  }
  const keptTurnsByPrompt = new Map<string, number>();
  startedTurns(input.turns).forEach((turn, index) => {
    // First turn wins: were one message ever to open two turns, rewinding to
    // it must drop both, which only the earlier ordinal does.
    if (turn.userMessageId !== undefined && !keptTurnsByPrompt.has(turn.userMessageId)) {
      keptTurnsByPrompt.set(turn.userMessageId, index);
    }
  });
  if (keptTurnsByPrompt.size === 0) {
    return byUserMessageId;
  }
  // Newest first, so "a compaction lies after it" is the point the walk stops.
  for (let index = input.entries.length - 1; index >= 0; index -= 1) {
    const entry = input.entries[index]!;
    if (isCompactedMarkerEntry(entry)) {
      break;
    }
    if (
      entry.kind !== "message" ||
      entry.message.role !== "user" ||
      isCompactCommandMessage(entry.message) ||
      isProviderInternalUserMessage(entry.message)
    ) {
      continue;
    }
    const keptTurns = keptTurnsByPrompt.get(entry.message.id);
    if (keptTurns !== undefined) {
      byUserMessageId.set(entry.message.id, keptTurns);
    }
  }
  return byUserMessageId;
}

// ---------------------------------------------------------------------------
// Layer 2
// ---------------------------------------------------------------------------

export interface TimelineRowsInput {
  timelineEntries: readonly TimelineEntry[];
  latestTurn?: LatestTurnSummary | null;
  runningTurnId?: string | null;
  expandedTurnIds?: ReadonlySet<string>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  /**
   * The thread is in the context-compaction phase
   * ({@link isCompactingThread}). It stamps the live placeholders — the
   * working row, the thinking row and a live activity group — so each can say
   * *what* the turn is doing instead of "Working"/"Thinking", and it is what
   * keeps the in-flight marker from projecting a "Context compacted" divider
   * for a compaction that has not happened yet.
   */
  isCompacting?: boolean;
  activeTurnStartedAt: string | null;
  /** Feeds the changed-files card only; "rewind to here" is by turn order. */
  checkpoints?: readonly Checkpoint[];
  /**
   * The fold's turns, in start order. "Rewind to here" numbers a user message
   * by the turn it opened (`Turn.userMessageId`) and that turn's position
   * among the STARTED turns (§5.5), and a settled turn's "Worked for …" is its
   * own duration, read off its row. Absent — the drill-in — means no rewind,
   * and folds timed by their rows.
   */
  turns?: readonly Turn[];
  supportsConversationRollback: boolean;
  /** Task ids of subagents still working; the live activity row reads them. */
  liveAgentTaskIds?: ReadonlySet<string>;
  /**
   * Whether a message can still be streaming — the thread's
   * `messageStreamingContext` (`@orquester/api/agent-chat`). A message row's
   * `streaming` and the fold a streaming answer keeps open read
   * `isMessageStreaming` against it, never the bare flag, which the log keeps
   * `true` for good on words a dead host or an unclosed agent left. Absent,
   * `NOTHING_STREAMS`: nothing reads as streaming — a caller that names no
   * live session has no stream to show. Compared by identity, like the sets
   * above; the context is memoised by the roster, so a streamed token keeps
   * the fast path.
   */
  messageStreaming?: MessageStreamingContext;
  /** The client's own undispatched queue, rendered as ghost bubbles (§7.4). */
  queuedMessages?: readonly QueuedComposerMessage[];
  /**
   * The timeline goes on BELOW this projection's last row — this is the older
   * history, and the retained window's rows follow it (design 2026-09-23). The
   * live TAIL — the trailing live tool run, a live activity group, the
   * "thinking" placeholder — belongs to the projection that ends the
   * timeline, never to this one; a running turn's rows here still render
   * live: unfolded, without the settled metadata row, an in-progress call as
   * a live row.
   *
   * *Added with the history bridge.*
   */
  continuesBelow?: boolean;
  /**
   * Where the running turn's header — the `working` row, right after the
   * timeline's LAST user message — goes when the timeline is split into the
   * history and the window: after this projection's own last user message
   * (`"here"`, the default: the only thing a whole timeline ever needs), in a
   * projection above (`"above"`: every row here comes after that prompt), or
   * in one below (`"below"`: no row here does).
   *
   * *Added with the history bridge.*
   */
  activeTurnHeader?: "here" | "above" | "below";
  /**
   * A projection above already renders a live activity row, so the live tail
   * needs no "thinking" placeholder to show the turn is working.
   *
   * *Added with the history bridge.*
   */
  liveActivityAbove?: boolean;
  /**
   * A drill-in's live agent (§7.6): where its current run begins in these
   * entries — the first row after the prompt that heads it, else its first
   * row at or after its start — which makes that run the running response,
   * as the running turn is the thread's. An agent's rows ride whatever parent
   * turn was live when each started, or none between the parent's turns, so a
   * run is a POSITION, never a turn: every row from here on is the response
   * whatever turn it rides — its turns unfold, an in-progress call is a live
   * row, a live tail is live and a provisional answer shows no meta yet — and
   * the working row goes here, timed from `activeTurnStartedAt`. A run before
   * it folds as a settled turn does. Read only with `isWorking`; absent — the
   * thread's own timeline — the running response is the running turn's, after
   * the last prompt.
   *
   * *Added with the drill-in's live rows.*
   */
  agentRunStartIndex?: number;
}

/**
 * The rows, whether any of them is a live activity row (`hasActivityRow`),
 * and the clocks of the folds they time by their rows, by the positions they
 * read (`foldClocksAt`).
 */
function deriveRowsDetailed(input: TimelineRowsInput): {
  rows: AgentChatTimelineRow[];
  hasActivityRow: boolean;
  foldClocksAt: ReadonlyMap<number, FoldClockAt>;
} {
  const entries = input.timelineEntries;
  const header = input.activeTurnHeader ?? "here";
  const tailHere = input.continuesBelow !== true;
  const checkpoints = input.checkpoints ?? [];
  const checkpointByAssistantMessageId = new Map<string, Checkpoint>();
  const checkpointByTurnId = new Map<string, Checkpoint>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.assistantMessageId) {
      checkpointByAssistantMessageId.set(checkpoint.assistantMessageId, checkpoint);
    }
    if (checkpoint.turnId) {
      checkpointByTurnId.set(checkpoint.turnId, checkpoint);
    }
  }
  const revertTurnCountByUserMessageId = buildRevertTurnCountByUserMessageId({
    supportsConversationRollback: input.supportsConversationRollback,
    entries,
    turns: input.turns ?? []
  });

  const streamingContext = input.messageStreaming ?? NOTHING_STREAMS;
  const isStreaming = (message: ThreadMessageItem): boolean =>
    isMessageStreaming(message, streamingContext);

  const rows: AgentChatTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []))
  );
  const foldKeys = timelineFoldKeys(entries);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(entries, foldKeys);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null
  );
  // A drill-in's live agent: its current run, by position — whatever turns its
  // rows ride (`agentRunStartIndex`).
  const agentRun =
    input.isWorking && input.agentRunStartIndex !== undefined
      ? Math.min(Math.max(input.agentRunStartIndex, 0), entries.length)
      : null;
  const activeVisualResponseTurnIds =
    agentRun !== null
      ? foldKeysFrom(foldKeys, agentRun)
      : deriveActiveVisualResponseTurnIds({
          entries,
          unsettledTurnId,
          // The rows after the timeline's last prompt are the live response;
          // with that prompt below, no row here is.
          isWorking: input.isWorking && header !== "below"
        });
  const foldsByAnchorEntryId = deriveTurnFolds({
    entries,
    foldKeys,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    turns: input.turns ?? [],
    unfoldedTurnIds: activeVisualResponseTurnIds,
    isStreaming
  });
  const collapsedEntryIds = new Set<string>();
  const foldClocksAt = new Map<number, FoldClockAt>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
    if (fold.clock !== null) {
      // Each position a clock reads is one of its own fold's rows, so no two
      // folds ever share one.
      const at: FoldClockAt = { foldKey: fold.turnId, clock: fold.clock };
      foldClocksAt.set(fold.clock.lastAt, at);
      if (fold.clock.terminalAt !== null) {
        foldClocksAt.set(fold.clock.terminalAt, at);
      }
    }
  }

  // Where the running response starts: after the last prompt here, from the
  // first row when that prompt is above (`lastUserMessageIndex` finds none
  // here), and nowhere in these rows when it is below — or, in a drill-in, at
  // its live agent's current run.
  let activeTurnHeaderIndex = entries.length;
  if (input.isWorking && header !== "below") {
    activeTurnHeaderIndex = agentRun ?? lastUserMessageIndex(entries) + 1;
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number): boolean =>
    input.isWorking &&
    index >= activeTurnHeaderIndex &&
    (agentRun !== null || unsettledTurnId === null || timelineEntryTurnId(entry) === unsettledTurnId);
  // A drill-in's run is judged by position; its rows are the ones from the
  // run's start, whatever turn each rides.
  const agentRunWork =
    agentRun === null
      ? null
      : new Set(entries.slice(agentRun).flatMap((entry) => (entry.kind === "work" ? [entry.entry] : [])));
  const workEntryIsInActiveRun = (entry: WorkLogEntry): boolean =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (agentRunWork !== null
      ? agentRunWork.has(entry)
      : unsettledTurnId !== null && entry.turnId === unsettledTurnId);

  // The live tool run: the trailing streak of work entries in the active turn
  // — at the timeline's end, so never in a projection the timeline continues
  // below — from its last failing row on (`fromLastFailingRow`).
  const trailingWorkEntries: WorkTimelineEntry[] = [];
  for (let index = entries.length - 1; tailHere && index >= activeTurnHeaderIndex; index -= 1) {
    const entry = entries[index]!;
    if (
      !entryBelongsToActiveTurn(entry, index) ||
      entry.kind !== "work" ||
      entry.entry.questionAnswer !== undefined ||
      isCompactionEntry(entry) ||
      isGoalEntry(entry) ||
      entry.entry.tone === "error"
    ) {
      break;
    }
    trailingWorkEntries.push(entry);
  }
  const activeToolEntries = fromLastFailingRow(trailingWorkEntries.reverse());
  const visibleActiveToolEntries = omitSupersededLifecycleMarkers(
    activeToolEntries.filter((entry) => workEntryIsVisibleInGroup(entry.entry, true)),
    (entry) => entry.entry
  );
  const activeWorkAnchor = activeToolEntries[0];
  // The live row names, and is judged by, a call's own row, never one of the
  // chunks it absorbs; it still carries them all (`groupedEntries`).
  const activeRowEntries = withoutJoinedOutput(visibleActiveToolEntries, (entry) => entry.entry);
  const latestVisibleToolEntry = activeRowEntries.at(-1);
  const latestRunningToolEntry = [...activeRowEntries]
    .reverse()
    .find((entry) => {
      const spawn = entry.entry.agentSpawn;
      return spawn
        ? entry === latestVisibleToolEntry &&
            ((spawn.workflowId !== null && input.liveAgentTaskIds?.has(spawn.workflowId)) ||
              spawn.agentTaskIds.some((taskId) => input.liveAgentTaskIds?.has(taskId)))
        : workEntryIsActiveTurnActivity(entry.entry);
    });
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      latestVisibleToolEntry.entry.agentSpawn === undefined &&
      (workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry) ||
        (latestVisibleToolEntry.entry.toolLifecycleStatus === "completed" &&
          !workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry))));
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow: Extract<AgentChatTimelineRow, { kind: "work-live" }> | null =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id, activeWorkAnchor.entry);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${workGroupIdentity(activeWorkAnchor.id, activeWorkAnchor.entry)}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : []
  );

  // The phase only exists while a turn does; a stamp on a settled row would
  // outlive the thing it describes.
  const compacting = input.isCompacting === true && input.isWorking;

  let hasActivityRow = false;
  const appendWorkingRow = (): void => {
    const latestUserMessage = entries[lastUserMessageIndex(entries)];
    // A drill-in's run is timed from its own start: the prompt above it, if
    // any, may head an earlier run.
    const startedAt =
      agentRun === null &&
      activeVisualResponseTurnIds.size > 1 &&
      latestUserMessage?.kind === "message" &&
      latestUserMessage.message.role === "user"
        ? latestUserMessage.message.createdAt
        : input.activeTurnStartedAt;
    rows.push({
      kind: "working",
      id: WORKING_ROW_ID,
      createdAt: startedAt,
      ...(compacting ? { compacting: true } : {})
    });
  };
  const appendActiveWorkRows = (): void => {
    if (activeWorkRow === null) {
      return;
    }
    rows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded || activeWorkRow.entry.agentSpawn) {
      return;
    }
    rows.push(
      expandedWorkGroupRow(activeWorkRow.groupId, activeWorkRow.createdAt, activeWorkRow.groupedEntries)
    );
  };

  let scannedActivityThrough = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const timelineEntry = entries[index]!;

    if (input.isWorking && header === "here" && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }
    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    const anchoredTurnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (anchoredTurnFold) {
      rows.push({
        kind: "turn-fold",
        id: `turn-fold:${anchoredTurnFold.turnId}`,
        createdAt: anchoredTurnFold.createdAt,
        turnId: anchoredTurnFold.turnId,
        label: anchoredTurnFold.label,
        expanded: input.expandedTurnIds?.has(anchoredTurnFold.turnId) ?? false
      });
    }
    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    // ── Activity group: a reasoning-bearing run inside one turn ────────────
    const activityTurnId = timelineEntryTurnId(timelineEntry);
    if (index > scannedActivityThrough && activityTurnId && isGroupingEntry(timelineEntry)) {
      const groupEntries = [timelineEntry];
      let cursor = index + 1;
      while (cursor < entries.length) {
        const next = entries[cursor]!;
        if (
          !isGroupingEntry(next) ||
          timelineEntryTurnId(next) !== activityTurnId ||
          collapsedEntryIds.has(next.id) ||
          foldsByAnchorEntryId.has(next.id)
        ) {
          break;
        }
        groupEntries.push(next);
        cursor += 1;
      }
      scannedActivityThrough = cursor - 1;
      // A run with no reasoning row is a plain tool group, not an activity group.
      if (groupEntries.some((entry) => entry.kind === "message")) {
        // Live only at the timeline's end — this projection's end is not that
        // when the timeline continues below it — and only in the running
        // response: the running turn's, or a drill-in run's by position.
        const active =
          input.isWorking &&
          tailHere &&
          (agentRun !== null ? cursor > activeTurnHeaderIndex : activityTurnId === unsettledTurnId) &&
          cursor === entries.length &&
          !latestToolFailed &&
          (latestVisibleToolEntry === undefined || latestToolKeepsActivityLive);
        const groupId =
          timelineEntry.kind === "work"
            ? workGroupId(timelineEntry.id, timelineEntry.entry)
            : `activity-group:${timelineEntry.id}`;
        rows.push({
          kind: "activity-group",
          id: active ? LIVE_ACTIVITY_ROW_ID : groupId,
          createdAt: timelineEntry.createdAt,
          turnId: activityTurnId,
          groupId,
          entries: groupEntries.flatMap((entry) =>
            entry.kind === "work"
              ? [entry.entry]
              : entry.kind === "message"
                ? [reasoningEntry(entry.message)]
                : []
          ),
          expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
          active,
          // Only a LIVE group has a label to replace: its header reads
          // "Thinking" exactly where the phase should be named instead.
          ...(active && compacting ? { compacting: true } : {})
        });
        hasActivityRow ||= active;
        index = cursor - 1;
        continue;
      }
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    // ── Compaction marker ─────────────────────────────────────────────────
    if (isCompactionEntry(timelineEntry) && timelineEntry.kind === "work") {
      const marker = timelineEntry.entry.compaction;
      // `compacting` is a PHASE, not an event: it is rendered by the live
      // placeholder above (see `compacting`), never as a divider — a
      // "Context compacted" hairline here would claim a compaction that has
      // not happened, and would still be claiming it if the attempt failed.
      if (marker?.state === "compacting") {
        continue;
      }
      const failed = marker?.state === "compaction-failed";
      rows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.entry.label,
        ...(marker?.beforeTokens !== undefined ? { beforeTokens: marker.beforeTokens } : {}),
        ...(marker?.afterTokens !== undefined ? { afterTokens: marker.afterTokens } : {}),
        ...(failed ? { failed: true } : {}),
        ...(failed && marker?.error ? { detail: marker.error } : {}),
        // A failed compaction dropped nothing, so it has nothing to summarise.
        ...(!failed && marker?.summary !== undefined ? { summary: marker.summary } : {}),
        ...(!failed && marker?.summaryTruncated === true ? { summaryTruncated: true } : {})
      });
      continue;
    }

    // ── Goal marker (goals §8.4) ──────────────────────────────────────────
    if (timelineEntry.kind === "work" && timelineEntry.entry.goal !== undefined) {
      const goal = timelineEntry.entry.goal;
      // Only an ending has a cost worth a line; the counters of a set or a
      // check are the chip's to show, live.
      const ended = goal.change === "achieved" || goal.change === "failed";
      rows.push({
        kind: "goal-marker",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        turnId: timelineEntry.entry.turnId,
        label: timelineEntry.entry.label,
        change: goal.change,
        ...(goal.objective !== undefined ? { objective: goal.objective } : {}),
        ...(ended && goal.rounds !== undefined ? { rounds: goal.rounds } : {}),
        ...(ended && goal.elapsedMs !== undefined ? { elapsedMs: goal.elapsedMs } : {}),
        ...(ended && goal.tokensUsed !== undefined ? { tokensUsed: goal.tokensUsed } : {})
      });
      continue;
    }

    // ── Work rows ─────────────────────────────────────────────────────────
    if (timelineEntry.kind === "work") {
      // Hoisted: an error, an answered question, a spawn row and a host
      // `/goal` answer are their own rows — an error must never hide inside a
      // collapsed summary (§7.3), nor an answer the user just asked for.
      if (
        timelineEntry.entry.agentSpawn !== undefined ||
        timelineEntry.entry.questionAnswer !== undefined ||
        timelineEntry.entry.tone === "error" ||
        isGoalEntry(timelineEntry)
      ) {
        const spawn = timelineEntry.entry.agentSpawn;
        if (spawn && entryBelongsToActiveTurn(timelineEntry, index)) {
          hasActivityRow ||=
            (spawn.workflowId !== null && (input.liveAgentTaskIds?.has(spawn.workflowId) ?? false)) ||
            spawn.agentTaskIds.some((taskId) => input.liveAgentTaskIds?.has(taskId) ?? false);
        }
        rows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false
        });
        continue;
      }

      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < entries.length) {
        const nextEntry = entries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.agentSpawn !== undefined ||
          nextEntry.entry.questionAnswer !== undefined ||
          isCompactionEntry(nextEntry) ||
          isGoalEntry(nextEntry) ||
          nextEntry.entry.tone === "error" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = omitSupersededLifecycleMarkers(
        groupedEntries.filter((entry) => workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry))),
        (entry) => entry
      );
      if (visibleGroupedEntries.length > 0) {
        // What the group counts, names, judges and is shaped by: the rows it
        // renders, its chunks joined away (`withoutJoinedOutput`) — so a call
        // that streamed renders exactly as one that did not. The rows it
        // renders still carry every chunk for the join.
        const rowEntries = withoutJoinedOutput(visibleGroupedEntries, (entry) => entry);
        const activeInProgress = rowEntries.filter(workEntryIsInActiveRun);
        if (activeInProgress.length > 0) {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          rows.push({
            kind: "work-live",
            id: `work-live:${workGroupIdentity(timelineEntry.id, timelineEntry.entry)}`,
            createdAt: timelineEntry.createdAt,
            entry: activeInProgress.at(-1)!,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true
          });
          hasActivityRow = true;
          if (expanded) {
            rows.push(expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries));
          }
        } else if (rowEntries.length === 1 && workLogEntryIsToolLike(rowEntries[0]!)) {
          const singleEntry = rowEntries[0]!;
          rows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(rowEntries)
                : singleToolCallLabel(singleEntry)
          });
        } else {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const singleEntry = rowEntries.length === 1 ? rowEntries[0]! : null;
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          const latestToolEntry = [...rowEntries].reverse().find(workLogEntryIsToolLike);
          rows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            turnId: timelineEntry.entry.turnId,
            groupId,
            hiddenCount: rowEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(rowEntries),
            summaryKind: toolGroupSummaryKind(rowEntries),
            hasFailure:
              latestToolEntry !== undefined && workEntryDisplayIndicatesToolFailure(latestToolEntry)
          });
          if (expanded) {
            rows.push(expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries));
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    // ── Plan proposal ─────────────────────────────────────────────────────
    if (timelineEntry.kind === "proposed-plan") {
      rows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        planMarkdown: timelineEntry.proposedPlan.planMarkdown,
        implementedAt: timelineEntry.proposedPlan.implementedAt,
        ...(timelineEntry.proposedPlan.truncated ? { truncated: true as const } : {})
      });
      continue;
    }

    // ── Message ───────────────────────────────────────────────────────────
    const message = timelineEntry.message;
    // §4.6.5(b): the `/compact` the host persisted verbatim is rendered as the
    // compaction marker, never as a bubble (fix-wave R2-4). An agent's launch
    // prompt is never the thread's command, whatever it says.
    if (isCompactCommandMessage(message) && agentPromptOf(message) === null) {
      continue;
    }
    const stillInProgress =
      message.role === "assistant" &&
      (agentRun !== null
        ? index >= activeTurnHeaderIndex
        : message.turnId !== null && activeVisualResponseTurnIds.has(message.turnId));
    // While the turn is still running the latest assistant message is only
    // provisionally terminal: withhold the metadata row so commentary does not
    // flash timestamps mid-work.
    const showAssistantMeta =
      message.role === "assistant" &&
      terminalAssistantMessageIds.has(message.id) &&
      !stillInProgress;

    rows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      durationStart: durationStartByMessageId.get(message.id) ?? message.createdAt,
      showAssistantMeta,
      ...(message.role === "user" && revertTurnCountByUserMessageId.has(message.id)
        ? { revertTurnCount: revertTurnCountByUserMessageId.get(message.id) }
        : {}),
      ...(isStreaming(message) ? { streaming: true } : {})
    });

    // The changed-files card sits at the end of the turn it belongs to (§7.3).
    if (showAssistantMeta) {
      const checkpoint =
        checkpointByAssistantMessageId.get(message.id) ??
        (message.turnId ? checkpointByTurnId.get(message.turnId) : undefined);
      if (checkpoint && checkpoint.files.length > 0) {
        rows.push({
          kind: "turn-diff",
          id: `turn-diff:${checkpoint.checkpointTurnCount}`,
          createdAt: checkpoint.completedAt,
          turnCount: checkpoint.checkpointTurnCount,
          turnId: checkpoint.turnId,
          files: checkpoint.files
        });
      }
    }
  }

  if (
    input.isWorking &&
    header === "here" &&
    !rows.some((row) => row.kind === "working") &&
    activeTurnHeaderIndex === entries.length
  ) {
    appendWorkingRow();
  }
  // The turn is never represented by an empty timeline (§7.3) — a live row
  // the history renders above counts, and the placeholder is the tail's.
  if (
    input.isWorking &&
    tailHere &&
    ((!hasActivityRow && input.liveActivityAbove !== true) || latestToolFailed)
  ) {
    rows.push({
      kind: "thinking",
      id: LIVE_ACTIVITY_ROW_ID,
      createdAt: input.activeTurnStartedAt,
      ...(compacting ? { compacting: true } : {})
    });
  }

  const withMeta = attachTrailingToolGroupsToAssistant(rows);
  input.queuedMessages?.forEach((queuedMessage, index) => {
    withMeta.push({
      kind: "queued-message",
      id: `queued-message:${queuedMessage.id}`,
      createdAt: queuedMessage.queuedAt,
      queuedMessage,
      isNext: index === 0
    });
  });
  return { rows: withMeta, hasActivityRow, foldClocksAt };
}

/**
 * A reasoning message inside an activity group is carried as a work-log entry
 * so the group renders one row type.
 *
 * *differs from T3:* T3's `ActivityEntry` is a `TimelineEntry` union, so a
 * group holds messages and work rows side by side; F's contract types
 * `activity-group.entries` as `WorkLogEntry[]`, so the reasoning message is
 * normalised into one on the way in. The text is the entry's `detail`, which
 * is exactly where the reasoning row reads it from.
 */
const reasoningEntryCache = new WeakMap<ThreadMessageItem, WorkLogEntry>();

function reasoningEntry(message: ThreadMessageItem): WorkLogEntry {
  const cached = reasoningEntryCache.get(message);
  if (cached) {
    return cached;
  }
  const entry: WorkLogEntry = {
    id: message.id,
    createdAt: message.createdAt,
    turnId: message.turnId,
    label: "Thought",
    detail: message.text,
    tone: "thinking",
    sourceActivityKind: "reasoning",
    ...(message.reasoningKind === "summary" ? { toolTitle: "summary" } : {})
  };
  reasoningEntryCache.set(message, entry);
  return entry;
}

/**
 * When a settled turn ends with tool calls after its terminal text, the text
 * and tools are one visual response: the metadata becomes the footer for the
 * whole block instead of separating prose from tools.
 *
 * *T3: `MessagesTimeline.logic.ts:806-900`.*
 */
function attachTrailingToolGroupsToAssistant(
  rows: readonly AgentChatTimelineRow[]
): AgentChatTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<number, Extract<AgentChatTimelineRow, { kind: "assistant-meta" }>>();

  for (const [messageIndex, row] of rows.entries()) {
    if (row.kind !== "message" || row.message.role !== "assistant" || !row.showAssistantMeta) {
      continue;
    }
    const turnId = row.message.turnId;
    if (turnId === null) {
      continue;
    }
    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate) {
        break;
      }
      if (candidate.kind === "message" && isGroupMessage(candidate.message)) {
        continue;
      }
      if (candidate.kind === "message") {
        break;
      }
      if (
        (candidate.kind === "work-toggle" || candidate.kind === "activity-group") &&
        candidate.turnId === turnId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (candidate.kind === "work" && candidate.groupedEntries.some((entry) => entry.turnId === turnId)) {
        if (!candidate.isExpandedToolGroup && candidate.groupedEntries.some(workLogEntryIsToolLike)) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }
    if (lastTrailingWorkIndex < 0) {
      continue;
    }
    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message
    });
  }

  const result: AgentChatTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer 2 with state: the streaming fast path
// ---------------------------------------------------------------------------

export interface TimelineRowsProjection {
  readonly input: TimelineRowsInput;
  readonly rows: AgentChatTimelineRow[];
  /**
   * These rows include a live activity row — what a projection below reads
   * as `liveActivityAbove`. Streamed text never changes it.
   */
  readonly hasActivityRow: boolean;
  /**
   * The clocks of the folds these rows time by their rows, by each position a
   * clock reads (its last row's, and its terminal answer's): what the
   * streamed-text fast path re-reads a fold's label by, one lookup per
   * streamed message. Streamed text never changes which folds there are, nor
   * where their rows sit.
   */
  readonly foldClocksAt: ReadonlyMap<number, FoldClockAt>;
}

/** A fold's clock, and the fold it times: its key ({@link timelineFoldKeys}), which its row's `turnId` carries. */
export interface FoldClockAt {
  readonly foldKey: string;
  readonly clock: TurnFoldClock;
}

function shallowEqualInput(left: TimelineRowsInput, right: TimelineRowsInput): boolean {
  return (
    left.isWorking === right.isWorking &&
    left.isCompacting === right.isCompacting &&
    left.continuesBelow === right.continuesBelow &&
    left.activeTurnHeader === right.activeTurnHeader &&
    left.liveActivityAbove === right.liveActivityAbove &&
    left.agentRunStartIndex === right.agentRunStartIndex &&
    left.activeTurnStartedAt === right.activeTurnStartedAt &&
    left.runningTurnId === right.runningTurnId &&
    left.supportsConversationRollback === right.supportsConversationRollback &&
    left.checkpoints === right.checkpoints &&
    // A pending turn starting stamps its prompt's `revertTurnCount` without
    // touching a single timeline entry.
    left.turns === right.turns &&
    left.liveAgentTaskIds === right.liveAgentTaskIds &&
    left.messageStreaming === right.messageStreaming &&
    left.queuedMessages === right.queuedMessages &&
    left.expandedTurnIds === right.expandedTurnIds &&
    left.expandedWorkGroupIds === right.expandedWorkGroupIds &&
    (left.latestTurn === right.latestTurn ||
      (left.latestTurn != null &&
        right.latestTurn != null &&
        left.latestTurn.turnId === right.latestTurn.turnId &&
        left.latestTurn.state === right.latestTurn.state &&
        left.latestTurn.startedAt === right.latestTurn.startedAt &&
        left.latestTurn.completedAt === right.latestTurn.completedAt))
  );
}

/**
 * Reuse rows when the only change is streamed text. A fold whose clock reads
 * the last write a token moved takes its new label ({@link TurnFoldClock}),
 * so these rows are the ones a rebuild would derive.
 *
 * *T3: `MessagesTimeline.logic.ts:1477-1538`.*
 */
function replaceStreamingMessageRows(
  input: TimelineRowsInput,
  previous: TimelineRowsProjection
): AgentChatTimelineRow[] | null {
  if (
    input.timelineEntries.length !== previous.input.timelineEntries.length ||
    !shallowEqualInput(previous.input, input)
  ) {
    return null;
  }
  const replacements = new Map<ThreadMessageItem, ThreadMessageItem>();
  // The folds whose clock reads a message a token moved, by fold key.
  let movedFolds: Map<string, TurnFoldClock> | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    const previousEntry = previous.input.timelineEntries[index]!;
    if (entry === previousEntry) {
      continue;
    }
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt
    ) {
      return null;
    }
    if (entry.message === previousEntry.message) {
      continue;
    }
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) {
      return null;
    }
    // A token of a flagged message WITH a turn that reads as settled rebuilds,
    // an answer or a thinking block alike: its turn may fold (such an answer
    // no longer holds it open; a thinking block never did), and the "Worked
    // for …" of a fold with no settled turn row to read is timed by its
    // terminal answer's and its last row's `updatedAt` (`deriveTurnFolds`).
    // A turnless message joins no fold and keeps the fast path, as does one
    // that reads as streaming — a streaming answer holds its turn unfolded; a
    // streaming thinking block does not, and a fold it ends (in a drill-in,
    // outside a live agent's current run, which never folds) is relabelled
    // below, off its clock, so its "Worked for …" follows the tokens.
    const turnId = entry.message.turnId;
    if (turnId !== null && !isMessageStreaming(entry.message, input.messageStreaming ?? NOTHING_STREAMS)) {
      return null;
    }
    replacements.set(previousEntry.message, entry.message);
    if (turnId !== null) {
      // The fold whose clock reads this position, found by the position — a
      // fold's key is its turn and, in a drill-in, the prompt above its run.
      // Its terminal answer never matches today: a streaming answer's turn
      // has no fold, and a settled one rebuilt above.
      const moved = previous.foldClocksAt.get(index);
      if (moved !== undefined) {
        (movedFolds ??= new Map()).set(moved.foldKey, moved.clock);
      }
    }
  }
  if (replacements.size === 0) {
    return previous.rows;
  }
  let labels: Map<string, string> | null = null;
  for (const [foldKey, clock] of movedFolds ?? []) {
    (labels ??= new Map()).set(foldKey, foldClockLabel(clock, input.timelineEntries));
  }
  return previous.rows.map((row) => {
    if (row.kind === "turn-fold") {
      const label = labels?.get(row.turnId);
      return label === undefined || label === row.label ? row : { ...row, label };
    }
    if (row.kind === "activity-group") {
      // A reasoning message inside a group is carried as a derived entry; the
      // cache is keyed on the message, so a replacement rebuilds only that one.
      const replaced = row.entries.map((entry) => entry);
      let changed = false;
      for (const [previousMessage, nextMessage] of replacements) {
        const at = replaced.findIndex((entry) => entry.id === previousMessage.id);
        if (at >= 0) {
          replaced[at] = reasoningEntry(nextMessage);
          changed = true;
        }
      }
      return changed ? { ...row, entries: replaced } : row;
    }
    if (row.kind !== "message" && row.kind !== "assistant-meta") {
      return row;
    }
    const message = replacements.get(row.message);
    return message ? { ...row, message } : row;
  });
}

/** Keep one projection per timeline; reuse rows only when streaming changed. */
export function deriveTimelineRowsWithState(
  input: TimelineRowsInput,
  previous: TimelineRowsProjection | null = null
): TimelineRowsProjection {
  const streamed = previous === null ? null : replaceStreamingMessageRows(input, previous);
  if (streamed !== null && previous !== null) {
    return { input, rows: streamed, hasActivityRow: previous.hasActivityRow, foldClocksAt: previous.foldClocksAt };
  }
  return { input, ...deriveRowsDetailed(input) };
}

// ---------------------------------------------------------------------------
// Layer 3: stable rows
// ---------------------------------------------------------------------------

export interface StableRowsState {
  byId: Map<string, AgentChatTimelineRow>;
  result: AgentChatTimelineRow[];
}

export const EMPTY_STABLE_ROWS: StableRowsState = { byId: new Map(), result: [] };

/**
 * Replace each row with the previous object when nothing it renders changed,
 * so one streamed token changes exactly one row object.
 *
 * *T3: `MessagesTimeline.logic.ts:1556-1571`.*
 */
export function computeStableRows(
  rows: AgentChatTimelineRow[],
  previous: StableRowsState
): StableRowsState {
  const next = new Map<string, AgentChatTimelineRow>();
  // Compare LENGTHS, not length-against-map-size: two rows sharing an id make
  // the map smaller than the array, which pinned `anyChanged` true forever and
  // silently disabled the reuse path (fix-wave R7-12). `LIVE_ACTIVITY_ROW_ID`
  // is used by three row kinds under conditions that are meant to be mutually
  // exclusive but are not enforced, so this must degrade, not break.
  let anyChanged = rows.length !== previous.result.length;

  const result = rows.map((row, index) => {
    const previousRow = previous.byId.get(row.id);
    const nextRow = previousRow && isRowUnchanged(previousRow, row) ? previousRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Shallow field comparison per row variant — deliberately hand-written, one
 * arm per kind, so adding a row kind is a compile error here rather than a
 * silent "always re-renders".
 *
 * *T3: `MessagesTimeline.logic.ts:1573-1675`.*
 */
function isRowUnchanged(a: AgentChatTimelineRow, b: AgentChatTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) {
    return false;
  }
  switch (a.kind) {
    case "activity-group": {
      const other = b as typeof a;
      return (
        a.active === other.active &&
        a.expanded === other.expanded &&
        a.groupId === other.groupId &&
        a.turnId === other.turnId &&
        a.compacting === other.compacting &&
        sameArray(a.entries, other.entries)
      );
    }
    case "working":
    case "thinking": {
      const other = b as typeof a;
      return a.createdAt === other.createdAt && a.compacting === other.compacting;
    }
    case "assistant-meta": {
      const other = b as typeof a;
      return a.createdAt === other.createdAt && a.message === other.message;
    }
    case "turn-fold": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt && a.label === other.label && a.expanded === other.expanded
      );
    }
    case "context-compaction": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.label === other.label &&
        a.beforeTokens === other.beforeTokens &&
        a.afterTokens === other.afterTokens &&
        a.failed === other.failed &&
        a.detail === other.detail
      );
    }
    case "goal-marker": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.turnId === other.turnId &&
        a.label === other.label &&
        a.change === other.change &&
        a.objective === other.objective &&
        a.rounds === other.rounds &&
        a.elapsedMs === other.elapsedMs &&
        a.tokensUsed === other.tokensUsed
      );
    }
    case "turn-diff": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.turnCount === other.turnCount &&
        a.turnId === other.turnId &&
        a.files === other.files
      );
    }
    case "proposed-plan": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.planMarkdown === other.planMarkdown &&
        a.implementedAt === other.implementedAt &&
        a.truncated === other.truncated
      );
    }
    case "queued-message": {
      const other = b as typeof a;
      return a.queuedMessage === other.queuedMessage && a.isNext === other.isNext;
    }
    case "work": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.isExpandedToolGroup === other.isExpandedToolGroup &&
        a.displayLabel === other.displayLabel &&
        sameArray(a.groupedEntries, other.groupedEntries)
      );
    }
    case "work-live": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.groupId === other.groupId &&
        a.expanded === other.expanded &&
        a.active === other.active &&
        a.entry === other.entry &&
        sameArray(a.groupedEntries, other.groupedEntries)
      );
    }
    case "work-toggle": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.turnId === other.turnId &&
        a.groupId === other.groupId &&
        a.hiddenCount === other.hiddenCount &&
        a.expanded === other.expanded &&
        a.summary === other.summary &&
        a.summaryKind === other.summaryKind &&
        a.hasFailure === other.hasFailure
      );
    }
    case "message": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.message === other.message &&
        a.durationStart === other.durationStart &&
        a.showAssistantMeta === other.showAssistantMeta &&
        a.revertTurnCount === other.revertTurnCount &&
        a.streaming === other.streaming
      );
    }
  }
}
