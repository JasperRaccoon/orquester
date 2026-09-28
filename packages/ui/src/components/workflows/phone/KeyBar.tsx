/**
 * The key bar (workflows spec §7.4): a row of the characters code, a shell
 * script or a prompt needs, above the soft keyboard. A key goes into the
 * focused field — a CodeMirror editor or a plain text field — at the caret,
 * without taking focus from it (so the keyboard stays up).
 */

import React, { useEffect, useRef } from "react";
import { EditorView } from "@uiw/react-codemirror";

import { cn } from "../../../lib/cn";
import { applyKeyBarKey, keyBarInsertion, keyBarKeys } from "./key-bar";

/** Insert a key into the focused editor or field; false when nothing editable is focused. */
export function insertKeyAtFocus(id: string, indent = "  "): boolean {
  const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  if (!active) return false;
  const editorRoot = active.closest?.(".cm-editor") as HTMLElement | null;
  if (editorRoot) {
    const view = EditorView.findFromDOM(editorRoot);
    if (!view) return false;
    const range = view.state.selection.main;
    if (id === "expr" && !range.empty) {
      const inner = view.state.sliceDoc(range.from, range.to);
      const text = `{{ ${inner} }}`;
      view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length }, scrollIntoView: true, userEvent: "input" });
    } else {
      const insertion = keyBarInsertion(id, indent);
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: insertion.text },
        selection: { anchor: range.from + insertion.caret },
        scrollIntoView: true,
        userEvent: "input"
      });
    }
    view.focus();
    return true;
  }
  if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|url|)$/.test(active.type))) {
    const from = active.selectionStart ?? active.value.length;
    const to = active.selectionEnd ?? from;
    const next = applyKeyBarKey(active.value, from, to, id, indent);
    active.setRangeText(next.text.slice(Math.min(from, to), next.text.length - (active.value.length - Math.max(from, to))), Math.min(from, to), Math.max(from, to), "end");
    active.setSelectionRange(next.selection, next.selection);
    active.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

export const KeyBar: React.FC<{ templates?: boolean; indent?: string; className?: string }> = ({ templates = true, indent = "  ", className }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const keys = keyBarKeys({ templates });

  // A touch must not take focus from the editor (the keyboard would drop):
  // the touch is taken whole, and the key goes in on its release.
  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    let pressed: string | null = null;
    let moved = false;
    let startX = 0;
    const keyOf = (target: EventTarget | null): string | null =>
      ((target as HTMLElement | null)?.closest?.("[data-key-id]") as HTMLElement | null)?.dataset.keyId ?? null;
    const onTouchStart = (event: TouchEvent): void => {
      pressed = keyOf(event.target);
      moved = false;
      startX = event.touches[0]?.clientX ?? 0;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (Math.abs((event.touches[0]?.clientX ?? 0) - startX) > 8) moved = true;
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (pressed && !moved) {
        event.preventDefault();
        insertKeyAtFocus(pressed, indent);
      }
      pressed = null;
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (keyOf(event.target)) event.preventDefault();
    };
    bar.addEventListener("touchstart", onTouchStart, { passive: true });
    bar.addEventListener("touchmove", onTouchMove, { passive: true });
    bar.addEventListener("touchend", onTouchEnd, { passive: false });
    bar.addEventListener("mousedown", onMouseDown);
    return () => {
      bar.removeEventListener("touchstart", onTouchStart);
      bar.removeEventListener("touchmove", onTouchMove);
      bar.removeEventListener("touchend", onTouchEnd);
      bar.removeEventListener("mousedown", onMouseDown);
    };
  }, [indent]);

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Symbols"
      className={cn("flex shrink-0 gap-1 overflow-x-auto border-t border-neutral-800 bg-neutral-900 px-1.5 py-1.5 [scrollbar-width:none]", className)}
    >
      {keys.map((key) => (
        <button
          key={key.id}
          type="button"
          tabIndex={-1}
          data-key-id={key.id}
          aria-label={key.title}
          title={key.title}
          onClick={() => insertKeyAtFocus(key.id, indent)}
          className={cn(
            "flex h-10 shrink-0 items-center justify-center rounded-lg bg-neutral-800 font-mono text-[15px] text-neutral-100 shadow-sm shadow-black/20 active:bg-neutral-700",
            key.id === "tab" || key.id === "expr" ? "min-w-[52px] px-2.5 font-sans text-[13px] font-medium" : "min-w-[38px] px-1"
          )}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
};
