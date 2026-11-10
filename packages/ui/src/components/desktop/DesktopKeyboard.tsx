import React, { useEffect, useRef, useState } from "react";
import { ClipboardPaste, KeyboardOff } from "lucide-react";
import type { LatchSet } from "../../lib/modifier-latch";
import { KEY_BAR_KEY_CLASS, KeyBarButton, LatchKeyButton } from "../ui/key-bar";
import { LATCH_MODIFIERS, XK, functionKeysym, keysymForNamedKey, type LatchModifier } from "./desktop-keys";

/**
 * Wire the touch keyboard's hidden input: text and IME output → `onText`,
 * non-text keys (Backspace, Enter, arrows…) and modifier chords from a
 * hardware keyboard → `onKey`.
 *
 * Native listeners rather than React's synthetic ones, for the reason spelled
 * out in `BrowserView`: Android soft keyboards deliver letters through
 * input/composition events only, and React's onBeforeInput polyfill drops them.
 * The field is cleared after every forward, so Backspace on an empty field is
 * always a real keydown.
 */
export function useDesktopHiddenInput(
  inputRef: React.RefObject<HTMLInputElement | null>,
  onText: (text: string) => void,
  onKey: (keysym: number, modifiers: LatchModifier[]) => void
): void {
  const textRef = useRef(onText);
  const keyRef = useRef(onKey);
  textRef.current = onText;
  keyRef.current = onKey;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    let composing = false;
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Unidentified" || e.keyCode === 229) return; // IME noise
      // The paste chord must stay a browser paste: the view's paste handler
      // sends the text to the desktop and then Ctrl+V.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
      const modifiers: LatchModifier[] = [];
      if (e.shiftKey) modifiers.push("shift");
      if (e.ctrlKey) modifiers.push("ctrl");
      if (e.altKey) modifiers.push("alt");
      if (e.metaKey) modifiers.push("super");
      const named = keysymForNamedKey(e.key);
      if (named !== null) {
        e.preventDefault();
        keyRef.current(named, modifiers);
        return;
      }
      if (e.key.length === 1 && (e.ctrlKey || e.altKey || e.metaKey)) {
        // A chord (Ctrl+C on a tablet keyboard) inserts no text: send it here.
        e.preventDefault();
        const cp = e.key.toLowerCase().codePointAt(0);
        if (cp !== undefined && cp >= 0x20 && cp <= 0xff) keyRef.current(cp, modifiers);
      }
    };
    const input = (e: Event) => {
      if (composing || (e as InputEvent).isComposing) return;
      if (el.value) {
        textRef.current(el.value);
        el.value = "";
      }
    };
    const compStart = () => {
      composing = true;
    };
    const compEnd = (e: CompositionEvent) => {
      composing = false;
      const text = e.data || el.value;
      if (text) textRef.current(text);
      el.value = "";
    };
    const blur = () => {
      el.value = "";
      composing = false;
    };
    el.addEventListener("keydown", keydown);
    el.addEventListener("input", input);
    el.addEventListener("compositionstart", compStart);
    el.addEventListener("compositionend", compEnd);
    el.addEventListener("blur", blur);
    return () => {
      el.removeEventListener("keydown", keydown);
      el.removeEventListener("input", input);
      el.removeEventListener("compositionstart", compStart);
      el.removeEventListener("compositionend", compEnd);
      el.removeEventListener("blur", blur);
    };
  }, [inputRef]);
}

type BarKey = { label: string; aria: string; keysym: number };

const EDIT_KEYS: BarKey[] = [
  { label: "Esc", aria: "Escape", keysym: XK.Escape },
  { label: "Tab", aria: "Tab", keysym: XK.Tab }
];

const ARROWS: BarKey[] = [
  { label: "←", aria: "Left arrow", keysym: XK.Left },
  { label: "↑", aria: "Up arrow", keysym: XK.Up },
  { label: "↓", aria: "Down arrow", keysym: XK.Down },
  { label: "→", aria: "Right arrow", keysym: XK.Right }
];

