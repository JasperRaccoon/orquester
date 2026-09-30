/**
 * "Rewind to here" from the right rail's History (spec §5.5) — the pure half.
 *
 * The same, existing rewind the timeline offers: conversation only, files are
 * never touched, and the rewound prompt comes back to the composer
 * (`actions.rewindTo`). The panel invents no rule of its own:
 *
 * - **Which prompts may be rewound to** is the timeline's own verdict. A user
 *   message row carries `revertTurnCount` exactly when the adapter supports a
 *   rollback, the message opened a started turn and no settled compaction
 *   comes after it (`rows.logic.ts` `buildRevertTurnCountByUserMessageId`;
 *   history rows are further gated on the index's `rewindable`,
 *   `history.logic.ts` `gateHistoryRewind`). A prompt the rows do not render
 *   is judged by the index entry's `rewindable` — the same history-page rule —
 *   and by any settled compaction the chat has loaded since it.
 * - **The count** is always the row's `revertTurnCount`: "keep the first N
 *   started turns", N being the 0-based index among `startedTurns` of the turn
 *   the prompt opened. The index's `turnOrdinal` is that turn's 1-based
 *   position in the same order, so `turnOrdinal - 1` names the same number —
 *   but it only ever sizes the confirm's sentence before the row exists; a
 *   count the rows did not vouch for is never posted.
 * - **When** is the composer picker's gate (`rewindPickerEnabled`): never
 *   while a turn runs, a rewind is in flight or a request waits on the user.
 */

import { isSettledConversationCompaction, startedTurns } from "@orquester/api/agent-chat";
import type { ThreadHistoryPage, ThreadItem, Turn } from "@orquester/api/agent-chat";

import {
  REWIND_BUSY_TITLE,
  rewindPickerEnabled
} from "../../components/agent-chat/composer/RewindControl";
import type { AgentChatConnectionState, AgentChatTimelineRow } from "../agent-chat/contracts";
import type { HistoryPrompt } from "./prompts.logic";

// ---------------------------------------------------------------------------
// The rows' verdicts
// ---------------------------------------------------------------------------

/**
 * Every user message the timeline's rows render (window, bridge and loaded
 * history pages) → its `revertTurnCount`, or null where the rows withhold a
 * rewind.
 */
export type RewindTargets = ReadonlyMap<string, number | null>;

export const NO_REWIND_TARGETS: RewindTargets = new Map();

/** The rewind verdict of every user message a row list renders, in one pass. */
export function rowsRewindTargetsOf(rows: readonly AgentChatTimelineRow[]): RewindTargets {
  const targets = new Map<string, number | null>();
  for (const row of rows) {
    if (row.kind === "message" && row.message.role === "user") {
      targets.set(row.message.id, typeof row.revertTurnCount === "number" ? row.revertTurnCount : null);
    }
  }
  return targets;
}

function sameTargets(left: RewindTargets, right: RewindTargets): boolean {
  if (left.size !== right.size) return false;
  for (const [id, count] of left) {
    // A missing id reads `undefined`, never a count or `null`.
    if (right.get(id) !== count) return false;
  }
  return true;
}

/**
 * {@link rowsRewindTargetsOf}, memoised for a surface outside the chat view:
 * the rows array is replaced on every streamed token, the verdicts almost
 * never — so the last map is handed back BY IDENTITY until one changes.
 */
export function createRewindTargetsMemo(): (rows: readonly AgentChatTimelineRow[]) => RewindTargets {
  let lastRows: readonly AgentChatTimelineRow[] | null = null;
  let targets: RewindTargets = NO_REWIND_TARGETS;
  return (rows) => {
    if (rows === lastRows) return targets;
    lastRows = rows;
    const next = rowsRewindTargetsOf(rows);
    if (!sameTargets(next, targets)) targets = next;
    return targets;
  };
}

// ---------------------------------------------------------------------------
// The compaction that bounds a rewind
// ---------------------------------------------------------------------------

/** Items keep their arrays' identity until one moves, so a list is scanned once. */
const settledCompactionCache = new WeakMap<readonly ThreadItem[], string | null>();

/**
 * When the newest SETTLED conversation compaction among `items` happened —
 * `isSettledConversationCompaction`, the one rule the timeline's gate, the
 * index's `rewindable` and the MCP share — or null with none. Read off the
 * ITEMS, never the rows: a settled turn's fold hides the compaction marker
 * inside it (`rows.logic.ts` `deriveTurnFolds`), and the rows draw a legacy
 * `thread.state.changed` of any state as a compaction divider. Memoised by
 * array identity, like `history.logic.ts` `hasSettledCompaction`.
 */
