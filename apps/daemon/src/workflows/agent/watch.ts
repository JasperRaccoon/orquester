// Automated workflows — watching an unattended agent (spec §5.5).
//
// Event-driven: the watcher subscribes to the daemon bus (`api.subscribe`) and re-reads the
// session summary and thread on every event about its session, plus a safety re-read every 10 s —
// a parked Claude turn writes its usage-limit warning without moving the summary. No sleeps: every
// wait is the injected clock's timer or a bus event.
//
// What it decides, in order, on every observation (only rows / turns after the block's baseline):
//   1. an account failure (usage limit / auth, `failureReasonOfActivity`) → the failover loop (§5.4);
//   2. an open question → answer it (never /dismiss) — message-mode ones too;
//   3. an open approval (should not happen under full access) → accept;
//   4. a plan card on a settled turn (the model called ExitPlanMode anyway) → implement it;
//   5. a failed / interrupted new turn, or a session that went `error` → `agent_error`;
//   6. done = the latest turn settled after the baseline AND the ladder's rung is `completed` (no
//      background work, no continuing goal, nothing pending) — or `monitoring` (only watch loops,
//      e.g. a dev server) after a 60 s grace when `whenOnlyWatchLoopsRemain: "finish"` — held for a
//      5 s quiet window, because a background agent finishing can wake the parent into a
//      provider-started turn;
// and `maxMinutes` / the run's cancel end the watch from outside.
//
// The watcher itself performs NO side effect: it returns what to do, and the executor persists its
// `WaitingOn` before doing it (§5.8).

import type { SessionSummary } from "@orquester/api";
import {
  agentChatRoutes,
  isPlanImplementationMessage,
  type ActivityFailureReason,
  type PendingApproval,
  type PendingUserInput,
  type ThreadItemResponse,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";
import { expectOk, listSessions, readThread, resolveChatActivity, type DaemonApi } from "../../chat-client/index.ts";
import type { Clock, WorkflowLogger } from "../contracts.ts";
import { activityLine, agentErrorMessage, failureAfterBaseline, isNewTurn, isSettled, itemsAfterBaseline, type AgentBaseline } from "./classify.ts";
import { AUTONOMOUS_ANSWER } from "./prompt.ts";

export interface WatchTimings {
  /** How long "done" must hold before the output is read. */
  quietMs: number;
  /** How long only watch loops must remain before `whenOnlyWatchLoopsRemain: "finish"` finishes. */
  monitorGraceMs: number;
  /** The safety re-read, whatever the bus says. */
  rereadMs: number;
  /** At most one `activity` update per this long. */
  activityThrottleMs: number;
}

export const DEFAULT_WATCH_TIMINGS: WatchTimings = {
  quietMs: 5_000,
  monitorGraceMs: 60_000,
  rereadMs: 10_000,
  activityThrottleMs: 2_000
};

export type WatchOutcome =
  | { kind: "done"; snapshot: ThreadSnapshotPayload; summary: SessionSummary }
  | { kind: "failure"; failure: ActivityFailureReason }
  | { kind: "question"; request: PendingUserInput }
  | { kind: "approval"; request: PendingApproval }
  | { kind: "plan"; markdown: string }
  | { kind: "failed"; message: string }
  | { kind: "closed" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface WatchInput {
  api: DaemonApi;
  sessionId: string;
  baseline: AgentBaseline;
  clock: Clock;
  signal: AbortSignal;
  /** Wall clock: `maxMinutes` from the block's start (waits for a reset excluded). */
  deadlineAt: Date;
  whenOnlyWatchLoopsRemain: "finish" | "wait";
  /** Request ids this block already answered (a snapshot may list one for a moment longer). */
  handled: ReadonlySet<string>;
  timings?: Partial<WatchTimings>;
  onActivity?: (line: string) => void;
  logger?: WorkflowLogger;
}

/** The session's bus events and the timers, as one wake-up. */
export interface Waker {
  /** Resolves on the next event about the session, after `ms`, or on abort — at once when one already came. */
  wait(ms: number): Promise<void>;
  dispose(): void;
}

export function createWaker(api: DaemonApi, sessionId: string, clock: Clock, signal: AbortSignal): Waker {
  let dirty = false;
  let wake: (() => void) | null = null;
  const fire = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
    else dirty = true;
  };
  const off = api.subscribe((event) => {
    if (event.channel !== "sessions") return;
    const payload = event.payload as { id?: unknown } | null;
    if (payload && payload.id === sessionId) fire();
  });
  signal.addEventListener("abort", fire);
  return {
    wait(ms: number): Promise<void> {
      if (dirty || signal.aborted) {
        dirty = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = clock.setTimeout(() => {
          wake = null;
          resolve();
        }, Math.max(0, ms));
        wake = () => {
          timer.cancel();
          resolve();
        };
      });
    },
    dispose(): void {
      off();
      signal.removeEventListener("abort", fire);
      const w = wake;
      wake = null;
      w?.();
    }
  };
}

