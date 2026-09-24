/**
 * Agent host — what a dead process left running, and the rows that close it
 * (spec §3.1 "a running state never outlives its process", §3.3).
 *
 * An adapter settles its own work when its session ends cleanly: it fails
 * every parked request first (Claude's `cancelPendingRequests`, Codex's
 * `failPendingRequests`, Grok's and OpenCode's settle), then Claude's
 * `closeLiveTasks` fails every call a subagent still has open and stops every
 * live task, a background shell's item before its task, and Codex's
 * `closeOpenItems` fails every open item. A host that is killed — a crash, an
 * OOM, a deploy's hard stop — runs none of that, and the log keeps the
 * requests, calls and tasks that process owned open for good. A card nobody can
 * answer blocks the composer ("Answer the request above first") and the MCP's
 * `send_message`; the fold keeps a call's opening row while it reads open
 * (`open-work.ts`, within its caps); a roster row with no terminal row reads
 * running again the moment a session is live. So the orchestrator appends, on
 * a thread's first load in a host lifetime, the rows its last process never
 * wrote (`closeLeftoverWork` in `orchestrator.ts`); this module derives them
 * from the folded window alone — reading the log past it is the cost the lazy
 * boot exists to avoid. The fold keeps the opening rows of open work within
 * its caps, so what a crash left open is normally in the window; a call whose
 * opening row the window no longer holds is not closed, and an older history
 * page still shows it as it was.
 *
 * - **Every request the fold shows pending but a message-mode question** —
 *   every approval, every structured question — is cancelled first, the way
 *   the host cancels one itself on a Stop: `settlePendingRequests`' own row
 *   ("Request cancelled", "Question cancelled", `cancelledRequestActivity` in
 *   `events.ts`) on the turn the head says is running — or said, when the
 *   caller settled that turn first ({@link LeftoverWorkInput.runningTurnId}:
 *   the orphaned-thread reconcile ends it at the time its process last wrote,
 *   before anything is closed) — never the provider's
 *   "resolved"/"submitted" rows the adapters' teardown leads to, which would
 *   say someone answered. The fold then closes it for good
 *   (`closedRequestIds`), and its card with it. A message-mode question
 *   (`responseMode: "message"`) stays pending, where a Stop would cancel it
 *   too: it parked no request, may outlive its turn by design, and a later
 *   user message answers it.
 * - **Every open call** ({@link openWorkOf}) gets a `tool.completed`, `failed`
 *   as both adapters' teardown writes it, with {@link LEFTOVER_CALL_DETAIL}.
 *   Item type, title, turn, owner, parent call and data are its latest
 *   lifecycle row's: the turn and the call id are what the GUI collapses a
 *   call's rows on, and the owner is its retention class — a closer in
 *   another class than the call's opener can leave the window first, and the
 *   call reads open again. The data rides along because a completion carries
 *   a call's final state: the snapshot read drops every `tool.updated` a later
 *   completion supersedes (`dropSupersededToolUpdatedActivities`), so a closer
 *   without it would take a call's input off every cold load. Ingestion
 *   stores a `tool.updated` already slimmed (§5.6, `truncated`), and the data
 *   counts as cut only when it holds a cut OUTPUT ({@link closerData}): an
 *   identity-only cut (Claude's `{command, toolName}`) rides unmarked — marked,
 *   it offered "Load full output" and an MCP `outputItemId` that read the same
 *   row back — while an output preview (Grok's `rawOutput`) never passes for
 *   the whole output: the opening row's whole data rides instead, and the cut
 *   copy rides marked only when no row holds whole data. So do the files the
 *   latest row names at its top level (`changedFiles`, the slimmer's promotion
 *   out of the data, the one top-level field a stored lifecycle row carries
 *   that the closer does not write itself): a Codex `patchUpdated` update is
 *   stored as `data: {}` beside them, and a closer that copied the data alone
 *   listed no files — the GUI's row and the MCP's entry read them there.
 *   **Except a call
 *   no row of the window anchors** ({@link anchorsCall}: every row of it
 *   turnless and ownerless) — what a rewind leaves of a woken Claude parent's
 *   call, its start and early input update, or a woken call no turn ever
 *   adopted. No view shows it (`@orquester/api`'s `call-anchor.ts`, the rule
 *   the GUI and the MCP hide it by), and a closer would anchor it: the call
 *   would come back as a failed row after any host start. It stays open in
 *   the fold, under the open-work caps like any unit.
 * - **Every task the roster shows active** — `pending`, `running`, `waiting`,
 *   the statuses the fold's session-death rule interrupts, any agent kind —
 *   gets a `task.completed {status: "stopped"}`. `idle` is left alone, as that
 *   rule leaves it: a resumable child stays resumable. The row carries the
 *   task's linkage bundle as its latest row has it (so the roster's title does
 *   not move back), the roster's own `agentKind` (an agent's closer is an
 *   anchor retention never drops, like its start), its start's owner, and its
 *   start's turn — a rewind keeps or drops a row by its turn (`reduceReverted`),
 *   so a closer on any other turn could go with a rewind that keeps the start,
 *   and the agent would read running again. Calls come before tasks, so a
 *   background shell's item closes before its task, as the adapters order it.
 *
 * **A message still `streaming: true` is left as the log has it.** Every
 * `thread.message-sent` moves the message's span in the thread index to its
 * line (`updateMessageDoc`), and a history page never splits a streamed
 * message (`outsideMessages` in `orchestrator.ts`), so a settle appended here
 * would stretch an old message's span to the end of the log: the first page
 * would end at its first chunk, and every row between that chunk and the
 * window would be on neither. Its readers decide instead: a message reads as
 * streaming only while a live session runs its turn or its agent is still at
 * work (`isMessageStreaming`, `@orquester/api/agent-chat`), so a stream no
 * process can continue reads as settled.
 *
 * A closer is a new activity id, so nothing it writes spans the log; its turn
 * may be an old one, and the index then grows that turn's range over it — the
 * late-reference rule, bounded at `MAX_LATE_REFERENCE_BYTES` past the next
 * turn's start (`extendReferenced` in `index/indexer.ts`), which pages over
 * without losing a row. A later rewind that keeps that turn and drops the ones
 * after it clips the range at its cut (`clipAtCut`), as it clips every
 * surviving range: no history page serves the dropped turns' rows, and the
 * closer, past the cut, leaves the history with them — the fold keeps it by
 * its turn, and the window shows it while retention does.
 *
 * Pure: no clock, no ids, no I/O of its own — the caller hands in both.
 */

