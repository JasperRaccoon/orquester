/**
 * A thread's HEAD: the compact, bounded read of what the daemon's per-call and per-event readers
 * need of a chat — its status, its running and latest turns, its open requests, its goal, its
 * permission and interaction modes, its lineage and, when asked, its last reply — without the
 * retained window's items, turns and checkpoints a whole snapshot carries
 * (`GET agentChatRoutes.threadHead`, the host's `GET /threads/:id/head`).
 *
 * One derivation, {@link threadHeadOf}, serves every side: the host runs it over its in-memory fold,
 * and the daemon runs it over a whole snapshot when the host predates the route (a handover's old
 * host answers its route-miss 404). So a head reads the same whichever path produced it — and the
 * same as the snapshot it summarises at the same `seq`.
 */

import type { InteractionMode } from "./adapter-types.ts";
import type { ThreadGoal } from "./goal.ts";
import { currentInteractionMode, runningTurnOf } from "./interaction-mode.ts";
import { reEmittedAssistantCopies, repairsReEmittedAssistantCopies } from "./re-emitted.ts";
import {
  SETTLED_TURN_STATES,
  type PendingRequests,
  type ThreadHead,
  type ThreadItem,
  type ThreadMessageItem,
  type ThreadSnapshotPayload,
  type Turn
} from "./thread.ts";
import { startedTurns } from "./turns.ts";

/** The newest turns a head carries ({@link ThreadHeadResponse.recentTurns}). */
export const THREAD_HEAD_RECENT_TURNS = 16;

/** The most code points of the last reply a head carries, whatever `replyChars` asks. */
export const THREAD_HEAD_REPLY_MAX_CHARS = 64_000;

/** The most ids a head looks turns up by, per list ({@link ThreadHeadQuery.turnIds}); the rest are ignored. */
export const THREAD_HEAD_LOOKUP_MAX = 64;

/** Query of `GET …/head`. On the wire each id list is its ids, each URI-encoded, joined by `,`. */
export interface ThreadHeadQuery {
  /**
   * Carry the last reply ({@link ThreadHeadResponse.lastReply}), cut at this many code points
   * (clamped to `[1, THREAD_HEAD_REPLY_MAX_CHARS]`). Absent or not a positive integer: no reply.
   */
  replyChars?: number;
  /** Look these turns up by `turnId` over the whole window ({@link ThreadHeadResponse.matchedTurns}). */
  turnIds?: string[];
  /** Look these turns up by the user message that opened them (`Turn.userMessageId`). */
  messageIds?: string[];
}

/** The latest settled turn's answer, as the parent's timeline shows it. */
export interface ThreadHeadReply {
  turnId: string;
  text: string;
  /** `text` was cut at the asked `replyChars`. */
  truncated: boolean;
  completedAt: string | null;
}

/** `GET …/head`. Field names a snapshot also has (`head`, `seq`, `pending`, `goal`) mean the same there. */
export interface ThreadHeadResponse {
  head: ThreadHead;
  /** The thread's sequence the head was read at — a snapshot's `seq`: a caller compares two reads by it. */
  seq: number;
  pending: PendingRequests;
  goal: ThreadGoal | null;
  /** `currentInteractionMode` of the thread. */
  interactionMode: InteractionMode;
  /** How many turns of the retained window started (`startedTurns(turns).length`). */
  startedTurnCount: number;
  /** The window's newest {@link THREAD_HEAD_RECENT_TURNS} turns, oldest first. */
  recentTurns: Turn[];
  /** The window's turns older than `recentTurns`: 0 means `recentTurns` is every turn of the window. */
  olderTurnCount: number;
  /** The active turn, else the latest unsettled one, else the latest (`runningTurnOf`); null with no turn. */
  runningTurn: Turn | null;
  /**
   * The latest settled turn with an id, and its 1-based number by START ORDER (`startedTurns`);
   * `ordinal` null when it is no started turn.
   */
  lastSettledTurn: { turn: Turn; ordinal: number | null } | null;
  /** Only when `replyChars` asked for it: null when no turn settled yet. */
  lastReply?: ThreadHeadReply | null;
  /**
   * Only when `turnIds` or `messageIds` asked: for each id, the window's FIRST turn with that
   * `turnId` (or `userMessageId`), in window order — so `matchedTurns.find(…)` by either key finds
   * exactly what `turns.find(…)` finds over the whole window, and an id it misses is in no turn
   * of the window.
   */
  matchedTurns?: Turn[];
}

