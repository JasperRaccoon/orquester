import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const WIDTH = 192;

/** Cursor-anchored menu rendered in a portal; closes on outside click/Escape/scroll. */
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
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

  const left = Math.min(x, window.innerWidth - WIDTH - 8);
  const top = Math.min(y, window.innerHeight - (items.length * 32 + 16));

  return createPortal(
    <div
      role="menu"
      style={{ position: "fixed", top, left, width: WIDTH }}
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
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
            "disabled:pointer-events-none disabled:opacity-40",
            item.danger
              ? "text-red-400 hover:bg-red-500/10"
              : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
          )}
        >
          {item.icon && (
            <span className="flex h-4 w-4 items-center justify-center text-neutral-500">
              {item.icon}
            </span>
          )}
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
};
