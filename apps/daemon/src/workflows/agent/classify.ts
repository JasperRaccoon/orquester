// Automated workflows — what a watched session's thread says about the block (spec §5.4, §5.5).
//
// Account failures are read STRUCTURALLY — `failureReasonOfActivity` (@orquester/api/agent-chat),
// which reads the `reason` / `resetsAt` every adapter stamps on its `runtime.error` /
// `runtime.warning` rows, with the documented legacy-prefix fallback only for a row that carries no
// `reason` at all. Only rows written after the block's baseline count.
//
// Known gap (documented, covered by `maxMinutes`): an OpenCode session whose provider answers a 429
// by retrying silently reports nothing at all — no row, no settled turn — so the block sees a turn
// that never ends. `maxMinutes` interrupts it and the block fails `timeout`.

import type { SessionSummary } from "@orquester/api";
import {
  failureReasonOfActivity,
  SETTLED_TURN_STATES,
  type ActivityFailureReason,
  type LatestTurnSummary,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";
import { turnBaseline, type TurnBaseline } from "../../chat-client/index.ts";

/** Where a block started watching a session: persisted with the command it precedes (§5.8). */
export interface AgentBaseline {
  /** `turnBaseline(summary)` — the chat-client's turn baseline. */
  turn: TurnBaseline;
  /** The newest item of the thread when the baseline was taken; rows after it are the block's. */
  lastItemId: string | null;
  /** Wall-clock ISO time the baseline was taken (the fallback cut when `lastItemId` left the window). */
  at: string;
  /** The thread's session status then: an `error` already there is not this block's failure. */
  sessionStatus?: string;
}

export function takeBaseline(summary: SessionSummary | null, snap: ThreadSnapshotPayload | null, now: Date): AgentBaseline {
  let turn: TurnBaseline = summary ? turnBaseline(summary) : { turnId: null, completedAt: null, running: false };
  // The snapshot is AHEAD of the summary (the summary rides a host poll), so its latest turn wins:
  // a summary still showing a settled turn as running would otherwise make that turn's settling look
  // like a new turn of ours.
  const last = snap?.turns.at(-1);
  if (snap && last) {
    const status = snap.head.session.status;
    turn = {
      turnId: last.turnId,
      completedAt: last.completedAt,
      running: last.state === "running" || last.state === "pending" || status === "running" || status === "starting"
    };
  }
  const sessionStatus = snap?.head.session.status ?? summary?.chatSessionStatus;
  return { turn, lastItemId: snap?.items.at(-1)?.id ?? null, at: now.toISOString(), ...(sessionStatus ? { sessionStatus } : {}) };
}

/** Parse a persisted baseline; null when it does not read. */
export function parseBaseline(value: unknown): AgentBaseline | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const turn = v.turn as Record<string, unknown> | undefined;
  if (!turn || typeof turn !== "object" || typeof v.at !== "string") return null;
  return {
    turn: {
      turnId: typeof turn.turnId === "string" ? turn.turnId : null,
      completedAt: typeof turn.completedAt === "string" ? turn.completedAt : null,
      running: turn.running === true
    },
    lastItemId: typeof v.lastItemId === "string" ? v.lastItemId : null,
    at: v.at,
    ...(typeof v.sessionStatus === "string" ? { sessionStatus: v.sessionStatus } : {})
  };
}

/**
 * The thread's rows written after the baseline: everything after `lastItemId` in list (log)
 * order; when that row left the retained window, the rows created after the baseline's time.
 */
export function itemsAfterBaseline(items: readonly ThreadItem[], baseline: AgentBaseline): ThreadItem[] {
  if (baseline.lastItemId === null) return [...items];
  const at = items.findIndex((item) => item.id === baseline.lastItemId);
  if (at !== -1) return items.slice(at + 1);
  const cut = Date.parse(baseline.at);
  return items.filter((item) => {
    const created = Date.parse(item.createdAt);
    return Number.isFinite(created) && created > cut;
  });
}

/** The newest account failure (usage limit / auth) the thread reports after the baseline, or null. */
export function failureAfterBaseline(snap: ThreadSnapshotPayload, baseline: AgentBaseline): ActivityFailureReason | null {
  const after = itemsAfterBaseline(snap.items, baseline);
  for (let i = after.length - 1; i >= 0; i -= 1) {
    const item = after[i]!;
    if (item.kind !== "activity") continue;
    const failure = failureReasonOfActivity(item);
    if (failure) return failure;
  }
  return null;
}

/**
 * The latest turn is not the one the baseline saw: another turn, or — when the baseline saw a turn
 * running — that same turn, now settled (the chat-client's `turnOutcome` rule).
 */
export function isNewTurn(latest: LatestTurnSummary | null | undefined, baseline: TurnBaseline): boolean {
  if (!latest) return false;
  return latest.turnId !== baseline.turnId || (baseline.running && latest.completedAt !== baseline.completedAt);
}

export function isSettled(latest: LatestTurnSummary | null | undefined): boolean {
  return Boolean(latest && SETTLED_TURN_STATES.has(latest.state));
}

/** The host's own words for a failed turn / errored session: `lastError`, the turn's error, the newest error row. */
export function agentErrorMessage(snap: ThreadSnapshotPayload | null, baseline: AgentBaseline): string {
  const lastError = snap?.head.session.lastError;
  if (lastError && lastError.trim()) return lastError.trim();
  const turn = snap?.turns.at(-1);
  if (turn?.errorMessage && turn.errorMessage.trim()) return turn.errorMessage.trim();
  if (snap) {
    const after = itemsAfterBaseline(snap.items, baseline);
    for (let i = after.length - 1; i >= 0; i -= 1) {
      const item = after[i]!;
      if (item.kind === "activity" && item.activityKind === "runtime.error") {
        const payload = (item.payload ?? {}) as { message?: unknown };
        return typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : item.summary;
      }
    }
  }
  if (turn?.state === "interrupted") return "The agent's turn was interrupted.";
  return "The agent's turn failed.";
}

/**
 * The activity rows that say what the agent DOES: its tool calls, the subagents it launches, the
 * cards it raises, a compaction, a proposed plan. Never `runtime.warning` / `runtime.error` (a
 * provider's stderr — Codex's "Linux sandbox uses bubblewrap…" — or its own notices), a tool's raw
 * `tool.output` chunk, or any other bookkeeping row.
 */
const ACTIVITY_LINE_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.denied",
  "task.started",
  "task.completed",
  "approval.requested",
  "user-input.requested",
  "context-compaction",
  "turn.proposed.completed"
]);

/**
 * A one-line description of what the parent is doing now, for the run view (`activity`): its
 * newest assistant text or meaningful activity row (`ACTIVITY_LINE_KINDS`), else its turn's state.
 */
export function activityLine(snap: ThreadSnapshotPayload): string | undefined {
  for (let i = snap.items.length - 1; i >= 0; i -= 1) {
    const item = snap.items[i]!;
    if (item.kind === "message") {
      if (item.agentId || item.role !== "assistant") continue;
      const line = item.text.split("\n").map((l) => l.trim()).find(Boolean);
      if (line) return clipLine(line);
      continue;
    }
    const activity = item as ThreadActivityItem;
    if (activity.agentId || !ACTIVITY_LINE_KINDS.has(activity.activityKind)) continue;
    if (activity.summary && activity.summary.trim()) return clipLine(activity.summary.trim());
  }
  const turn = snap.turns.at(-1);
  if (turn && (turn.state === "running" || turn.state === "pending")) return "Working";
  return undefined;
}

function clipLine(line: string): string {
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
