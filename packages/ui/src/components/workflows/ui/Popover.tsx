/**
 * The workflow editor's one floating-panel primitive: a portaled panel
 * anchored to an element or to a point (the add menu opens where the pointer
 * is), clamped into the viewport and flipped above when there is no room
 * below. It is an open layer while it shows (`useOpenLayer`), so the app's
 * key handlers leave its Escape to it; an outside press closes it too.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useOpenLayer } from "../../../hooks/use-open-layer";
import { cn } from "../../../lib/cn";

export type PopoverAnchor = { element: HTMLElement | null } | { point: { x: number; y: number } };

export interface PopoverProps {
  open: boolean;
  anchor: PopoverAnchor;
  onClose: () => void;
  children: React.ReactNode;
  /** Horizontal alignment to an element anchor. */
  align?: "start" | "end";
  className?: string;
  /** The panel's accessible role and name. */
  role?: "dialog" | "menu" | "listbox";
  ariaLabel?: string;
  /** Leave presses inside these elements alone (the trigger that toggles it). */
  ignoreOutside?: (target: Node) => boolean;
}

const MARGIN = 8;
const GAP = 6;

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
}

export const Popover: React.FC<PopoverProps> = ({
  open,
  anchor,
  onClose,
  children,
  align = "start",
  className,
  role = "dialog",
  ariaLabel,
  ignoreOutside
}) => {
  useOpenLayer(open);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The anchor as primitives, so a fresh anchor object per render does not re-place (and loop).
  const anchorEl = "element" in anchor ? anchor.element : null;
  const pointX = "point" in anchor ? anchor.point.x : null;
  const pointY = "point" in anchor ? anchor.point.y : null;

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = (): void => {
      const panel = panelRef.current;
      const width = panel?.offsetWidth ?? 280;
      const height = panel?.offsetHeight ?? 320;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      let x: number;
      let top: number;
      let bottomEdge: number;
      if (pointX !== null && pointY !== null) {
        x = pointX;
        top = pointY + GAP;
        bottomEdge = pointY - GAP;
      } else {
        const rect = anchorEl?.getBoundingClientRect();
        if (!rect) return;
        x = align === "end" ? rect.right - width : rect.left;
        top = rect.bottom + GAP;
        bottomEdge = rect.top - GAP;
      }
      const roomBelow = viewportH - top - MARGIN;
      const roomAbove = bottomEdge - MARGIN;
      let maxHeight = Math.max(160, roomBelow);
      if (height > roomBelow && roomAbove > roomBelow) {
        maxHeight = Math.max(160, roomAbove);
        top = Math.max(MARGIN, bottomEdge - Math.min(height, maxHeight));
      }
      const left = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, viewportW - width - MARGIN));
      setPlacement({ top, left, maxHeight });
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorEl, pointX, pointY, align]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    };
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (ignoreOutside?.(target)) return;
      // A menu or listbox opened from inside this panel (a Dropdown) portals elsewhere.
      if ((target as Element).closest?.('[data-wf-popover-child], [role="menu"], [role="listbox"]')) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, ignoreOutside]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      data-keyboard-surface=""
      style={{
        position: "fixed",
        top: placement?.top ?? -9999,
        left: placement?.left ?? -9999,
        maxHeight: placement?.maxHeight,
        visibility: placement ? "visible" : "hidden"
      }}
      className={cn(
        "app-no-drag z-[120] flex flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900",
        "shadow-2xl shadow-black/40",
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
};
