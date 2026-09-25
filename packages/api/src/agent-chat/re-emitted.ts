/**
 * Re-emitted assistant copies in an old Claude log (spec §7.3) — one rule for
 * every reader that shows a thread's messages.
 *
 * Hosts before the pre-turn-stream fix wrote a CLI-started Claude turn's
 * opening paragraph a SECOND time at `result`, and `events.ndjson` is never
 * rewritten, so those logs keep the copy. Two readers leave it out, both in
 * the parent view only (a drill-in shows its subagent's messages as they
 * are): the GUI's timeline (`splitThreadItems`, `packages/ui`
 * `entries.logic.ts`, opted in by the store from the thread head's adapter)
 * and the Orquester MCP (`get_session`'s `lastReply` and `send_message`'s
 * `reply`, `apps/daemon/src/mcp/views.ts`; `read_transcript`'s rows,
 * `transcript.ts`). Both ask {@link repairsReEmittedAssistantCopies} whether a
 * thread gets the repair, and {@link reEmittedAssistantCopies} which messages
 * it drops.
 */

import type { AgentAdapterId } from "./adapter-types.ts";
import type { ThreadItem, ThreadMessageItem } from "./thread.ts";

/**
 * Whether a thread of this adapter gets the {@link reEmittedAssistantCopies}
 * repair: exactly a Claude thread (`claudex`/`claudemix` run on the `claude`
 * adapter too). Only a Claude log can hold a re-emitted copy; Codex narration
 * may legitimately repeat itself, and nothing ever re-emitted a Codex,
 * OpenCode or Grok message. The one place that decision lives.
 */
export function repairsReEmittedAssistantCopies(adapter: AgentAdapterId | string | undefined): boolean {
  return adapter === "claude";
}

/**
 * The re-emitted assistant copies in one view — `ownerAgentId`'s messages, so
 * one author's: per turn, its LAST assistant message when it is finished and
 * repeats the turn's FIRST finished one word for word. That is exactly where
 * the copy sits and what it copies: hosts before the pre-turn-stream fix
 * flushed a CLI-started Claude turn's opening paragraph AGAIN at `result`,
 * under a new id, where it rendered below the final summary, became the turn's
 * answer and folded the real one away (live thread 19976137, seq 38664/38963;
 * 160 turns across three threads). `events.ndjson` is never rewritten, so
 * those logs keep the copy; the first occurrence stays where it was said.
 * Only a Claude log can hold one, so only a Claude thread asks for this
 * ({@link repairsReEmittedAssistantCopies}): Codex narration may legitimately
 * repeat itself. And nothing else is dropped, because a long Claude turn — a
 * goal run is ONE turn of many rounds — may well repeat itself, or end two
 * rounds on the same words: dropping the later one would take the turn's real
 * answer. Counted in the view the caller hands in, as every repair of a view
 * is: a view that starts mid-turn (retention, a history page) compares with
 * its own first message. `ownerAgentId` absent is the parent's view.
 */
export function reEmittedAssistantCopies(items: readonly ThreadItem[], ownerAgentId?: string): Set<string> {
  const firstFinished = new Map<string, ThreadMessageItem>();
  const last = new Map<string, ThreadMessageItem>();
  for (const item of items) {
    if (item.kind !== "message" || item.role !== "assistant" || item.turnId === null) {
      continue;
    }
    const owner = item.agentId !== undefined && item.agentId.length > 0 ? item.agentId : undefined;
    if (owner !== ownerAgentId) {
      continue;
    }
    last.set(item.turnId, item);
    if (!item.streaming && item.text.trim().length > 0 && !firstFinished.has(item.turnId)) {
      firstFinished.set(item.turnId, item);
    }
  }
  const copies = new Set<string>();
  for (const [turnId, message] of last) {
    const opening = firstFinished.get(turnId);
    if (
      opening !== undefined &&
      !message.streaming &&
      message.id !== opening.id &&
      message.text === opening.text
    ) {
      copies.add(message.id);
    }
  }
  return copies;
}
