import { releaseThreadStore, retainThreadStore } from "../../lib/agent-chat/store";
import type { AgentChatTransport } from "../../lib/agent-chat/transport";

/**
 * Reveal a search hit's turn in its thread (design 2026-09-23 "Client").
 *
 * The palette has just activated the tab, whose view may not have mounted
 * yet, so it takes a reference on the thread's registry slice — the very one
 * that view picks up — for as long as the reveal runs (waiting for the stream
 * to synchronize, paging older turns in), and lets go afterwards. Resolves
 * whether a reveal request was set; never rejects.
 */
export async function revealConversationTurn(
  transport: AgentChatTransport,
  threadId: string,
  turnId: string
): Promise<boolean> {
  const store = retainThreadStore(threadId, { transport });
  try {
    return await store.getState().actions.revealTurn(turnId);
  } finally {
    releaseThreadStore(threadId);
  }
}
