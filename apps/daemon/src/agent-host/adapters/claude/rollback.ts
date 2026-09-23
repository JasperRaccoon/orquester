/**
 * Claude adapter — conversation rollback (spec §4.5 "Rollback is a native
 * fork with a hard failure mode", §5.5).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts:146-225`
 * (`isClaudeHumanTurnStart`, `conversationIndexForUuid`,
 * `remapClaudeForkTurnBoundaries`) and `:5306-5486` (the rollback itself).
 *
 * The pure half lives here so the alignment rules — which are the part that
 * must never guess — are unit-tested without a CLI.
 *
 * A fork **rewrites every uuid**, and `getSessionMessages` then rebuilds the
 * parentUuid chain, so system notices and compaction metadata can change the
 * raw length without dropping retained turns. Retained conversation messages
 * are therefore aligned **from the truncated end**, and every one of them must
 * match on **deep-equal body and role**: matching roles alone once mistook a
 * restored steering message for a retained turn start. Any mismatch, any
 * missing boundary, or a compaction in between is a **hard error** telling the
 * user to start a new thread — refuse rather than guess.
 *
 * The cut itself is named by turn ID when the host supplies one
 * ({@link planClaudeRollbackById}): a count over the host's turns and a count
 * over this adapter's boundaries are counts of different lists — a resumed
 * transcript has history turns no cursor recorded, a compaction writes rows
 * that look like turn starts — and a count-based cut then lands on the wrong
 * turn without refusing (fixtures/claude README observation 21).
 */

import { isDeepStrictEqual } from "node:util";

import type { ClaudeTurnBoundary } from "./cursor.ts";

/** The `SessionMessage` shape this module needs, read structurally. */
export interface ClaudeHistoryMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
}

export const ROLLBACK_BOUNDARY_UNAVAILABLE =
  "The exact Claude turn boundary is unavailable, possibly after compaction or recovery of older history. Start a new thread instead.";
export const ROLLBACK_FORK_MISALIGNED =
  "Claude fork history did not preserve the retained turn boundaries. Start a new thread instead.";
export const ROLLBACK_HISTORY_UNAVAILABLE = "Claude session history is unavailable.";
export const ROLLBACK_COMPACTED =
  "This conversation was compacted after that turn, so Claude no longer holds the messages the rewind would restore. Start a new thread instead.";
export const ROLLBACK_SESSION_UNAVAILABLE = "Claude session id is unavailable.";

export function isClaudeConversationMessage(message: ClaudeHistoryMessage): boolean {
  return message.type === "user" || message.type === "assistant";
}

/**
 * Only human prompts begin a turn. Tool results are user-role messages too,
 * and so are the CLI's synthetic notices, so neither may be counted.
 */
export function isClaudeHumanTurnStart(message: ClaudeHistoryMessage): boolean {
  if (message.type !== "user" || message.isMeta === true) {
    return false;
  }
  if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
    return false;
  }
  const body = message.message;
  if (body === null || typeof body !== "object") {
    return false;
  }
  const content = (body as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  // A block array that holds a tool_result is the tool half of a turn, never
  // its start.
  return !content.some(
    (entry) =>
      entry !== null && typeof entry === "object" && (entry as { type?: unknown }).type === "tool_result"
  );
}

/**
 * Group a native transcript into turns, the way `ThreadSnapshot` wants them: a
 * turn opens at each human prompt and runs to the next one, and everything
 * before the first prompt (the CLI's own preamble) is dropped.
 *
 * The turn's id is the human row's uuid, which for a session this adapter
 * started IS our own turn id — every `SDKUserMessage` is stamped with it
 * (§4.5), so a projected turn and a live one agree.
 */
export function groupClaudeHistoryTurns(
  messages: readonly ClaudeHistoryMessage[]
): Array<{ id: string; items: unknown[] }> {
  const turns: Array<{ id: string; items: unknown[] }> = [];
  for (const message of messages) {
    if (isClaudeHumanTurnStart(message)) {
      turns.push({ id: message.uuid, items: [message] });
      continue;
    }
    if (!isClaudeConversationMessage(message)) {
      continue;
    }
    turns.at(-1)?.items.push(message);
  }
  return turns;
}