export interface Observation {
  summary: SessionSummary | null;
  snapshot: ThreadSnapshotPayload | null;
  /** The session is no longer listed (closed). */
  gone: boolean;
}

/** One read of the session's summary and thread. A failed read is no observation, never a verdict. */
export async function observe(api: DaemonApi, sessionId: string, logger?: WorkflowLogger): Promise<Observation | null> {
  let summary: SessionSummary | null;
  try {
    summary = (await listSessions(api)).find((s) => s.id === sessionId) ?? null;
  } catch (error) {
    logger?.debug("agent watch: session list read failed", { sessionId, error: String(error) });
    return null;
  }
  if (!summary) return { summary: null, snapshot: null, gone: true };
  try {
    return { summary, snapshot: await readThread(api, sessionId), gone: false };
  } catch (error) {
    logger?.debug("agent watch: thread read failed", { sessionId, error: String(error) });
    return null;
  }
}

/**
 * Nothing is in flight: no active turn, no pending request, no queued or running turn, no
 * background liveness, no continuing goal — the conditions the host's `identitySwitchRefusal` reads,
 * as far as the summary and the thread show them.
 */
export function isIdle(obs: Observation): boolean {
  const s = obs.summary;
  const snap = obs.snapshot;
  if (!s || !snap) return false;
  if (s.chatSessionStatus === "running" || s.chatSessionStatus === "starting") return false;
  if (s.latestTurn?.state === "running" || s.latestTurn?.state === "pending") return false;
  if (s.hasPendingApprovals || s.hasPendingUserInput || s.backgroundLiveness) return false;
  if (s.goal?.continuing === true) return false;
  const head = snap.head.session;
  if (head.activeTurnId !== null || head.status === "running" || head.status === "starting") return false;
  const last = snap.turns.at(-1);
  if (last && (last.state === "running" || last.state === "pending")) return false;
  return snap.pending.approvals.length === 0 && snap.pending.userInputs.length === 0;
}

/**
 * The newest proposed plan the thread has not implemented yet, whole (read past the wire cap when
 * cut) — only one proposed after the baseline: a plan an earlier block left is not this block's.
 */
export async function actionablePlanMarkdown(api: DaemonApi, sessionId: string, snap: ThreadSnapshotPayload, baseline?: AgentBaseline): Promise<string | null> {
  const items = baseline ? itemsAfterBaseline(snap.items, baseline) : snap.items;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) return null;
    if (item.kind !== "activity" || item.activityKind !== "turn.proposed.completed") continue;
    let payload = (item.payload ?? {}) as { planMarkdown?: unknown; truncated?: unknown };
    if (payload.truncated === true) {
      try {
        const { item: whole } = expectOk<ThreadItemResponse>(await api.request("GET", agentChatRoutes.item(sessionId, item.id)), "plan");
        payload = (whole?.kind === "activity" ? whole.payload ?? {} : {}) as typeof payload;
      } catch {
        // The slimmed text is still a plan to implement.
      }
    }
    const markdown = typeof payload.planMarkdown === "string" ? payload.planMarkdown : "";
    return markdown.trim() ? markdown : null;
  }
  return null;
}

/** §5.5: the answers an unattended block gives — a custom answer where allowed, else "(Recommended)", else the first option. */
export function autonomousAnswers(request: PendingUserInput): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const q of request.questions) {
    if (q.allowCustomAnswer || q.options.length === 0) {
      answers[q.id] = AUTONOMOUS_ANSWER;
      continue;
    }
    const option = q.options.find((o) => /\(recommended\)/i.test(o.label)) ?? q.options[0]!;
    const value = option.value ?? option.label;
    answers[q.id] = q.multiSelect ? [value] : value;
  }
  return answers;
}

/** §5.5: an approval is accepted (a one-shot grant, never "always" — OpenCode's is directory-wide). */
export function autonomousDecision(request: PendingApproval): string {
  const offered = request.options?.map((o) => o.decision);
  if (!offered || offered.length === 0 || offered.includes("accept")) return "accept";
  return offered.find((d) => d === "acceptForSession") ?? offered[0]!;
}