import {
  ACTIVE_SUBAGENT_STATUSES,
  anchorsCall,
  CALL_ROW_KINDS,
  commandOutputText,
  foldSubagentActivities,
  openWorkOf,
  type OpenCall,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { taskLinkageActivityFields } from "../ingestion/activities.ts";
import { cancelledRequestActivity } from "./events.ts";

/** The detail a call a dead process left open is closed with. */
export const LEFTOVER_CALL_DETAIL = "Stopped when the agent host restarted.";

/** One row that ends one unit of leftover work: a `thread.activity-appended` payload's activity. */
export interface LeftoverClosing {
  /**
   * `request:<requestId>`, `call:<toolUseId>` or `task:<taskId>` — one per
   * unit, so a caller can skip what it closed.
   */
  readonly key: string;
  readonly activity: ThreadActivityItem;
  /** The request a resolution closes: its event's `metadata.requestId`, as the host's own settle writes it. */
  readonly requestId?: string;
}

export interface LeftoverWorkInput {
  /** Stamped on every row. */
  readonly now: string;
  /** A fresh activity id, asked once per row. */
  readonly nextId: () => string;
  /** Keys of units already closed: a later pass skips them. */
  readonly closed?: ReadonlySet<string>;
  /**
   * The turn a Stop would cancel a parked request in: the one the head said
   * was running before the caller wrote anything. The head's own when absent;
   * a caller that settles the turn first — the orphaned-thread reconcile, which
   * ends the turn at the time its process last wrote — names the turn it
   * settled.
   */
  readonly runningTurnId?: string | null;
}

const NOTHING_CLOSED: ReadonlySet<string> = new Set();

const TASK_ROW_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed"
]);

/**
 * The rows that close what `state` shows running: the parked requests, then
 * the open calls, then the active tasks. `[]` when nothing is.
 *
 * The roster lists at most `ROSTER_LIMIT` rows, live ones first, so a thread
 * with more running tasks than that shows the rest only once these are
 * closed: fold these rows on and ask again, with {@link LeftoverWorkInput.closed}.
 */
