/**
 * The phone's sheet (workflows spec §7.4): slides up from the bottom, a drag
 * handle to pull it down, a header, a body that scrolls, an optional footer.
 * `size="full"` is the inspector's full-height sheet; `"auto"` fits its
 * content (menus, pickers).
 *
 * A fixed overlay, so it keeps itself above the soft keyboard — it is laid out
 * inside the VISUAL viewport (`useVisualViewportBox`) and scrolls the focused
 * field into view — and pads its own bottom safe-area inset (the app-shell
 * rule, AGENTS.md). An open layer (`useOpenLayer`) and a keyboard surface
 * while it shows: Escape and the phone's Back button close it.
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useOpenLayer } from "../../../hooks/use-open-layer";
import { cn } from "../../../lib/cn";
import { openTrackedLayer } from "../../../lib/open-layers";
import { KEYBOARD_SURFACE_PROPS } from "../../../lib/keyboard-surfaces";
import { pushBackClose } from "./back-close";
import { PhoneLayoutContext } from "./phone-context";
import { useVisualViewportBox } from "./use-visual-viewport";

export interface WorkflowSheetProps {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  /** The header's title (else `label`); `null` for no header row. */
  title?: React.ReactNode | null;
  subtitle?: React.ReactNode;
  /** Beside the title (a tile, an icon). */
  leading?: React.ReactNode;
  /** Right of the title, before the close button. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "full" | "auto";
  /** Draw the close button (the drag handle, Escape and Back close it anyway). */
  closeButton?: boolean;
  bodyClassName?: string;
  /** The body scrolls itself (default) — or its child does (an inspector with its own scroll). */
  scroll?: boolean;
  /** Stacked over another sheet. */
  level?: 0 | 1 | 2;
  children: React.ReactNode;
}

const DISMISS_PX = 96;

export const WorkflowSheet: React.FC<WorkflowSheetProps> = (props) => {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<SheetFrame {...props} />, document.body);
};

