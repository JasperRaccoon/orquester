// Small pieces the Knowledge tab's views and panels share.

import React from "react";
import { AlertTriangle } from "lucide-react";
import type { KnowledgeColor } from "@orquester/api";

import { cn } from "../../lib/cn";
import { knowledgeColorCss } from "./knowledge.logic";

export const CollectionDot: React.FC<{ color: KnowledgeColor | null; className?: string }> = ({ color, className }) => (
  <span
    aria-hidden
    className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color ? null : "bg-neutral-600", className)}
    style={color ? { backgroundColor: knowledgeColorCss(color) } : undefined}
  />
);

/** A collection label: its colour dot and name. */
export const CollectionChip: React.FC<{
  name: string;
  color: KnowledgeColor | null;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  /** Without the colour dot ("All"). */
  dot?: boolean;
  className?: string;
}> = ({ name, color, active, onClick, title, dot = true, className }) => {
  const classes = cn(
    "inline-flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
    active ? "border-neutral-500 bg-neutral-800 text-neutral-100" : "border-neutral-800 text-neutral-400",
    onClick ? "hover:border-neutral-600 hover:text-neutral-200" : null,
    className
  );
  const inner = (
    <>
      {dot && <CollectionDot color={color} />}
      <span className="truncate">{name}</span>
    </>
  );
  return onClick ? (
    <button type="button" aria-pressed={active} title={title} className={classes} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span title={title} className={classes}>
      {inner}
    </span>
  );
};

export const ErrorLine: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <p role="alert" className={cn("flex items-start gap-1.5 text-xs text-danger", className)}>
    <AlertTriangle size={13} className="mt-px shrink-0" />
    <span className="min-w-0">{children}</span>
  </p>
);

export const Centered: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn("flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-neutral-400", className)}>
    {children}
  </div>
);

/** The small uppercase line above a title ("Thread · Pending"). */
export const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10.5px] font-medium uppercase tracking-wide text-neutral-500">{children}</p>
);

export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">{children}</h3>
);
