/**
 * What Escape does inside a chat tab (§7.4 "Escape interrupts when a turn is
 * active", §7.6 "read-only, with a breadcrumb and Escape back to main", and
 * the CLI's double Escape — "press Esc twice to jump to a previous message" —
 * which opens the rewind picker, §5.5).
 *
 * Pure, because the listener that used to hold this logic had no test at all:
 * it is a `window` handler in a package with no DOM, so the only way to pin the
 * rules is to lift the decision out of the event plumbing. The listener keeps
 * the three lines that touch the event; every rule about *whether* to act is
 * here.
 *
 * **The shell and the composer share Escape by scope, never by order.** Two
 * capture-phase `window` listeners for the same key cannot be ordered reliably
 * — one whose effect deps change (the composer's include `queue`) re-registers
 * and moves to the back of the list — so whichever fired first won: two
 * interrupts when both acted, and a stopped turn instead of a closed drill-in
 * when the composer went first. The scopes are therefore disjoint and
 * target-based. This half covers every Escape landing OUTSIDE the thread's
 * composer shell; `composerOwnsEscape` (`composer/tab-visibility.ts`) covers
 * the inside, minus the textarea, where an open token menu gets first refusal.
 * `insideComposer` below is this side of that contract.
 *
 * The double press follows the same split: the textarea counts its own
 * Escapes (with a hint after the first), this side counts the ones landing
 * outside the composer, and each keeps its own `createEscapeSequence()` — so
 * one Escape can never advance both, and a press is only ever the first half
 * of a rewind when it did nothing else.
 *
 * **An open layer comes before all of it.** This side runs on `window` in the
 * capture phase — before any modal's, sheet's, menu's or popover's own Escape
 * listener — and stops the event when it acts, so the only way a layer gets
 * its Escape is for this side to stand down while one is up
 * (`blockingLayerOpen`). The composer's two arms do the same.
 */

export type ChatEscapeAction = "close-drill-in" | "interrupt" | "rewind" | "ignore";

export interface ChatEscapeInput {
  /** The pressed key, straight off the event. */
  key: string;
  /** Another listener already acted on this event. */
  defaultPrevented: boolean;
  /** This tab is the visible one (every tab stays mounted, §7.1). */
  isActiveTab: boolean;
  /**
   * A layer that closes on Escape is up anywhere in the app —
   * `anotherLayerOwnsTheKeyboard()`: the auth prompt, Settings, a
   * close-confirm, the palette, and every open `Modal`, `BottomSheet`,
   * `Dropdown`, `ContextMenu` and `ComposerPopover` (`lib/open-layers.ts`) —
   * this thread's own output viewer and context meter among them.
   */
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
  /**
   * This Escape completes a double press: the listener's
   * `createEscapeSequence()` answered `true` for it. The listener only presses
   * the sequence for an Escape {@link chatEscapeSequenceStep} says counts, so a
   * press that stopped a turn or left a drill-in is never half of a rewind.
   */
  secondPress: boolean;
  /**
   * The thread has a message to rewind to and nothing stands in the way — the
   * composer's rewind picker would open (it has targets and is enabled).
   */
  rewindAvailable: boolean;
}

/** The part of the input that decides whether an Escape is idle. */
export type ChatEscapeGate = Omit<ChatEscapeInput, "secondPress" | "rewindAvailable">;

/**
 * An Escape this side would otherwise ignore **only because nothing is
 * happening**: the visible tab, nothing modal on top, focus outside the
 * composer, no drill-in to leave and no turn to stop. Exactly these are the
 * Escapes the double press counts — the ones that did nothing else.
 */
export function isIdleChatEscape(input: ChatEscapeGate): boolean {
  return (
    input.key === "Escape" &&
    !input.defaultPrevented &&
    input.isActiveTab &&
    !input.blockingLayerOpen &&
    !input.insideComposer &&
    !input.drillInOpen &&
    !input.turnActive
  );
}

/**
 * What one keydown does to the shell's double-press sequence.
 *
 * - `"press"` — an idle Escape ({@link isIdleChatEscape}).
 * - `"keep"` — a held key's auto-repeat. Holding Escape is one press, not a
 *   double one, and the repeat must not break a sequence either.
 * - `"reset"` — everything else. A double press is two CONSECUTIVE Escapes:
 *   a key typed in between, an Escape that stopped a turn or left a drill-in,
 *   and an Escape a layer takes to close itself all start the count over
 *   rather than becoming its first half. A composer popover is such a layer
 *   (`blockingLayerOpen`); its Escape lands in the portaled panel, outside the
 *   composer shell, so nothing else here tells it from an idle one.
 */
export function chatEscapeSequenceStep(
  input: ChatEscapeGate & {
    /** `KeyboardEvent.repeat`. */
    repeat: boolean;
  }
): "press" | "keep" | "reset" {
  if (input.repeat) {
    return "keep";
  }
  return isIdleChatEscape(input) ? "press" : "reset";
}

/**
 * The drill-in wins over the interrupt: leaving a child view is the narrower,
 * reversible action, and a user watching a subagent who presses Escape means
 * "take me back", not "stop the agent". The composer keeps the same order
 * inside its shell (`composerEscapeAction`), so where the caret sits never
 * changes what Escape does. The rewind comes last: it is only ever what an
 * idle Escape does, and only the second of two.
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
  if (input.turnActive) {
    return "interrupt";
  }
  // Idle: nothing to leave and nothing to stop. The CLI's Esc Esc opens the
  // rewind picker — the second press, and only where there is one to open.
  return input.secondPress && input.rewindAvailable ? "rewind" : "ignore";
}
