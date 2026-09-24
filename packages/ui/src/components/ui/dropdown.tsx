import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useKeyboardLayer } from "../../hooks/use-keyboard-layer";
import {
  dropdownDismissSubscription,
  dropdownFocusTarget,
  dropdownHorizontalPosition,
  dropdownPanelAttributes,
  dropdownPanelMaxWidth,
  type DropdownRole
} from "./dropdown-logic";

export interface DropdownProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  /** Tailwind width class for the panel. */
  width?: string;
  className?: string;
  /**
   * Also open on hover, for a panel that is a *readout* rather than a menu —
   * reading it is a glance, not a decision, and requiring a click costs one
   * interaction for information the pointer is already next to.
   *
   * Off by default, so every existing menu keeps click-only behaviour. Only a
   * **mouse** opens it (`pointerType === "mouse"`): on touch, `pointerenter`
   * fires on tap and would make the first tap open and the second close.
   * Click still works, and the panel stays open while the pointer is inside it
   * so its own controls remain reachable.
   * *T3: `apps/web/src/components/chat/ContextWindowMeter.tsx:39-42` —
   * `openOnHover delay={150} closeDelay={150}`.*
   */
  openOnHover?: boolean;
  /** Hover dwell before opening. T3's value; a shorter one opens on a pass-by. */
  hoverOpenDelay?: number;
  /** Grace after the pointer leaves, so the gap to the panel is crossable. */
  hoverCloseDelay?: number;
  /**
   * What the panel announces itself as: a `menu` (the default, unchanged), or
   * a `dialog` for a panel holding a readout and plain buttons rather than
   * menu items — the goal popover (goals §8.2). The trigger then says it opens
   * a dialog.
   */
  role?: DropdownRole;
  /** The panel's accessible name. */
  ariaLabel?: string;
  /**
   * Move focus into the panel when it opens — its first control, else the
   * panel itself — and give it back to the trigger when the panel closes from
   * the keyboard or from one of its own controls (an outside click leaves
   * focus where the click put it). Off by default: every existing menu keeps
   * its focus behaviour.
   */
  focusOnOpen?: boolean;
  /**
   * Extra classes for the trigger `<button>`: a focus ring, or `min-w-0
   * shrink` so a trigger in a crowded flex row may shrink below its content
   * (its own content then truncates) — the goal chip in a 360 px status line.
   */
  triggerClassName?: string;
  /**
   * Subscribe to the event that closes an open panel, e.g.
   * `dismissWhenChatTabLeaves(sessionId)`: a chat tab's popover must not
   * outlive its own tab being on screen, and must not close when that tab is
   * the one being activated. Called with the dismiss; returns its unsubscribe.
   * Focus is not moved back to the trigger — it lives in the tab just left.
   */
  dismissOn?: (dismiss: () => void) => () => void;
}

interface DropdownContextValue {
  close: () => void;
}

/** Shared so menu items work inside both the Dropdown and the mobile BottomSheet. */
export const DropdownContext = React.createContext<DropdownContextValue>({
  close: () => undefined
});

/** Fixed-viewport coordinates for the portaled panel. */
interface PanelPosition {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
  maxWidth: number;
}

const GAP = 4;
const MARGIN = 8;

/**
 * Lightweight popover menu. The panel is rendered in a portal on `document.body`
 * with fixed positioning derived from the trigger, so it never gets clipped or
 * pushed around by `overflow`/flex ancestors (e.g. the scrollable tab strip).
 * Closes on outside click or Escape.
 *
 * Open, it is a keyboard layer (`lib/keyboard-layers.ts`): Escape is its to
 * close, so the chat's capture-phase listeners stand down instead of
 * interrupting a running turn. It flips vertically when there is no room
 * below, and a panel that would leave the viewport sideways is clamped back
 * inside (`dropdownHorizontalPosition`).
 */
