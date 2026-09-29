/**
 * Where an agent-profile editor sits: a centred dialog on desktop (up to
 * 720 px wide, its body scrolling), and on a phone a full-screen sheet laid
 * out inside the VISUAL viewport, so its sticky header and Save bar stay above
 * the soft keyboard (the workflows editor's rule, `useVisualViewportBox`).
 *
 * A fixed overlay, so it pads its own safe-area insets. An open layer while it
 * shows (`useOpenLayer`) and a keyboard surface (`aria-modal`): the chat
 * stands down for its keys. Its Escape — unless something inside took it, or a
 * newer layer sits above it — asks to close (the unsaved-changes guard), and
 * says so with `preventDefault()`. On a phone the Back button asks the same.
 *
 * The discard confirmation is drawn inside the dialog rather than as a second
 * modal, so there is only ever one layer and one Escape listener to agree.
 *
 * Focus: the dialog takes it when nothing inside did (an edit, a phone —
 * fields autofocus only on a desktop create), so Tab and the screen reader
 * start in the editor rather than behind it; and it goes back to what opened
 * the editor when it closes. The opener is read while RENDERING, before the
 * editor mounts — a field inside autofocuses during the commit, before any
 * effect of this frame runs, and would otherwise pass for the opener (then
 * nothing gets focus back, and the next bare Escape reaches the chat).
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

import { useOpenLayer } from "../../../../hooks/use-open-layer";
import { cn } from "../../../../lib/cn";
import { KEYBOARD_SURFACE_PROPS } from "../../../../lib/keyboard-surfaces";
import { openTrackedLayer } from "../../../../lib/open-layers";
import { pushBackClose } from "../../../workflows/phone/back-close";
import { useVisualViewportBox } from "../../../workflows/phone/use-visual-viewport";
import type { EditorVariant } from "./layout.logic";

interface EditorFrameProps {
  open: boolean;
  variant: EditorVariant;
  /** The dialog's accessible name. */
  label: string;
  /** Escape, the backdrop, Back. */
  onRequestClose: () => void;
  /** Ask "Discard changes?" over the editor. */
  confirmingDiscard: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  children: React.ReactNode;
}

export const EditorFrame: React.FC<EditorFrameProps> = (props) => {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<FrameBody {...props} />, document.body);
};

const FrameBody: React.FC<EditorFrameProps> = ({
  open,
  variant,
  label,
  onRequestClose,
  confirmingDiscard,
  onKeepEditing,
  onDiscard,
  children
}) => {
  // Mounted only while open; holds its layer with that state.
  useOpenLayer(open);
  const phone = variant === "phone";
  const box = useVisualViewportBox(phone);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ onRequestClose, onKeepEditing, confirmingDiscard });
  latest.current = { onRequestClose, onKeepEditing, confirmingDiscard };

  // Its place among the open layers: a menu opened inside it is newer and owns Escape.
  const tracked = useRef<{ release: () => void; isTopmost: () => boolean } | null>(null);
  useEffect(() => {
    const layer = openTrackedLayer();
    tracked.current = layer;
    return () => {
      layer.release();
      if (tracked.current === layer) tracked.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (tracked.current && !tracked.current.isTopmost()) return;
      event.preventDefault();
      if (latest.current.confirmingDiscard) latest.current.onKeepEditing();
      else latest.current.onRequestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Back asks to close; when the guard keeps the editor open, it re-arms.
  const [backArm, setBackArm] = useState(0);
  useEffect(() => {
    if (!phone) return;
    return pushBackClose(() => {
      latest.current.onRequestClose();
      setBackArm((n) => n + 1);
    });
  }, [phone, backArm]);

  // Focus goes back to what opened the editor (the row's menu, "+ Add").
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = focusOpener(document);
  useLayoutEffect(() => {
    if (needsInitialFocus(dialogRef.current, document.activeElement)) dialogRef.current?.focus({ preventScroll: true });
    return () => {
      const target = opener.current;
      setTimeout(() => {
        const now = document.activeElement;
        if (now !== null && now !== document.body) return;
        if (target?.isConnected) target.focus({ preventScroll: true });
      }, 0);
    };
  }, []);

  const confirm = confirmingDiscard ? (
    <DiscardConfirm onKeepEditing={onKeepEditing} onDiscard={onDiscard} touch={phone} />
  ) : null;

  if (phone) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        {...KEYBOARD_SURFACE_PROPS}
        className="app-no-drag fixed inset-x-0 z-[120] flex flex-col overflow-hidden bg-neutral-950 text-neutral-100 focus:outline-none"
        style={{
          top: box.top,
          height: box.height || "100%",
          paddingTop: box.top === 0 ? "env(safe-area-inset-top)" : 0,
          paddingBottom: box.keyboard ? 0 : "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)"
        }}
      >
        {children}
        {confirm}
      </div>
    );
  }

  return (
    <div
      className="app-no-drag fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onRequestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        {...KEYBOARD_SURFACE_PROPS}
        // A row, like `ui/modal.tsx`: the editor inside stretches to the height
        // this box settles on (its content's, or the fill height it asks for),
        // capped by max-height, and its body scrolls.
        className="relative flex max-h-[min(90vh,880px)] w-full max-w-[720px] overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-100 shadow-2xl focus:outline-none"
      >
        {children}
        {confirm}
      </div>
    </div>
  );
};

/** What had focus before the editor opened, to give it back: an element, never `<body>`. */
function focusOpener(doc: Pick<Document, "activeElement" | "body">): HTMLElement | null {
  const active = doc.activeElement;
  return active !== null && active !== doc.body && typeof (active as HTMLElement).focus === "function"
    ? (active as HTMLElement)
    : null;
}

/** The dialog takes focus when nothing inside it has it (no field autofocused). */
function needsInitialFocus(
  dialog: Pick<HTMLElement, "contains"> | null,
  active: Element | null
): boolean {
  return dialog !== null && (active === null || !dialog.contains(active));
}

const DiscardConfirm: React.FC<{ onKeepEditing: () => void; onDiscard: () => void; touch: boolean }> = ({
  onKeepEditing,
  onDiscard,
  touch
}) => (
  <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-4">
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="agent-profile-discard-title"
      aria-describedby="agent-profile-discard-message"
      className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-danger-500/10 text-danger">
          <AlertTriangle size={16} aria-hidden />
        </span>
        <p id="agent-profile-discard-title" className="text-sm font-medium text-neutral-100">
          Discard your changes?
        </p>
      </div>
      <p id="agent-profile-discard-message" className="text-sm text-neutral-400">
        What you changed here has not been saved.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          onClick={onKeepEditing}
          className={cn(
            "inline-flex items-center justify-center rounded-md border border-neutral-700 px-3 text-sm font-medium text-neutral-200 hover:bg-neutral-800",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500",
            touch ? "h-10" : "h-8"
          )}
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className={cn(
            "inline-flex items-center justify-center rounded-md bg-danger-600 px-3 text-sm font-medium text-white hover:bg-danger-500",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500",
            touch ? "h-10" : "h-8"
          )}
        >
          Discard
        </button>
      </div>
    </div>
  </div>
);
