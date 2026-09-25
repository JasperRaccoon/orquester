/**
 * Agent chat — the fold snapshot, `threads/<id>/state.json` (design
 * `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`,
 * A2).
 *
 * A thread's folded state as of one `seq`, so a cold load folds only the log's
 * tail on top of it instead of the whole `events.ndjson`. **A cache, never an
 * authority**: the store writes it beside the log and discards it on any doubt
 * (`parseFoldSnapshotFile` → `null`), and the host then folds from byte 0.
 *
 * The one invariant everything here serves: a snapshot of the fold after event
 * `n`, restored and folded forward through events `n+1…`, is exactly the fold
 * of the whole log.
 *
 * **What the serialized form leaves out, and why.**
 * - `activities` is rebuilt from `items` — the activity rows, in order, **as
 *   the same objects**. The fold relies on that identity: it replaces an
 *   activity in place by finding the old object in `activities`, and retention
 *   drops a row from both lists by identity. Two separately parsed copies
 *   would make the first in-place update append a duplicate row and let the
 *   two lists drift apart under retention. It also halves the file: activities
 *   carry the fold's unslimmed payloads.
 * - `closedRequestIds` / `closedRequestAt` become a string list and a list of
 *   `[requestId, resolvedAt]` pairs.
 * - The fold's caches — the id → position index, the retention counters, the
 *   roster engine — are not part of the state at all (design
 *   `2026-09-23-fold-performance-design.md`, A1): the fold keeps them beside
 *   each state and builds them from the arrays the first time a restored state
 *   is folded onto, so a restored state folds exactly as the one it was
 *   written from.
 *
 * **Validation.** A snapshot is read back with {@link deserializeFoldState},
 * field by field, never trusting the file. Every field of every object the
 * fold builds — head, items, turns, checkpoints, pending entries, roster rows —
 * is checked against its declared type, and each check table below is typed
 * against the model, so a field added to one of those types without a check
 * here is a typecheck error rather than a hole. Values the fold only copies
 * through from an event payload are checked no deeper than the fold reads them
 * (an activity's `payload`, the session's `resumeCursor`, a turn's
 * `tokenUsage`, a message's attachment and context records, a model
 * selection's options): the log would reproduce whatever they hold, so a
 * stricter check could only reject a state the log itself folds to. Closed
 * string unions are checked as strings for the same reason. The goal is the
 * opposite case (goals §4.4): the fold does not copy it but BUILDS it, with
 * the goal parser, so it is checked against that parser — `null`, or a goal
 * parsing gives back unchanged — and anything else, a missing key included,
 * rejects the file like any other malformed field.
 *
 * No Node APIs: `@orquester/api` is shared with the browser client.
 */

import type { ModelSelection } from "./adapter-types.ts";
import type { FoldEvictions, ThreadFoldState } from "./fold.ts";
import { parseThreadGoal } from "./goal.ts";
import type { ThreadGoal } from "./goal.ts";
import type {
  ApprovalOption,
  TaskRunHandles,
  TaskWorkflowPhase,
  UserInputQuestion,
  UserInputQuestionOption
} from "./runtime-events.ts";
import type {
  Checkpoint,
  CheckpointFile,
  ContinueAfterRestart,
  PendingApproval,
  PendingRequests,
  PendingUserInput,
  RuntimeSubagent,
  SubagentActivityEntry,
  SubagentUsage,
  ThreadActivityItem,
  ThreadHead,
  ThreadItem,
  ThreadMessageItem,
  ThreadSessionState,
  Turn
} from "./thread.ts";

/**
 * The `state.json` format. **Bump it whenever the fold** (`fold.ts` and what it
 * calls: `compaction.ts`, `pending.ts`, `roster.ts`, `turn-state.ts`,
 * `turns.ts`) **changes what it produces from the same log.** A load folds only
 * the tail on top of a snapshot, so a snapshot written by the old code would
 * carry the old fold's answer forward for every event before its `seq`; a
 * bumped version makes the next load discard it and fold from byte 0, once.
 */
export const FOLD_SNAPSHOT_VERSION = 4;

// 2: batch retention (design `2026-09-23-fold-performance-design.md`) — the
// window now grows past each limit by its slack before a trim, so a state
// folded by version 1 holds a different window than version 2 folds to from
// the same log; and the state carries `evicted`.
// 3: the parent window keeps the legacy compaction marker, `thread.state.changed
// {state: "compacted"}`, whatever its age, as it keeps `context-compaction`
// (`isCompactionActivity`). Version 2 read it as an ordinary parent row: a
// state it folded may have evicted the marker for good, and trimmed at other
// steps, the marker having counted toward the parent's trigger.
// 4: the fold derives the thread's `goal` from its `goal.updated` rows (goals
// §4.4) — a field a version-3 state never carries, whatever its log holds.

