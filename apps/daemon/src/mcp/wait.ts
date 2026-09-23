import type { SessionSummary } from "@orquester/api";
import { SETTLED_TURN_STATES } from "@orquester/api/agent-chat";
import { resolveChatActivity } from "../agent-chat/activity-ladder.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import { listSessions } from "./reads.ts";

export interface WatchState { sessions: ReadonlyMap<string, SessionSummary>; closed: ReadonlySet<string> }
export interface WatchOptions<T> { api: DaemonApi; select: (s: SessionSummary) => boolean; evaluate: (state: WatchState) => T | null; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number; rereadMs?: number }

const DEFAULT_SETTLE_MS = 300;
const DEFAULT_REREAD_MS = 10_000;

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
 * listener, never thrown into the publisher.
 */
export async function watchSessions<T>(opts: WatchOptions<T>): Promise<T | null> {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const rereadMs = opts.rereadMs ?? DEFAULT_REREAD_MS;
  let sessions = new Map<string, SessionSummary>();
  const closed = new Set<string>();
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  let latched: { hit: T } | { error: unknown } | null = null;
  const check = (): { hit: T } | { error: unknown } | null => {
    if (latched !== null) return latched;
    try {
      const hit = opts.evaluate({ sessions, closed });
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
      if (opts.select(s)) sessions.set(s.id, keepActivity(s));
      else if (!sessions.delete(s.id)) return;
    } else if (event.type === "session.activity") {
      const cur = payload.id ? sessions.get(payload.id) : undefined;
      if (!cur) return;
      sessions.set(cur.id, { ...cur, activity: (event.payload as { activity: SessionSummary["activity"] }).activity });
    } else if (event.type === "session.closed") {
      if (!payload.id) return;
      closed.add(payload.id);
      if (!sessions.delete(payload.id)) return;
    } else return;
    check();
    notify();
  });
  // Built beside the old map, which keepActivity still reads; a closed id stays closed
  // even when the list predates its close.
  const reload = async () => {
    const list = await listSessions(opts.api);
    const next = new Map<string, SessionSummary>();
    for (const s of list) if (opts.select(s) && !closed.has(s.id)) next.set(s.id, keepActivity(s));
    sessions = next;
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
    await reload();
    for (;;) {
      if (opts.signal.aborted) return null;
      const found = check();
      if (found !== null) {
        if ("error" in found) throw found.error;
        if (settleMs > 0 && settleMs < remaining()) {
          await sleep(settleMs);
          if (opts.signal.aborted) return null;
          await reload();
          const settled = opts.evaluate({ sessions, closed });
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

export async function waitForTurn(api: DaemonApi, sessionId: string, baseline: TurnBaseline, opts: { timeoutMs: number; signal: AbortSignal; now: () => number }): Promise<{ outcome: TurnOutcome; summary: SessionSummary | null }> {
  let last: SessionSummary | null = null;
  const hit = await watchSessions<{ outcome: TurnOutcome; summary: SessionSummary }>({
    api, select: (s) => s.id === sessionId, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: 0,
    evaluate: (state) => {
      if (state.closed.has(sessionId)) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while waiting.`);
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

export async function waitForAttention(api: DaemonApi, opts: { select: (s: SessionSummary) => boolean; after: string; timeoutMs: number; signal: AbortSignal; now: () => number; settleMs?: number }): Promise<{ sessions: SessionSummary[]; cursor: string; timedOut: boolean }> {
  const hit = await watchSessions<SessionSummary[]>({
    api, select: opts.select, timeoutMs: opts.timeoutMs, signal: opts.signal, now: opts.now, settleMs: opts.settleMs,
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