/** What {@link threadHeadOf} reads: a snapshot, or the host's fold with its head-only state applied. */
export type ThreadHeadSource = Pick<ThreadSnapshotPayload, "head" | "turns" | "items" | "pending" | "seq" | "goal">;

/** A head query as URL parameters (what {@link threadHeadQueryOf} reads back). */
export function threadHeadQueryParams(query: ThreadHeadQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.replyChars !== undefined) params.replyChars = String(query.replyChars);
  if (query.turnIds?.length) params.turnIds = query.turnIds.map(encodeURIComponent).join(",");
  if (query.messageIds?.length) params.messageIds = query.messageIds.map(encodeURIComponent).join(",");
  return params;
}

/** A head query from its URL parameters (absent, malformed or empty entries dropped; lists bounded). */
export function threadHeadQueryOf(params: { replyChars?: unknown; turnIds?: unknown; messageIds?: unknown }): ThreadHeadQuery {
  const query: ThreadHeadQuery = {};
  const replyChars = threadHeadReplyChars(params.replyChars);
  if (replyChars !== undefined) query.replyChars = replyChars;
  const turnIds = idList(params.turnIds);
  if (turnIds.length) query.turnIds = turnIds;
  const messageIds = idList(params.messageIds);
  if (messageIds.length) query.messageIds = messageIds;
  return query;
}

function idList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    if (ids.length === THREAD_HEAD_LOOKUP_MAX) break;
    try {
      const id = decodeURIComponent(part);
      if (id !== "") ids.push(id);
    } catch {
      // A malformed escape names no id.
    }
  }
  return ids;
}

/** `?replyChars=` as a head serves it: a positive integer clamped to the cap, else undefined (no reply). */
export function threadHeadReplyChars(raw: unknown): number | undefined {
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, THREAD_HEAD_REPLY_MAX_CHARS);
}

/** The head of a thread (see the module comment). Reads messages only of `items`, never an activity. */
export function threadHeadOf(source: ThreadHeadSource, query: ThreadHeadQuery = {}): ThreadHeadResponse {
  const { turns } = source;
  const started = startedTurns(turns);
  // `turnId !== null`, as `workReport` and the reply router pick it (`latestSettledTurn` is the
  // timeline's reply rule, which also passes over an empty id).
  let settled: Turn | null = null;
  for (let i = turns.length - 1; i >= 0 && settled === null; i -= 1) {
    if (turns[i]!.turnId !== null && SETTLED_TURN_STATES.has(turns[i]!.state)) settled = turns[i]!;
  }
  const ordinal = settled === null ? -1 : started.findIndex((turn) => turn.turnId === settled.turnId);
  const recentTurns = turns.slice(-THREAD_HEAD_RECENT_TURNS);
  const replyChars = threadHeadReplyChars(query.replyChars);
  return {
    head: source.head,
    seq: source.seq,
    pending: source.pending,
    goal: source.goal ?? null,
    interactionMode: currentInteractionMode(source),
    startedTurnCount: started.length,
    recentTurns,
    olderTurnCount: turns.length - recentTurns.length,
    runningTurn: runningTurnOf(source) ?? null,
    lastSettledTurn: settled === null ? null : { turn: settled, ordinal: ordinal === -1 ? null : ordinal + 1 },
    ...(replyChars === undefined ? {} : { lastReply: lastReplyOf(source, replyChars) }),
    ...(query.turnIds?.length || query.messageIds?.length ? { matchedTurns: matchedTurns(turns, query) } : {})
  };
}

