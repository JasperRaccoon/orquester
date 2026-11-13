import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackClose } from "../../hooks/use-back-close";
import { useOpenLayer } from "../../hooks/use-open-layer";
import { cn } from "../../lib/cn";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /**
   * A second, muted line under the label, wrapped in full — e.g. why a
   * disabled item is refused. Shown as text because a disabled item takes no
   * pointer events, so a tooltip would never appear on it.
   */
  description?: string;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const WIDTH = 192;
/** A menu with descriptions grows up to this wide (within the viewport) before they wrap. */
const DESCRIBED_MAX_WIDTH = "min(18rem, calc(100vw - 16px))";
/** Space kept between the menu and the viewport's right / bottom edge. */
const EDGE_X = 8;
const EDGE_Y = 6;

/**
 * Cursor-anchored menu rendered in a portal; closes on outside click/Escape/scroll.
 * Mounted only while open, so it is an open layer for its whole life
 * (`useOpenLayer`): its Escape is its own, and on a phone so is Back
 * (`useBackClose`) — a long-pressed row's menu closes before anything under it.
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  useOpenLayer(true);
  useBackClose(true, onClose);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  // Measured before paint, so a menu near an edge (wrapped descriptions included) opens inside the viewport.
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // A menu sized by its content is measured at the left edge, where nothing narrows it.
    const shown = menu.style.left;
    menu.style.left = "0px";
    const box = menu.getBoundingClientRect();
    menu.style.left = shown;
    const left = Math.min(x, window.innerWidth - box.width - EDGE_X);
    const top = Math.min(y, window.innerHeight - box.height - EDGE_Y);
    setPlace((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, [x, y, items]);

  const described = items.some((item) => item.description);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        top: place.top,
        left: place.left,
        ...(described ? { minWidth: WIDTH, maxWidth: DESCRIBED_MAX_WIDTH } : { width: WIDTH })
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="z-[120] overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 p-1 shadow-xl shadow-black/40"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={cn(
            "flex w-full gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
            // A described item dims only its icon and label: its reason stays readable.
            item.description ? "items-start" : "items-center disabled:opacity-40",
            "disabled:pointer-events-none",
            item.danger
              ? "text-danger hover:bg-danger-500/10"
              : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
          )}
        >
          {item.icon && (
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center text-neutral-500",
                // Level with the label's line, not the middle of a wrapped reason.
                item.description && "mt-0.5",
                item.description && item.disabled && "opacity-40"
              )}
            >
              {item.icon}
            </span>
          )}
          {item.description ? (
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate", item.disabled && "opacity-40")}>{item.label}</span>
              <span className="block whitespace-normal break-words text-[11px] leading-snug text-neutral-500">
                {item.description}
              </span>
            </span>
          ) : (
            <span className="flex-1 truncate">{item.label}</span>
          )}
        </button>
      ))}
    </div>,
    document.body
  );
};