export function conversationIndexForUuid(
  messages: readonly ClaudeHistoryMessage[],
  uuid: string
): number {
  let index = -1;
  for (const message of messages) {
    if (!isClaudeConversationMessage(message)) {
      continue;
    }
    index += 1;
    if (message.uuid === uuid) {
      return index;
    }
  }
  return -1;
}

/**
 * Re-align the retained turn boundaries onto the fork's rewritten uuids.
 * Returns `undefined` when the fork did not preserve them — the caller turns
 * that into a hard refusal.
 */
export function remapClaudeForkTurnBoundaries(
  messages: readonly ClaudeHistoryMessage[],
  forkMessages: readonly ClaudeHistoryMessage[],
  firstRemoved: number,
  retainedBoundaries: readonly (string | null)[]
): Array<string | null> | undefined {
  const retainedConversation = messages.slice(0, firstRemoved).filter(isClaudeConversationMessage);
  const forkConversation = forkMessages.filter(isClaudeConversationMessage);

  if (retainedConversation.length === 0) {
    return retainedBoundaries.every((id) => id === null) ? [...retainedBoundaries] : undefined;
  }

  const offset = forkConversation.length - retainedConversation.length;
  if (
    offset < 0 ||
    retainedConversation.some((message, index) => {
      const forkMessage = forkConversation[index + offset];
      return (
        forkMessage === undefined ||
        forkMessage.type !== message.type ||
        !isDeepStrictEqual(forkMessage.message, message.message)
      );
    })
  ) {
    return undefined;
  }

  const remapped = retainedBoundaries.map((originalId) => {
    if (originalId === null) {
      return null;
    }
    const originalIndex = conversationIndexForUuid(messages, originalId);
    const forkIndex = originalIndex + offset;
    const forkMessage =
      originalIndex >= 0 && forkIndex >= 0 ? forkConversation[forkIndex] : undefined;
    const originalMessage = messages.find((message) => message.uuid === originalId);
    return forkMessage !== undefined &&
      originalMessage !== undefined &&
      forkMessage.type === originalMessage.type
      ? forkMessage.uuid
      : null;
  });
  return remapped.some((id) => id === null) ? undefined : remapped;
}

export interface RollbackPlan {
  /** Number of turns kept. */
  retainedCount: number;
  /** The boundaries kept, before any fork remap. */
  retainedBoundaries: Array<string | null>;
  /**
   * The uuid to fork at — the last retained chain entry. `undefined` means
   * everything is removed and the caller starts a fresh session instead.
   */
  rollbackAt: string | undefined;
  /** Index of the first removed message in the raw history. */
  firstRemoved: number;
}

/**
 * Decide what a rollback of `numTurns` removes, from the persisted boundaries
 * and the native history. Throws the exact §4.5 refusal when the boundary
 * cannot be established.
 */
export function planClaudeRollback(input: {
  messages: readonly ClaudeHistoryMessage[];
  boundaries: readonly (string | null)[];
  numTurns: number;
}): RollbackPlan {
  const { messages, numTurns } = input;
  if (messages.length === 0) {
    throw new Error(ROLLBACK_HISTORY_UNAVAILABLE);
  }

  const boundaries = [...input.boundaries];
  // Older cursors did not record native boundaries. Infer them only when their
  // turn count agrees; a steer must never be treated as an extra turn.
  const turnStarts = messages.flatMap((message, index) =>
    isClaudeHumanTurnStart(message) ? [index] : []
  );
  const noNativeBoundaries = !boundaries.some((id) => id !== null);
  if (boundaries.length > 0 && noNativeBoundaries && boundaries.length === turnStarts.length) {
    boundaries.splice(
      0,
      boundaries.length,
      ...turnStarts.map((index) => messages[index]!.uuid)
    );
  }

  const retainedCount = Math.max(0, boundaries.length - numTurns);
  const firstRemovedId = boundaries[retainedCount];
  const firstRemoved = messages.findIndex((message) => message.uuid === firstRemovedId);

  if (
    boundaries.length === 0 ||
    boundaries.some((id) => id === null) ||
    (retainedCount > 0 && firstRemoved < 1)
  ) {
    throw new Error(ROLLBACK_BOUNDARY_UNAVAILABLE);
  }

  return {
    retainedCount,
    retainedBoundaries: boundaries.slice(0, retainedCount),
    rollbackAt: retainedCount > 0 ? messages[firstRemoved - 1]?.uuid : undefined,
    firstRemoved
  };
}

