/**
 * Claude adapter — forking a conversation into ANOTHER thread (thread lineage,
 * spec 2026-10-14 §6).
 *
 * Native: the SDK's `forkSession(sessionId, {upToMessageId})` copies the
 * source transcript, sliced inclusively at a message uuid, into a NEW session
 * file in the same config dir (`sdk.d.ts` `ForkSessionOptions`) — the very
 * call a rewind makes (`history.ts`, fixtures/claude README observation 8).
 * Unlike a rewind, nothing about the source changes: no session is stopped,
 * no cursor moves, and the fork is a different session id the child resumes
 * through its minimal `{threadId, resume}` cursor, whose history the host then
 * replays into the child's timeline (§4.1 `projectHistory`).
 *
 * The cut is resolved by turn ID through the rewind planner
 * (`planClaudeRollbackById`): the boundary pairs the source's cursor carries,
 * merged with the transcript's own human turn starts — so a projected history
 * turn and a live one resolve alike — and a cut a later compaction made
 * unreachable refuses before any file is written.
 */

import type { ClaudeHistoryReader } from "./history.ts";
import {
  claudeTurnBoundariesFromCursor,
  type ClaudeResumeCursor
} from "./cursor.ts";
import { planClaudeRollbackById, type ClaudeHistoryMessage } from "./rollback.ts";

export const CLAUDE_FORK_EMPTY_HISTORY =
  "Claude has no saved conversation for this thread yet, so there is nothing to fork.";

/**
 * The transcript as the source cursor sees it: a cursor that resumes AT a
 * message (`resumeSessionAt`) ends its conversation there, whatever was
 * written after it.
 */
function visibleMessages(
  messages: readonly ClaudeHistoryMessage[],
  cursor: ClaudeResumeCursor
): readonly ClaudeHistoryMessage[] {
  if (cursor.resumeSessionAt === undefined) return messages;
  const index = messages.findIndex((message) => message.uuid === cursor.resumeSessionAt);
  return index === -1 ? messages : messages.slice(0, index + 1);
}

/**
 * Fork `cursor`'s session through the turns before `firstRemovedTurnId` (the
 * whole conversation when null) and answer the child's cursor. Throws the
 * rewind planner's own refusals for a cut the transcript cannot place.
 */
export async function forkClaudeConversation(input: {
  history: ClaudeHistoryReader;
  cursor: ClaudeResumeCursor;
  /** The CHILD thread the returned cursor belongs to. */
  threadId: string;
  cwd: string;
  firstRemovedTurnId: string | null;
  /** The live source session's compaction record, when one is live; else undefined. */
  preservedUuids?: readonly string[] | undefined;
}): Promise<ClaudeResumeCursor> {
  const sessionId = input.cursor.resume;
  const messages = visibleMessages(
    await input.history.readMessages({ sessionId, cwd: input.cwd }),
    input.cursor
  );
  let upToMessageId: string | undefined;
  if (input.firstRemovedTurnId === null) {
    upToMessageId = messages.at(-1)?.uuid;
  } else {
    if (messages.length === 0) throw new Error(CLAUDE_FORK_EMPTY_HISTORY);
    const plan = planClaudeRollbackById({
      messages,
      boundaries: claudeTurnBoundariesFromCursor(input.cursor),
      firstRemovedTurnId: input.firstRemovedTurnId,
      preservedUuids: input.preservedUuids
    });
    upToMessageId = plan.rollbackAt;
  }
  if (upToMessageId === undefined) {
    throw new Error(CLAUDE_FORK_EMPTY_HISTORY);
  }
  const fork = await input.history.fork({ sessionId, upToMessageId, cwd: input.cwd });
  // The minimal form a create-time resume uses (§6.1): the child's first
  // session start refreshes every other field itself.
  return { threadId: input.threadId, resume: fork.sessionId };
}