const SheetFrame: React.FC<WorkflowSheetProps> = ({
  open,
  onClose,
  label,
  title,
  subtitle,
  leading,
  actions,
  footer,
  size = "auto",
  closeButton = true,
  bodyClassName,
  scroll = true,
  level = 0,
  children
}) => {
  // Mounted only while open; holds its layer with that state.
  useOpenLayer(open);
  // Its place among the open layers: a dropdown or menu opened inside it is newer, and owns Escape.
  const tracked = useRef<{ release: () => void; isTopmost: () => boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const layer = openTrackedLayer();
    tracked.current = layer;
    return () => {
      layer.release();
      if (tracked.current === layer) tracked.current = null;
    };
  }, [open]);
  const box = useVisualViewportBox(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [drag, setDrag] = useState<{ start: number; dy: number } | null>(null);

  // Escape (unless something inside took it) and Back close it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const sheets = document.querySelectorAll("[data-wf-sheet]");
      if (sheets[sheets.length - 1] !== sheetRef.current) return; // only the topmost
      if (tracked.current && !tracked.current.isTopmost()) return; // a layer above it (a dropdown) takes it
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

  // The focused field stays in view as the keyboard comes and goes.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !sheetRef.current?.contains(active) || active === sheetRef.current) return;
    const frame = requestAnimationFrame(() => active.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [box.height, box.top]);

  const onFocusIn = (event: React.FocusEvent): void => {
    const target = event.target as HTMLElement;
    setTimeout(() => {
      if (document.activeElement === target) target.scrollIntoView?.({ block: "nearest" });
    }, 280);
  };

  // Pull the handle down to close.
  const grab = {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, a")) return;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      setDrag({ start: event.clientY, dy: 0 });
    },
    onPointerMove: (event: React.PointerEvent) => {
      setDrag((current) => (current ? { ...current, dy: Math.max(0, event.clientY - current.start) } : current));
    },
    onPointerUp: () => {
      setDrag((current) => {
        if (current && current.dy > DISMISS_PX) setTimeout(() => closeRef.current(), 0);
        return null;
      });
    },
    onPointerCancel: () => setDrag(null)
  };

  const gap = box.keyboard ? 8 : size === "full" ? 40 : 56;
  const heading = title === undefined ? label : title;

  return (
    <div
      className="fixed inset-x-0 z-[110] flex flex-col justify-end overflow-hidden"
      style={{ top: box.top, height: box.height || "100%", zIndex: 110 + level * 2 }}
    >
      <div
        aria-hidden
        className="wf-sheet-backdrop absolute inset-0 bg-black/55"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-wf-sheet=""
        {...KEYBOARD_SURFACE_PROPS}
        onFocus={onFocusIn}
        className={cn(
          "wf-sheet wf-touch relative flex w-full min-h-0 flex-col rounded-t-2xl border-t border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/50",
          drag === null && "transition-transform duration-200 ease-out motion-reduce:transition-none"
        )}
        style={{
          maxHeight: `calc(100% - ${gap}px)`,
          ...(size === "full" ? { height: `calc(100% - ${gap}px)` } : {}),
          transform: drag ? `translateY(${drag.dy}px)` : undefined,
          paddingBottom: box.keyboard ? 0 : "env(safe-area-inset-bottom)"
        }}
      >
        <div className="shrink-0 touch-none select-none" {...grab}>
          <div className="flex justify-center pb-1 pt-2">
            <span aria-hidden className="h-1 w-10 rounded-full bg-neutral-700" />
          </div>
          {heading !== null ? (
            <div className="flex min-h-12 items-center gap-3 px-4 pb-2">
              {leading}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold leading-5 text-neutral-50">{heading}</div>
                {subtitle ? <div className="truncate text-xs leading-4 text-neutral-500">{subtitle}</div> : null}
              </div>
              {actions}
              {closeButton ? (
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  className="-mr-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                >
                  <X size={18} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <PhoneLayoutContext.Provider value={true}>
          <div
            ref={bodyRef}
            className={cn("min-h-0 flex-1", scroll ? "overflow-y-auto overscroll-contain" : "flex flex-col overflow-hidden", bodyClassName)}
          >
            {children}
          </div>
          {footer ? <div className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-4 py-3">{footer}</div> : null}
        </PhoneLayoutContext.Provider>
      </div>
    </div>
  );
};

/** One tappable row of an action sheet. */
export interface SheetAction {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onSelect: () => void;
}

/** A list of actions in an auto-height sheet (a step's ⋯ menu, the editor's overflow). */
export const ActionSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  label: string;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  leading?: React.ReactNode;
  actions: readonly (SheetAction | "separator")[];
  level?: 0 | 1 | 2;
}> = ({ open, onClose, label, title, subtitle, leading, actions, level }) => (
  <WorkflowSheet open={open} onClose={onClose} label={label} title={title} subtitle={subtitle} leading={leading} level={level}>
    <div role="menu" aria-label={label} className="px-2 pb-3">
      {actions.map((action, index) =>
        action === "separator" ? (
          <div key={`sep-${index}`} className="mx-2 my-1.5 h-px bg-neutral-800" />
        ) : (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            disabled={action.disabled}
            onClick={() => {
              onClose();
              action.onSelect();
            }}
            className={cn(
              "flex min-h-12 w-full items-center gap-3.5 rounded-xl px-3 py-2 text-left transition-colors",
              "active:bg-neutral-800 hover:bg-neutral-900 focus:outline-none focus-visible:bg-neutral-900",
              "disabled:pointer-events-none disabled:opacity-40",
              action.tone === "danger" ? "text-danger" : "text-neutral-100"
            )}
          >
            {action.icon ? (
              <span
                aria-hidden
                className={cn("flex h-5 w-5 shrink-0 items-center justify-center", action.tone === "danger" ? "text-danger" : "text-neutral-400")}
              >
                {action.icon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] leading-5">{action.label}</span>
              {action.hint ? <span className="block text-xs leading-4 text-neutral-500">{action.hint}</span> : null}
            </span>
          </button>
        )
      )}
    </div>
  </WorkflowSheet>
);
