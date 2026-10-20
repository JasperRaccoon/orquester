import type { SessionActivity, SessionActivityEvent, SessionSummary } from "@orquester/api";
import {
  agentChatRoutes,
  replyNoticeText,
  SETTLED_TURN_STATES,
  type ReplyWaitResponse,
  type ThreadHeadResponse
} from "@orquester/api/agent-chat";
import { resolveChatActivity } from "../agent-chat/activity-ladder.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { expectOk, ToolError } from "./errors.ts";
import { listSessions, readThreadHead } from "./reads.ts";
import { fitJsonBytes } from "./result.ts";
import { replyWithin } from "./views.ts";

interface WatchState { sessions: ReadonlyMap<string, SessionSummary>; closed: ReadonlySet<string> }
/**
 * What a watch holds: ONE session — whose close, or absence from the first read, rejects the watch with
 * SESSION_NOT_FOUND at once rather than running it to the timeout — or every session `select` admits. Never both,
 * so the two cannot disagree.
 */
export type WatchScope = { sessionId: string; select?: never } | { select: (s: SessionSummary) => boolean; sessionId?: never };
type WatchOptions<T> = WatchScope & { api: DaemonApi; evaluate: (state: WatchState) => T | null; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number };

const DEFAULT_SETTLE_MS = 300;
const DEFAULT_REREAD_MS = 10_000;

/** An activity's attention stamp as an instant; none sorts first. */
function attentionStamp(activity: SessionActivity | undefined): number {
  const at = activity?.needsAttentionAt ? Date.parse(activity.needsAttentionAt) : Number.NaN;
  return Number.isNaN(at) ? -Infinity : at;
}

/**
 * Watch the daemon bus for the selected sessions and resolve the first non-null
 * evaluation (spec §4.3, §9). Subscribes BEFORE the initial read, so an event
 * published during it is still evaluated, and evaluates after EVERY event about a
 * watched session, latching the first hit (or throw): a burst of events would
 * otherwise be judged only by its last state, and a turn that settles and is at
 * once followed by the next would never be seen settled. Events about other
 * sessions are ignored. Re-reads the list every `rereadMs` as a safety net, on its
 * own schedule however busy the bus is; on a hit waits `settleMs` and re-reads so
 * siblings stamped in the same host poll are seen together. Resolves null on
 * timeout or abort. An `evaluate` throw rejects the watch — it is caught in the
 * listener, never thrown into the publisher. A closed session leaves the watch for
 * good; with `sessionId`, its close ends the watch (SESSION_NOT_FOUND).
 */
