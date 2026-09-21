/**
 * The host's **coarse** per-thread signal stream (spec §6.4).
 *
 * `GET /signals` on the agent-host socket is a long-lived NDJSON stream of the
 * only thread facts the daemon itself needs: the six `SessionSummary` fields
 * of §6.4, the turn transitions that become `agentChat.turn`, the request
 * open/close pairs that become `agentChat.pending`, and the coarse
 * `agent.providers.changed`.
 *
 * It exists because those fields are not all derivable from
 * `events.ndjson`: `backgroundLiveness` is an **in-memory** registry on the
 * host (§3.1, "deliberately not persisted"), so no fold over the persisted log
 * can produce it. Subscribing the daemon to every thread's full event stream
 * would also put the whole timeline — deltas included — through the daemon on
 * its way to nothing, which §6.4's "nothing higher-rate rides the bus" exists
 * to prevent.
 *
 * Contract rules:
 * - The first frame on every (re)connect is `hello`, carrying the host
 *   instance id and the CURRENT fields of every live thread. The daemon
 *   replaces its whole map from it — a restarted host is not a reconnect (§8),
 *   and an in-memory liveness registry is empty after a restart, which is
 *   correct.
 * - Everything after `hello` is a delta. A `thread` frame carries the full
 *   six-field shape for one thread, never a patch.
 * - A `thread` frame with `gone: true` means the thread no longer exists on
 *   the host (deleted); the daemon drops its derived state.
 * - Unknown `kind`s are ignored, never fatal: the host may be a build ahead of
 *   the daemon (§8's rollback boundary cuts both ways).
 */

import type {
  AgentAdapterId,
  AgentChatSessionSummaryFields,
  TurnState,
  TurnTokenUsage
} from "@orquester/api/agent-chat";

/** Opening frame: the full current state, sent before any delta. */
export interface AgentHostSignalHelloFrame {
  kind: "hello";
  hostInstanceId: string;
  threads: Array<{ threadId: string; fields: AgentChatSessionSummaryFields }>;
}

/** One thread's six §6.4 fields, in full. `gone` retires the thread. */
export interface AgentHostSignalThreadFrame {
  kind: "thread";
  threadId: string;
  fields: AgentChatSessionSummaryFields;
  gone?: boolean;
}

/** Becomes the `agentChat.turn` bus event. */
export interface AgentHostSignalTurnFrame {
  kind: "turn";
  threadId: string;
  turnId: string | null;
  state: TurnState;
  tokenUsage?: TurnTokenUsage;
}

/** Becomes the `agentChat.pending` bus event, and drives the push copy. */
export interface AgentHostSignalPendingFrame {
  kind: "pending";
  threadId: string;
  requestId: string;
  requestKind: "approval" | "question";
  title: string;
  open: boolean;
}

/** Becomes the coarse `agent.providers.changed`; the client re-reads §6.3. */
export interface AgentHostSignalProvidersFrame {
  kind: "providers";
  adapterId?: AgentAdapterId;
}

export type AgentHostSignalFrame =
  | AgentHostSignalHelloFrame
  | AgentHostSignalThreadFrame
  | AgentHostSignalTurnFrame
  | AgentHostSignalPendingFrame
  | AgentHostSignalProvidersFrame;

/** The heartbeat comment the stream sends while idle; skipped by the parser. */
export const AGENT_HOST_SIGNALS_HEARTBEAT = ":hb";

/**
 * Tolerant parse of one NDJSON line. Blank lines, `:` comments, malformed
 * JSON and frames whose required fields are missing all answer `null` — this
 * reads another process's output, so a bad line may only be skipped, never
 * throw into the daemon's read loop.
 */
