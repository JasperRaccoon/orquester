import type { SessionActivity, SessionActivityEvent, SessionSummary } from "@orquester/api";
import { SETTLED_TURN_STATES } from "@orquester/api/agent-chat";
import { resolveChatActivity } from "../agent-chat/activity-ladder.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import { listSessions } from "./reads.ts";

export interface WatchState { sessions: ReadonlyMap<string, SessionSummary>; closed: ReadonlySet<string> }
export interface WatchOptions<T> {
  api: DaemonApi; select: (s: SessionSummary) => boolean; evaluate: (state: WatchState) => T | null; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number; rereadMs?: number;
  /**
   * Set for a single-session wait (`select` admitting just this id): the session closing, or already missing
   * from the first read, rejects the watch with SESSION_NOT_FOUND at once rather than running it to the timeout.
   */
  sessionId?: string;
}

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
export async function watchSessions<T>(opts: WatchOptions<T>): Promise<T | null> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const rereadMs = opts.rereadMs ?? DEFAULT_REREAD_MS;
  let sessions = new Map<string, SessionSummary>();
  const closed = new Set<string>();
  // Activity published while a list read is in flight, which that read may predate; null between reads.
  let heard: Map<string, SessionActivity> | null = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  let latched: { hit: T } | { error: unknown } | null = null;
  // A single-session watch ends on that session's close, whatever the caller's evaluate would make of it.
  const evaluate = (state: WatchState): T | null => {
    if (opts.sessionId !== undefined && state.closed.has(opts.sessionId)) throw new ToolError("SESSION_NOT_FOUND", `Session "${opts.sessionId}" was closed while waiting.`);
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
      if (opts.select(s)) sessions.set(s.id, keepActivity(s));
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
      if (!opts.select(s) || closed.has(s.id)) continue;
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
    if (opts.sessionId !== undefined && !first.some((s) => s.id === opts.sessionId)) closed.add(opts.sessionId);
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

export interface TurnBaseline { turnId: string | null; completedAt: string | null; running: boolean }
export function turnBaseline(s: SessionSummary): TurnBaseline {
  const lt = s.latestTurn ?? null;
  const running = s.chatSessionStatus === "running" || s.chatSessionStatus === "starting" || lt?.state === "running" || lt?.state === "pending";
  return { turnId: lt?.turnId ?? null, completedAt: lt?.completedAt ?? null, running };
}

export type TurnOutcome = "completed" | "needs-input" | "plan-ready" | "interrupted" | "failed" | "timeout";

function turnOutcome(s: SessionSummary, baseline: TurnBaseline): TurnOutcome | null {
  if (s.hasPendingApprovals || s.hasPendingUserInput) return "needs-input";
  const lt = s.latestTurn ?? null;
  // Not the turn the wait started from: another one, or — for a steer into a running turn — that turn, now settled.
  const isNew = lt !== null && (lt.turnId !== baseline.turnId || (baseline.running && lt.completedAt !== baseline.completedAt));
  // plan-ready waits for a new turn too: the summary moves only on the host poll, so the
  // first reads after implement_plan posts still show the very plan being implemented.
  if (isNew && resolveChatActivity(s).rung === "plan-ready") return "plan-ready";
  if (s.chatSessionStatus === "error") return "failed";
  if (!lt || !isNew || !SETTLED_TURN_STATES.has(lt.state)) return null;
  if (lt.state === "completed") return "completed";
  if (lt.state === "failed") return "failed";
  return "interrupted";
}

/** §9.1's wait on one session's turn. Rejects with SESSION_NOT_FOUND when the session closes, or is gone by the first read. */
export async function waitForTurn(api: DaemonApi, sessionId: string, baseline: TurnBaseline, opts: { timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<{ outcome: TurnOutcome; summary: SessionSummary | null }> {
  let last: SessionSummary | null = null;
  const hit = await watchSessions<{ outcome: TurnOutcome; summary: SessionSummary }>({
    api, sessionId, select: (s) => s.id === sessionId, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: 0,
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
export function attentionQualifies(s: SessionSummary, after: string): boolean {
  const a = s.activity;
  return Boolean(a && a.attention !== null && a.needsAttentionAt && Date.parse(a.needsAttentionAt) > Date.parse(after));
}

/**
 * §9.2's wait. With `sessionId` (and a `select` admitting just it) the session closing, or being gone by the first
 * read, rejects with SESSION_NOT_FOUND; a project-wide or unfiltered wait just stops watching a closed session.
 */
export async function waitForAttention(api: DaemonApi, opts: { select: (s: SessionSummary) => boolean; sessionId?: string; after: string; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number }): Promise<{ sessions: SessionSummary[]; cursor: string; timedOut: boolean }> {
  const hit = await watchSessions<SessionSummary[]>({
    api, select: opts.select, sessionId: opts.sessionId, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: opts.settleMs,
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