async function watchSessions<T>(opts: WatchOptions<T>): Promise<T | null> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const rereadMs = DEFAULT_REREAD_MS;
  const only = opts.sessionId;
  const select = only === undefined ? opts.select : (s: SessionSummary) => s.id === only;
  let sessions = new Map<string, SessionSummary>();
  const closed = new Set<string>();
  // Activity published while a list read is in flight, which that read may predate; null between reads.
  let heard: Map<string, SessionActivity> | null = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  let latched: { hit: T } | { error: unknown } | null = null;
  // A single-session watch ends on that session's close, whatever the caller's evaluate would make of it.
  const evaluate = (state: WatchState): T | null => {
    if (only !== undefined && state.closed.has(only)) throw new ToolError("SESSION_NOT_FOUND", `Session "${only}" was closed while waiting.`);
    return opts.evaluate(state);
  };
  const check = (): { hit: T } | { error: unknown } | null => {
    if (latched !== null) return latched;
    try {
      const hit = evaluate({ sessions, closed });
      if (hit !== null) latched = { hit };
    } catch (error) {
      latched = { error };
    }
    return latched;
  };
  // An exited tab's summary carries no `activity` (the daemon drops it on exit), and its
  // `finished` stamp arrives on the bus just after: a summary without one keeps ours.
  const keepActivity = (s: SessionSummary): SessionSummary => {
    const known = s.activity === undefined ? sessions.get(s.id)?.activity : undefined;
    return known ? { ...s, activity: known } : s;
  };
  const off = opts.api.subscribe((event) => {
    if (event.channel !== "sessions") return;
    const payload = event.payload as { id?: string };
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.exited") {
      const s = event.payload as SessionSummary;
      // A closed tab stays closed: the daemon can publish its exit after the close.
      if (closed.has(s.id)) return;
      if (select(s)) sessions.set(s.id, keepActivity(s));
      else if (!sessions.delete(s.id)) return;
    } else if (event.type === "session.activity") {
      if (!payload.id) return;
      const { activity } = event.payload as SessionActivityEvent;
      heard?.set(payload.id, activity);
      const cur = sessions.get(payload.id);
      if (!cur) return;
      sessions.set(cur.id, { ...cur, activity });
    } else if (event.type === "session.closed") {
      if (!payload.id) return;
      closed.add(payload.id);
      if (!sessions.delete(payload.id)) return;
    } else return;
    check();
    notify();
  });
  // Built beside the old map, which keepActivity still reads; a closed id stays closed even when the
  // list predates its close. Activity published during the read replaces the list's unless the list's
  // attention stamp is later (a tie goes to the bus): the first read would otherwise lose it — nothing is
  // held before that read lands — and any re-read would overwrite it with an older reading.
  const reload = async (): Promise<SessionSummary[]> => {
    const during = new Map<string, SessionActivity>();
    heard = during;
    let list: SessionSummary[];
    try {
      list = await listSessions(opts.api);
    } finally {
      heard = null;
    }
    const next = new Map<string, SessionSummary>();
    for (const s of list) {
      if (!select(s) || closed.has(s.id)) continue;
      const listed = keepActivity(s);
      const bus = during.get(s.id);
      next.set(s.id, bus && attentionStamp(bus) >= attentionStamp(listed.activity) ? { ...listed, activity: bus } : listed);
    }
    sessions = next;
    return list;
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { opts.signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    opts.signal.addEventListener("abort", onAbort, { once: true });
  });
  // Elapsed time is the larger of the caller's clock and the monotonic one: the timers
  // below are real, and a frozen `now` (the tools' test contexts) must never stop a timeout.
  const startedAt = opts.now();
  const startedMono = performance.now();
  const remaining = () => opts.timeoutMs - Math.max(opts.now() - startedAt, performance.now() - startedMono);
  // The safety net keeps its own schedule: an event waking the loop must not postpone it.
  let nextRereadAt = startedMono + rereadMs;
  try {
    const first = await reload();
    // Missing from the first read, it closed before the watch could hear it: the same end as a close heard.
    if (only !== undefined && !first.some((s) => s.id === only)) closed.add(only);
    for (;;) {
      if (opts.signal.aborted) return null;
      const found = check();
      if (found !== null) {
        if ("error" in found) throw found.error;
        if (settleMs > 0 && settleMs < remaining()) {
          await sleep(settleMs);
          if (opts.signal.aborted) return null;
          await reload();
          const settled = evaluate({ sessions, closed });
          if (settled !== null) return settled;
          latched = null;
          continue;
        }
        return found.hit;
      }
      const left = remaining();
      if (left <= 0) return null;
      const timer = setTimeout(notify, Math.max(0, Math.min(left, nextRereadAt - performance.now())));
      opts.signal.addEventListener("abort", notify, { once: true });
      await new Promise<void>((resolve) => { wake = resolve; });
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", notify);
      if (!opts.signal.aborted && performance.now() >= nextRereadAt) {
        nextRereadAt = performance.now() + rereadMs;
        await reload();
      }
    }
  } finally {
    off();
  }
}

/** `errored`: the session read `error` already (a start that failed earlier): only a latest turn that moves counts then. */
export interface TurnBaseline { turnId: string | null; completedAt: string | null; running: boolean; errored?: boolean }
export function turnBaseline(s: SessionSummary): TurnBaseline {
  const lt = s.latestTurn ?? null;
  const running = s.chatSessionStatus === "running" || s.chatSessionStatus === "starting" || lt?.state === "running" || lt?.state === "pending";
  return { turnId: lt?.turnId ?? null, completedAt: lt?.completedAt ?? null, running, errored: s.chatSessionStatus === "error" };
}

export type TurnOutcome = "completed" | "needs-input" | "plan-ready" | "interrupted" | "failed" | "timeout";