export function parseAgentHostSignalFrame(line: string): AgentHostSignalFrame | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const frame = parsed as Record<string, unknown>;
  switch (frame.kind) {
    case "hello": {
      if (typeof frame.hostInstanceId !== "string" || !frame.hostInstanceId) return null;
      const rows = Array.isArray(frame.threads) ? frame.threads : [];
      const threads: AgentHostSignalHelloFrame["threads"] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const entry = row as Record<string, unknown>;
        if (typeof entry.threadId !== "string" || !entry.threadId) continue;
        threads.push({
          threadId: entry.threadId,
          fields: sanitizeFields(entry.fields)
        });
      }
      return { kind: "hello", hostInstanceId: frame.hostInstanceId, threads };
    }
    case "thread": {
      if (typeof frame.threadId !== "string" || !frame.threadId) return null;
      const out: AgentHostSignalThreadFrame = {
        kind: "thread",
        threadId: frame.threadId,
        fields: sanitizeFields(frame.fields)
      };
      if (frame.gone === true) out.gone = true;
      return out;
    }
    case "turn": {
      if (typeof frame.threadId !== "string" || !frame.threadId) return null;
      if (typeof frame.state !== "string") return null;
      const out: AgentHostSignalTurnFrame = {
        kind: "turn",
        threadId: frame.threadId,
        turnId: typeof frame.turnId === "string" ? frame.turnId : null,
        state: frame.state as TurnState
      };
      if (frame.tokenUsage && typeof frame.tokenUsage === "object") {
        out.tokenUsage = frame.tokenUsage as TurnTokenUsage;
      }
      return out;
    }
    case "pending": {
      if (typeof frame.threadId !== "string" || !frame.threadId) return null;
      if (typeof frame.requestId !== "string" || !frame.requestId) return null;
      if (frame.requestKind !== "approval" && frame.requestKind !== "question") return null;
      return {
        kind: "pending",
        threadId: frame.threadId,
        requestId: frame.requestId,
        requestKind: frame.requestKind,
        title: typeof frame.title === "string" ? frame.title : "",
        open: frame.open !== false
      };
    }
    case "providers": {
      const out: AgentHostSignalProvidersFrame = { kind: "providers" };
      if (typeof frame.adapterId === "string") out.adapterId = frame.adapterId as AgentAdapterId;
      return out;
    }
    default:
      // A build-ahead host may send a kind this daemon has never heard of.
      return null;
  }
}

/**
 * Keep only the six §6.4 fields, each only when it has the right shape. A
 * field written by a newer host with an unexpected type is dropped rather than
 * trusted, because the ladder in `activity-ladder.ts` branches on it.
 */
function sanitizeFields(value: unknown): AgentChatSessionSummaryFields {
  const fields: AgentChatSessionSummaryFields = {};
  if (!value || typeof value !== "object") {
    return fields;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.hasPendingApprovals === "boolean") fields.hasPendingApprovals = row.hasPendingApprovals;
  if (typeof row.hasPendingUserInput === "boolean") fields.hasPendingUserInput = row.hasPendingUserInput;
  if (typeof row.hasActionableProposedPlan === "boolean") {
    fields.hasActionableProposedPlan = row.hasActionableProposedPlan;
  }
  if (row.backgroundLiveness === "working" || row.backgroundLiveness === "monitoring") {
    fields.backgroundLiveness = row.backgroundLiveness;
  } else if (row.backgroundLiveness === null) {
    fields.backgroundLiveness = null;
  }
  if (row.latestTurn === null) {
    fields.latestTurn = null;
  } else if (row.latestTurn && typeof row.latestTurn === "object") {
    const turn = row.latestTurn as Record<string, unknown>;
    if (typeof turn.state === "string") {
      fields.latestTurn = {
        turnId: typeof turn.turnId === "string" ? turn.turnId : null,
        state: turn.state as TurnState,
        startedAt: typeof turn.startedAt === "string" ? turn.startedAt : null,
        completedAt: typeof turn.completedAt === "string" ? turn.completedAt : null
      };
    }
  }
  if (typeof row.chatSessionStatus === "string") {
    fields.chatSessionStatus = row.chatSessionStatus as NonNullable<
      AgentChatSessionSummaryFields["chatSessionStatus"]
    >;
  }
  return fields;
}
