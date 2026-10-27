// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/**
 * Keyboard and text mapping for device input: browser `KeyboardEvent.code` to
 * USB HID usages (serve-sim, iOS), browser keys to Android `KeyEvent` keycodes
 * and meta state (serve-emu), text chunking within serve-emu's packet limits,
 * and US-layout keystrokes for typing ASCII into a simulator.
 */

import type { DevicePlatform } from "./types.ts";

/** The fields of a `KeyboardEvent` the maps read. */
export interface KeyboardEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

export type KeyPhase = "down" | "up";

// ---------------------------------------------------------------------------
// iOS: USB HID keyboard page (0x07) usages
// ---------------------------------------------------------------------------

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  NumpadEnter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  IntlBackslash: 0x64,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7
};

export const HID_USAGE_LEFT_SHIFT = 0xe1;

/** HID usage for a physical key (`KeyboardEvent.code`), or null when unmapped. */
function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return 0x3a + Number(fn[1]) - 1;
  return HID_USAGE_BY_CODE[code] ?? null;
}

export interface HidStroke {
  readonly usage: number;
  readonly shift: boolean;
}

const SHIFTED_DIGITS = ")!@#$%^&*(";
const HID_PUNCTUATION: ReadonlyArray<readonly [plain: string, shifted: string, usage: number]> = [
  ["-", "_", 0x2d],
  ["=", "+", 0x2e],
  ["[", "{", 0x2f],
  ["]", "}", 0x30],
  ["\\", "|", 0x31],
  [";", ":", 0x33],
  ["'", '"', 0x34],
  ["`", "~", 0x35],
  [",", "<", 0x36],
  [".", ">", 0x37],
  ["/", "?", 0x38]
];

/** The US-layout keystroke that types `char`, or null for anything outside printable ASCII, tab and newline. */
function hidStrokeForChar(char: string): HidStroke | null {
  if (char.length !== 1) return null;
  const c = char.charCodeAt(0);
  if (c >= 0x61 && c <= 0x7a) return { usage: 0x04 + c - 0x61, shift: false };
  if (c >= 0x41 && c <= 0x5a) return { usage: 0x04 + c - 0x41, shift: true };
  if (c >= 0x31 && c <= 0x39) return { usage: 0x1e + c - 0x31, shift: false };
  if (char === "0") return { usage: 0x27, shift: false };
  const shiftedDigit = SHIFTED_DIGITS.indexOf(char);
  if (shiftedDigit !== -1) return { usage: shiftedDigit === 0 ? 0x27 : 0x1e + shiftedDigit - 1, shift: true };
  if (char === " ") return { usage: 0x2c, shift: false };
  if (char === "\n") return { usage: 0x28, shift: false };
  if (char === "\t") return { usage: 0x2b, shift: false };
  for (const [plain, shifted, usage] of HID_PUNCTUATION) {
    if (char === plain) return { usage, shift: false };
    if (char === shifted) return { usage, shift: true };
  }
  return null;
}

/** Keystrokes for `text`; `\r` is dropped (CRLF types one Enter), other unmappable characters are counted. */
export function textToHidStrokes(text: string): { strokes: HidStroke[]; unsupported: number } {
  const strokes: HidStroke[] = [];
  let unsupported = 0;
  for (const char of text) {
    if (char === "\r") continue;
    const stroke = hidStrokeForChar(char);
    if (stroke) strokes.push(stroke);
    else unsupported++;
  }
  return { strokes, unsupported };
}

// ---------------------------------------------------------------------------
// Android: KeyEvent keycodes and meta state
// ---------------------------------------------------------------------------

const ANDROID_KEYCODE_BY_CODE: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Comma: 55,
  Period: 56,
  Tab: 61,
  Space: 62,
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Backquote: 68,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  PageUp: 92,
  PageDown: 93,
  Escape: 111,
  Delete: 112,
  Home: 122,
  End: 123,
  Insert: 124
};