/** Watch a session until something needs doing, the work is done, the deadline passes or the run is cancelled. */
export async function watchAgent(input: WatchInput): Promise<WatchOutcome> {
  const timings = { ...DEFAULT_WATCH_TIMINGS, ...input.timings };
  const { api, sessionId, baseline, clock, signal } = input;
  const waker = createWaker(api, sessionId, clock, signal);
  let doneSince: number | null = null;
  let doneKey: string | null = null;
  let monitorSince: number | null = null;
  let lastActivity: string | undefined;
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  try {
    for (;;) {
      if (signal.aborted) return { kind: "cancelled" };
      const now = clock.now().getTime();
      if (now >= input.deadlineAt.getTime()) return { kind: "timeout" };
      const obs = await observe(api, sessionId, input.logger);
      if (signal.aborted) return { kind: "cancelled" };
      let nextWake = now + timings.rereadMs;
      if (obs?.gone) return { kind: "closed" };
      if (obs?.summary && obs.snapshot) {
        const s = obs.summary;
        const snap = obs.snapshot;
        const at = clock.now().getTime();

        const failure = failureAfterBaseline(snap, baseline);
        if (failure) return { kind: "failure", failure };

        const question = snap.pending.userInputs.find((r) => !input.handled.has(r.requestId));
        if (question) return { kind: "question", request: question };
        const approval = snap.pending.approvals.find((r) => !input.handled.has(r.requestId));
        if (approval) return { kind: "approval", request: approval };

        const rung = resolveChatActivity(s).rung;
        const latest = s.latestTurn ?? null;
        const newTurn = isNewTurn(latest, baseline.turn);
        const snapLast = snap.turns.at(-1);
        const snapQuiet =
          snap.head.session.activeTurnId === null &&
          snap.pending.approvals.length === 0 &&
          snap.pending.userInputs.length === 0 &&
          snapLast !== undefined &&
          isSettled(snapLast) &&
          snapLast.turnId === latest?.turnId;

        if (rung === "plan-ready" && newTurn && snapQuiet) {
          const markdown = await actionablePlanMarkdown(api, sessionId, snap, baseline);
          if (markdown) return { kind: "plan", markdown };
        }

        if (rung !== "goal-continuing") {
          // A session that reads `error` — while the thread agrees — ends the block, unless it
          // already read `error` before this block's command and nothing new has settled since.
          const sessionError = s.chatSessionStatus === "error" && snap.head.session.status === "error";
          const failedTurn = newTurn && isSettled(latest) && latest!.state !== "completed";
          if (failedTurn || (sessionError && (newTurn || !baselineIsError(baseline, snap)))) {
            return { kind: "failed", message: agentErrorMessage(snap, baseline) };
          }
        }

        const completed = newTurn && latest?.state === "completed" && snapQuiet;
        const key = completed ? `${latest!.turnId}@${latest!.completedAt}` : null;
        if (completed && (rung === "completed" || rung === "plan-ready")) {
          monitorSince = null;
          if (doneKey !== key || doneSince === null) {
            doneKey = key;
            doneSince = at;
          }
          if (at - doneSince >= timings.quietMs) return { kind: "done", snapshot: snap, summary: s };
          nextWake = Math.min(nextWake, doneSince + timings.quietMs);
        } else if (completed && rung === "monitoring" && input.whenOnlyWatchLoopsRemain === "finish") {
          doneSince = null;
          doneKey = null;
          if (monitorSince === null) monitorSince = at;
          if (at - monitorSince >= Math.max(timings.monitorGraceMs, timings.quietMs)) return { kind: "done", snapshot: snap, summary: s };
          nextWake = Math.min(nextWake, monitorSince + Math.max(timings.monitorGraceMs, timings.quietMs));
        } else {
          doneSince = null;
          doneKey = null;
          monitorSince = null;
        }

        const line = activityLine(snap);
        if (line && line !== lastActivity && at - lastActivityAt >= timings.activityThrottleMs) {
          lastActivity = line;
          lastActivityAt = at;
          input.onActivity?.(line);
        }
      }
      nextWake = Math.min(nextWake, input.deadlineAt.getTime());
      await waker.wait(nextWake - clock.now().getTime());
    }
  } finally {
    waker.dispose();
  }
}

/** The session already read `error` when the baseline was taken (a failed start the block is recovering from). */
function baselineIsError(baseline: AgentBaseline, snap: ThreadSnapshotPayload): boolean {
  return baseline.sessionStatus === "error" && snap.head.session.status === "error";
}

/** Wait until the session is idle (`isIdle`), closed, or `until` passes. */
export async function waitForIdle(input: {
  api: DaemonApi;
  sessionId: string;
  clock: Clock;
  signal: AbortSignal;
  until: Date;
  rereadMs?: number;
  logger?: WorkflowLogger;
}): Promise<"idle" | "closed" | "timeout" | "cancelled"> {
  const waker = createWaker(input.api, input.sessionId, input.clock, input.signal);
  try {
    for (;;) {
      if (input.signal.aborted) return "cancelled";
      const obs = await observe(input.api, input.sessionId, input.logger);
      if (obs?.gone) return "closed";
      if (obs && isIdle(obs)) return "idle";
      const now = input.clock.now().getTime();
      if (now >= input.until.getTime()) return "timeout";
      await waker.wait(Math.min(input.rereadMs ?? DEFAULT_WATCH_TIMINGS.rereadMs, input.until.getTime() - now));
    }
  } finally {
    waker.dispose();
  }
}
