// Key names and keysyms for the automation engine's `key` and `type` (spec 2026-11-10 §2.3):
// combo parsing ("ctrl+shift+t"), the named keys, a table of X keysym names, and the Unicode →
// keysym rule. Keysym values are from X11's keysymdef.h.

import type { DesktopModifier } from "@orquester/api";

import { DesktopAutomationError } from "./types.ts";

/** One key of a combo: a modifier (pressed through the modifier map) or a keysym. */
export type ComboKey = { kind: "modifier"; modifier: DesktopModifier } | { kind: "keysym"; keysym: number };

export const Keysym = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Meta_L: 0xffe7,
  Meta_R: 0xffe8,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
  Super_R: 0xffec
} as const;

const MODIFIER_NAMES: Readonly<Record<string, DesktopModifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  super: "super",
  cmd: "super",
  meta: "super",
  win: "super"
};

/** The spec's friendly names (matched case-insensitively). */
const NAMED_KEYS: Readonly<Record<string, number>> = {
  enter: Keysym.Return,
  return: Keysym.Return,
  esc: Keysym.Escape,
  escape: Keysym.Escape,
  tab: Keysym.Tab,
  space: 0x20,
  backspace: Keysym.BackSpace,
  delete: Keysym.Delete,
  del: Keysym.Delete,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  page_up: 0xff55,
  pagedown: 0xff56,
  page_down: 0xff56,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  menu: 0xff67,
  print: 0xff61,
  capslock: 0xffe5,
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, 0xffbe + i]))
};

/** X keysym names (exact first, then case-insensitive): function, keypad, modifier, media and ASCII punctuation keys. */
const KEYSYM_NAMES: Readonly<Record<string, number>> = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Linefeed: 0xff0a,
  Clear: 0xff0b,
  Return: 0xff0d,
  Pause: 0xff13,
  Scroll_Lock: 0xff14,
  Sys_Req: 0xff15,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Prior: 0xff55,
  Page_Up: 0xff55,
  Next: 0xff56,
  Page_Down: 0xff56,
  End: 0xff57,
  Begin: 0xff58,
  Select: 0xff60,
  Print: 0xff61,
  Execute: 0xff62,
  Insert: 0xff63,
  Undo: 0xff65,
  Redo: 0xff66,
  Menu: 0xff67,
  Find: 0xff68,
  Cancel: 0xff69,
  Help: 0xff6a,
  Break: 0xff6b,
  Mode_switch: 0xff7e,
  Num_Lock: 0xff7f,
  KP_Space: 0xff80,
  KP_Tab: 0xff89,
  KP_Enter: 0xff8d,
  KP_Home: 0xff95,
  KP_Left: 0xff96,
  KP_Up: 0xff97,
  KP_Right: 0xff98,
  KP_Down: 0xff99,
  KP_Prior: 0xff9a,
  KP_Page_Up: 0xff9a,
  KP_Next: 0xff9b,
  KP_Page_Down: 0xff9b,
  KP_End: 0xff9c,
  KP_Begin: 0xff9d,
  KP_Insert: 0xff9e,
  KP_Delete: 0xff9f,
  KP_Equal: 0xffbd,
  KP_Multiply: 0xffaa,
  KP_Add: 0xffab,
  KP_Separator: 0xffac,
  KP_Subtract: 0xffad,
  KP_Decimal: 0xffae,
  KP_Divide: 0xffaf,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`KP_${i}`, 0xffb0 + i])),
  ...Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`F${i + 1}`, 0xffbe + i])),
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Caps_Lock: 0xffe5,
  Shift_Lock: 0xffe6,
  Meta_L: 0xffe7,
  Meta_R: 0xffe8,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
  Super_R: 0xffec,
  Hyper_L: 0xffed,
  Hyper_R: 0xffee,
  ISO_Level3_Shift: 0xfe03,
  ISO_Left_Tab: 0xfe20,
  XF86MonBrightnessUp: 0x1008ff02,
  XF86MonBrightnessDown: 0x1008ff03,
  XF86AudioLowerVolume: 0x1008ff11,
  XF86AudioMute: 0x1008ff12,
  XF86AudioRaiseVolume: 0x1008ff13,
  XF86AudioPlay: 0x1008ff14,
  XF86AudioStop: 0x1008ff15,
  XF86AudioPrev: 0x1008ff16,
  XF86AudioNext: 0x1008ff17,
  XF86HomePage: 0x1008ff18,
  XF86Mail: 0x1008ff19,
  XF86Search: 0x1008ff1b,
  XF86Calculator: 0x1008ff1d,
  XF86Back: 0x1008ff26,
  XF86Forward: 0x1008ff27,
  XF86Refresh: 0x1008ff29,
  XF86PowerOff: 0x1008ff2a,
  XF86Sleep: 0x1008ff2f,
  XF86Copy: 0x1008ff57,
  XF86Cut: 0x1008ff58,
  XF86Paste: 0x1008ff6d,
  space: 0x20,
  exclam: 0x21,
  quotedbl: 0x22,
  numbersign: 0x23,
  dollar: 0x24,
  percent: 0x25,
  ampersand: 0x26,
  apostrophe: 0x27,
  parenleft: 0x28,
  parenright: 0x29,
  asterisk: 0x2a,
  plus: 0x2b,
  comma: 0x2c,
  minus: 0x2d,
  period: 0x2e,
  slash: 0x2f,
  colon: 0x3a,
  semicolon: 0x3b,
  less: 0x3c,
  equal: 0x3d,
  greater: 0x3e,
  question: 0x3f,
  at: 0x40,
  bracketleft: 0x5b,
  backslash: 0x5c,
  bracketright: 0x5d,
  asciicircum: 0x5e,
  underscore: 0x5f,
  grave: 0x60,
  braceleft: 0x7b,
  bar: 0x7c,
  braceright: 0x7d,
  asciitilde: 0x7e
};