/** Android keycode for a physical key (`KeyboardEvent.code`), or null when unmapped. */
function androidKeycodeForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 29 + (code.charCodeAt(3) - 65);
  if (/^Digit[0-9]$/.test(code)) return 7 + (code.charCodeAt(5) - 48);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return 131 + Number(fn[1]) - 1;
  return ANDROID_KEYCODE_BY_CODE[code] ?? null;
}

const META_SHIFT_ON = 0x1;
const META_ALT_ON = 0x2;
const META_CTRL_ON = 0x1000;
const META_META_ON = 0x10000;

function androidMetaState(event: KeyboardEventLike): number {
  return (
    (event.shiftKey ? META_SHIFT_ON : 0) |
    (event.altKey ? META_ALT_ON : 0) |
    (event.ctrlKey ? META_CTRL_ON : 0) |
    (event.metaKey ? META_META_ON : 0)
  );
}

// ---------------------------------------------------------------------------
// One keyboard event to one device action
// ---------------------------------------------------------------------------

export type DeviceKeyAction =
  /** serve-sim `0x06`; `key` lets the simulator type the character when its hardware keyboard is off. */
  | { readonly kind: "hid"; readonly type: KeyPhase; readonly usage: number; readonly key?: string }
  /** serve-emu `{type:"key"}`. */
  | { readonly kind: "android-key"; readonly action: KeyPhase; readonly keycode: number; readonly metaState: number }
  /** serve-emu `{type:"text"}`: printable characters go through the IME path so any layout types correctly. */
  | { readonly kind: "text"; readonly text: string }
  /** Escape is Back on Android. */
  | { readonly kind: "button"; readonly button: "back" };

const isPrintable = (key: string) => [...key].length === 1 && key !== "\u007f";

export function mapKeyboardEvent(
  platform: DevicePlatform,
  event: KeyboardEventLike,
  phase: KeyPhase
): DeviceKeyAction | null {
  if (platform === "ios") {
    const usage = hidUsageForCode(event.code);
    if (usage === null) return null;
    return isPrintable(event.key) && phase === "down"
      ? { kind: "hid", type: phase, usage, key: event.key }
      : { kind: "hid", type: phase, usage };
  }
  const chord = event.ctrlKey || event.metaKey || event.altKey;
  if (event.key === "Escape" && !chord) return phase === "down" ? { kind: "button", button: "back" } : null;
  if (!chord && isPrintable(event.key)) return phase === "down" ? { kind: "text", text: event.key } : null;
  const keycode = androidKeycodeForCode(event.code);
  if (keycode === null) return null;
  return { kind: "android-key", action: phase, keycode, metaState: androidMetaState(event) };
}

// ---------------------------------------------------------------------------
// Text chunking (serve-emu)
// ---------------------------------------------------------------------------

/** serve-emu `input.js` MAX_TEXT_BYTES truncates longer text packets. */
const ANDROID_MAX_TEXT_BYTES = 300;
/** Well under serve-emu's per-client input queue depth (128); the rest is dropped. */
const ANDROID_MAX_TEXT_CHUNKS = 64;

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Split `text` into packets within serve-emu's UTF-8 byte and queue limits
 * without splitting a code point; `truncated` says text was dropped.
 */
export function chunkText(
  text: string
): { chunks: string[]; truncated: boolean } {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of text) {
    const characterBytes = utf8ByteLength(character.codePointAt(0)!);
    if (chunkBytes + characterBytes > ANDROID_MAX_TEXT_BYTES) {
      chunks.push(chunk);
      if (chunks.length >= ANDROID_MAX_TEXT_CHUNKS) return { chunks, truncated: true };
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) {
    if (chunks.length >= ANDROID_MAX_TEXT_CHUNKS) return { chunks, truncated: true };
    chunks.push(chunk);
  }
  return { chunks, truncated: false };
}
