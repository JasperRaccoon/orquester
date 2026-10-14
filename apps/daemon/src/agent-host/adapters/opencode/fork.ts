/**
 * OpenCode adapter — forking a conversation into ANOTHER thread (thread
 * lineage, spec 2026-10-14 §6).
 *
 * Native: `POST /session/:id/fork {messageID?, directory}` copies the source
 * session's messages BEFORE `messageID` (all of them without one) into a new
 * session, re-minting every message id (fixtures README observation 17) —
 * the call a rewind already makes (`session.ts` `rollbackThread`), and which
 * is likewise verified here by the fork's message count. The source session
 * is only read: unlike a rewind, nothing re-points it. The child resumes the
 * fork in place (`OpenCodeThreadSession.start`, same directory), which
 * re-asserts its own ruleset.
 */

import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import type { OpenCodeClient } from "./http.ts";
import {
  openCodeRoutes,
  type ForkBody,
  type OpenCodeMessageWithParts,
  type OpenCodeSessionInfo
} from "./routes.ts";

export const OPENCODE_FORK_NO_SESSION =
  "OpenCode has no saved conversation for this thread yet, so there is nothing to fork.";
export const OPENCODE_FORK_BOUNDARY_GONE =
  "opencode: the message to fork from is no longer in this conversation";

/**
 * Where to cut: the fork keeps every message before the user message that
 * opens the first removed turn. A turn id the fold holds for OpenCode is an
 * OpenCode message id — a live turn's prompt, a replayed turn's assistant
 * message or trailing prompt — so it is looked up in the list itself and
 * walked back to its prompt, as a rewind does. An id that is not there is a
 * refusal, never a guess.
 */
export function planOpenCodeFork(
  messages: readonly OpenCodeMessageWithParts[],
  firstRemovedMessageId: string | null
): { messageID?: string; expectedCount: number } {
  if (firstRemovedMessageId === null) {
    return { expectedCount: messages.length };
  }
  const index = messages.findIndex((entry) => entry.info?.id === firstRemovedMessageId);
  if (index < 0) {
    throw new Error(OPENCODE_FORK_BOUNDARY_GONE);
  }
  for (let at = index; at >= 0; at -= 1) {
    const entry = messages[at];
    if (entry?.info?.role === "user" && typeof entry.info.id === "string") {
      return { messageID: entry.info.id, expectedCount: at };
    }
  }
  throw new Error(OPENCODE_FORK_BOUNDARY_GONE);
}

/** Fork `sourceSessionId` before `firstRemovedMessageId` and answer the new session id. */
export async function forkOpenCodeSession(input: {
  client: OpenCodeClient;
  sourceSessionId: string;
  firstRemovedMessageId: string | null;
  directory: string;
}): Promise<string> {
  const listMessages = async (sessionId: string): Promise<OpenCodeMessageWithParts[]> => {
    const list = await input.client.get<OpenCodeMessageWithParts[]>(
      openCodeRoutes.messages(sessionId),
      { timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs }
    );
    return Array.isArray(list) ? list : [];
  };
  const source = await listMessages(input.sourceSessionId);
  const plan = planOpenCodeFork(source, input.firstRemovedMessageId);
  if (plan.expectedCount === 0) {
    throw new Error(OPENCODE_FORK_NO_SESSION);
  }
  const fork = await input.client.post<OpenCodeSessionInfo>(
    openCodeRoutes.fork(input.sourceSessionId),
    {
      timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
      body: {
        ...(plan.messageID !== undefined ? { messageID: plan.messageID } : {}),
        directory: input.directory
      } satisfies ForkBody
    }
  );
  if (fork === undefined || typeof fork.id !== "string") {
    throw new Error("OpenCode session fork returned no session payload.");
  }
  // A whole-session fork may legitimately hold more than was read a moment
  // ago (the source moved on); a cut fork must hold exactly the kept part.
  const forked = await listMessages(fork.id);
  if (
    plan.messageID !== undefined
      ? forked.length !== plan.expectedCount
      : forked.length < plan.expectedCount
  ) {
    throw new Error("OpenCode did not preserve the requested fork point.");
  }
  return fork.id;
}