const NAVIGATION: BarKey[] = [
  { label: "Home", aria: "Home", keysym: XK.Home },
  { label: "End", aria: "End", keysym: XK.End },
  { label: "PgUp", aria: "Page up", keysym: XK.Page_Up },
  { label: "PgDn", aria: "Page down", keysym: XK.Page_Down }
];

const FUNCTION_KEYS: BarKey[] = Array.from({ length: 12 }, (_, i) => ({
  label: `F${i + 1}`,
  aria: `F${i + 1}`,
  keysym: functionKeysym(i + 1)
}));

const MODIFIER_LABEL: Record<LatchModifier, string> = { shift: "Shift", ctrl: "Ctrl", alt: "Alt", super: "Super" };

const Divider = () => <span aria-hidden className="mx-0.5 w-px shrink-0 self-stretch bg-neutral-800" />;

/**
 * The desktop's touch key bar (spec 2026-11-10 R3.3): `Esc Tab | Shift Ctrl Alt
 * Super | ← ↑ ↓ → | Home End PgUp PgDn | Fn ▸ | Alt+Tab Ctrl+Alt+Del | Paste |
 * Hide`, in the terminal key bar's look. Modifiers latch for the next key or
 * click (one tap armed, a quick second tap locked). Keys act on pointerdown
 * with preventDefault so the hidden input keeps focus and the soft keyboard
 * stays up; Paste reads the clipboard on its click, inside the gesture.
 */
export const DesktopKeyBar: React.FC<{
  latches: LatchSet<LatchModifier>;
  onTapModifier: (modifier: LatchModifier, timeStamp: number) => void;
  /** Press `keysym` with the latched modifiers and `extra` held. */
  onKey: (keysym: number, extra?: LatchModifier[]) => void;
  onCtrlAltDel: () => void;
  onPaste: () => void;
  onHide: () => void;
}> = ({ latches, onTapModifier, onKey, onCtrlAltDel, onPaste, onHide }) => {
  const [fnOpen, setFnOpen] = useState(false);
  const key = (k: BarKey) => <KeyBarButton key={k.aria} label={k.label} ariaLabel={k.aria} onPress={() => onKey(k.keysym)} />;
  return (
    <div className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-t border-neutral-800 bg-neutral-900 px-2 py-1.5" role="toolbar" aria-label="Desktop keys" data-desktop-handoff="">
      {EDIT_KEYS.map(key)}
      <Divider />
      {LATCH_MODIFIERS.map((m) => (
        <LatchKeyButton key={m} label={MODIFIER_LABEL[m]} state={latches[m].state} onTap={(at) => onTapModifier(m, at)} />
      ))}
      <Divider />
      {ARROWS.map(key)}
      <Divider />
      {NAVIGATION.map(key)}
      <Divider />
      <KeyBarButton
        label={fnOpen ? "Fn ◂" : "Fn ▸"}
        ariaLabel={fnOpen ? "Hide function keys" : "Show function keys"}
        pressed={fnOpen}
        onPress={() => setFnOpen((open) => !open)}
      />
      {fnOpen && FUNCTION_KEYS.map(key)}
      <Divider />
      <KeyBarButton label="Alt+Tab" ariaLabel="Alt+Tab" onPress={() => onKey(XK.Tab, ["alt"])} />
      <KeyBarButton label="Ctrl+Alt+Del" ariaLabel="Ctrl+Alt+Delete" onPress={onCtrlAltDel} />
      <Divider />
      <button
        type="button"
        aria-label="Paste from this device's clipboard"
        // preventDefault on pointerdown keeps the keyboard up; the clipboard
        // read runs on click, still inside the gesture's user activation.
        onPointerDown={(e) => e.preventDefault()}
        onClick={onPaste}
        className={KEY_BAR_KEY_CLASS}
      >
        <ClipboardPaste size={16} />
      </button>
      <button type="button" aria-label="Hide keyboard" onClick={onHide} className={KEY_BAR_KEY_CLASS}>
        <KeyboardOff size={16} />
      </button>
    </div>
  );
};