export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  children,
  align = "left",
  width = "w-56",
  className,
  openOnHover = false,
  hoverOpenDelay = 150,
  hoverCloseDelay = 150,
  role,
  ariaLabel,
  focusOnOpen = false,
  triggerClassName,
  dismissOn
}) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Close from the keyboard or from one of the panel's own controls. A panel
   * that took focus gives it back to its trigger — never stranded on a control
   * that has just disappeared. (An outside click closes without this: focus
   * goes where the click put it.)
   */
  const close = useCallback(() => {
    setOpen(false);
    if (focusOnOpen) triggerRef.current?.focus({ preventScroll: true });
  }, [focusOnOpen]);

  // Open, it is a keyboard layer: Escape is this panel's to close, so the
  // chat's capture-phase listeners stand down (`lib/keyboard-layers.ts`).
  useKeyboardLayer(open);

  // Closed from outside (the caller's `dismissOn`): no focus move — the
  // trigger belongs to whatever just went off screen.
  const dismissQuietly = useCallback(() => setOpen(false), []);
  useEffect(
    () => dropdownDismissSubscription(open, dismissOn, dismissQuietly),
    [open, dismissOn, dismissQuietly]
  );

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  // A pending open/close must not outlive the component, or it fires against a
  // dead setState after the panel's owner unmounts (a chat tab closing).
  useEffect(() => cancelHoverTimer, [cancelHoverTimer]);

  const scheduleHover = useCallback(
    (next: boolean, delay: number) => {
      cancelHoverTimer();
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        setOpen(next);
      }, delay);
    },
    [cancelHoverTimer]
  );

  const hoverProps = openOnHover
    ? {
        onPointerEnter: (event: React.PointerEvent) => {
          if (event.pointerType !== "mouse") return;
          scheduleHover(true, hoverOpenDelay);
        },
        onPointerLeave: (event: React.PointerEvent) => {
          if (event.pointerType !== "mouse") return;
          scheduleHover(false, hoverCloseDelay);
        }
      }
    : {};

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    // Flip upward when there isn't room below (e.g. the sidebar-footer switcher).
    const openUp = spaceBelow < 280 && spaceAbove > spaceBelow;

    const vertical = openUp
      ? { bottom: window.innerHeight - rect.top + GAP }
      : { top: rect.bottom + GAP };
    // Anchored to the trigger; clamped inside the viewport once the panel has
    // been measured (the first pass has no panel yet — `attachPanel` measures
    // it before the browser paints).
    const horizontal = dropdownHorizontalPosition({
      align,
      triggerLeft: rect.left,
      triggerRight: rect.right,
      viewportWidth: window.innerWidth,
      panelWidth: panelRef.current?.getBoundingClientRect().width ?? null,
      margin: MARGIN
    });

    setPosition({
      ...vertical,
      ...horizontal,
      maxHeight: Math.max(120, (openUp ? spaceAbove : spaceBelow) - GAP),
      maxWidth: dropdownPanelMaxWidth(window.innerWidth, MARGIN)
    });
  }, [align]);

  /**
   * The panel mounting: measure it and re-position before the browser paints
   * (a clamped panel never visibly jumps), and move focus into it when asked.
   * A new panel element mounts on every open, so this runs once per open.
   */
  const attachPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (!node) return;
      updatePosition();
      if (focusOnOpen) dropdownFocusTarget(node).focus({ preventScroll: true });
    },
    [focusOnOpen, updatePosition]
  );

  // Position before paint to avoid a flash at the wrong spot.
  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    const onReflow = () => updatePosition();

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReflow);
    // Reposition (capture phase) when any ancestor scrolls.
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [close, open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn("inline-flex app-no-drag", triggerClassName)}
        onClick={() => {
          // A click is decisive: it must not be undone by a hover timer that
          // was already in flight when the pointer arrived.
          cancelHoverTimer();
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        // A dialog says so before it opens; a menu keeps the markup it had.
        aria-haspopup={role === "dialog" ? "dialog" : undefined}
        // Marks the hover affordance in the DOM: it is the only observable
        // trace of `openOnHover` (handlers are not markup), so a render test
        // can assert the wiring, and a debugger can see why a panel opened
        // without a click.
        data-hover-open={openOnHover ? "true" : undefined}
        // The same, for a panel that takes focus when it opens.
        data-focus-on-open={focusOnOpen ? "true" : undefined}
        {...hoverProps}
      >
        {trigger}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={attachPanel}
            {...dropdownPanelAttributes({ role, ariaLabel, focusOnOpen })}
            {...hoverProps}
            style={{
              position: "fixed",
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              right: position.right,
              maxHeight: position.maxHeight,
              maxWidth: position.maxWidth
            }}
            className={cn(
              // z-[120] so the panel sits above Modal (z-[100]) / BottomSheet
              // (z-[110]) when composed inside one — matches ContextMenu/Tooltip.
              "z-[120] overflow-y-auto rounded-md border border-neutral-800",
              "bg-neutral-900 p-1 shadow-xl shadow-black/40 app-no-drag",
              focusOnOpen && "focus:outline-none",
              width,
              className
            )}
          >
            <DropdownContext.Provider value={{ close }}>{children}</DropdownContext.Provider>
          </div>,
          document.body
        )}
    </>
  );
};

export interface DropdownItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  /** Keep the menu open after activation (e.g. nested toggles). */
  keepOpen?: boolean;
}

export const DropdownItem: React.FC<DropdownItemProps> = ({
  icon,
  keepOpen,
  className,
  children,
  onClick,
  ...props
}) => {
  const { close } = React.useContext(DropdownContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-300",
        "transition-colors hover:bg-neutral-800 hover:text-neutral-100",
        "disabled:pointer-events-none disabled:opacity-40",
        className
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!keepOpen) {
          close();
        }
      }}
      {...props}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center text-neutral-500">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
    </button>
  );
};

export const DropdownLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
    {children}
  </div>
);

export const DropdownSeparator: React.FC = () => (
  <div className="my-1 h-px bg-neutral-800" />
);

export const DropdownEmpty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-2 py-1.5 text-sm italic text-neutral-600">{children}</div>
);
