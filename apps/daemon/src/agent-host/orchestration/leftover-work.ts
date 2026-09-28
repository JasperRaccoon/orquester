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
 *   **Except a call no row of the window anchors** ({@link anchorsCall}:
 *   every row of it turnless and ownerless) — in a log written before
 *   2026-09-28, what a rewind leaves of a Claude parent call a later turn
 *   adopted, its start and early input update (the tail of an interrupted
 *   message; before a woken parent's first message was held for its turn, any
 *   woken call), or such a call no turn ever adopted. The normaliser writes no
 *   such rows any more: the tail's call rides its message's turn. No view shows it
 *   (`@orquester/api`'s `call-anchor.ts`, the rule the GUI and the MCP hide it
 *   by), and a closer would anchor it: the call would come back as a failed row
 *   after any host start. It stays open in the fold, under the open-work caps
 *   like any unit.
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
 * closer, past the cut, is served by the page that holds the cut, by the turn
 * it names (`historyBlockEvents` in `orchestrator.ts`), as the fold keeps it.
 *
 * **A first load also names the launches an older host never wrote**
 * ({@link legacyLaunchStarts}): an OpenCode or Codex agent launched before
 * the relaunch fix has no launch id on its start, so the roster could never
 * tell its relaunch from a late delivery. One `task.started` carrying
 * {@link legacyLaunchId} gives a settled one an id; it changes nothing the
 * roster shows, and lets the next relaunch reopen it. After the closings, so
 * an agent they stop counts as settled.
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
  TERMINAL_SUBAGENT_STATUSES,
  type AgentAdapterId,
  type OpenCall,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { taskLinkageActivityFields } from "../ingestion/activities.ts";
import { cancelledRequestActivity } from "./events.ts";

/** The detail a call a dead process left open is closed with. */
const LEFTOVER_CALL_DETAIL = "Stopped when the agent host restarted.";

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

// ---------------------------------------------------------------------------
// Launch ids an older host never wrote
// ---------------------------------------------------------------------------

/**
 * The adapters whose older hosts launched agents with no launch id on their
 * first `task.started`: OpenCode started a child's run at its own
 * `session.created`, before the parent's `task` part named it, and Codex's
 * `subAgentActivity started` carried no `codex-launch:` id (both until the
 * relaunch fix, 2026-09-24) — and Grok's did too in the 2026-09-24 goals
 * build: a `subagent_spawned` no spawn call explained started under its id
 * with none (every goal-engine planner, worker, skeptic and summarizer), and
 * the merge (2026-09-27) replaces that build's host on the machine that ran
 * it. Claude's starts always name the launching `tool_use_id`.
 */
const LEGACY_LAUNCH_ADAPTERS: ReadonlySet<AgentAdapterId> = new Set(["opencode", "codex", "grok"]);

/** The launch id a first load gives an agent an older host launched with none. */
function legacyLaunchId(taskId: string): string {
  return `legacy-launch:${taskId}`;
}

/** One agent's rows, as {@link legacyLaunchStarts} reads them. */
interface AgentRows {
  /** Every row naming the task — the roster folds the kinds it reads, skips the rest. */
  readonly rows: ThreadActivityItem[];
  /** Its first `task.started`: the launch this row stands for, its turn and its owner. */
  readonly start: ThreadActivityItem;
  /** Its newest `task.*` row: the linkage bundle as it now stands. */
  latest: ThreadActivityItem;
  /** Some `task.started` of it names a launch id, as the roster reads one. */
  launched: boolean;
}

