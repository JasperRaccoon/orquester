import React, { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { XK, keysymForNamedKey, type LatchModifier } from "./desktop-keys";

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
      if (e.ctrlKey) modifiers.push("ctrl");
      if (e.altKey) modifiers.push("alt");
      if (e.metaKey) modifiers.push("super");
      const named = keysymForNamedKey(e.key);
      if (named !== null) {
        e.preventDefault();
        keyRef.current(named, modifiers);
        return;
      }
      if (e.key.length === 1 && modifiers.length > 0) {
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

const STRIP_KEYS: { label: string; aria: string; keysym: number }[] = [
  { label: "Esc", aria: "Escape", keysym: XK.Escape },
  { label: "Tab", aria: "Tab", keysym: XK.Tab }
];

const ARROWS: { label: string; aria: string; keysym: number }[] = [
  { label: "←", aria: "Left arrow", keysym: XK.Left },
  { label: "↑", aria: "Up arrow", keysym: XK.Up },
  { label: "↓", aria: "Down arrow", keysym: XK.Down },
  { label: "→", aria: "Right arrow", keysym: XK.Right }
];

const MODIFIERS: { id: LatchModifier; label: string }[] = [
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Alt" },
  { id: "super", label: "Super" }
];

const KEY_CLASS =
  "flex h-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-3 font-mono text-xs text-neutral-200 active:bg-neutral-700";

/**
 * The touch key strip: Esc, Tab, one-shot Ctrl/Alt/Super, arrows. Keys act on
 * pointerdown with preventDefault so the hidden input keeps focus and the soft
 * keyboard stays up (the terminal's `MobileKeyBar` does the same).
 */
export const DesktopKeyStrip: React.FC<{
  latched: ReadonlySet<LatchModifier>;
  onToggleModifier: (modifier: LatchModifier) => void;
  onKey: (keysym: number) => void;
}> = ({ latched, onToggleModifier, onKey }) => {
  const press = (fn: () => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    fn();
  };
  return (
    <div className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-t border-neutral-800 bg-neutral-900 px-2 py-1.5">
      {STRIP_KEYS.map((k) => (
        <button key={k.aria} type="button" aria-label={k.aria} className={KEY_CLASS} onPointerDown={press(() => onKey(k.keysym))}>
          {k.label}
        </button>
      ))}
      {MODIFIERS.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-label={`${m.label} (applies to the next key)`}
          aria-pressed={latched.has(m.id)}
          className={cn(KEY_CLASS, latched.has(m.id) && "bg-neutral-200 text-neutral-900 active:bg-neutral-300")}
          onPointerDown={press(() => onToggleModifier(m.id))}
        >
          {m.label}
        </button>
      ))}
      {ARROWS.map((k) => (
        <button key={k.aria} type="button" aria-label={k.aria} className={cn(KEY_CLASS, "w-9 px-0")} onPointerDown={press(() => onKey(k.keysym))}>
          {k.label}
        </button>
      ))}
    </div>
  );
};
