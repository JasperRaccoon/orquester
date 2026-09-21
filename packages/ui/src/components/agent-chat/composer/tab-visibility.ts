/**
 * "Is this chat tab the one the user is looking at?"
 *
 * **Every `window`/`document` keyboard listener in agent-chat must gate on
 * this.** `MainView` renders every tab of a project and merely hides the
 * inactive ones with a CSS class, so the tree stays structurally stable — which
 * means every open chat tab has a live `AgentChatView`, a live `ChatComposer`
 * and a live question card, each with its own global listener. Without a gate,
 * one `Ctrl/Cmd+Shift+Enter` sends the queued message of *every* tab and one
 * `1` answers the question in *every* tab. The second is irreversible.
 *
 * Two independent signals, and the element check is the backstop rather than
 * the primary: a caller that forgets to thread `active` through still gets the
 * right answer, because a hidden tab's subtree has no layout box. That is the
 * same rule `isOperableControl` already uses for the control arm — which is
 * precisely why that arm was accidentally safe while the others were not.
 */

/**
 * `active` is the explicit signal from the shell (`AgentChatViewProps.active`).
 * `root` is the listener owner's own element.
 *
 * Returns false as soon as either says "not visible": an explicit `false`
 * is authoritative, and so is a subtree with no client rects. `undefined`
 * `active` means "the caller did not say", so the element decides; a `root`
 * that is null means "not mounted yet", which is also not actionable.
 */
export function isChatTabListenerActive(
  active: boolean | undefined,
  root: { getClientRects(): { length: number } } | null | undefined
): boolean {
  if (active === false) return false;
  if (!root) return false;
  return root.getClientRects().length > 0;
}
