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

import type { ComposerShortcutCommand } from "./composer-shortcuts";

export interface ComposerHandle {
  /** Append or insert text into the draft, focusing the composer. */
  insertText: (text: string, mode?: "cursor" | "append") => void;
  /** Focus the textarea with the caret at the end. */
  focusAtEnd: () => void;
  /**
   * Un-collapse, focus, then find and click the control advertising this
   * token — the `data-composer-shortcut` convention (§7.4).
   */
  openControl: (command: ComposerShortcutCommand) => void;
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

/** Open a composer control by its `data-composer-shortcut` token. */
export function openComposerControl(sessionId: string, command: ComposerShortcutCommand): void {
  composerHandle(sessionId)?.openControl(command);
}

export function focusComposer(sessionId: string): void {
  composerHandle(sessionId)?.focusAtEnd();
}