function latestSettledCompactionAt(items: readonly ThreadItem[]): string | null {
  const cached = settledCompactionCache.get(items);
  if (cached !== undefined) return cached;
  let latest: string | null = null;
  for (const item of items) {
    if (isSettledConversationCompaction(item) && (latest === null || item.createdAt > latest)) {
      latest = item.createdAt;
    }
  }
  settledCompactionCache.set(items, latest);
  return latest;
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return right > left ? right : left;
}

/**
 * {@link latestSettledCompactionAt} over everything the chat holds: its
 * loaded history pages, the bridge and the window. The pages and the bridge
 * keep their arrays until they change, so per streamed token only the
 * window's own array is scanned.
 */
export function latestLoadedCompactionAt(input: {
  pages: readonly ThreadHistoryPage[];
  bridge: readonly ThreadItem[];
  entries: readonly ThreadItem[];
}): string | null {
  let latest: string | null = null;
  for (const page of input.pages) latest = later(latest, latestSettledCompactionAt(page.items));
  latest = later(latest, latestSettledCompactionAt(input.bridge));
  return later(latest, latestSettledCompactionAt(input.entries));
}

/** What the panel's rewind reads off the thread. */
export interface RewindFacts {
  targets: RewindTargets;
  /** {@link latestLoadedCompactionAt}. */
  latestCompactionAt: string | null;
}

// ---------------------------------------------------------------------------
// One prompt
// ---------------------------------------------------------------------------

export type RewindPrompt = Pick<
  HistoryPrompt,
  "messageId" | "turnId" | "turnOrdinal" | "createdAt" | "source" | "indexRewindable"
>;

/**
 * The turn count a rewind to `prompt` keeps — or null when the panel must not
 * offer one: the adapter cannot roll back (Grok), the prompt started no turn
 * (a steer, an answer, a turn not started yet), or the rows withhold it. For a
 * prompt the rows do not render yet the count is provisional (it sizes the
 * confirm's sentence); the rewind itself reads the row's own.
 */
export function promptRewindTarget(input: {
  prompt: RewindPrompt;
  facts: RewindFacts;
  /** The adapter capability, known (`supportsConversationRollback !== false`). */
  rollbackSupported: boolean;
}): number | null {
  const { prompt, facts } = input;
  if (!input.rollbackSupported || prompt.turnId === null || prompt.turnOrdinal === null) {
    return null;
  }
  const fromRows = facts.targets.get(prompt.messageId);
  if (fromRows !== undefined) return fromRows;
  // Not rendered: older than everything the chat has loaded. Only the index
  // can vouch for it, and only as of its page — a settled compaction the chat
  // holds that is newer than the prompt came after it.
  if (prompt.source !== "index" || prompt.indexRewindable !== true) return null;
  if (facts.latestCompactionAt !== null && !(prompt.createdAt > facts.latestCompactionAt)) {
    return null;
  }
  return prompt.turnOrdinal - 1;
}

export interface RewindBusyInput {
  isTurnActive: boolean;
  reverting: boolean;
  hasPendingRequest: boolean;
}

/**
 * Why a rewind must wait right now, or null when it may go ahead — the
 * composer picker's own gate, a composer send still on its way included
 * (`isSending`: the thread state does not hold it — the panel and the runner
 * read the composer's send registry, `composer-sends.ts`).
 */
export function rewindBusyReason(input: RewindBusyInput & { isSending: boolean }): string | null {
  return rewindPickerEnabled({ targetCount: 1, ...input }) ? null : REWIND_BUSY_TITLE;
}

// ---------------------------------------------------------------------------
// Bringing a turn on screen
// ---------------------------------------------------------------------------

/** The fold no longer knows the turn: a rewind removed it. */
const PROMPT_GONE = "That prompt is no longer in this chat.";
/** Known, but more than `revealTurn`'s page cap back, or older than anything the index can page in. */
const TURN_TOO_FAR_BACK = "That turn is too far back to bring into the chat from here.";
/** A history page failed on the way. */
const TURN_LOAD_FAILED = "Couldn't load that part of the chat's history.";
/** The thread's stream is not synchronized (yet, or any more). */
export const CHAT_NOT_READY = "The chat isn't connected right now — try again in a moment.";

