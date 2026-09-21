import React from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn";

/**
 * The composer's own anchored popover.
 *
 * It exists rather than reusing `components/ui/Dropdown` for one structural
 * reason: §7.4's `data-composer-shortcut` convention needs the attribute on
 * the real `<button>`, and `Dropdown` renders its trigger button itself with
 * no way to pass props through. Here the caller renders the button, so a chip
 * that moves into an overflow menu keeps its token — and a menu absorbing two
 * controls can carry both.
 *
 * It opens **upwards** by default, because every one of its callers lives in a
 * bar pinned to the bottom of the view, and flips down only when there is no
 * room above.
 *
 * Focus: closing returns focus where the caller says, which for every composer
 * control is the composer itself — a floating layer must never leave focus
 * stranded on a button that has just disappeared.
 * *T3: `composerEventScope.ts:12-28`.*
 */

export interface ComposerPopoverTriggerProps {
  ref: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
}

export interface ComposerPopoverProps {
  renderTrigger: (props: ComposerPopoverTriggerProps) => React.ReactNode;
  /** `close` is passed in so an item can act and dismiss in one handler. */
  children: (close: () => void) => React.ReactNode;
  /** Accessible name of the panel. */
  label: string;
  align?: "start" | "end";
  /** Tailwind width class for the panel. */
  width?: string;
  /** Where focus lands on close. Defaults to the trigger. */
  returnFocusTo?: () => HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
}

interface PanelPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  maxWidth: number;
}

const GAP = 6;
const MARGIN = 8;

export function ComposerPopover({
  renderTrigger,
  children,
  label,
  align = "start",
  width = "w-64",
  returnFocusTo,
  onOpenChange
}: ComposerPopoverProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<PanelPosition | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const setOpenState = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  const close = React.useCallback(() => {
    setOpenState(false);
    const target = returnFocusTo?.() ?? triggerRef.current;
    target?.focus({ preventScroll: true });
  }, [returnFocusTo, setOpenState]);

  const updatePosition = React.useCallback(() => {
    const element = triggerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const spaceAbove = rect.top - MARGIN;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    // Upwards by default: every caller sits in a bottom-pinned bar.
    const openUp = spaceAbove >= 200 || spaceAbove >= spaceBelow;
    const maxWidth = Math.max(180, window.innerWidth - MARGIN * 2);
    // Measure the panel when it exists so an `end` alignment is exact rather
    // than a guess from the trigger's own width.
    const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 256;
    const rawLeft = align === "end" ? rect.right - panelWidth : rect.left;
    const left = Math.min(
      Math.max(MARGIN, rawLeft),
      Math.max(MARGIN, window.innerWidth - MARGIN - Math.min(panelWidth, maxWidth))
    );
    setPosition({
      left,
      ...(openUp ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      maxHeight: Math.max(140, (openUp ? spaceAbove : spaceBelow) - GAP),
      maxWidth
    });
  }, [align]);

  React.useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpenState(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The composer's own Escape interrupts a turn; a menu takes it first.
      event.stopPropagation();
      event.preventDefault();
      close();
    };
    const onReflow = () => updatePosition();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [close, open, setOpenState, updatePosition]);

  return (
    <>
      {renderTrigger({
        ref: triggerRef,
        onClick: () => (open ? close() : setOpenState(true)),
        "aria-expanded": open,
        "aria-haspopup": "menu"
      })}
      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={label}
              data-chat-composer-floating-layer="true"
              style={{
                position: "fixed",
                left: position.left,
                top: position.top,
                bottom: position.bottom,
                maxHeight: position.maxHeight,
                maxWidth: position.maxWidth
              }}
              className={cn(
                // Above the app's Modal (z-100) and BottomSheet (z-110), like
                // every other portaled panel in this codebase.
                "ac-scroll-thin z-[120] overflow-y-auto rounded-lg border border-neutral-800",
                "bg-neutral-900 p-1 shadow-xl shadow-black/40",
                width
              )}
            >
              {children(close)}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export interface ComposerMenuRowProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  selected?: boolean;
  /** The muted second line: a description, a scope, an argument hint. */
  hint?: React.ReactNode;
  /** Right-aligned trailing slot — a check, a digit, a badge. */
  trailing?: React.ReactNode;
}

/** One row inside a {@link ComposerPopover}. */
export function ComposerMenuRow({
  icon,
  selected,
  hint,
  trailing,
  className,
  children,
  ...props
}: ComposerMenuRowProps): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      data-selected={selected ? "true" : undefined}
      className={cn(
        "ac-press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
        "disabled:pointer-events-none disabled:opacity-40",
        selected
          ? "bg-neutral-800/60 text-neutral-100"
          : "text-neutral-300 hover:bg-neutral-800/50 hover:text-neutral-100",
        className
      )}
      {...props}
    >
      {icon ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{children}</span>
        {hint ? <span className="truncate text-[11px] text-neutral-500">{hint}</span> : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  );
}
