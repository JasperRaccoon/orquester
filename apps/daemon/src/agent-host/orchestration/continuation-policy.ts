/**
 * Agent host — which threads a restart continues, and how (spec 2026-11-01
 * P1.2): the decisions the intentional stop (`markThreadsForContinuation`) and
 * the boot reconcile (`reconcileThread`) take, kept apart from those bodies.
 *
 * - **R2** — `/stop` marks a running turn, and a thread whose turn had ended
 *   but whose subagents or background commands the stop kills: a revival
 *   ({@link stopMarkFor}, {@link revivalMarkFor}). Background commands alone
 *   revive only a thread whose last turn ended less than
 *   {@link REVIVAL_BACKGROUND_FRESH_MS} before the stop: a days-old dev server
 *   is nothing the agent waits on.
 * - **R3** — a crash applies the same rule to the roster the dead process
 *   left ({@link activeTopLevelWork}).
 * - **R4** — a user's Stop before the teardown is never undone; a thread the
 *   hosts keep continuing ({@link autoContinueChain}) is not continued again.
 * - **R6** — a transient start failure is retried, twice
 *   ({@link continuationRetryDelay}).
 * - **R7** — Codex's promptless continuation only when nothing but the turn
 *   was cut ({@link promptlessAllowed}).
 *
 * Pure: no clock, no I/O — the orchestrator hands in what it read.
 */

import {
  ACTIVE_SUBAGENT_STATUSES,
  CONTINUATION_STOPPED_WORK_MAX,
  type AutoContinue,
  type ContinuationStoppedWork,
  type ContinueAfterRestart,
  type RuntimeSubagent,
  type ThreadFoldState,
  type Turn
} from "@orquester/api/agent-chat";

import { AUTO_CONTINUE_LOOP_MAX, AUTO_CONTINUE_LOOP_WINDOW_MS } from "../host-protocol.ts";
import type { LiveBackgroundTask } from "../services.ts";
import { DeadlineExceededError } from "../support/deadline.ts";

/** R2b: background commands alone revive a thread only this soon after its last turn ended. */
export const REVIVAL_BACKGROUND_FRESH_MS = 6 * 60 * 60_000;

/** R6: the waits before the first and the second retry of a continuation that failed to start. */
export const CONTINUATION_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000];

/** What a marker records of the stop besides its turn (R2, R5). */
export type ContinuationDetails = Pick<
  ContinueAfterRestart,
  "revival" | "stoppedWork" | "moreStoppedWork" | "requestCancelled"
>;

/** A marker's turn and details, before the caller stamps it (`markedAt`). */
export type StopMark = { turnId: string } & ContinuationDetails;

/**
 * R2, at `/stop`, for a thread that opted in and has a cursor: the running
 * turn, unless the user's Stop for it is already under way (R4); else a
 * revival ({@link revivalMarkFor}); else nothing.
 */
export function stopMarkFor(input: {
  session: { status: string; activeTurnId: string | null };
  turns: readonly Turn[] | undefined;
  /** What the stop is about to kill: the thread's live subagents and background commands. */
  live: readonly ContinuationStoppedWork[];
  /** An approval or a question the cut turn waits on (R5). */
  requestPending: boolean;
  /** The turn the user asked to stop, while that stop is under way. */
  userInterruptedTurnId: string | null;
  nowMs: number;
}): StopMark | null {
  const { status, activeTurnId } = input.session;
  if (status === "running" && activeTurnId !== null) {
    if (input.userInterruptedTurnId === activeTurnId) return null;
    return {
      turnId: activeTurnId,
      ...stoppedWorkFields(input.live),
      ...(input.requestPending ? { requestCancelled: true as const } : {})
    };
  }
  return revivalMarkFor({ turns: input.turns, stopped: input.live, stopAtMs: input.nowMs });
}

/**
 * R2b / R3: a thread with no turn running whose stop killed `stopped` — when
 * the stop is worth waking the agent for. Its latest turn must have ended on
 * its own: one still pending or running is not idle, and one the user
 * interrupted is not revived (R4). Any subagent qualifies; background commands
 * alone only within {@link REVIVAL_BACKGROUND_FRESH_MS} of that turn's end.
 */
export function revivalMarkFor(input: {
  turns: readonly Turn[] | undefined;
  stopped: readonly ContinuationStoppedWork[];
  stopAtMs: number;
}): StopMark | null {
  if (input.stopped.length === 0) return null;
  const latest = input.turns?.at(-1);
  if (latest === undefined || latest.turnId === null) return null;
  if (latest.state === "pending" || latest.state === "running" || latest.state === "interrupted") return null;
  if (!input.stopped.some((item) => item.kind === "subagent")) {
    const endedAt = latest.completedAt !== null ? Date.parse(latest.completedAt) : Number.NaN;
    if (!Number.isFinite(endedAt) || input.stopAtMs - endedAt >= REVIVAL_BACKGROUND_FRESH_MS) return null;
  }
  return { turnId: latest.turnId, revival: true, ...stoppedWorkFields(input.stopped) };
}

/** `stopped` as a marker records it: at most {@link CONTINUATION_STOPPED_WORK_MAX} named, the rest counted. */
export function stoppedWorkFields(
  stopped: readonly ContinuationStoppedWork[],
  moreStopped = 0
): Pick<ContinuationDetails, "stoppedWork" | "moreStoppedWork"> {
  const more = stopped.length - CONTINUATION_STOPPED_WORK_MAX + moreStopped;
  return {
    ...(stopped.length > 0 ? { stoppedWork: stopped.slice(0, CONTINUATION_STOPPED_WORK_MAX) } : {}),
    ...(more > 0 ? { moreStoppedWork: more } : {})
  };
}

