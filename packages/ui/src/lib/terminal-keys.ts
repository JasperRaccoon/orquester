/**
 * Mobile terminal keys: the byte encoding behind the key bar and its latching
 * Ctrl/Alt modifiers (a phone keyboard has neither, so ⌃R, ⌃Z, ⌃L or Alt-b
 * could not be typed at all).
 *
 * A modifier tap arms it for the next key only; a second tap within
 * `DOUBLE_TAP_MS` locks it until it is tapped again. The armed or locked
 * modifiers apply to the next key from the key bar (`encodeKey`) or from the
 * on-screen keyboard (`applyLatchedModifiers` on xterm's `onData`), encoded the
 * way xterm itself encodes a real modified key press.
 */
import React from "react";

const ESC = "\x1b";

export type LatchState = "off" | "armed" | "locked";
export type ModifierName = "ctrl" | "alt";

/** One modifier's latch; `armedAt` dates the first tap so a second can lock it. */
export interface ModifierLatch {
  state: LatchState;
  armedAt: number | null;
}

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

/** The window in which a second tap locks an armed modifier instead of releasing it. */
export const DOUBLE_TAP_MS = 350;

export const LATCH_OFF: ModifierLatch = { state: "off", armedAt: null };

/** off → armed; armed → locked on a quick second tap, else off; locked → off. */
export function tapLatch(latch: ModifierLatch, now: number): ModifierLatch {
  if (latch.state === "off") return { state: "armed", armedAt: now };
  if (latch.state === "armed" && latch.armedAt !== null && now - latch.armedAt <= DOUBLE_TAP_MS) {
    return { state: "locked", armedAt: null };
  }
  return LATCH_OFF;
}

/** After a key went out: a one-shot (armed) modifier is spent, a locked one stays. */
export function consumeLatch(latch: ModifierLatch): ModifierLatch {
  return latch.state === "armed" ? LATCH_OFF : latch;
}

export type SpecialKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "insert"
  | "delete"
  | "pageUp"
  | "pageDown"
  | "escape"
  | "tab"
  | "enter"
  | "backspace";

export type TerminalKey = { kind: "char"; char: string } | { kind: "special"; key: SpecialKey };

// Final byte of `CSI 1;<m> <final>` (unmodified: `CSI <final>`).
const CURSOR_FINAL: Partial<Record<SpecialKey, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F"
};

// Number of `CSI <n>;<m> ~` (unmodified: `CSI <n> ~`).
const TILDE_CODE: Partial<Record<SpecialKey, number>> = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6
};

// Ctrl on the punctuation and digits that have a C0 code (xterm's legacy table).
const CTRL_SYMBOLS: Record<string, string> = {
  " ": "\x00",
  "@": "\x00",
  "2": "\x00",
  "[": "\x1b",
  "3": "\x1b",
  "\\": "\x1c",
  "4": "\x1c",
  "]": "\x1d",
  "5": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  "_": "\x1f",
  "7": "\x1f",
  "/": "\x1f",
  "?": "\x7f",
  "8": "\x7f"
};

