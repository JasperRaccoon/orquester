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
 * first refusal before the turn is stopped. Both follow one precedence: an
 * open drill-in is left before a turn is interrupted, wherever focus is — so
 * with a child open the composer claims even an idle Escape, to leave it
 * (`composerEscapeAction` says which).
 *
 * The two rules are complements by construction: the shell bails when
 * `target.closest('[data-agent-chat-composer-shell=…]')` matches, and this
 * returns true only when it does. `defaultPrevented` is the belt on top —
 * `stopPropagation()` does **not** silence a sibling listener on the same
 * node, so whichever runs first must be able to tell the other to stand down.
 *
 * Without this, one Escape fired two `actions.interrupt()` calls: two POSTs,
 * two `commandId`s and a redundant queue drain.
 *
 * **Neither owns an Escape while a layer is up** (`layerOpen`, which is
 * `anotherLayerOwnsTheKeyboard()`): a modal, a sheet, a menu, a composer
 * popover, the palette. Each closes on its own Escape from a `document`
 * listener, which both `window` owners run before — so an owner that acted
 * stopped the turn under the open layer. The shell also stops the event, and
 * the layer never saw the key at all.
 */
export function composerOwnsEscape(input: {
  /** The other listener already acted on this event. */
  defaultPrevented: boolean;
  /** The event target is inside THIS thread's composer shell. */
  insideComposerShell: boolean;
  /** The target is the textarea, which handles Escape on its own. */
  isTextarea: boolean;
  isTurnActive: boolean;
  /** A subagent's drill-in is open on this tab (§7.6). */
  drillInOpen: boolean;
  /** A layer that closes on Escape is up: the key is that layer's. */
  layerOpen: boolean;
}): boolean {
  if (input.defaultPrevented) return false;
  if (input.layerOpen) return false;
  // Nothing to leave and nothing to stop: an idle Escape on a chip is nobody's.
  if (!input.isTurnActive && !input.drillInOpen) return false;
  // The textarea's own handler runs first and owns the menu-vs-interrupt call.
  if (input.isTextarea) return false;
  return input.insideComposerShell;
}

/**
 * The shell's half, stated here so the disjointness is testable in one place.
 * `AgentChatView` implements exactly this; if it ever drifts, the test that
 * asserts the two never both return true is what catches it.
 *
 * `rewindPress` is the shell's third arm (`resolveChatEscape`'s `"rewind"`):
 * the second of two idle Escapes, with a rewind picker to open. It lives
 * outside the composer shell like the other two — the double press INSIDE the
 * composer is the textarea's own, counted on its own sequence — so the scopes
 * stay disjoint by the same rule.
 */
export function shellOwnsEscape(input: {
  defaultPrevented: boolean;
  insideComposerShell: boolean;
  isTurnActive: boolean;
  drillInOpen: boolean;
  rewindPress?: boolean;
  /** `resolveChatEscape`'s `blockingLayerOpen`: the same gate, the same set. */
  layerOpen: boolean;
  /** Typed into a field that is not this chat's (`chatEscapeTargetGate`): the field's. */
  editableOutsideChat: boolean;
}): boolean {
  if (input.defaultPrevented) return false;
  if (input.layerOpen) return false;
  if (input.editableOutsideChat) return false;
  if (input.insideComposerShell) return false;
  return input.drillInOpen || input.isTurnActive || input.rewindPress === true;
}

// ---------------------------------------------------------------------------
// The textarea's own Escape (§7.4)
// ---------------------------------------------------------------------------

/**
 * What an Escape the composer's textarea receives does — first match wins:
 *
 * - `"hold"` — a held key's auto-repeat. Holding Escape is one press: the
 *   first keydown closed the menu, yielded to a layer or left the drill-in,
 *   and its repeats — ~500 ms on, with none of those left — used to stop the
 *   turn. Nothing happens, and the double press keeps its count.
 * - `"close-menu"` — the token menu (`@`, `/`, `$`) is showing. It is the
 *   textarea's own, and closing a menu the user just opened must not also
 *   stop the agent, nor count as half of a rewind.
 * - `"yield-to-layer"` — another layer is up. The textarea's React handler
 *   runs before a modal's, a sheet's or a menu's `document` listener (a
 *   composer popover's capture listener stops the key before it gets here),
 *   so it does nothing and the layer closes itself; the double press starts
 *   over. The case that bit: the context meter's panel opens on hover, so it
 *   can be up with the caret in the textarea, and one Escape stopped the turn
 *   AND closed the panel.
 * - `"leave-drill-in"` — a subagent's view is open (§7.6): back to the
 *   thread, not a stopped agent and not half of Esc Esc. It is the shell's own
 *   precedence (`resolveChatEscape`: the drill-in wins over the interrupt),
 *   which this side used to miss — the composer never knew a child was open,
 *   so typing a steer while watching one and pressing Escape to go back
 *   stopped the parent's turn instead. Stop stays one click away on the
 *   composer's own button.
 * - `"interrupt"` — a turn is running.
 * - `"rewind-press"` — idle: one half of Esc Esc (§5.5).
 *
 * The composer's `window` arm, once it owns an Escape (`composerOwnsEscape`),
 * asks the same question for its two actions: leave, else interrupt.
 */
export type ComposerEscapeAction =
  | "hold"
  | "close-menu"
  | "yield-to-layer"
  | "leave-drill-in"
  | "interrupt"
  | "rewind-press";

export interface ComposerEscapeInput {
  /** `KeyboardEvent.repeat`. */
  repeat: boolean;
  /** The token menu is showing (`showMenu`). */
  menuOpen: boolean;
  /** Another layer is up: `anotherLayerOwnsTheKeyboard()`. */
  layerOpen: boolean;
  /** A subagent's drill-in is open on this tab (§7.6). */
  drillInOpen: boolean;
  isTurnActive: boolean;
}

export function composerEscapeAction(input: ComposerEscapeInput): ComposerEscapeAction {
  if (input.repeat) return "hold";
  if (input.menuOpen) return "close-menu";
  if (input.layerOpen) return "yield-to-layer";
  if (input.drillInOpen) return "leave-drill-in";
  if (input.isTurnActive) return "interrupt";
  return "rewind-press";
}
