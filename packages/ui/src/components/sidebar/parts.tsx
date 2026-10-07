import React from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";

/** A small rounded count beside a section title or a workspace name. */
export const CountPill: React.FC<{
  children: React.ReactNode;
  tone?: "default" | "warn" | "danger";
  title?: string;
  className?: string;
}> = ({ children, tone = "default", title, className }) => (
  <span
    title={title}
    className={cn(
      "inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums",
      tone === "warn" && "bg-warn-soft/60 text-warn",
      tone === "danger" && "bg-danger-soft/60 text-danger",
      tone === "default" && "bg-neutral-800 text-neutral-400",
      className
    )}
  >
    {children}
  </span>
);

/** A sidebar section's title row: the title, its count, and actions on the right. */
export const SectionHeader: React.FC<{
  title: string;
  count?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, count, children }) => (
  <div className="flex h-8 items-center gap-2 px-1">
    <h3 className="text-[13px] font-medium text-neutral-200">{title}</h3>
    {count}
    <div className="flex-1" />
    {children}
  </div>
);

/**
 * A row's "…" button: the same menu as its right-click, anchored under the
 * button — touch has no right-click. Always shown on touch; revealed on hover
 * or focus from `md` up (the row carries `group`).
 */
export const RowActionsButton: React.FC<{
  label: string;
  onOpen: (at: { x: number; y: number }) => void;
}> = ({ label, onOpen }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={(event) => {
      event.stopPropagation();
      const r = event.currentTarget.getBoundingClientRect();
      onOpen({ x: r.right, y: r.bottom + 4 });
    }}
    className={cn(
      "mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500",
      "transition-colors hover:bg-neutral-700 hover:text-neutral-200",
      "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
      "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
    )}
  >
    <MoreHorizontal size={15} />
  </button>
);