/** The outcome a turn wait ends on, or null while it goes on. */
function turnOutcome(s: SessionSummary, baseline: TurnBaseline): TurnOutcome | null {
  if (s.hasPendingApprovals || s.hasPendingUserInput) return "needs-input";
  const rung = resolveChatActivity(s).rung;
  // Goals §4.7: a goal the provider continues by itself (Codex) starts its next turn within milliseconds of the last
  // one settling, and the host reports it continuing through the 60 s grace after that, and through a restart's owed
  // resume, where the session may read `error`. A host poll in that gap shows a new settled turn, or an error, while
  // the work goes on: the ladder says working and holds its error rung back, so the wait goes on as well — until the
  // goal stops (paused, blocked, achieved…) or the timeout.
  if (rung === "goal-continuing") return null;
  const lt = s.latestTurn ?? null;
  // Not the turn the wait started from: another one, or — for a steer into a running turn — that turn, now settled.
  const isNew = lt !== null && (lt.turnId !== baseline.turnId || (baseline.running && lt.completedAt !== baseline.completedAt));
  // plan-ready waits for a new turn too: the summary moves only on the host poll, so the
  // first reads after implement_plan posts still show the very plan being implemented.
  if (isNew && rung === "plan-ready") return "plan-ready";
  // An error the session already showed when the message was posted is the earlier failure (a
  // CLI that never started): this message's turn has not reached the summary yet. It counts once
  // a settled latest turn moves — this message's own start failing settles a new one (its pending
  // row, which shows first, is not that yet).
  const moved = lt !== null && SETTLED_TURN_STATES.has(lt.state) && (lt.turnId !== baseline.turnId || lt.completedAt !== baseline.completedAt);
  if (s.chatSessionStatus === "error" && (!baseline.errored || moved)) return "failed";
  if (!lt || !isNew || !SETTLED_TURN_STATES.has(lt.state)) return null;
  if (lt.state === "completed") return "completed";
  if (lt.state === "failed") return "failed";
  return "interrupted";
}