const KEYSYM_NAMES_LOWER: ReadonlyMap<string, number> = new Map(Object.entries(KEYSYM_NAMES).map(([name, keysym]) => [name.toLowerCase(), keysym]));

/** The keysym for a Unicode code point: Latin-1 printable code points are their own keysym, others `0x01000000 + cp`. */
export function keysymForCodePoint(codePoint: number): number {
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint;
  return 0x0100_0000 + codePoint;
}

/** One key name of a combo (case-insensitive names; a single character as itself). */
function parseKeyName(name: string): ComboKey {
  const lower = name.toLowerCase();
  const modifier = MODIFIER_NAMES[lower];
  if (modifier) return { kind: "modifier", modifier };
  const named = NAMED_KEYS[lower];
  if (named !== undefined) return { kind: "keysym", keysym: named };
  const chars = [...name];
  if (chars.length === 1) {
    const codePoint = chars[0]!.codePointAt(0)!;
    if (isControl(codePoint)) throw new DesktopAutomationError("INVALID_ARGUMENT", `"${name}" is a control character, not a key name`);
    return { kind: "keysym", keysym: keysymForCodePoint(codePoint) };
  }
  const keysym = KEYSYM_NAMES[name] ?? KEYSYM_NAMES_LOWER.get(lower);
  if (keysym !== undefined) return { kind: "keysym", keysym };
  throw new DesktopAutomationError("INVALID_ARGUMENT", `Unknown key "${name}"`);
}

/** A `+`-separated combo ("ctrl+shift+t", "ctrl++"), its keys in press order. */
export function parseCombo(combo: string): ComboKey[] {
  const trimmed = combo.trim();
  if (trimmed === "") throw new DesktopAutomationError("INVALID_ARGUMENT", "The key combo is empty");
  let names: string[];
  if (trimmed === "+") names = ["+"];
  else if (trimmed.endsWith("++")) names = [...trimmed.slice(0, -2).split("+"), "+"];
  else names = trimmed.split("+");
  return names.map((raw, index) => {
    // "+" itself is only the trailing key; any other empty part is a stray separator.
    const name = raw === "+" && index === names.length - 1 ? raw : raw.trim();
    if (name === "") throw new DesktopAutomationError("INVALID_ARGUMENT", `"${combo}" has an empty key name`);
    return parseKeyName(name);
  });
}

/** C0, DEL and C1 controls. */
export const isControl = (codePoint: number): boolean => codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);

/** `type`'s text as keysyms: `\n` → Return, `\t` → Tab; any other control character is refused. */
export function keysymsForText(text: string): number[] {
  const keysyms: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (char === "\n") keysyms.push(Keysym.Return);
    else if (char === "\t") keysyms.push(Keysym.Tab);
    else if (isControl(codePoint)) throw new DesktopAutomationError("INVALID_ARGUMENT", `The text has a control character (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}); only \\n and \\t are typed`);
    else keysyms.push(keysymForCodePoint(codePoint));
  }
  return keysyms;
}

/**
 * The lower- and upper-case keysyms of a Latin-1 letter, or null for anything else. The core
 * protocol reads a keycode listing one letter (and NoSymbol) as lower case unshifted, upper case
 * shifted.
 */
export function letterCases(keysym: number): { lower: number; upper: number } | null {
  if ((keysym >= 0x61 && keysym <= 0x7a) || (keysym >= 0xe0 && keysym <= 0xfe && keysym !== 0xf7)) return { lower: keysym, upper: keysym - 0x20 };
  if ((keysym >= 0x41 && keysym <= 0x5a) || (keysym >= 0xc0 && keysym <= 0xde && keysym !== 0xd7)) return { lower: keysym + 0x20, upper: keysym };
  return null;
}
