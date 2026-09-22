/**
 * Which chat tab is the VISIBLE one.
 *
 * `MainView` keeps every tab of a project mounted and merely hides the
 * inactive ones (`show ? "flex" : "hidden"`), so every open chat tab has a
 * live `AgentChatView`, a live `ChatComposer` and a live banner dock — each
 * with its own `window`/`document` keyboard listeners. Without an
 * "am I the one on screen?" check, one `Ctrl+Shift+Enter` sends the queued
 * message of *every* thread and one `1` answers a question in *every* thread:
 * mutations dispatched to an agent the user is not looking at, one of them
 * (an answer) irreversible.
 *
 * The shell is the only layer that knows which tab is showing, so it publishes
 * it here and every keyboard surface in the chat UI gates on
 * {@link isActiveChatTab}. A module-level registry rather than a prop chain
 * because the listeners that need it are `window`-level and several component
 * layers down; a prop would have to thread through every one of them and a
 * missed hop is a silent wrong-tab mutation.
 *
 * In grid view several chat tabs are visible at once. The rule is then
 * "the focused cell", which is exactly `activeTabByProject` — the one the grid
 * outlines — so a single id stays correct there too.
 */

let activeSessionId: string | null = null;

const listeners = new Set<(sessionId: string | null) => void>();

/**
 * Publish the visible chat tab. Called by the shell; pass `null` when the
 * active tab is not a chat tab (a terminal, the file browser, nothing open),
 * so a hidden chat tab never inherits the keyboard by default.
 */
export function setActiveChatTab(sessionId: string | null): void {
  if (activeSessionId === sessionId) {
    return;
  }
  activeSessionId = sessionId;
  for (const listener of listeners) {
    listener(sessionId);
  }
}

/**
 * True when this chat tab is the visible one.
 *
 * **Every `window`/`document` keyboard listener in the chat surface must call
 * this before acting.** A listener that only reads its own state cannot tell
 * that it belongs to a hidden tab.
 */
export function isActiveChatTab(sessionId: string): boolean {
  return activeSessionId === sessionId;
}

/** The visible chat tab's session id, or `null` when none is showing. */
export function activeChatTab(): string | null {
  return activeSessionId;
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeActiveChatTab(
  listener: (sessionId: string | null) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Release the claim if this tab still holds it — for a tab unmounting (closed,
 * or its project navigated away from) while it was the visible one. Guarded on
 * identity: a fast switch unmounts the old tab *after* the new one claimed,
 * and a blind clear would leave the keyboard unowned.
 */
export function releaseActiveChatTab(sessionId: string): void {
  if (activeSessionId === sessionId) {
    setActiveChatTab(null);
  }
}

/**
 * A tab, as much of one as this decision needs: the arms that carry no
 * `sessionId` (files, git, todo, browser, the overview) satisfy it by omission.
 */
export interface ActiveChatTabCandidate {
  id: string;
  type: string;
  sessionId?: string | undefined;
}

/**
 * Which chat tab the shell should publish, given a project's tabs and its
 * active tab id.
 *
 * Lifted out of `MainView` because this — not the registry above — is where
 * Q2-1/Q2-2 were: the registry only ever reports what it is told, so a wrong
 * derivation here hands the keyboard to a thread the user cannot see. Three
 * cases have to stay pinned: a **terminal** tab is active (a chat tab is
 * mounted but hidden ⇒ `null`, not "the last chat tab"), the active id names
 * no tab at all (mid-close ⇒ `null`), and a legacy `agent` terminal record,
 * which is a PTY tab and never a chat one.
 */
export function activeChatSessionIdFor(
  tabs: readonly ActiveChatTabCandidate[],
  activeTabId: string | null | undefined
): string | null {
  if (!activeTabId) return null;
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (!active || active.type !== "agent-chat") return null;
  return active.sessionId ?? null;
}
