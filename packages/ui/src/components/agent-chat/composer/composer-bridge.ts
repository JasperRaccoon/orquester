/**
 * The one way other chat surfaces reach the composer (spec §7.4).
 *
 * The timeline's "return this queued message to the composer", a browser-pick
 * payload, a session upload targeting a chat tab and a displaced custom answer
 * all end the same way: **text lands in the draft at the caret, never typed
 * into a pane**. None of those callers can hold a React ref to a component
 * they do not render, so the composer registers a tiny handle per session and
 * they call it by session id.
 *
 * A handle for a session that is not mounted is simply absent and every call
 * is a no-op — which is the right behaviour for a tab that was closed while a
 * request was in flight.
 */

import type { AttachmentRef } from "@orquester/api/agent-chat";

import type { ComposerDraft } from "../../../lib/agent-chat/composer.logic";
import type { StagedAttachment } from "./ComposerAttachments";
import type { ComposerShortcutCommand } from "./composer-shortcuts";
import type { FailedSendRestore } from "./composer-submission";

export interface ComposerHandle {
  /** Insert text into the draft at the caret (or append it); focus stays where it is (§7.4). */
  insertText: (text: string, mode?: "cursor" | "append") => void;
  /**
   * Stage a NEW **already-uploaded** attachment as a real chip — a browser
   * pick, a chat-targeted drop.
   *
   * Everything a picked file gets — a place in the eight, a removable chip,
   * the upload-complete gate — minus the upload, which already happened.
   * Returns `false` when the turn bounds refuse it, so the caller can fall
   * back to writing the path into the draft rather than losing the file.
   * Re-staging the same ref is idempotent and returns `true`.
   */
  stageAttachment: (ref: AttachmentRef) => boolean;
  /**
   * Merge a message coming BACK into the live draft (§7.4) — a queued message
   * returned, the queue a Stop drained, a rewound message — behind what it
   * holds (`draftAfterReturn`): its text after a blank line, its `[Image #N]`
   * following its own images, every file staged as a returning chip (never
   * refused for the count — the send gate holds a draft over the eight) and
   * its context records carried with the draft. Answers the refs a bound
   * still refused, for the caller to write into the draft as their paths.
   */
  returnMessage: (message: ComposerDraft) => AttachmentRef[];
  /** Focus the textarea with the caret at the end. */
  focusAtEnd: () => void;
  /**
   * Un-collapse, focus, then find and click the control advertising this
   * token — the `data-composer-shortcut` convention (§7.4).
   */
  openControl: (command: ComposerShortcutCommand) => void;
  /**
   * Put a failed send's draft back into this composer's live draft (§7.4) —
   * `draftAfterSend` over what it holds now, the send's notice with it — for
   * a send from this thread that the composer it left from can no longer put
   * back itself (a project switch unmounted it — or, defensively, it shows
   * another thread). `false` when this composer does not show that thread
   * either, so the caller writes the thread's persisted draft instead.
   */
  restoreFailedSend: (restore: FailedSendRestore<StagedAttachment>) => boolean;
}

const handles = new Map<string, ComposerHandle>();

/** Returns the unregister function; the composer calls it on unmount. */
export function registerComposerHandle(sessionId: string, handle: ComposerHandle): () => void {
  handles.set(sessionId, handle);
  return () => {
    // Guard the identity: a fast tab switch can unmount the old effect after
    // the new one registered, and a blind delete would drop the live handle.
    if (handles.get(sessionId) === handle) handles.delete(sessionId);
  };
}

export function composerHandle(sessionId: string): ComposerHandle | null {
  return handles.get(sessionId) ?? null;
}

/** Insert text into a session's composer draft. No-op when it is not mounted. */
export function insertComposerText(
  sessionId: string,
  text: string,
  mode: "cursor" | "append" = "cursor"
): void {
  composerHandle(sessionId)?.insertText(text, mode);
}

/**
 * Stage an already-uploaded attachment into a session's draft as a chip.
 *
 * `false` means it did not land — either no composer is mounted for that
 * session, or the turn bounds refused it. **The caller is expected to fall
 * back** to writing the attachment's path into the draft text; a file that
 * silently disappears between the picker and the message is worse than a path
 * the user can see.
 */
export function stageComposerAttachment(sessionId: string, ref: AttachmentRef): boolean {
  return composerHandle(sessionId)?.stageAttachment(ref) ?? false;
}

/**
 * Hand a message coming back to the composer that shows its thread (§7.4).
 * `null` when none is mounted — the caller merges it into the thread's
 * persisted draft instead, where the next mount loads it — else the refs the
 * composer could not stage, which the caller writes into the draft as their
 * paths (`composerTextForDelivery`). Nothing goes into the persisted draft
 * behind a mounted composer: it owns the one visible draft, and its next save
 * would write over it.
 */
export function returnComposerMessage(
  sessionId: string,
  message: ComposerDraft
): AttachmentRef[] | null {
  return composerHandle(sessionId)?.returnMessage(message) ?? null;
}

/**
 * Hand a failed send's draft to the composer that shows its thread (§7.4).
 * `false` when none takes it — nothing is mounted for that thread, or
 * (defensively) the one registered no longer shows it — and the caller then
 * writes the thread's persisted draft, where the next composer to show the
 * thread loads it.
 */
export function restoreComposerFailedSend(
  sessionId: string,
  restore: FailedSendRestore<StagedAttachment>
): boolean {
  return composerHandle(sessionId)?.restoreFailedSend(restore) ?? false;
}

/** Open a composer control by its `data-composer-shortcut` token. */
export function openComposerControl(sessionId: string, command: ComposerShortcutCommand): void {
  composerHandle(sessionId)?.openControl(command);
}

export function focusComposer(sessionId: string): void {
  composerHandle(sessionId)?.focusAtEnd();
}