/** Ctrl+char: letters → 0x01–0x1A, the symbols above → their C0 code, anything else unchanged. */
// Adapted from T3 Code (MIT): apps/mobile/src/features/terminal/terminalInput.ts
export function ctrlChar(char: string): string {
  const lower = char.toLowerCase();
  if (lower.length === 1 && lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  return CTRL_SYMBOLS[char] ?? char;
}

/**
 * The bytes a PTY expects for `key` with `mods`, matching xterm: Alt is an ESC
 * prefix on a character, and cursor/editing keys carry the xterm modifier
 * parameter (`1 + 2·alt + 4·ctrl`), e.g. Ctrl+↑ = `CSI 1;5A`. Unmodified
 * cursor keys use normal (not application) cursor mode, as the key bar always has.
 */
export function encodeKey(key: TerminalKey, mods: Modifiers): string {
  const alt = mods.alt ? ESC : "";
  if (key.kind === "char") {
    return alt + (mods.ctrl ? ctrlChar(key.char) : key.char);
  }
  const param = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  const cursor = CURSOR_FINAL[key.key];
  if (cursor) {
    return param > 1 ? `${ESC}[1;${param}${cursor}` : `${ESC}[${cursor}`;
  }
  const tilde = TILDE_CODE[key.key];
  if (tilde !== undefined) {
    return param > 1 ? `${ESC}[${tilde};${param}~` : `${ESC}[${tilde}~`;
  }
  switch (key.key) {
    case "escape":
      return alt + ESC;
    case "tab":
      return alt + "\t";
    case "enter":
      return alt + "\r";
    case "backspace":
      return alt + (mods.ctrl ? "\b" : "\x7f");
    default:
      return "";
  }
}

const SEQUENCE_KEYS: Record<string, SpecialKey> = {
  [`${ESC}[A`]: "up",
  [`${ESC}OA`]: "up",
  [`${ESC}[B`]: "down",
  [`${ESC}OB`]: "down",
  [`${ESC}[C`]: "right",
  [`${ESC}OC`]: "right",
  [`${ESC}[D`]: "left",
  [`${ESC}OD`]: "left",
  [`${ESC}[H`]: "home",
  [`${ESC}OH`]: "home",
  [`${ESC}[F`]: "end",
  [`${ESC}OF`]: "end",
  [`${ESC}[2~`]: "insert",
  [`${ESC}[3~`]: "delete",
  [`${ESC}[5~`]: "pageUp",
  [`${ESC}[6~`]: "pageDown",
  [ESC]: "escape",
  "\t": "tab",
  "\r": "enter",
  "\n": "enter",
  "\x7f": "backspace",
  "\b": "backspace"
};

/**
 * Read one key press back out of xterm's `onData`. Returns null for anything
 * that is not a single key: text an IME or autocomplete commits in one go, a
 * paste, other control bytes, and xterm's own reports (mouse, focus, DSR) —
 * those must reach the PTY untouched, so a latched modifier never mangles them.
 */
export function parseInputKey(data: string): TerminalKey | null {
  const special = SEQUENCE_KEYS[data];
  if (special) return { kind: "special", key: special };
  const points = Array.from(data);
  if (points.length !== 1) return null;
  const code = data.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return null;
  return { kind: "char", char: data };
}

/** `data` with `mods` applied, or null when it is not a single key or no modifier is on. */
export function applyModifiers(data: string, mods: Modifiers): string | null {
  if (!mods.ctrl && !mods.alt) return null;
  const key = parseInputKey(data);
  return key ? encodeKey(key, mods) : null;
}

// ---------------------------------------------------------------------------
// The latch store, shared by the key bar (taps) and the terminal (input path).
// Scoped to one session: the bar resets it when the active session changes,
// and another session's terminal never sees it.
// ---------------------------------------------------------------------------

export interface ModifierLatches {
  sessionId: string | null;
  ctrl: ModifierLatch;
  alt: ModifierLatch;
}

const INITIAL: ModifierLatches = { sessionId: null, ctrl: LATCH_OFF, alt: LATCH_OFF };

let latches: ModifierLatches = INITIAL;
const listeners = new Set<() => void>();

function setLatches(next: ModifierLatches): void {
  if (next === latches) return;
  latches = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getModifierLatches(): ModifierLatches {
  return latches;
}

/** Release every modifier and point the latches at `sessionId` (null: none). */
export function resetModifierLatches(sessionId: string | null = null): void {
  if (
    latches.sessionId === sessionId &&
    latches.ctrl.state === "off" &&
    latches.alt.state === "off"
  ) {
    return;
  }
  setLatches({ sessionId, ctrl: LATCH_OFF, alt: LATCH_OFF });
}

export function tapModifier(sessionId: string, name: ModifierName, now: number): void {
  const current = latches.sessionId === sessionId ? latches : { ...INITIAL, sessionId };
  setLatches({ ...current, [name]: tapLatch(current[name], now) });
}

/** The modifiers that apply to `sessionId`'s next key. */
export function activeModifiers(sessionId: string): Modifiers {
  if (latches.sessionId !== sessionId) return { ctrl: false, alt: false };
  return { ctrl: latches.ctrl.state !== "off", alt: latches.alt.state !== "off" };
}

/** A key went out on `sessionId`: spend its one-shot modifiers. */
export function consumeModifiers(sessionId: string): void {
  if (latches.sessionId !== sessionId) return;
  const ctrl = consumeLatch(latches.ctrl);
  const alt = consumeLatch(latches.alt);
  if (ctrl === latches.ctrl && alt === latches.alt) return;
  setLatches({ ...latches, ctrl, alt });
}

/**
 * The terminal input path: `data` from the on-screen keyboard with the latched
 * modifiers applied (spending the one-shots), or null to send it as it is.
 */
export function applyLatchedModifiers(sessionId: string, data: string): string | null {
  const encoded = applyModifiers(data, activeModifiers(sessionId));
  if (encoded !== null) consumeModifiers(sessionId);
  return encoded;
}

export function useModifierLatches(): ModifierLatches {
  return React.useSyncExternalStore(subscribe, getModifierLatches, getModifierLatches);
}
