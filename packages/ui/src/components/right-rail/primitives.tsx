/**
 * The small pieces both right-rail panels are built from, so Saved prompts and
 * History read as one surface: the search field, the segmented scope switch,
 * the section label, the chip and the empty state. Neutral scale only — the
 * colour scheme tints it (AGENTS.md "Theming is data").
 */

import React from "react";
import { Search, X } from "lucide-react";

import { cn } from "../../lib/cn";

/** The search field at the top of a panel. Escape clears it first (and says so by preventing default). */
export const RailSearchInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  autoFocus?: boolean;
}> = ({ value, onChange, placeholder, label, autoFocus }) => (
  <div className="relative">
    <Search
      size={14}
      aria-hidden
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
    />
    <input
      type="search"
      value={value}
      autoFocus={autoFocus}
      aria-label={label ?? placeholder}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          onChange("");
        }
      }}
      className={cn(
        "h-9 w-full rounded-lg border border-neutral-800 bg-neutral-900/60 pl-8 pr-8 text-[13px]",
        "text-neutral-100 placeholder:text-neutral-500",
        "focus:border-neutral-600 focus:outline-none",
        // The native clear button duplicates ours and ignores the theme.
        "[&::-webkit-search-cancel-button]:appearance-none"
      )}
    />
    {value.length > 0 ? (
      <button
        type="button"
        aria-label="Clear search"
        title="Clear search"
        onClick={() => onChange("")}
        className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
      >
        <X size={13} />
      </button>
    ) : null}
  </div>
);

export interface RailSegmentOption<T extends string> {
  id: T;
  label: string;
  /** Shown as the button's tooltip. */
  title?: string;
  disabled?: boolean;
}

/** A full-width two-or-more-way switch ("All | Project", "Prompts | Checkpoints"). */
export function RailSegmented<T extends string>({
  options,
  value,
  onChange,
  label
}: {
  options: readonly RailSegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name. */
  label: string;
}): React.ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800"
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
            className={cn(
              "h-7 flex-1 rounded-md text-xs font-medium transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              // Hoverable while disabled, so its tooltip can say why ("Open a
              // project to list its prompts"); the browser ignores the click.
              "disabled:cursor-not-allowed disabled:opacity-40",
              active
                ? "bg-neutral-700/70 text-neutral-50"
                : "text-neutral-400 hover:text-neutral-200 disabled:hover:text-neutral-400"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** "PINNED", "PROMPTS", … — the list's section headings. */
export const RailSectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className
}) => (
  <div
    className={cn(
      "px-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500",
      className
    )}
  >
    {children}
  </div>
);

/** A small label on a card: a tag, the scope, a turn number, a file count. */
export const RailChip: React.FC<{
  children: React.ReactNode;
  title?: string;
  className?: string;
}> = ({ children, title, className }) => (
  <span
    title={title}
    className={cn(
      "inline-flex max-w-full items-center gap-1 truncate rounded-md border border-neutral-700/80 px-1.5 py-px text-[11px] leading-4 text-neutral-300",
      className
    )}
  >
    {children}
  </span>
);

/** What a panel shows with nothing to list. */
export const RailEmptyState: React.FC<{
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}> = ({ title, hint, action }) => (
  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
    <div className="text-[13px] text-neutral-300">{title}</div>
    {hint ? <div className="text-xs leading-5 text-neutral-500">{hint}</div> : null}
    {action ?? null}
  </div>
);

/**
 * The card chrome both panels use for a list row: resting, hovered, and the
 * expanded (selected) state the mockup's pinned card shows.
 */
export function railCardClass(expanded: boolean): string {
  return cn(
    "rounded-xl border transition-colors",
    expanded
      ? "border-neutral-600 bg-neutral-900/80"
      : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900/70"
  );
}