/** §9.1's wait on one session's turn. Rejects with SESSION_NOT_FOUND when the session closes, or is gone by the first read. */
export async function waitForTurn(api: DaemonApi, sessionId: string, baseline: TurnBaseline, opts: { timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<{ outcome: TurnOutcome; summary: SessionSummary | null }> {
  let last: SessionSummary | null = null;
  const hit = await watchSessions<{ outcome: TurnOutcome; summary: SessionSummary }>({
    api, sessionId, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: 0,
    evaluate: (state) => {
      const s = state.sessions.get(sessionId);
      if (!s) return null;
      last = s;
      const outcome = turnOutcome(s, baseline);
      return outcome ? { outcome, summary: s } : null;
    }
  });
  return hit ?? { outcome: "timeout", summary: last };
}

/** Stamps compare as instants: the daemon writes UTC `toISOString()`, a caller's `after` may carry an offset or no milliseconds. */
function attentionQualifies(s: SessionSummary, after: string): boolean {
  const a = s.activity;
  return Boolean(a && a.attention !== null && a.needsAttentionAt && Date.parse(a.needsAttentionAt) > Date.parse(after));
}

/**
 * §9.2's wait. Scoped by `sessionId`, the session closing, or being gone by the first read, rejects with
 * SESSION_NOT_FOUND; a `select` scope — a project, or every session — just stops watching a closed session.
 */
export async function waitForAttention(api: DaemonApi, opts: WatchScope & { after: string; timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<{ sessions: SessionSummary[]; cursor: string; timedOut: boolean }> {
  const scope: WatchScope = opts.sessionId === undefined ? { select: opts.select } : { sessionId: opts.sessionId };
  const hit = await watchSessions<SessionSummary[]>({
    ...scope, api, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now,
    evaluate: (state) => { const q = [...state.sessions.values()].filter((s) => attentionQualifies(s, opts.after)); return q.length ? q : null; }
  });
  if (!hit) return { sessions: [], cursor: opts.after, timedOut: true };
  // The latest instant, spelled as the daemon wrote it.
  const cursor = hit.reduce((max, s) => {
    const at = s.activity?.needsAttentionAt;
    return at && Date.parse(at) > Date.parse(max) ? at : max;
  }, opts.after);
  return { sessions: hit, cursor, timedOut: false };
}

// ---------------------------------------------------------------------------
// Conversation waits (unified MCP design 2026-10-15 §8; plan Task 8): a chat's work state and final
// reply, waiting while chats work, and the reply-subscription wait with its release on cancel.
// ---------------------------------------------------------------------------

/** A chat's state as the conversation tools report it. */
export type WorkState = "working" | "needs-input" | "idle" | "failed";

/** What a chat looks like to the conversation tools: its state, its latest finished turn and that turn's answer. */
export interface WorkReport {
  sessionId: string;
  title: string;
  agent: string;
  state: WorkState;
  /** Turns started so far (read_transcript's numbers). */
  turnCount: number;
  /** The latest finished turn: its number, id and how it ended. */
  lastTurn?: { turn: number; turnId: string; state: string };
  /** That turn's final reply (another chat's words: content, §5.2). */
  reply?: string;
  replyTruncated?: true;
  /** §13 d: the turn completed without a written reply; `hint` points at read_transcript. */
  emptyReply?: true;
  hint?: string;
  /** Why the session or its latest turn failed. */
  error?: string;
  /** What it waits on its user for. */
  waitingOn?: { approvals: number; questions: number };
}

/** The reply's ceiling in UTF-8 bytes of its JSON, inside the 60 000-byte result cap. */
export const WORK_REPLY_MAX_BYTES = 40_000;
const WORK_REPLY_MAX_CHARS = 40_000;

/** Busy by the tab's summary alone: a turn starting or running, or a goal the provider continues. */
function summaryBusy(s: SessionSummary): boolean {
  return (
    s.chatSessionStatus === "running" ||
    s.chatSessionStatus === "starting" ||
    s.latestTurn?.state === "running" ||
    s.latestTurn?.state === "pending" ||
    s.goal?.continuing === true
  );
}

/**
 * A chat's state from its summary AND its thread's head just read — the summary trails the host by
 * up to one poll, so either one saying busy is busy, and the thread's own open requests are the
 * truth about needs-input.
 */
export function workState(s: SessionSummary, thread: ThreadHeadResponse): WorkState {
  if (thread.pending.approvals.length > 0 || thread.pending.userInputs.length > 0) return "needs-input";
  const head = thread.head.session;
  const last = thread.recentTurns.at(-1);
  if (summaryBusy(s) || head.activeTurnId !== null || head.status === "running" || head.status === "starting" || (last !== undefined && !SETTLED_TURN_STATES.has(last.state))) {
    return "working";
  }
  if (s.chatSessionStatus === "error" || head.status === "error") return "failed";
  return "idle";
}

/** The report of one chat, its summary and thread head (read with `replyChars: WORK_REPLY_MAX_CHARS`) already read. */
export function workReport(s: SessionSummary, thread: ThreadHeadResponse): WorkReport {
  const state = workState(s, thread);
  const report: WorkReport = { sessionId: s.id, title: s.title, agent: s.refId, state, turnCount: thread.startedTurnCount };
  const settled = thread.lastSettledTurn;
  if (settled) {
    const turn = settled.turn;
    report.lastTurn = { turn: settled.ordinal ?? thread.startedTurnCount, turnId: turn.turnId!, state: turn.state };
    if (turn.state === "failed" && turn.errorMessage) report.error = turn.errorMessage;
  }
  const reply = replyWithin(thread.lastReply, WORK_REPLY_MAX_CHARS);
  if (reply && reply.text.trim()) {
    const fitted = fitJsonBytes(reply.text, WORK_REPLY_MAX_BYTES);
    report.reply = fitted.text;
    if (reply.truncated || fitted.truncated) report.replyTruncated = true;
  } else if (report.lastTurn?.state === "completed") {
    report.emptyReply = true;
    report.hint = replyNoticeText("empty", { title: s.title, sessionId: s.id });
  }
  if (state === "failed" && thread.head.session.lastError) report.error = thread.head.session.lastError;
  if (state === "needs-input") report.waitingOn = { approvals: thread.pending.approvals.length, questions: thread.pending.userInputs.length };
  return report;
}

/** A chat's report now; null once it is closed. Reads the thread's head, never its whole snapshot. */
export async function readWorkReport(api: DaemonApi, sessionId: string, sessions?: readonly SessionSummary[]): Promise<WorkReport | null> {
  const summary = (sessions ?? (await listSessions(api))).find((s) => s.id === sessionId);
  if (!summary) return null;
  try {
    return workReport(summary, await readThreadHead(api, sessionId, { replyChars: WORK_REPLY_MAX_CHARS }));
  } catch (error) {
    // Closed between the list and the read.
    if (error instanceof ToolError && (error.code === "THREAD_NOT_FOUND" || error.code === "NOT_FOUND")) return null;
    throw error;
  }
}

/** How long a wait whose reads said "still working" waits for the bus before looking again anyway (a safety net). */
const WORK_RECHECK_MS = 10_000;

/**
 * Wait while every chat of `ids` is working — until one of them reaches a state `until` accepts
 * (default: anything but working), closes, the timeout passes or `signal` aborts. Event-driven on
 * the daemon bus (each event about one of them re-reads them), never a polling sleep; the reads are
 * the thread's own, so a summary one poll behind never ends the wait early. Returns the reports it
 * ended on (null for a closed chat).
 */
export async function waitWhileWorking(
  api: DaemonApi,
  ids: readonly string[],
  opts: {
    timeoutMs: number;
    signal: AbortSignal;
    now: () => number;
    until?: (state: WorkState) => boolean;
    /**
     * Look only after the next bus event about one of them (or the safety re-check): for a caller
     * the host just refused for a reason these reads may not see yet, so it never re-asks in a loop.
     */
    afterNextEvent?: boolean;
  }
): Promise<{ reports: Map<string, WorkReport | null>; timedOut: boolean; cancelled: boolean }> {
  const until = opts.until ?? ((state: WorkState) => state !== "working");
  const watched = new Set(ids);
  const startedAt = opts.now();
  const startedMono = performance.now();
  const remaining = () => opts.timeoutMs - Math.max(opts.now() - startedAt, performance.now() - startedMono);
  let events = 0;
  let wake: (() => void) | null = null;
  const off = api.subscribe((event) => {
    if (event.channel !== "sessions" || !watched.has((event.payload as { id?: string } | null)?.id ?? "")) return;
    events += 1;
    const w = wake;
    wake = null;
    w?.();
  });
  const pause = (left: number) =>
    new Promise<void>((resolve) => {
      const resume = () => { clearTimeout(timer); opts.signal.removeEventListener("abort", resume); wake = null; resolve(); };
      const timer = setTimeout(resume, Math.min(left, WORK_RECHECK_MS));
      opts.signal.addEventListener("abort", resume, { once: true });
      wake = resume;
    });
  try {
    if (opts.afterNextEvent && !opts.signal.aborted && remaining() > 0) await pause(remaining());
    for (;;) {
      const seen = events;
      const sessions = await listSessions(api);
      // A summary that says busy (no open request) is working whatever the thread says: no thread read.
      const plainlyWorking = (id: string): boolean => {
        const summary = sessions.find((s) => s.id === id);
        return summary !== undefined && !summary.hasPendingApprovals && !summary.hasPendingUserInput && summaryBusy(summary) && !until("working");
      };
      const reports = new Map<string, WorkReport | null>();
      let ended = false;
      for (const id of ids) {
        if (plainlyWorking(id)) continue;
        const report = await readWorkReport(api, id, sessions);
        reports.set(id, report);
        if (report === null || until(report.state)) ended = true;
      }
      const left = remaining();
      if (ended || opts.signal.aborted || left <= 0) {
        // The answer reports every session in full.
        for (const id of ids) if (!reports.has(id)) reports.set(id, await readWorkReport(api, id, sessions));
        return { reports, timedOut: !ended && !opts.signal.aborted, cancelled: !ended && opts.signal.aborted };
      }
      if (events === seen) await pause(left);
    }
  } finally {
    off();
  }
}

/**
 * Attach the caller's waiter to one reply subscription (socket-only route) until the bound turn's
 * reply, `timeoutSeconds`, or that turn asking its user something (§8.1, §8.3). `DaemonApi.request`
 * cannot abort its in-process inject, so when `signal` aborts (the provider cancelled the call, the
 * turn was stopped) the waiter is RELEASED through its own route. The router keeps a release
 * tombstone: a release that lands before the waiter attached still turns the subscription into
 * `notify` (the late wait answers at once), and a reply a waiter already took is re-delivered as a
 * message — so is one whose tool result never reached the provider (`delivered` resolving false,
 * as `request_secret` and the approval cards read it).
 */
export async function awaitReplySubscription(
  api: DaemonApi,
  targetId: string,
  subscriptionId: string,
  timeoutSeconds: number,
  signal: AbortSignal,
  delivered?: Promise<boolean>
): Promise<ReplyWaitResponse> {
  // One release per call at most: a cancel and an undelivered result are the same call going away.
  let releasedOnce = false;
  const release = (): void => {
    if (releasedOnce) return;
    releasedOnce = true;
    void api.request("POST", agentChatRoutes.replySubscriptionRelease(targetId, subscriptionId)).catch(() => undefined);
  };
  const waiting = api.request("POST", agentChatRoutes.replySubscriptionWait(targetId, subscriptionId), { body: { timeoutSeconds } });
  if (signal.aborted) release();
  else signal.addEventListener("abort", release, { once: true });
  let answer: ReplyWaitResponse;
  try {
    answer = expectOk<ReplyWaitResponse>(await waiting);
  } finally {
    signal.removeEventListener("abort", release);
  }
  // The waiter took the reply: if the call's result never reaches the provider, the router sends it as a message.
  if (answer.outcome === "replied" && delivered) void delivered.then((ok) => { if (!ok) release(); });
  return answer;
}
