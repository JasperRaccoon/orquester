/**
 * The workflow editor's form vocabulary: fields, inputs, a segmented switch,
 * toggles, collapsible sections, key/value tables and small icon buttons —
 * the rail's and the composer's look (neutral scale, 8 px radii, 12–13 px
 * type), sized for a 320–640 px inspector.
 */

import React, { useId, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { cn } from "../../../lib/cn";

export const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export const INPUT_CLASS = cn(
  "h-8 w-full min-w-0 rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 text-[13px] text-neutral-100",
  "placeholder:text-neutral-600 hover:border-neutral-700 focus:border-neutral-600 focus:outline-none",
  "disabled:opacity-50"
);

export const Field: React.FC<{
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  warning?: string | null;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, hint, error, warning, aside, className, children }) => (
  <div className={cn("space-y-1.5", className)} data-field-error={error ? "" : undefined}>
    <div className="flex min-h-4 items-center justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-neutral-400">
        {label}
      </label>
      {aside}
    </div>
    {children}
    {error ? (
      <p className="text-[11px] leading-4 text-danger">{error}</p>
    ) : warning ? (
      <p className="text-[11px] leading-4 text-warn">{warning}</p>
    ) : hint ? (
      <p className="text-[11px] leading-4 text-neutral-500">{hint}</p>
    ) : null}
  </div>
);

export const TextInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
    value: string;
    onValue: (value: string) => void;
    invalid?: boolean;
  }
>(({ value, onValue, invalid, className, ...props }, ref) => (
  <input
    ref={ref}
    {...props}
    value={value}
    spellCheck={false}
    onChange={(event) => onValue(event.target.value)}
    className={cn(INPUT_CLASS, invalid && "border-danger/60 hover:border-danger/70", className)}
  />
));
TextInput.displayName = "TextInput";

/** A number field that tolerates an empty or half-typed value while focused. */
export const NumberInput: React.FC<{
  value: number | undefined;
  onValue: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  suffix?: string;
  id?: string;
  className?: string;
  allowEmpty?: boolean;
  "aria-label"?: string;
}> = ({ value, onValue, min, max, step, placeholder, suffix, id, className, allowEmpty = true, ...rest }) => {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === undefined ? "" : String(value));
  const commit = (raw: string): void => {
    if (raw.trim() === "") {
      if (allowEmpty) onValue(undefined);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    let next = parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onValue(next);
  };
  return (
    <div className={cn("relative", className)}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        aria-label={rest["aria-label"]}
        value={shown}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value);
        }}
        onBlur={() => setText(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          const delta = (step ?? 1) * (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
          const next = (value ?? min ?? 0) + delta;
          setText(null);
          commit(String(next));
        }}
        className={cn(INPUT_CLASS, "tabular-nums", suffix && "pr-10")}
      />
      {suffix ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-500">
          {suffix}
        </span>
      ) : null}
    </div>
  );
};

export const SelectInput: React.FC<
  Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & { onValue: (value: string) => void }
> = ({ className, onValue, children, ...props }) => (
  <div className={cn("relative min-w-0", className)}>
    <select
      {...props}
      onChange={(event) => onValue(event.target.value)}
      className={cn(INPUT_CLASS, "appearance-none truncate pr-7")}
    >
      {children}
    </select>
    <ChevronDown
      size={13}
      aria-hidden
      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500"
    />
  </div>
);

export interface SegmentOption<T extends string> {
  id: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex items-center gap-0.5 rounded-lg bg-neutral-950/60 p-0.5 ring-1 ring-neutral-800", className)}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 font-medium transition-colors",
              FOCUS_RING,
              size === "sm" ? "h-6 text-[11px]" : "h-7 text-xs",
              "disabled:cursor-not-allowed disabled:opacity-40",
              active ? "bg-neutral-800 text-neutral-50 shadow-sm shadow-black/20" : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A switch with its label and an optional line of explanation, the whole row clickable. */
export const ToggleRow: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}> = ({ checked, onChange, label, description, disabled }) => {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] text-neutral-200">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
          FOCUS_RING,
          checked ? "bg-neutral-200" : "bg-neutral-700 hover:bg-neutral-600"
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-neutral-950 transition-transform motion-reduce:transition-none",
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          )}
        />
      </button>
    </div>
  );
};

