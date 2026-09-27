/**
 * Surfaces outside a chat that own the keys typed into them: the right rail's
 * docked panel, its mobile sheet and the saved-prompt editor (each root
 * carries {@link KEYBOARD_SURFACE_ATTRIBUTE}), and every modal dialog or sheet
 * (`aria-modal="true"`: `ui/modal.tsx`, `ui/sheet.tsx`).
 *
 * The chat's chords — the composer's Ctrl/Cmd+E, Ctrl/Cmd+/, Ctrl/Cmd+Shift+M
 * and Ctrl/Cmd+Shift+Enter, the timeline's Ctrl/Cmd+J — are capture-phase
 * `window` listeners of the VISIBLE chat tab, so they run before any surface
 * can stop the key. A chord typed into the panel's search, the prompt editor
 * or a confirm dialog must never open the chat's model menu behind it, steal
 * its focus or send the chat's queued message, so those listeners stand down
 * for a key whose target is inside one ({@link insideKeyboardSurface}). The
 * chat's OWN popovers are menus, not modal, so a chord still moves between
 * them. The question card's digits also stand down inside any menu
 * ({@link insideKeyboardOwner}): a digit typed on a menu item is the menu's,
 * and an answer cannot be taken back.
 *
 * Target-based on purpose: a hover popover that holds an open layer while the
 * mouse rests on it (the context meter's) owns no chord typed elsewhere. The
 * question card's digits read the open layers as well (`questionShortcutOption`,
 * `lib/open-layers.ts`): an answer cannot be taken back.
 */

export const KEYBOARD_SURFACE_ATTRIBUTE = "data-keyboard-surface";

/** Spread onto a surface's root element. */
export const KEYBOARD_SURFACE_PROPS = { [KEYBOARD_SURFACE_ATTRIBUTE]: "" } as const;

const SURFACE_SELECTOR = `[${KEYBOARD_SURFACE_ATTRIBUTE}], [aria-modal="true"]`;
const OWNER_SELECTOR = `${SURFACE_SELECTOR}, [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]`;

function closestMatches(target: EventTarget | null, selector: string): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === "function" && element.closest(selector) !== null;
}

/** True when a key event's target sits inside a rail surface or a modal dialog/sheet. */
export function insideKeyboardSurface(target: EventTarget | null): boolean {
  return closestMatches(target, SURFACE_SELECTOR);
}

/** {@link insideKeyboardSurface}, or inside an open menu or listbox. */
export function insideKeyboardOwner(target: EventTarget | null): boolean {
  return closestMatches(target, OWNER_SELECTOR);
}
