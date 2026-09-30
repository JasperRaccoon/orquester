/**
 * X keysyms for the desktop viewer's touch keyboard (hidden input + key strip).
 * noVNC's own keysym tables live in `core/input/*`, which the package does not
 * export, so the handful of values used here are spelled out (X11
 * `keysymdef.h`).
 */

export const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
  v: 0x0076
} as const;

export type LatchModifier = "ctrl" | "alt" | "super";

export const MODIFIER_KEYSYM: Record<LatchModifier, number> = {
  ctrl: XK.Control_L,
  alt: XK.Alt_L,
  super: XK.Super_L
};

/**
 * The keysym for one Unicode code point: Latin-1 printable characters map
 * directly, a newline is Return, a tab is Tab, anything else is the Unicode
 * keysym `0x01000000 + codepoint` (which Xvnc maps onto a spare keycode).
 */
export function keysymForCodePoint(cp: number): number | null {
  if (cp === 0x0a || cp === 0x0d) return XK.Return;
  if (cp === 0x09) return XK.Tab;
  if (cp === 0x08) return XK.BackSpace;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return null; // control characters
  if (cp <= 0xff) return cp;
  if (cp > 0x10ffff) return null;
  return 0x01000000 + cp;
}

/** Keysyms for a text string, one per code point, unknown ones dropped. */
export function keysymsForText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const keysym = keysymForCodePoint(ch.codePointAt(0) ?? 0);
    if (keysym !== null) out.push(keysym);
  }
  return out;
}

/** Non-text `KeyboardEvent.key` values the hidden input forwards itself. */
const NAMED_KEYS: Record<string, number> = {
  Backspace: XK.BackSpace,
  Tab: XK.Tab,
  Enter: XK.Return,
  Escape: XK.Escape,
  Delete: XK.Delete,
  Home: XK.Home,
  End: XK.End,
  PageUp: XK.Page_Up,
  PageDown: XK.Page_Down,
  ArrowLeft: XK.Left,
  ArrowUp: XK.Up,
  ArrowRight: XK.Right,
  ArrowDown: XK.Down
};

export function keysymForNamedKey(key: string): number | null {
  return NAMED_KEYS[key] ?? null;
}
