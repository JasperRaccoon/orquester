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

// ---------------------------------------------------------------------------
// Escape ownership (V1 §10.1)
// ---------------------------------------------------------------------------

/**
 * Who handles an Escape that reached a `window` capture listener.
 *
 * **Two listeners exist and exactly one of them may act.** The shell
 * (`AgentChatView`) owns Escape everywhere *outside* this thread's composer
 * shell — it leaves an open drill-in, else interrupts. The composer owns it
 * *inside* the shell, because the textarea has to give an open token menu
 * first refusal before the turn is stopped.
 *
 * The two rules are complements by construction: the shell bails when
 * `target.closest('[data-agent-chat-composer-shell=…]')` matches, and this
 * returns true only when it does. `defaultPrevented` is the belt on top —
 * `stopPropagation()` does **not** silence a sibling listener on the same
 * node, so whichever runs first must be able to tell the other to stand down.
 *
 * Without this, one Escape fired two `actions.interrupt()` calls: two POSTs,
 * two `commandId`s and a redundant queue drain.
 */
export function composerOwnsEscape(input: {
  /** The other listener already acted on this event. */
  defaultPrevented: boolean;
  /** The event target is inside THIS thread's composer shell. */
  insideComposerShell: boolean;
  /** The target is the textarea, which handles Escape on its own. */
  isTextarea: boolean;
  isTurnActive: boolean;
}): boolean {
  if (input.defaultPrevented) return false;
  if (!input.isTurnActive) return false;
  // The textarea's own handler runs first and owns the menu-vs-interrupt call.
  if (input.isTextarea) return false;
  return input.insideComposerShell;
}

/**
 * The shell's half, stated here so the disjointness is testable in one place.
 * `AgentChatView` implements exactly this; if it ever drifts, the test that
 * asserts the two never both return true is what catches it.
 */
export function shellOwnsEscape(input: {
  defaultPrevented: boolean;
  insideComposerShell: boolean;
  isTurnActive: boolean;
  drillInOpen: boolean;
}): boolean {
  if (input.defaultPrevented) return false;
  if (input.insideComposerShell) return false;
  return input.drillInOpen || input.isTurnActive;
}
