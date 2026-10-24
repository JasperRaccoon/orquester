import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useBackClose } from "../../hooks/use-back-close";
import { cn } from "../../lib/cn";
import { openTrackedLayer } from "../../lib/open-layers";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * Open modals in the order they opened. Every modal listens for Escape on
 * `document`, and a listener cannot stop another one on the same node, so a
 * dialog opened from inside another (a confirm inside Settings) would close
 * both on one keypress; only the topmost acts on it.
 */
const escapeStack: object[] = [];

/**
 * Centered modal dialog rendered in a portal; closes on backdrop click / Escape.
 * An open layer while it is up (`openTrackedLayer`), so the app-level key
 * handlers that run before its `document` listener leave its Escape to it.
 *
 * Its Escape is its own only while it is the newest open layer: a menu opened
 * inside it, or an editor drawn over it that is not a `Modal` (the agent-config
 * editor over Settings), takes that Escape and the modal stays. Which layer is
 * newest is read in the capture phase, before any handler runs — a menu that
 * closes on the same key has already let go of its layer by the time the
 * bubbling listener here runs.
 *
 * On a phone, Back closes it too (`useBackClose`): one modal at a time, the
 * newest first.
 */
export const Modal: React.FC<ModalProps> = ({ open, onClose, children, className }) => {
  const layerRef = useRef<{ release: () => void; isTopmost: () => boolean } | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const layer = openTrackedLayer();
    layerRef.current = layer;
    return () => {
      layer.release();
      if (layerRef.current === layer) layerRef.current = null;
    };
  }, [open]);
  useBackClose(open, onClose);
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
  const escapeToken = useRef({});
  // Keyed on `open` alone: `onClose` is usually a fresh closure each render,
  // and re-registering on every parent render would reorder the stack.
  useEffect(() => {
    if (!open) return undefined;
    const token = escapeToken.current;
    escapeStack.push(token);
    return () => {
      const at = escapeStack.lastIndexOf(token);
      if (at >= 0) escapeStack.splice(at, 1);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      return;
    }
    let newestAtPress = false;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key === "Escape") newestAtPress = layerRef.current?.isTopmost() ?? false;
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" &&
      newestAtPress &&
      escapeStack[escapeStack.length - 1] === escapeToken.current &&
      onClose();
    document.addEventListener("keydown", onCapture, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onCapture, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

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