export function leftoverWorkClosings(
  state: Pick<ThreadFoldState, "head" | "activities" | "pending">,
  input: LeftoverWorkInput
): LeftoverClosing[] {
  const closed = input.closed ?? NOTHING_CLOSED;
  const closings: LeftoverClosing[] = [];

  // First, as a teardown settles them before anything else; approvals, then
  // questions, as `settlePendingRequests` lists them.
  const parked: ParkedRequest[] = [
    ...(state.pending?.approvals ?? []).map((approval) => ({
      requestId: approval.requestId,
      kind: "approval" as const
    })),
    ...(state.pending?.userInputs ?? [])
      .filter((question) => question.responseMode !== "message")
      .map((question) => ({ requestId: question.requestId, kind: "question" as const }))
  ];
  // The turn a Stop cancels its requests in: the one the head says is running
  // — or said, before a caller that settled it first.
  const turnId =
    input.runningTurnId !== undefined ? input.runningTurnId : (state.head?.session.activeTurnId ?? null);
  for (const request of parked) {
    const key = `request:${request.requestId}`;
    if (closed.has(key)) continue;
    closings.push({
      key,
      requestId: request.requestId,
      activity: cancelledRequestActivity({ ...request, turnId, createdAt: input.now })
    });
  }

  const anchored = anchoredCallsOf(state.activities);
  for (const call of openWorkOf(state.activities).calls) {
    const key = `call:${call.toolUseId}`;
    if (closed.has(key) || !anchored.has(call.toolUseId)) continue;
    closings.push({ key, activity: callCloser(call, input) });
  }

  const active = foldSubagentActivities(state.activities).filter((agent) =>
    ACTIVE_SUBAGENT_STATUSES.has(agent.status)
  );
  if (active.length > 0) {
    const rows = taskRowsOf(state.activities);
    for (const agent of active) {
      const key = `task:${agent.id}`;
      const taskRows = rows.get(agent.id);
      // The roster is folded from these very rows, so an active agent has one.
      if (closed.has(key) || taskRows === undefined) continue;
      closings.push({ key, activity: taskCloser(agent, taskRows, input) });
    }
  }
  return closings;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** An id as the fold reads one: any non-empty string, blank or not. */
function presentId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The agent that owns a row — its retention class — or undefined for the
 * parent's: the fold's own rule (`fold.ts` `ownerOf`), so a closer lands in
 * exactly the class the fold gives the row it closes.
 */
function ownerOf(activity: ThreadActivityItem): string | undefined {
  return presentId(activity.agentId);
}

/**
 * The calls some row of `activities` anchors ({@link anchorsCall}: it names a
 * turn, an agent owns it, or it closes the call), keyed as `openWorkOf` keys
 * them — the non-blank `toolUseId`, as written. One pass.
 */
function anchoredCallsOf(activities: readonly ThreadActivityItem[]): Set<string> {
  const anchored = new Set<string>();
  for (const activity of activities) {
    if (!CALL_ROW_KINDS.has(activity.activityKind) || !anchorsCall(activity)) continue;
    const toolUseId = nonBlank(asRecord(activity.payload)?.toolUseId);
    if (toolUseId !== undefined) anchored.add(toolUseId);
  }
  return anchored;
}

/** A payload that carries `data` at all. */
function hasData(payload: Record<string, unknown>): boolean {
  return payload.data !== undefined && payload.data !== null;
}

/**
 * The data a call's closer carries, and whether it is marked cut: the latest
 * lifecycle row's, else the opening row's — ingestion stores a `tool.updated`
 * already slimmed (§5.6, `truncated`), and what that cut means depends on
 * what the data holds. An identity only (Claude's `{command, toolName}`, its
 * input projected to the command) holds nothing more anywhere: it rides
 * unmarked, the command kept, and no "Load full output" or `outputItemId`
 * points at a read that finds nothing more. An OUTPUT cut to its preview
 * (`commandOutputText` finds one: Grok's `rawOutput`, the result on a Claude
 * update whose completion never landed) must not pass for the whole output —
 * `read_tool_output` answers a command's output from an unmarked completion —
 * so the opening row's whole data rides instead, unmarked, and only when no
 * row holds whole data does the cut copy ride, with its `truncated`.
 */
function closerData(
  latest: Record<string, unknown>,
  opening: Record<string, unknown>
): { data: unknown; truncated: boolean } {
  const source = hasData(latest) ? latest : opening;
  if (source.truncated !== true || commandOutputText(source.data) === undefined) {
    return { data: source.data, truncated: false };
  }
  if (source !== opening && hasData(opening) && opening.truncated !== true) {
    return { data: opening.data, truncated: false };
  }
  return { data: source.data, truncated: true };
}

/**
 * The files a lifecycle row names at its top level — the slimmer's promotion
 * out of its data (`slimActivityPayload`), which is all a stored update keeps
 * of a patch: a Codex `patchUpdated` update is `data: {}` and `changedFiles`.
 * Undefined when the row names none.
 */
function changedFilesOf(payload: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(payload.changedFiles)) return undefined;
  const files = payload.changedFiles.filter((file): file is string => typeof file === "string");
  return files.length > 0 ? files : undefined;
}

