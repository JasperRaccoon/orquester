import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface TooltipProps {
  label: string;
  children: React.ReactNode;
  /** Only "right" is implemented (used by the collapsed sidebar rail). */
  side?: "right";
}

/**
 * Hover label rendered in a portal so it is never clipped by `overflow`
 * ancestors (e.g. the icon-only collapsed sidebar). Positioned to the right.
 */
export const Tooltip: React.FC<TooltipProps> = ({ label, children }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };

  return (
    <span
      ref={ref}
      className="contents"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateY(-50%)" }}
            className="z-[120] whitespace-nowrap rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 shadow-lg"
          >
            {label}
          </div>,
          document.body
        )}
    </span>
  );
};
