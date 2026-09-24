/**
 * Whether a message is still being written (spec §5.1, §7.3) — one rule for
 * every reader that shows it.
 *
 * A message's `streaming` flag is the log's last word on it, and the log can
 * say `true` for good:
 *
 * - a subagent's words that rode no turn were never closed until ingestion
 *   learned to settle them on their own completion (`handleTurnlessCompletion`
 *   in `apps/daemon/src/agent-host/ingestion/index.ts`) — Claude CLI 2.1.280
 *   runs agents in the background by default, and one live thread held 5 479
 *   such messages, each a "Thinking" shimmer in its drill-in forever;
 * - a host that is killed closes nothing it was streaming, and the next host's
 *   first load does not close it either
 *   (`apps/daemon/src/agent-host/orchestration/leftover-work.ts`): every
 *   `thread.message-sent` moves the message's span in the thread index to its
 *   line, so a settle appended at the end of the log stretched an old message
 *   over everything after it, and "Load older" lost those rows.
 *
 * So the flag is never read on its own. A message reads as streaming
 * ({@link isMessageStreaming}) only while something can still be writing it:
 * its flag says so, the session is live — the notion the roster fold's
 * session-death pass uses ({@link isSessionLive}) — and either it belongs to
 * the turn the session is running or its owner (`agentId`) is an agent the
 * roster shows active (`pending`, `running`, `waiting`). Otherwise it reads as
 * settled. A turnless message nobody owns therefore never reads as streaming:
 * no turn and no agent can still be writing it.
 *
 * Pure and read-side. The fold keeps the flag as the log wrote it (so no
 * `FOLD_SNAPSHOT_VERSION` bump), the thread index still indexes a message at
 * its own close, and nothing is written. What renders or reports liveness goes
 * through it — the GUI's message rows (the reasoning row's "Thinking" shimmer,
 * an answer's streaming text) and its turn folds (a streaming answer keeps its
 * turn unfolded), in the timeline, the history and the drill-in alike; what
 * merges a stream keeps reading the flag — the fold, ingestion, the index, the
 * GUI's streamed-text fast path (`isStreamingMessageTextUpdate`).
 */

import { isSessionLive } from "./fold.ts";
import {
  ACTIVE_SUBAGENT_STATUSES,
  type RuntimeSubagent,
  type ThreadMessageItem,
  type ThreadSessionState
} from "./thread.ts";

/** What decides whether a flagged message can still be streaming. */
export interface MessageStreamingContext {
  /** A provider process is attached: `starting`, `ready` or `running` ({@link isSessionLive}). */
  readonly sessionLive: boolean;
  /** The turn the session is running — the head's `session.activeTurnId` — or null. */
  readonly activeTurnId: string | null;
  /** The roster's agents still at work: `pending`, `running` or `waiting` ({@link ACTIVE_SUBAGENT_STATUSES}). */
  readonly activeAgentIds: ReadonlySet<string>;
}

/**
 * The context with no live session: nothing reads as streaming. What a reader
 * falls back to when it was handed no thread to ask — a caller that names no
 * live session has no stream to show.
 */
export const NOTHING_STREAMS: MessageStreamingContext = {
  sessionLive: false,
  activeTurnId: null,
  activeAgentIds: new Set()
};

/** What the context is read from: a fold state, a snapshot and the GUI's thread slice all are one. */
export interface MessageStreamingSource {
  readonly head: { readonly session: Pick<ThreadSessionState, "status" | "activeTurnId"> } | null;
  readonly roster: readonly Pick<RuntimeSubagent, "id" | "status">[];
}

/**
 * The last context built over each roster array. The roster is immutable, and
 * the fold keeps it by identity until it re-derives it — on a task row, a
 * change of session liveness or a retention drop (`commit` in `fold.ts`) — or
 * a snapshot replaces it, so a streamed token finds its context here and a
 * derivation that compares the context by identity keeps its fast path. A
 * cache, never state: a context is a function of the roster and two session
 * fields alone.
 */
const contextByRoster = new WeakMap<object, MessageStreamingContext>();

/**
 * The context of a thread as `state` has it. The same roster array and the
 * same session answer the same object.
 */
export function messageStreamingContext(state: MessageStreamingSource): MessageStreamingContext {
  const session = state.head?.session;
  const sessionLive = isSessionLive(session?.status);
  const activeTurnId = session?.activeTurnId ?? null;
  const cached = contextByRoster.get(state.roster);
  if (cached !== undefined && cached.sessionLive === sessionLive && cached.activeTurnId === activeTurnId) {
    return cached;
  }
  const context: MessageStreamingContext = {
    sessionLive,
    activeTurnId,
    activeAgentIds: cached?.activeAgentIds ?? activeAgentIdsOf(state.roster)
  };
  contextByRoster.set(state.roster, context);
  return context;
}

function activeAgentIdsOf(roster: MessageStreamingSource["roster"]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const agent of roster) {
    if (ACTIVE_SUBAGENT_STATUSES.has(agent.status)) {
      ids.add(agent.id);
    }
  }
  return ids;
}

/**
 * Whether `message` reads as streaming: its flag says so, the session is live,
 * and it belongs to the running turn or to an agent still at work. Everything
 * else — a stream a dead host left, an agent's words after it settled, a turn
 * that ended without closing its answer — reads as settled.
 */
export function isMessageStreaming(
  message: Pick<ThreadMessageItem, "streaming" | "turnId" | "agentId">,
  context: MessageStreamingContext
): boolean {
  if (!message.streaming || !context.sessionLive) {
    return false;
  }
  if (message.turnId !== null && message.turnId === context.activeTurnId) {
    return true;
  }
  return message.agentId !== undefined && context.activeAgentIds.has(message.agentId);
}