export type RevealResult = { shown: true } | { shown: false; reason: string };

/**
 * Why `actions.revealTurn(turnId)` answered `false`, read off the thread
 * right after: it gives up when the stream never synchronizes, when the fold
 * no longer knows the turn (it keeps every turn a rewind has not removed),
 * when a history page fails (`slice.history.error`, already worded for the
 * user), and when the turn lies past its page cap or before anything older
 * exists. Only the second is "no longer in this chat".
 */
export function revealMissReason(input: {
  turnId: string;
  connection: AgentChatConnectionState;
  turns: readonly Turn[];
  historyError: string | null;
}): string {
  if (input.connection !== "synchronized") return CHAT_NOT_READY;
  if (!startedTurns(input.turns).some((turn) => turn.turnId === input.turnId)) return PROMPT_GONE;
  if (input.historyError !== null) {
    return input.historyError.trim().length > 0 ? input.historyError : TURN_LOAD_FAILED;
  }
  return TURN_TOO_FAR_BACK;
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

const REWIND_NOT_OFFERED = "This chat can't rewind to that prompt.";
const REWIND_WITHHELD = "This chat can no longer rewind to that prompt.";
/** The turn came on screen, but not the prompt's own row: no count the rows vouch for. */
const REWIND_NOT_RENDERED = "Couldn't find that prompt in the chat to rewind to it.";

export type RewindOutcome = { ok: true } | { ok: false; reason: string };

/** What the runner reads off the live thread, fresh at each step. */
export interface RewindSnapshot {
  targets: RewindTargets;
  busy: RewindBusyInput;
  /** A composer send from this thread is on its way (`isComposerSending`), read fresh. */
  isSending: boolean;
  rollbackSupported: boolean;
}

function reasonOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

/**
 * The whole rewind, from the panel:
 *
 * 1. refuse what may not happen now (busy) or at all (not offered);
 * 2. a prompt the rows do not render yet is brought in first —
 *    `revealTurn` pages the chat's older history in until the turn is on
 *    screen (and scrolls the timeline to it), because `rewindTo` can only
 *    rewind to a message the thread holds — and a turn it cannot bring in
 *    says why ({@link revealMissReason});
 * 3. the count comes from the prompt's row — its `revertTurnCount` — and
 *    nothing else: a row that withholds one is refused rather than
 *    second-guessed, and a prompt whose row is still not rendered is refused
 *    rather than rewound by a count no row vouched for;
 * 4. `rewindTo` does the rest — the host truncates, the prompt goes back to
 *    the composer — and rejects with the failure's reason.
 *
 * Never rejects.
 */
export async function runPromptRewind(input: {
  prompt: RewindPrompt;
  read: () => RewindSnapshot;
  revealTurn: (turnId: string) => Promise<RevealResult>;
  rewindTo: (target: { messageId: string; targetTurnCount: number }) => Promise<void>;
}): Promise<RewindOutcome> {
  const { prompt } = input;
  const turnId = prompt.turnId;
  if (turnId === null || prompt.turnOrdinal === null) {
    return { ok: false, reason: REWIND_NOT_OFFERED };
  }
  let snapshot = input.read();
  const refusal = (current: RewindSnapshot): RewindOutcome | null => {
    if (!current.rollbackSupported) return { ok: false, reason: REWIND_NOT_OFFERED };
    const busy = rewindBusyReason({ ...current.busy, isSending: current.isSending });
    return busy === null ? null : { ok: false, reason: busy };
  };
  const early = refusal(snapshot);
  if (early) return early;
  if (!snapshot.targets.has(prompt.messageId)) {
    let revealed: RevealResult;
    try {
      revealed = await input.revealTurn(turnId);
    } catch {
      revealed = { shown: false, reason: TURN_LOAD_FAILED };
    }
    if (!revealed.shown) return { ok: false, reason: revealed.reason };
    snapshot = input.read();
    const late = refusal(snapshot);
    if (late) return late;
  }
  const targetTurnCount = snapshot.targets.get(prompt.messageId);
  if (targetTurnCount === undefined) return { ok: false, reason: REWIND_NOT_RENDERED };
  if (targetTurnCount === null) return { ok: false, reason: REWIND_WITHHELD };
  try {
    await input.rewindTo({ messageId: prompt.messageId, targetTurnCount });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reasonOf(error, "The rewind failed.") };
  }
}