/** {@link ThreadHeadResponse.matchedTurns}: each id's first turn of the window, in window order. */
function matchedTurns(turns: readonly Turn[], query: ThreadHeadQuery): Turn[] {
  const picked = new Set<Turn>();
  for (const id of (query.turnIds ?? []).slice(0, THREAD_HEAD_LOOKUP_MAX)) {
    const turn = turns.find((candidate) => candidate.turnId === id);
    if (turn) picked.add(turn);
  }
  for (const id of (query.messageIds ?? []).slice(0, THREAD_HEAD_LOOKUP_MAX)) {
    const turn = turns.find((candidate) => candidate.userMessageId === id);
    if (turn) picked.add(turn);
  }
  return turns.filter((turn) => picked.has(turn));
}

/** The latest turn with a (non-empty) id in a settled state, or null: the turn whose answer is the last reply. */
export function latestSettledTurn(turns: readonly Turn[]): Turn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (turn.turnId && SETTLED_TURN_STATES.has(turn.state)) return turn;
  }
  return null;
}

/**
 * The latest settled turn's answer, as the parent's timeline shows it, cut at `maxChars` code points.
 * On a Claude thread that leaves out the opening paragraph a host before the pre-turn-stream fix
 * wrote a second time at `result`, which an old log keeps: the GUI's rule, from the one
 * implementation (`reEmittedAssistantCopies`), counted over the window.
 */
export function lastReplyOf(
  source: { head: Pick<ThreadHead, "adapter">; turns: readonly Turn[]; items: readonly ThreadItem[] },
  maxChars: number
): ThreadHeadReply | null {
  const turn = latestSettledTurn(source.turns);
  if (!turn?.turnId) return null;
  const copies = repairsReEmittedAssistantCopies(source.head.adapter) ? reEmittedAssistantCopies(source.items) : undefined;
  const capped = capCodePoints(assistantTextForTurn(source.items, turn.turnId, copies), maxChars);
  return { turnId: turn.turnId, text: capped.text, truncated: capped.truncated, completedAt: turn.completedAt };
}

/**
 * The main agent's answer in a turn: its assistant messages, joined. A message the provider marked as commentary
 * (Codex's `phase`, carried as `messageKind`) is the running "I'll do X next" narration, not the answer, while the turn
 * has one (`isCommentaryAssistantMessage`). A turn with none — interrupted, ended on a tool, a Codex goal turn the Stop
 * paused then interrupted — ends on its last commentary, as the GUI's timeline does (`deriveTerminalAssistantMessageIds`).
 * A message `skip` names is no part of the turn at all, neither answer nor commentary: a re-emitted copy.
 */
export function assistantTextForTurn(items: readonly ThreadItem[], turnId: string, skip?: ReadonlySet<string>): string {
  const own = items.filter(
    (i): i is ThreadMessageItem => i.kind === "message" && i.role === "assistant" && i.turnId === turnId && !i.agentId && !skip?.has(i.id)
  );
  const answer = own.filter((i) => i.messageKind !== "commentary").map((i) => i.text).filter(Boolean).join("\n\n");
  if (answer) return answer;
  for (let i = own.length - 1; i >= 0; i -= 1) if (own[i]!.messageKind === "commentary") return own[i]!.text;
  return "";
}

/**
 * `text` in at most `maxChars` code points (never splitting one) — the MCP's `capText` rule, so a
 * reply cut here and cut again there by a smaller cap reads as one cut by the smaller cap alone.
 */
function capCodePoints(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let chars = 0;
  let end = 0;
  for (const char of text) {
    if (chars >= maxChars) return { text: text.slice(0, end), truncated: true };
    chars += 1;
    end += char.length;
  }
  return { text, truncated: false };
}
