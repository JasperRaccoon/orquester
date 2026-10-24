/**
 * The composer's way to the open question card (§7.5): a message sent while a
 * provider question is docked is that question's typed answer
 * (`composer-pending-send.ts`), and the card — which holds the question's
 * progress and drafts — takes it (`applyComposerAnswer`).
 *
 * One handler per session, registered by the mounted card. No card mounted
 * (none docked, or another card in front of it) answers `null`, and the
 * composer then says the request above needs an answer first.
 */

export type QuestionComposerAnswer = { ok: true } | { ok: false; reason: string };

type Handler = (text: string) => QuestionComposerAnswer;

const handlers = new Map<string, Handler>();

/** Register the card's handler for `sessionId`; the returned function removes it (only if still its own). */
export function registerQuestionComposerAnswer(sessionId: string, handler: Handler): () => void {
  handlers.set(sessionId, handler);
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
}

/** Hand the composer's text to the session's open question, or `null` when no card takes it. */
export function answerQuestionFromComposer(sessionId: string, text: string): QuestionComposerAnswer | null {
  const handler = handlers.get(sessionId);
  return handler ? handler(text) : null;
}
