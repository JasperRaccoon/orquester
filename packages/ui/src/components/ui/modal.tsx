import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { useKeyboardLayer } from "../../hooks/use-keyboard-layer";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}

/** Centered modal dialog rendered in a portal; closes on backdrop click / Escape. */
export const Modal: React.FC<ModalProps> = ({ open, onClose, children, className }) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // What had focus when the modal opened. Read while rendering, before the
  // dialog mounts: a field inside it autofocuses before any effect runs.
  const openerRef = useRef<HTMLElement | null>(null);
  if (!open) {
    openerRef.current = null;
  } else if (openerRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  // Give focus back to what opened the modal (the WAI-ARIA dialog pattern). A
  // modal that closed leaving focus on <body> hands the next bare Escape to
  // the visible chat, which interrupts its running turn. Decided a tick after
  // the close: a StrictMode rehearsal leaves the dialog in place (nothing to
  // do), a caller that moved focus on purpose keeps it, and an opener that is
  // gone (the card a Delete removed) is not revived.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    const opener = openerRef.current;
    return () => {
      setTimeout(() => {
        if (dialog?.isConnected) return;
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      }, 0);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  // A keyboard layer while open: Escape is the modal's to close, never a
  // running chat turn's to interrupt (`lib/keyboard-layers.ts`).
  useKeyboardLayer(open);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="app-no-drag fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 sm:p-6"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "flex max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl",
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
};

export const ModalCloseButton: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <button
    type="button"
    aria-label="Close"
    onClick={onClose}
    className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
  >
    <X size={16} />
  </button>
);
