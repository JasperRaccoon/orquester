/**
 * A code, shell or prompt editor full screen on a phone (workflows spec
 * §7.4): the editor fills the visible screen — laid out in the visual
 * viewport, so the soft keyboard never covers the line being typed — with the
 * key bar over the keyboard. A fixed overlay: it pads its own safe-area
 * insets. Escape, Back and Done close it (the edit is already saved: every
 * keystroke is).
 */

import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

import { useOpenLayer } from "../../../hooks/use-open-layer";
import { KEYBOARD_SURFACE_PROPS } from "../../../lib/keyboard-surfaces";
import { pushBackClose } from "./back-close";
import { KeyBar } from "./KeyBar";
import { PhoneLayoutContext } from "./phone-context";
import { useVisualViewportBox } from "./use-visual-viewport";

export interface FullScreenEditorProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Offer the `{{ }}` key (templates); code and shell scripts have none. */
  templates?: boolean;
  /** Render the editor for the height it has. */
  children: (height: number) => React.ReactNode;
}

const HEADER = 52;
const KEYBAR = 53;

export const FullScreenEditor: React.FC<FullScreenEditorProps> = (props) => {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<Frame {...props} />, document.body);
};

const Frame: React.FC<FullScreenEditorProps> = ({ open, onClose, title, subtitle, templates = true, children }) => {
  // Mounted only while open; holds its layer with that state.
  useOpenLayer(open);
  const box = useVisualViewportBox(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const release = pushBackClose(() => closeRef.current());
    return () => {
      document.removeEventListener("keydown", onKey);
      release();
    };
  }, []);
  const insetTop = box.top === 0 ? "env(safe-area-inset-top)" : "0px";
  const insetBottom = box.keyboard ? "0px" : "env(safe-area-inset-bottom)";
  const editorHeight = Math.max(120, box.height - HEADER - KEYBAR - (box.keyboard ? 0 : 34));
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      {...KEYBOARD_SURFACE_PROPS}
      className="wf-touch fixed inset-x-0 z-[130] flex flex-col bg-neutral-950 text-neutral-100"
      style={{ top: box.top, height: box.height || "100%", paddingTop: insetTop, paddingBottom: insetBottom }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4" style={{ height: HEADER }}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold leading-5">{title}</div>
          {subtitle ? <div className="truncate text-xs text-neutral-500">{subtitle}</div> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 inline-flex h-10 items-center gap-1.5 rounded-full bg-neutral-100 px-4 text-sm font-semibold text-neutral-900 active:bg-neutral-300"
        >
          <Check size={15} aria-hidden />
          Done
        </button>
      </div>
      <PhoneLayoutContext.Provider value={true}>
        <div className="wf-fullscreen-editor min-h-0 flex-1 overflow-hidden" onKeyDown={(event) => event.stopPropagation()}>
          {children(editorHeight)}
        </div>
      </PhoneLayoutContext.Provider>
      <KeyBar templates={templates} />
    </div>
  );
};
