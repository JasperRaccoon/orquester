/**
 * The `Dropdown`'s decisions, as pure functions: where the panel sits
 * horizontally, what it announces itself as, and where focus lands when it
 * opens. The component keeps only the DOM plumbing.
 *
 * No React import.
 */

// ---------------------------------------------------------------------------
// Horizontal position
// ---------------------------------------------------------------------------

/** The widest a panel may be: the viewport less a margin on each side. */
export function dropdownPanelMaxWidth(viewportWidth: number, margin: number): number {
  return Math.max(0, viewportWidth - margin * 2);
}

/**
 * Where the panel sits horizontally.
 *
 * It is anchored to its trigger — its right edge on the trigger's for
 * `align: "right"`, its left edge on the trigger's otherwise — and that anchor
 * is returned unchanged whenever the panel fits, so every dropdown that fitted
 * before sits exactly where it did. Only a panel that would leave the viewport
 * (less `margin`) is clamped back inside as a `left`: a right-aligned `w-72`
 * under a chip on a 360px phone used to start off the left edge (fix round 1,
 * the goal popover of goals §8.2).
 *
 * `panelWidth` is `null` before the panel has been measured; the anchor is the
 * first guess, and the measurement that follows corrects it before paint.
 */
export function dropdownHorizontalPosition(input: {
  align: "left" | "right";
  triggerLeft: number;
  triggerRight: number;
  viewportWidth: number;
  panelWidth: number | null;
  margin: number;
}): { left: number } | { right: number } {
  const anchored =
    input.align === "right"
      ? { right: input.viewportWidth - input.triggerRight }
      : { left: input.triggerLeft };
  if (input.panelWidth === null) return anchored;
  const width = Math.min(input.panelWidth, dropdownPanelMaxWidth(input.viewportWidth, input.margin));
  const idealLeft = input.align === "right" ? input.triggerRight - width : input.triggerLeft;
  const minLeft = input.margin;
  const maxLeft = Math.max(minLeft, input.viewportWidth - input.margin - width);
  if (idealLeft >= minLeft && idealLeft <= maxLeft) return anchored;
  return { left: Math.min(Math.max(idealLeft, minLeft), maxLeft) };
}

// ---------------------------------------------------------------------------
// Role and focus
// ---------------------------------------------------------------------------

/** What the panel is: a menu of items (the default) or a dialog. */
export type DropdownRole = "menu" | "dialog";

/**
 * The panel's own accessibility attributes.
 *
 * A `menu` by default, exactly as before. A panel holding a text readout and
 * plain buttons is a `dialog` — a `menu` promises menu items and arrow-key
 * navigation it does not have — and names itself. One that takes focus when it
 * opens is focusable itself (`tabIndex: -1`), for when it holds no control to
 * take it.
 */
export function dropdownPanelAttributes(input: {
  role?: DropdownRole;
  ariaLabel?: string;
  focusOnOpen?: boolean;
}): { role: DropdownRole; "aria-label"?: string; tabIndex?: -1 } {
  return {
    role: input.role ?? "menu",
    ...(input.ariaLabel !== undefined ? { "aria-label": input.ariaLabel } : {}),
    ...(input.focusOnOpen === true ? { tabIndex: -1 as const } : {})
  };
}

/**
 * Marks a control that must never take focus by itself: a destructive one,
 * which the Enter that follows an open would fire (fix round 2 — "Clear goal"
 * as the goal popover's only action).
 */
export const DROPDOWN_DESTRUCTIVE_ATTRIBUTE = "data-destructive";

/** What counts as a control focus may land on: enabled, and in the tab order. */
export const DROPDOWN_FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(", ");

/**
 * Where focus lands when a focus-taking panel opens: its first control — or
 * the panel itself when it has none, or when that first control is
 * destructive ({@link DROPDOWN_DESTRUCTIVE_ATTRIBUTE}). A keyboard user who
 * opens a panel and presses Enter must never have destroyed something.
 */
export function dropdownFocusTarget(panel: HTMLElement): HTMLElement {
  const first = panel.querySelector<HTMLElement>(DROPDOWN_FOCUSABLE);
  return first === null || first.hasAttribute(DROPDOWN_DESTRUCTIVE_ATTRIBUTE) ? panel : first;
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

/**
 * Subscribe an OPEN panel to the event that should close it — for the chat's
 * popovers, the visible chat tab moving away from the panel's own thread
 * (`dismissWhenChatTabLeaves`, `lib/agent-chat-active-tab.ts`): the panel is
 * portaled, so it would otherwise stay open over the next tab with the old
 * thread's Pause/Clear or Compact still live (final fix wave). Its own tab
 * being activated never closes it — in the grid view the click that opens it
 * also activates its cell. Returns the unsubscribe for the effect's cleanup;
 * a closed panel, or one with nothing to watch, subscribes to nothing.
 */
export function dropdownDismissSubscription(
  open: boolean,
  dismissOn: ((dismiss: () => void) => () => void) | undefined,
  dismiss: () => void
): (() => void) | undefined {
  return open && dismissOn !== undefined ? dismissOn(dismiss) : undefined;
}
