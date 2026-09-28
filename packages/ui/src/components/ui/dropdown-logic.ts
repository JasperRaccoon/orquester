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
 * Marks a control that must never take focus by itself: a destructive one,
 * which the Enter that follows an open would fire (fix round 2 — "Clear goal"
 * as the goal popover's only action).
 */
export const DROPDOWN_DESTRUCTIVE_ATTRIBUTE = "data-destructive";

/** What counts as a control focus may land on: enabled, and in the tab order. */
const DROPDOWN_FOCUSABLE = [
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