/** A turn boundary the native history can place. */
export interface PlacedClaudeTurnBoundary {
  turnId: string;
  uuid: string;
  /** Index of `uuid` in the raw history. */
  index: number;
}

/**
 * Every turn boundary the native history can place, in transcript order.
 *
 * Two sources, merged:
 *
 * - the pairs this adapter recorded (`ClaudeNormalizer.turnBoundaries`,
 *   carried across restarts by the cursor), kept only while the transcript
 *   still holds their uuid — a pair whose uuid is gone is stale and names
 *   nothing;
 * - an identity pair for every human turn start that no recorded pair already
 *   maps. Those are the turns of a resumed transcript that no cursor ever saw:
 *   a projected history turn's id IS its uuid (`groupClaudeHistoryTurns`), so
 *   this is what makes one rewindable.
 *
 * A recorded pair beats the identity reading of its uuid because the uuid may
 * be a fork's: a rewind rewrites every uuid, and only the pair still says
 * which of our turns that turn start is.
 */
export function mergeClaudeTurnBoundaries(
  messages: readonly ClaudeHistoryMessage[],
  known: readonly ClaudeTurnBoundary[]
): PlacedClaudeTurnBoundary[] {
  const indexByUuid = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!indexByUuid.has(message.uuid)) {
      indexByUuid.set(message.uuid, index);
    }
  });

  const placed: PlacedClaudeTurnBoundary[] = [];
  const mapped = new Set<string>();
  for (const boundary of known) {
    if (boundary.uuid === null) {
      continue;
    }
    const index = indexByUuid.get(boundary.uuid);
    if (index === undefined) {
      // Stale: the transcript no longer holds this uuid.
      continue;
    }
    placed.push({ turnId: boundary.turnId, uuid: boundary.uuid, index });
    mapped.add(boundary.uuid);
  }
  messages.forEach((message, index) => {
    if (
      isClaudeHumanTurnStart(message) &&
      !mapped.has(message.uuid) &&
      indexByUuid.get(message.uuid) === index
    ) {
      placed.push({ turnId: message.uuid, uuid: message.uuid, index });
    }
  });
  return placed.sort((a, b) => a.index - b.index);
}

export interface ClaudeRollbackByIdPlan {
  /** Every boundary the history could place, in transcript order. */
  boundaries: PlacedClaudeTurnBoundary[];
  /** The boundaries kept: every one before the cut. Remapped onto the fork. */
  retained: PlacedClaudeTurnBoundary[];
  /** The boundaries the cut removes: the target and every one after it. */
  dropped: PlacedClaudeTurnBoundary[];
  /**
   * The uuid to fork at — the entry just before the target's turn start.
   * `undefined` means nothing of the conversation survives and the caller
   * starts a fresh session instead (§4.5's full rollback).
   */
  rollbackAt: string | undefined;
  /** Index of the first removed message — the target's turn start — in the raw history. */
  firstRemoved: number;
}

/**
 * Decide what a rewind to BEFORE `firstRemovedTurnId` removes, by id: the id
 * is resolved to exactly one turn start in the native history through
 * {@link mergeClaudeTurnBoundaries}, and the cut lands there whatever any
 * count says. Throws the exact §4.5 refusal when it cannot: an id the history
 * cannot place (or places twice) is `ROLLBACK_BOUNDARY_UNAVAILABLE`, an anchor
 * a later compaction dropped is `ROLLBACK_COMPACTED` — both before any fork
 * exists, so a doomed rewind leaves no orphan session on disk.
 */