/**
 * {@link ThreadFoldState} as JSON: without `activities` (rebuilt from
 * `items`), with the tombstone set and its stamps as arrays.
 */
export interface SerializedFoldState {
  head: ThreadHead | null;
  items: ThreadItem[];
  turns: Turn[];
  checkpoints: Checkpoint[];
  pending: PendingRequests;
  roster: RuntimeSubagent[];
  /**
   * Always written — `null` when the thread has no goal, and for a state built
   * before goals — so a file without it is not one this build wrote.
   */
  goal: ThreadGoal | null;
  closedRequestIds: string[];
  /** `[requestId, resolvedAt]`; absent exactly when the state had no stamp map. */
  closedRequestAt?: Array<[string, string]>;
  seq: number;
  deleted: boolean;
  /** Absent exactly when retention never dropped anything. */
  evicted?: FoldEvictions;
}

/** `threads/<id>/state.json`. */
export interface FoldSnapshotFile {
  version: number;
  threadId: string;
  /** `state.seq`: the last event the snapshot folded. */
  seq: number;
  /** Byte length of `events.ndjson` right after that event — where the tail starts. */
  logBytes: number;
  writtenAt: string;
  state: SerializedFoldState;
  /** Orchestrator-owned derivations that are not part of the fold (`revertedTo`, `titleManual`). */
  extras?: Record<string, unknown>;
}

/**
 * The JSON-safe form of `state`. Shares every array and object with `state` —
 * the fold never mutates what it has returned — so this is cheap; the caller
 * `JSON.stringify`s it.
 */
export function serializeFoldState(state: ThreadFoldState): SerializedFoldState {
  return {
    head: state.head,
    items: state.items,
    turns: state.turns,
    checkpoints: state.checkpoints,
    pending: state.pending,
    roster: state.roster,
    goal: state.goal ?? null,
    closedRequestIds: [...state.closedRequestIds],
    ...(state.closedRequestAt !== undefined
      ? { closedRequestAt: [...state.closedRequestAt] }
      : {}),
    seq: state.seq,
    deleted: state.deleted,
    ...(state.evicted !== undefined ? { evicted: state.evicted } : {})
  };
}

/**
 * The inverse of {@link serializeFoldState}, validating field-wise; `null` when
 * `value` is not a serialized fold state. Rebuilds `activities` from `items`.
 * Reuses the objects it validated rather than copying them — a freshly parsed
 * file has no other owner.
 *
 * Also rejects a head folded to another sequence than the state: the fold
 * stamps `head.seq` with every event it applies, so the two can only disagree
 * in a file that was not written from one fold.
 */
export function deserializeFoldState(value: unknown): ThreadFoldState | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    head,
    items,
    turns,
    checkpoints,
    pending,
    roster,
    goal,
    closedRequestIds,
    closedRequestAt,
    seq,
    deleted,
    evicted
  } = value;
  if (!isSequence(seq) || typeof deleted !== "boolean") {
    return null;
  }
  if (evicted !== undefined && !isFoldEvictions(evicted)) {
    return null;
  }
  if (!isStoredGoal(goal)) {
    return null;
  }
  if (head !== null && !(isThreadHead(head) && head.seq === seq)) {
    return null;
  }
  if (
    !isListOf(items, isThreadItem) ||
    !isListOf(turns, isTurn) ||
    !isListOf(checkpoints, isCheckpoint) ||
    !isPendingRequests(pending) ||
    !isListOf(roster, isRuntimeSubagent) ||
    !isListOf(closedRequestIds, isString)
  ) {
    return null;
  }
  if (closedRequestAt !== undefined && !isListOf(closedRequestAt, isStringPair)) {
    return null;
  }
  return {
    head,
    items,
    activities: items.filter(isActivityItem),
    turns,
    checkpoints,
    pending,
    roster,
    goal,
    closedRequestIds: new Set(closedRequestIds),
    ...(closedRequestAt !== undefined ? { closedRequestAt: new Map(closedRequestAt) } : {}),
    seq,
    deleted,
    ...(evicted !== undefined
      ? { evicted: { activities: evicted.activities, messages: evicted.messages } }
      : {})
  };
}

/**
 * The stored goal (goals §4.4): `null`, or exactly a goal the fold could hold.
 * The fold builds its goal with the goal parser (`fold.ts`, `goalAfterActivity`),
 * so the parser is the check: a stored goal is valid when parsing gives back
 * every field it has and no other — nothing dropped, nothing added. Anything
 * else is doubt, and doubt discards the snapshot: the host refolds the log.
 */
function isStoredGoal(value: unknown): value is ThreadGoal | null {
  if (value === null) {
    return true;
  }
  const parsed = parseThreadGoal(value);
  if (parsed === null || !isRecord(value)) {
    return false;
  }
  const fields = Object.entries(parsed);
  return (
    fields.length === Object.keys(value).length &&
    fields.every(([field, fieldValue]) => value[field] === fieldValue)
  );
}