/**
 * The thread's live work as the agent knows it, named: the roster's title, the
 * task's own, a shell's command, its id. Only the parent's own — a subagent's
 * shells go with the subagent, which the parent relaunches — and never a row
 * that drives work rather than does it (a scheduled prompt, a legacy goal).
 */
export function namedLiveWork(
  live: readonly LiveBackgroundTask[],
  roster: readonly RuntimeSubagent[] | undefined,
  commandOf: (taskId: string) => string | undefined
): ContinuationStoppedWork[] {
  const work: ContinuationStoppedWork[] = [];
  for (const task of live) {
    const row = roster?.find((entry) => entry.id === task.taskId);
    if (row !== undefined && !isOwnWork(row)) continue;
    const name = nonBlank(row?.title) ?? nonBlank(task.title) ?? nonBlank(commandOf(task.taskId)) ?? task.taskId;
    work.push({ name, kind: task.kind === "agent" ? "subagent" : "background" });
  }
  return work;
}

/** R3: what a dead process left running, as its roster shows it — the work its crash stopped. */
export function activeTopLevelWork(roster: readonly RuntimeSubagent[] | undefined): ContinuationStoppedWork[] {
  return (roster ?? [])
    .filter((row) => ACTIVE_SUBAGENT_STATUSES.has(row.status) && isOwnWork(row))
    .map((row) => ({
      name: nonBlank(row.title) ?? row.id,
      kind: row.agentKind === "background" ? ("background" as const) : ("subagent" as const)
    }));
}

/** `first`, then every item of `second` it does not name already. */
export function mergeStoppedWork(
  first: readonly ContinuationStoppedWork[],
  second: readonly ContinuationStoppedWork[]
): ContinuationStoppedWork[] {
  const seen = new Set(first.map(keyOf));
  return [...first, ...second.filter((item) => !seen.has(keyOf(item)))];
}

/** R5: an approval, or a question that parked its request, waits for the user. */
export function requestPending(pending: ThreadFoldState["pending"]): boolean {
  return (
    (pending?.approvals.length ?? 0) > 0 ||
    (pending?.userInputs ?? []).some((question) => question.responseMode !== "message")
  );
}

/**
 * R4: the automatic continues in a row that still count at `nowMs` — none once
 * another turn followed the last one (the user's message, or anything else the
 * agent did on its own), and only those inside {@link AUTO_CONTINUE_LOOP_WINDOW_MS}.
 */
export function autoContinueChain(
  record: readonly AutoContinue[] | undefined,
  turns: readonly Turn[] | undefined,
  nowMs: number
): AutoContinue[] {
  const last = record?.at(-1);
  if (record === undefined || last === undefined || turns?.at(-1)?.turnId !== last.turnId) return [];
  return record.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && nowMs - at < AUTO_CONTINUE_LOOP_WINDOW_MS;
  });
}

/** R4: the chain is as long as the cap allows: no continue is sent again. */
export function loopCapReached(chain: readonly AutoContinue[]): boolean {
  return chain.length >= AUTO_CONTINUE_LOOP_MAX;
}

/** The chain with `entry` added, newest last, no longer than the cap counts. */
export function withAutoContinue(chain: readonly AutoContinue[], entry: AutoContinue): AutoContinue[] {
  return [...chain, entry].slice(-AUTO_CONTINUE_LOOP_MAX);
}

/**
 * R6: the wait before retrying a continuation whose start failed, or null when
 * it is not retried — after {@link CONTINUATION_RETRY_DELAYS_MS} retries, and
 * for any failure that is not transient ({@link isTransientStartFailure}).
 */
export function continuationRetryDelay(error: unknown, retriesDone: number): number | null {
  if (retriesDone >= CONTINUATION_RETRY_DELAYS_MS.length || !isTransientStartFailure(error)) return null;
  return CONTINUATION_RETRY_DELAYS_MS[retriesDone]!;
}

/** A refusal: retrying it changes nothing (a usage limit, auth, a request the provider rejects). */
const PERMANENT_FAILURE =
  /usage limit|rate.?limit|quota|credit|unauthori[sz]ed|forbidden|authenticat|log ?in|sign ?in|api key|invalid|not found|no such|unsupported|minimum version|requires? version/i;

/** A start that ran out of time or lost its process mid-handshake. */
const TRANSIENT_FAILURE =
  /timed out|timeout|handshake|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|exited before|closed before|transport closed/i;

/**
 * R6: a provider start that timed out, or a resume handshake that failed —
 * what a retry a little later can fix. Never a usage limit, an auth error or a
 * validation error: those are settled at once.
 */
export function isTransientStartFailure(error: unknown): boolean {
  if (error instanceof DeadlineExceededError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (PERMANENT_FAILURE.test(message)) return false;
  const name = error instanceof Error ? error.name : "";
  return name === "CodexTransportClosedError" || TRANSIENT_FAILURE.test(message);
}

/**
 * R7: a continuation may go without a prompt (Codex) only when nothing but the
 * turn was cut: stopped work or a cancelled request needs the prompt that says
 * so, and a revival has no cut turn to continue at all.
 */
export function promptlessAllowed(details: ContinuationDetails & { stopped: readonly ContinuationStoppedWork[] }): boolean {
  return (
    details.revival !== true &&
    details.requestCancelled !== true &&
    details.stopped.length === 0 &&
    (details.moreStoppedWork ?? 0) === 0
  );
}

function isOwnWork(row: RuntimeSubagent): boolean {
  return row.parentAgentId === null && row.kind !== "loop" && row.kind !== "goal";
}

function keyOf(item: ContinuationStoppedWork): string {
  return `${item.kind}:${item.name}`;
}

function nonBlank(value: string | undefined | null): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