export function planClaudeRollbackById(input: {
  messages: readonly ClaudeHistoryMessage[];
  /** The pairs the session recorded (`ClaudeNormalizer.turnBoundaries`). */
  boundaries: readonly ClaudeTurnBoundary[];
  /** `RollbackTarget.firstRemovedTurnId` — the first turn that goes. */
  firstRemovedTurnId: string;
  /** `ClaudeNormalizer.preservedMessageUuids`; `undefined` = no compaction seen. */
  preservedUuids?: readonly string[] | undefined;
}): ClaudeRollbackByIdPlan {
  const { messages } = input;
  if (messages.length === 0) {
    throw new Error(ROLLBACK_HISTORY_UNAVAILABLE);
  }

  const boundaries = mergeClaudeTurnBoundaries(messages, input.boundaries);
  const matches = boundaries.filter((boundary) => boundary.turnId === input.firstRemovedTurnId);
  const target = matches.length === 1 ? matches[0] : undefined;
  const firstRemoved =
    target === undefined ? -1 : messages.findIndex((message) => message.uuid === target.uuid);
  if (firstRemoved < 0) {
    throw new Error(ROLLBACK_BOUNDARY_UNAVAILABLE);
  }

  // Nothing of the conversation precedes the cut: every turn goes, which is a
  // fresh session, never a fork (§4.5).
  if (!messages.slice(0, firstRemoved).some(isClaudeConversationMessage)) {
    return { boundaries, retained: [], dropped: boundaries, rollbackAt: undefined, firstRemoved };
  }

  const rollbackAt = messages[firstRemoved - 1]!.uuid;
  // A compaction between the anchor and now makes the anchor unreachable
  // (§4.5 "or a compaction in between", fixtures README obs. 17).
  if (
    !isAnchorReachableAfterCompaction({
      anchorUuid: rollbackAt,
      preservedUuids: input.preservedUuids,
      messages
    })
  ) {
    throw new Error(ROLLBACK_COMPACTED);
  }

  return {
    boundaries,
    retained: boundaries.filter((boundary) => boundary.index < firstRemoved),
    dropped: boundaries.filter((boundary) => boundary.index >= firstRemoved),
    rollbackAt,
    firstRemoved
  };
}

/**
 * A compaction between the anchor and now makes a rollback unreachable — the
 * CLI no longer holds the messages the rewind would restore (§4.5 "or a
 * compaction in between", fixtures/claude README observation 17).
 *
 * Decided by POSITION in the transcript whenever it is at hand: the CLI writes
 * its summary as a `user` row flagged `isCompactSummary`, and everything from
 * that row onwards is the context the session runs on, so an anchor at or after
 * the LAST summary is reachable whatever `preserved_messages.all_uuids` says —
 * that list names the pre-compaction rows that were kept, never the rows
 * written afterwards, and reading it as the whole set of reachable anchors made
 * every rewind after a live `/compact` refuse with "compacted". An anchor
 * before the last summary is reachable only when that list preserves it; with
 * no list at all (a session resumed after the compaction, whose boundary frame
 * this process never saw) it is refused rather than guessed. Without a
 * transcript, or on a transcript whose summary is not flagged, the list alone
 * decides as it always did.
 */
export function isAnchorReachableAfterCompaction(input: {
  anchorUuid: string;
  preservedUuids: readonly string[] | undefined;
  /** The transcript, to place the anchor relative to the last compaction summary. */
  messages?: readonly ClaudeHistoryMessage[] | undefined;
}): boolean {
  const messages = input.messages;
  if (messages !== undefined) {
    let lastSummary = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.isCompactSummary === true) {
        lastSummary = index;
        break;
      }
    }
    if (lastSummary !== -1) {
      const anchorIndex = messages.findIndex((message) => message.uuid === input.anchorUuid);
      if (anchorIndex === -1 || anchorIndex >= lastSummary) {
        // Not before the compaction (an anchor the transcript cannot place at
        // all fails later, precisely, as a missing boundary).
        return true;
      }
      return input.preservedUuids?.includes(input.anchorUuid) === true;
    }
  }
  if (input.preservedUuids === undefined || input.preservedUuids.length === 0) {
    return true;
  }
  return input.preservedUuids.includes(input.anchorUuid);
}
