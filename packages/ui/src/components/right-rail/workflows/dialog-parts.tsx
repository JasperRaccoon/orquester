/**
 * The pieces the workflows panel's two dialogs (New workflow, Secrets) are
 * built from: a header with a close button, a labelled field, and a themed
 * native select — native on purpose, so a phone opens its own picker.
 */

import React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../../lib/cn";
import { ModalCloseButton } from "../../ui/modal";

export const DialogHeader: React.FC<{ title: string; subtitle?: string; onClose: () => void }> = ({
  title,
  subtitle,
  onClose
}) => (
  <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
    <div className="min-w-0">
      <div className="truncate text-sm font-medium text-neutral-100">{title}</div>
      {subtitle ? <div className="truncate text-xs text-neutral-500">{subtitle}</div> : null}
    </div>
    <ModalCloseButton onClose={onClose} />
  </div>
);

export const Field: React.FC<{
  id?: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}> = ({ id, label, hint, error, children }) => (
  <div className="space-y-1.5">
    <label htmlFor={id} className="block text-xs text-neutral-400">
      {label}
    </label>
    {children}
    {error ? (
      <p className="text-xs text-danger">{error}</p>
    ) : hint ? (
      <p className="text-[11px] leading-4 text-neutral-500">{hint}</p>
    ) : null}
  </div>
);

export const SelectField: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & { touch?: boolean }
> = ({ className, touch, children, ...props }) => (
  <div className="relative">
    <select
      {...props}
      className={cn(
        "w-full appearance-none rounded-md border border-neutral-700 bg-neutral-900 pl-2.5 pr-8 text-sm text-neutral-100",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50",
        touch ? "h-10" : "h-8",
        className
      )}
    >
      {children}
    </select>
    <ChevronDown
      size={14}
      aria-hidden
      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
    />
  </div>
);