function isFoldEvictions(value: unknown): value is FoldEvictions {
  return (
    isRecord(value) &&
    typeof value.activities === "boolean" &&
    typeof value.messages === "boolean"
  );
}

/**
 * A whole `state.json`, validated; `null` unless it is this build's
 * {@link FOLD_SNAPSHOT_VERSION}, it names `threadId`, `seq`/`logBytes` are
 * non-negative integers, its state deserializes, and the state agrees with the
 * file: folded to the file's `seq`, and headed by `threadId` (or headless).
 *
 * The returned `state` is the validated state re-serialized, so it holds
 * exactly the declared fields.
 */
export function parseFoldSnapshotFile(value: unknown, threadId: string): FoldSnapshotFile | null {
  if (!isRecord(value) || value.version !== FOLD_SNAPSHOT_VERSION || value.threadId !== threadId) {
    return null;
  }
  const { seq, logBytes, writtenAt, extras } = value;
  if (!isSequence(seq) || !isSequence(logBytes) || !isString(writtenAt)) {
    return null;
  }
  if (extras !== undefined && !isRecord(extras)) {
    return null;
  }
  const state = deserializeFoldState(value.state);
  if (state === null || state.seq !== seq || (state.head !== null && state.head.id !== threadId)) {
    return null;
  }
  return {
    version: FOLD_SNAPSHOT_VERSION,
    threadId,
    seq,
    logBytes,
    writtenAt,
    state: serializeFoldState(state),
    ...(extras !== undefined ? { extras } : {})
  };
}

// ---------------------------------------------------------------------------
// Rebuilt from items
// ---------------------------------------------------------------------------

function isActivityItem(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity";
}

// ---------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------

type Check = (value: unknown) => boolean;

/**
 * One check per field of `T`, optional fields included: `-?` makes a field
 * missing from a table a type error, and an object literal typed with it
 * rejects a field `T` does not have.
 */
type Shape<T> = { readonly [K in keyof T]-?: Check };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A sequence number or a byte offset. */
function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && isString(value[0]) && isString(value[1]);
}

function anything(): boolean {
  return true;
}

function nullable(check: Check): Check {
  return (value) => value === null || check(value);
}

function optional(check: Check): Check {
  return (value) => value === undefined || check(value);
}

function literal(expected: string): Check {
  return (value) => value === expected;
}

function isTrue(value: unknown): value is true {
  return value === true;
}

function isListOf<T>(value: unknown, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every((entry) => check(entry));
}

function listOf(check: Check): Check {
  return (value) => Array.isArray(value) && value.every((entry) => check(entry));
}

/** A type guard for `T` from its check table. */
function shaped<T>(shape: Shape<T>): (value: unknown) => value is T {
  const fields = Object.entries(shape) as Array<[string, Check]>;
  return (value: unknown): value is T => {
    if (!isRecord(value)) {
      return false;
    }
    for (const [field, check] of fields) {
      if (!check(value[field])) {
        return false;
      }
    }
    return true;
  };
}

// --- head ------------------------------------------------------------------

const isModelSelection = shaped<ModelSelection>({
  instanceId: optional(isString),
  model: isString,
  options: optional(listOf(isRecord))
});

const isSessionState = shaped<ThreadSessionState>({
  status: isString,
  resumeCursor: anything,
  providerThreadId: optional(isString),
  activeTurnId: nullable(isString),
  lastError: optional(isString)
});

const isContinueAfterRestart = shaped<ContinueAfterRestart>({
  turnId: isString,
  prepared: optional(isBoolean)
});

const isThreadHead = shaped<ThreadHead>({
  id: isString,
  projectPath: isString,
  cwd: isString,
  title: isString,
  adapter: isString,
  refId: isString,
  accountId: isString,
  home: isString,
  modelSelection: isModelSelection,
  runtimeMode: isString,
  session: isSessionState,
  turnCount: isNumber,
  seq: isSequence,
  continueAfterRestart: optional(isContinueAfterRestart),
  // Goals §5.5 and §5.7. Head-only state, so a fold's own head never holds
  // either; only the shape is checked, as for the other marker.
  resumeGoalAfterRestart: optional(isTrue),
  goalHeldForHandover: optional(isTrue),
  createdAt: isString,
  updatedAt: isString
});

// --- items -----------------------------------------------------------------

const isMessageItem = shaped<ThreadMessageItem>({
  kind: literal("message"),
  id: isString,
  role: isString,
  text: isString,
  attachments: optional(listOf(isRecord)),
  context: optional(listOf(isRecord)),
  turnId: nullable(isString),
  agentId: optional(isString),
  reasoningKind: optional(isString),
  messageKind: optional(isString),
  streaming: isBoolean,
  createdAt: isString,
  updatedAt: isString
});

