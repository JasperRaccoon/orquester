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
 * The goal chip's actions (goals §8.2) and the right rail's Send (a saved
 * prompt, a prompt from the thread's history) are the callers that SEND
 * rather than insert, and they send through the composer too, never around
 * it: the message must be the user's, refused for whatever refuses the user's
 * own send, with the thread's mode and model riding along.
 *
 * A handle for a session that is not mounted is simply absent and every call
 * is a no-op — which is the right behaviour for a tab that was closed while a
 * request was in flight.
 */

import type { AttachmentRef } from "@orquester/api/agent-chat";

import type { StagedAttachment } from "./ComposerAttachments";
import type { ComposerShortcutCommand } from "./composer-shortcuts";
import type { FailedSendRestore } from "./composer-submission";

/**
 * What the right rail's Send gets back: the message left (`sent`) or waits
 * behind the running turn (`queued`); a bare `/plan` or `/default` switched
 * the mode instead, as Enter does (`mode`) — or nothing was sent, and why (the
 * composer shows the same reason as its own notice).
 */
export type ComposerSubmitResult =
  | { ok: true; disposition: "sent" | "queued" }
  | { ok: true; disposition: "mode"; mode: "plan" | "default" }
  | { ok: false; reason: string };

/**
 * Why an Insert or a Send reached no composer: none is mounted for that
 * thread — its tab is closed, or its chat is still loading.
 */
export const COMPOSER_NOT_MOUNTED_REASON = "This chat isn't ready for input yet.";

export interface ComposerHandle {
  /**
   * Insert text into the draft at the caret (or append it). Focus stays where
   * it is (§7.4) unless `options.focus` asks for it — the right rail's Insert,
   * a user's click that means "put this in the composer and let me type" —
   * which focuses the textarea with the caret right after the inserted text.
   */
  insertText: (text: string, mode?: "cursor" | "append", options?: { focus?: boolean }) => void;
  /**
   * Stage an **already-uploaded** attachment as a real chip.
   *
   * Everything a picked file gets — a place in the eight, a removable chip,
   * the upload-complete gate — minus the upload, which already happened.
   * Returns `false` when the turn bounds refuse it, so the caller can fall
   * back to writing the path into the draft rather than losing the file.
   * Re-staging the same ref is idempotent and returns `true`.
   */
  stageAttachment: (ref: AttachmentRef) => boolean;
  /** Focus the textarea with the caret at the end. */
  focusAtEnd: () => void;
  /**
   * Un-collapse, focus, then find and click the control advertising this
   * token — the `data-composer-shortcut` convention (§7.4).
   */
  openControl: (command: ComposerShortcutCommand) => void;
  /**
   * Send `text` as the user's message through the composer's own send path —
   * its guards, the thread's interaction mode and model, `/turn` — leaving the
   * draft exactly as it is (goals §8.2: a goal chip action). `false` when the
   * composer refused it; the reason is then the composer's own notice.
   */
  sendText: (text: string) => boolean;
  /**
   * Submit `text` as the user's message exactly as Enter would — the right
   * rail's Send: the composer's guards, the thread's interaction mode and
   * model, and the follow-up preference, so while a turn runs the message is
   * queued behind it or steers it as the user chose. The draft is left as it
   * is; a send that fails comes back INTO the draft with its notice, because
   * this text is the user's prompt and must not be lost (unlike `sendText`'s
   * goal commands).
   */
  submitText: (text: string) => ComposerSubmitResult;
  /**
   * Put a failed send's draft back into this composer's live draft (§7.4) —
   * `draftAfterSend` over what it holds now, the send's notice with it — for
   * a send from this thread that the composer it left from can no longer put
   * back itself (a project switch unmounted it, or it shows another thread).
   * `false` when this composer does not show that thread either, so the
   * caller writes the thread's persisted draft instead.
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
  mode: "cursor" | "append" = "cursor",
  options?: { focus?: boolean }
): void {
  composerHandle(sessionId)?.insertText(text, mode, options);
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
 * Hand a failed send's draft to the composer that shows its thread (§7.4).
 * `false` when none takes it — nothing is mounted for that thread, or what is
 * no longer shows it — and the caller then writes the thread's persisted
 * draft, where the next composer to show the thread loads it.
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

/**
 * Send `text` from a session's composer as the user's message (goals §8.2).
 * `false` when no composer is mounted for that session or it refused.
 */
export function sendComposerText(sessionId: string, text: string): boolean {
  return composerHandle(sessionId)?.sendText(text) ?? false;
}

/**
 * Submit `text` from a session's composer as Enter would (the right rail's
 * Send). Refused with {@link COMPOSER_NOT_MOUNTED_REASON} when no composer
 * is mounted for that session.
 */
export function submitComposerText(sessionId: string, text: string): ComposerSubmitResult {
  return (
    composerHandle(sessionId)?.submitText(text) ?? {
      ok: false,
      reason: COMPOSER_NOT_MOUNTED_REASON
    }
  );
}
