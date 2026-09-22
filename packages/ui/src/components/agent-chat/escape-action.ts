/**
 * What Escape does inside a chat tab (§7.4 "Escape interrupts when a turn is
 * active", §7.6 "read-only, with a breadcrumb and Escape back to main").
 *
 * Pure, because the listener that used to hold this logic had no test at all:
 * it is a `window` handler in a package with no DOM, so the only way to pin the
 * rules is to lift the decision out of the event plumbing. The listener keeps
 * the three lines that touch the event; every rule about *whether* to act is
 * here.
 *
 * **The chat shell is the single Escape owner for a tab.** Two capture-phase
 * `window` listeners for the same key cannot be ordered reliably — a listener
 * whose effect deps change (a queue mutation, a turn transition) re-registers
 * and moves to the back of the list — so whichever fired first won, and with a
 * drill-in open that meant Escape stopped the turn instead of leaving the child
 * view. The composer keeps Escape only on its own textarea, where its open
 * token menu gets first refusal.
 */

export type ChatEscapeAction = "close-drill-in" | "interrupt" | "ignore";

export interface ChatEscapeInput {
  /** The pressed key, straight off the event. */
  key: string;
  /** Another listener already acted on this event. */
  defaultPrevented: boolean;
  /** This tab is the visible one (every tab stays mounted, §7.1). */
  isActiveTab: boolean;
  /** A modal, the auth prompt, a close-confirm or the palette owns the screen. */
  blockingLayerOpen: boolean;
  /**
   * Focus is inside this thread's composer, which owns Escape there so an open
   * token menu can consume it before the turn does.
   */
  insideComposer: boolean;
  /** A subagent drill-in is open on this tab. */
  drillInOpen: boolean;
  /** A turn is running on this thread. */
  turnActive: boolean;
}

/**
 * The drill-in wins over the interrupt: leaving a child view is the narrower,
 * reversible action, and a user watching a subagent who presses Escape means
 * "take me back", not "stop the agent".
 */
export function resolveChatEscape(input: ChatEscapeInput): ChatEscapeAction {
  if (input.key !== "Escape" || input.defaultPrevented) {
    return "ignore";
  }
  if (!input.isActiveTab || input.blockingLayerOpen || input.insideComposer) {
    return "ignore";
  }
  if (input.drillInOpen) {
    return "close-drill-in";
  }
  return input.turnActive ? "interrupt" : "ignore";
}