/** A titled group of fields; collapsible when `collapsible`. */
export const Section: React.FC<{
  title: React.ReactNode;
  aside?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}> = ({ title, aside, collapsible = false, defaultOpen = true, children, className }) => {
  const [open, setOpen] = useState(defaultOpen);
  const shown = !collapsible || open;
  return (
    <section className={cn("border-t border-neutral-800/80 px-4 py-4 first:border-t-0", className)}>
      <div className="mb-3 flex min-h-5 items-center justify-between gap-2">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cn("-ml-1 flex items-center gap-1 rounded px-1 text-[13px] font-medium text-neutral-100", FOCUS_RING)}
          >
            {open ? <ChevronDown size={13} className="text-neutral-500" /> : <ChevronRight size={13} className="text-neutral-500" />}
            {title}
          </button>
        ) : (
          <h3 className="text-[13px] font-medium text-neutral-100">{title}</h3>
        )}
        {aside}
      </div>
      {shown ? <div className="space-y-4">{children}</div> : null}
    </section>
  );
};

export const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md"; tone?: "neutral" | "danger" }
> = ({ label, size = "md", tone = "neutral", className, children, ...props }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    {...props}
    className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors",
      "disabled:pointer-events-none disabled:opacity-35",
      FOCUS_RING,
      size === "sm" ? "h-6 w-6" : "h-8 w-8",
      tone === "danger" ? "hover:bg-danger-soft/40 hover:text-danger" : "hover:bg-neutral-800 hover:text-neutral-100",
      className
    )}
  >
    {children}
  </button>
);

/** A small bordered text button (Add rule, Test block…). */
export const SmallButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode; variant?: "outline" | "solid" | "ghost" }
> = ({ icon, variant = "outline", className, children, ...props }) => (
  <button
    type="button"
    {...props}
    className={cn(
      "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
      "disabled:pointer-events-none disabled:opacity-40",
      FOCUS_RING,
      variant === "outline" && "border border-neutral-800 text-neutral-200 hover:border-neutral-700 hover:bg-neutral-800/60",
      variant === "solid" && "bg-neutral-100 text-neutral-900 hover:bg-neutral-50",
      variant === "ghost" && "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
      className
    )}
  >
    {icon}
    {children}
  </button>
);

export interface KeyValueRow {
  name: string;
  value: string;
}

/** Name / value rows (headers, query, env): add, edit, remove. `renderValue` swaps the value input. */
export const KeyValueTable: React.FC<{
  rows: readonly KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  addLabel: string;
  nameInvalid?: (name: string) => string | null;
  renderValue?: (row: KeyValueRow, index: number, update: (value: string) => void) => React.ReactNode;
  emptyText?: string;
}> = ({ rows, onChange, namePlaceholder = "Name", valuePlaceholder = "Value", addLabel, nameInvalid, renderValue, emptyText }) => (
  <div className="space-y-1.5">
    {rows.length === 0 && emptyText ? <p className="text-[11px] text-neutral-500">{emptyText}</p> : null}
    {rows.map((row, index) => {
      const problem = nameInvalid?.(row.name) ?? null;
      const update = (patch: Partial<KeyValueRow>): void =>
        onChange(rows.map((current, i) => (i === index ? { ...current, ...patch } : current)));
      return (
        <div key={index} className="group flex items-start gap-1.5">
          <div className="w-[38%] shrink-0">
            <TextInput
              aria-label={`${namePlaceholder} ${index + 1}`}
              value={row.name}
              placeholder={namePlaceholder}
              invalid={problem !== null}
              title={problem ?? undefined}
              onValue={(name) => update({ name })}
              className="font-mono text-[12px]"
            />
          </div>
          <div className="min-w-0 flex-1">
            {renderValue ? (
              renderValue(row, index, (value) => update({ value }))
            ) : (
              <TextInput
                aria-label={`${valuePlaceholder} ${index + 1}`}
                value={row.value}
                placeholder={valuePlaceholder}
                onValue={(value) => update({ value })}
                className="font-mono text-[12px]"
              />
            )}
          </div>
          <IconButton
            label={`Remove ${row.name || "row"}`}
            tone="danger"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      );
    })}
    <SmallButton variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...rows, { name: "", value: "" }])} className="-ml-1">
      {addLabel}
    </SmallButton>
  </div>
);