/**
 * The `task.started` rows that give a settled agent the launch id an older
 * host never wrote on its start — `[]` for anything but an OpenCode or Codex
 * thread (the head's adapter).
 *
 * The roster reopens a settled agent only on a start whose `toolUseId`
 * differs from the previous start's, both defined (`roster.ts`, the
 * `task.started` arm): a new call is a relaunch, the same one a late
 * delivery. A host with the relaunch fix starts every run under a launch id,
 * but an agent an older host launched has none behind it, so its first
 * relaunch reads as a late delivery and the agent stays settled while it
 * works. One start carrying {@link legacyLaunchId} gives it one; the fold is
 * untouched (`FOLD_SNAPSHOT_VERSION` stays), and a log an older host folds
 * reads the row as what it is, the same agent's start.
 *
 * For every agent the roster reads as one (`agentKind: "agent"`) with a start
 * in the window, none of whose starts names a launch id, and whose own fold is
 * TERMINAL — `completed`, `failed`, `cancelled`, `interrupted`, a stop the
 * first load's closings just wrote included. On a terminal agent the start
 * only records the id: no reopen, and no visible row — it is that agent's
 * anchor again (retention keeps it; the GUI's spawn row and the MCP's entry
 * are keyed by task id). An `idle` agent gets none: any start reopens it
 * (Codex's resumable child), and this one would, now. An active one is the
 * closings' to settle first. An agent with no start in the window gets none:
 * no launch to stand for and no turn to ride, and a start would be the row
 * that creates it in the roster, running, once retention dropped the rest.
 *
 * The row is the agent's launch again: its first start's turn — a rewind
 * keeps or drops it with that start (`reduceReverted`) — owner, tone and
 * summary; its newest row's linkage (without the status and error that row
 * reported), as a closer carries it, so the roster's title does not move
 * back; the launch id in place of any call a later row named. Its
 * `createdAt`/`updatedAt` are the roster's own `updatedAt` for the agent,
 * which the `task.started` arm writes back unchanged (the event carrying it is
 * stamped with the load's time, like every row a first load appends): with
 * the load's time on the row, a thread of more than `ROSTER_LIMIT` agents
 * would rank every legacy one newest among the settled rows, and the cap
 * would drop the agents that really are.
 *
 * Once per agent: the row names a launch id, so the next load finds none.
 * Pure — `nextId` asked once per row.
 */
export function legacyLaunchStarts(
  state: Pick<ThreadFoldState, "head" | "activities">,
  input: { readonly nextId: () => string }
): ThreadActivityItem[] {
  const adapter = state.head?.adapter;
  if (adapter === undefined || !LEGACY_LAUNCH_ADAPTERS.has(adapter)) return [];

  // One pass: every row naming a task, by the trimmed id the roster keys it on.
  const tasks = new Map<string, ThreadActivityItem[]>();
  const agents = new Map<string, AgentRows>();
  for (const activity of state.activities) {
    const payload = asRecord(activity.payload);
    const taskId = nonBlank(payload?.taskId)?.trim();
    if (taskId === undefined) continue;
    let rows = tasks.get(taskId);
    if (rows === undefined) {
      rows = [];
      tasks.set(taskId, rows);
    }
    rows.push(activity);
    if (!TASK_ROW_KINDS.has(activity.activityKind)) continue;
    const known = agents.get(taskId);
    const launches = activity.activityKind === "task.started" && nonBlank(payload?.toolUseId) !== undefined;
    if (known !== undefined) {
      known.latest = activity;
      known.launched ||= launches;
    } else if (activity.activityKind === "task.started") {
      agents.set(taskId, { rows, start: activity, latest: activity, launched: launches });
    }
  }

  const starts: ThreadActivityItem[] = [];
  for (const [taskId, agent] of agents) {
    if (agent.launched) continue;
    // The task's own fold, alone: one task is never capped, and every arm of
    // the roster fold reads its own task only. Its roster row can differ by
    // the cross-task post-passes (`rosterFromEngine`): the session-death rule,
    // which a fold without `sessionLive` never applies, and the workflow
    // cascade, which settles a member of a settled `local_workflow`
    // coordinator — a Claude task type; OpenCode and Codex tasks are
    // `subagent`, so neither moves a row this function reads.
    const [folded] = foldSubagentActivities(agent.rows);
    if (folded === undefined || folded.agentKind !== "agent" || !TERMINAL_SUBAGENT_STATUSES.has(folded.status)) {
      continue;
    }
    const linkage = taskLinkageActivityFields(asRecord(agent.latest.payload) ?? {});
    delete linkage.status;
    delete linkage.error;
    linkage.agentKind = folded.agentKind;
    const owner = ownerOf(agent.start);
    starts.push({
      kind: "activity",
      id: input.nextId(),
      tone: agent.start.tone,
      activityKind: "task.started",
      summary: agent.start.summary,
      payload: {
        // The rows' own spelling, as a closer writes it.
        taskId: nonBlank(asRecord(agent.start.payload)?.taskId) ?? taskId,
        ...linkage,
        toolUseId: legacyLaunchId(taskId)
      },
      turnId: agent.start.turnId,
      ...(owner !== undefined ? { agentId: owner } : {}),
      createdAt: folded.updatedAt,
      updatedAt: folded.updatedAt
    });
  }
  return starts;
}