const isActivityItemShape = shaped<ThreadActivityItem>({
  kind: literal("activity"),
  id: isString,
  tone: isString,
  activityKind: isString,
  summary: isString,
  payload: anything,
  turnId: nullable(isString),
  agentId: optional(isString),
  parentToolUseId: optional(isString),
  status: optional(isString),
  createdAt: isString,
  updatedAt: isString
});

function isThreadItem(value: unknown): value is ThreadItem {
  return isMessageItem(value) || isActivityItemShape(value);
}

// --- turns and checkpoints --------------------------------------------------

const isTurn = shaped<Turn>({
  turnId: nullable(isString),
  state: isString,
  turnCount: nullable(isNumber),
  requestedAt: isString,
  startedAt: nullable(isString),
  completedAt: nullable(isString),
  assistantMessageId: nullable(isString),
  userMessageId: optional(isString),
  interactionMode: optional(isString),
  model: optional(isString),
  tokenUsage: optional(isRecord),
  totalCostUsd: optional(isNumber),
  stopReason: optional(nullable(isString)),
  errorMessage: optional(isString)
});

const isCheckpointFile = shaped<CheckpointFile>({
  path: isString,
  additions: isNumber,
  deletions: isNumber
});

const isCheckpoint = shaped<Checkpoint>({
  turnId: nullable(isString),
  checkpointTurnCount: isNumber,
  checkpointRef: isString,
  status: isString,
  files: listOf(isCheckpointFile),
  assistantMessageId: nullable(isString),
  completedAt: isString
});

// --- pending requests --------------------------------------------------------

const isApprovalOption = shaped<ApprovalOption>({
  decision: isString,
  label: isString,
  warning: optional(isString)
});

const isPendingApproval = shaped<PendingApproval>({
  requestId: isString,
  requestKind: isString,
  createdAt: isString,
  detail: optional(isString),
  appName: optional(isString),
  toolUseId: optional(isString),
  options: optional(listOf(isApprovalOption))
});

const isQuestionOption = shaped<UserInputQuestionOption>({
  label: isString,
  description: isString,
  value: optional(isString)
});

const isQuestion = shaped<UserInputQuestion>({
  id: isString,
  header: isString,
  question: isString,
  options: listOf(isQuestionOption),
  allowCustomAnswer: optional(isBoolean),
  multiSelect: optional(isBoolean),
  isOther: optional(isBoolean),
  isSecret: optional(isBoolean)
});

const isPendingUserInput = shaped<PendingUserInput>({
  requestId: isString,
  createdAt: isString,
  questions: listOf(isQuestion),
  responseMode: optional(literal("message")),
  dismissible: isBoolean,
  turnId: optional(nullable(isString))
});

const isPendingRequests = shaped<PendingRequests>({
  approvals: listOf(isPendingApproval),
  userInputs: listOf(isPendingUserInput)
});

// --- roster --------------------------------------------------------------------

const isSubagentUsage = shaped<SubagentUsage>({
  totalTokens: isNumber,
  inputTokens: optional(isNumber),
  cachedInputTokens: optional(isNumber),
  outputTokens: optional(isNumber),
  reasoningOutputTokens: optional(isNumber),
  toolUses: optional(isNumber),
  durationMs: optional(isNumber)
});

const isWorkflowPhase = shaped<TaskWorkflowPhase>({
  index: isNumber,
  title: isString
});

const isRunHandles = shaped<TaskRunHandles>({
  runId: optional(isString),
  scriptPath: optional(isString),
  transcriptDir: optional(isString),
  sessionUrl: optional(isString)
});

const isSubagentActivityEntry = shaped<SubagentActivityEntry>({
  at: isString,
  summary: isString
});

const isRuntimeSubagent = shaped<RuntimeSubagent>({
  id: isString,
  kind: isString,
  agentKind: isString,
  title: isString,
  role: nullable(isString),
  model: nullable(isString),
  effort: nullable(isString),
  status: isString,
  activationCount: isNumber,
  usage: nullable(isSubagentUsage),
  progress: nullable(isString),
  lastToolName: nullable(isString),
  result: nullable(isString),
  error: nullable(isString),
  outputFile: nullable(isString),
  exitCode: nullable(isNumber),
  isBackgrounded: nullable(isBoolean),
  parentAgentId: nullable(isString),
  agentIndex: nullable(isNumber),
  phaseIndex: nullable(isNumber),
  phaseTitle: nullable(isString),
  attempt: nullable(isNumber),
  workflowName: nullable(isString),
  phases: listOf(isWorkflowPhase),
  runHandles: nullable(isRunHandles),
  recentActivity: listOf(isSubagentActivityEntry),
  firstSeenAt: isString,
  startedAt: nullable(isString),
  completedAt: nullable(isString),
  updatedAt: isString
});