/** `item.completed`'s row, as ingestion writes one, for a call nothing will complete. */
function callCloser(call: OpenCall, input: LeftoverWorkInput): ThreadActivityItem {
  const latest = call.latestLifecycle;
  const payload = asRecord(latest.payload) ?? {};
  const opening = asRecord(call.opening.payload) ?? {};
  const itemType = nonBlank(payload.itemType) ?? nonBlank(opening.itemType);
  const title = nonBlank(payload.title) ?? nonBlank(opening.title);
  const { data, truncated } = closerData(payload, opening);
  // The one top-level field a stored lifecycle row carries beyond what this
  // row writes itself (`ItemLifecyclePayload` has no other): the GUI's row
  // and the MCP's entry read a call's files there, and the data beside them
  // is `{}` once an update was slimmed.
  const changedFiles = changedFilesOf(payload);
  const owner = ownerOf(latest);
  const parentToolUseId = presentId(latest.parentToolUseId) ?? presentId(payload.parentToolUseId);
  return {
    kind: "activity",
    id: input.nextId(),
    tone: "tool",
    activityKind: "tool.completed",
    summary: title ?? "Tool",
    payload: {
      ...(itemType !== undefined ? { itemType } : {}),
      toolUseId: call.toolUseId,
      status: "failed",
      ...(title !== undefined ? { title } : {}),
      detail: LEFTOVER_CALL_DETAIL,
      ...(data !== undefined ? { data } : {}),
      ...(changedFiles !== undefined ? { changedFiles } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(owner !== undefined ? { agentId: owner } : {}),
      ...(parentToolUseId !== undefined ? { parentToolUseId } : {})
    },
    turnId: latest.turnId,
    ...(owner !== undefined ? { agentId: owner } : {}),
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
    status: "failed",
    createdAt: input.now,
    updatedAt: input.now
  };
}

/** A request the fold shows pending that no process of this host can answer. */
interface ParkedRequest {
  readonly requestId: string;
  readonly kind: "approval" | "question";
}

interface TaskRows {
  /** The task's first `task.started`: whose window and turn it opened in. */
  start: ThreadActivityItem | undefined;
  /** Its newest `task.*` row: the linkage bundle as it now stands. */
  latest: ThreadActivityItem;
}

/** Each task's rows, by the trimmed id the roster keys it on. One pass. */
function taskRowsOf(activities: readonly ThreadActivityItem[]): Map<string, TaskRows> {
  const rows = new Map<string, TaskRows>();
  for (const activity of activities) {
    if (!TASK_ROW_KINDS.has(activity.activityKind)) continue;
    const taskId = nonBlank(asRecord(activity.payload)?.taskId)?.trim();
    if (taskId === undefined) continue;
    const known = rows.get(taskId);
    if (known === undefined) {
      rows.set(taskId, {
        start: activity.activityKind === "task.started" ? activity : undefined,
        latest: activity
      });
      continue;
    }
    if (known.start === undefined && activity.activityKind === "task.started") {
      known.start = activity;
    }
    known.latest = activity;
  }
  return rows;
}

/** `task.completed {status: "stopped"}`, as a teardown's `closeLiveTasks` writes it. */
function taskCloser(agent: RuntimeSubagent, rows: TaskRows, input: LeftoverWorkInput): ThreadActivityItem {
  const source = asRecord(rows.latest.payload) ?? {};
  const linkage = taskLinkageActivityFields(source);
  // The status is this row's own, and an error the last row reported is not
  // what stopped it.
  delete linkage.status;
  delete linkage.error;
  // Sticky on the roster: a row that ever named the task an agent made it one.
  linkage.agentKind = agent.agentKind;
  // The row that opened the task decides both the window and the turn the
  // stop rides; without one in the window, its latest row does.
  const opener = rows.start ?? rows.latest;
  const owner = ownerOf(opener);
  return {
    kind: "activity",
    id: input.nextId(),
    tone: "info",
    activityKind: "task.completed",
    summary: "Task stopped",
    payload: {
      // The rows' own spelling: `openWorkOf` keys a task on it untrimmed.
      taskId: nonBlank(asRecord(rows.start?.payload)?.taskId) ?? nonBlank(source.taskId) ?? agent.id,
      status: "stopped",
      ...linkage
    },
    turnId: opener.turnId,
    ...(owner !== undefined ? { agentId: owner } : {}),
    createdAt: input.now,
    updatedAt: input.now
  };
}
