/**
 * The agent-profile editors' form pieces: a labelled field, inputs that grow
 * to finger size (40 px, 16 px text — no zoom on focus) on a phone, a native
 * select (the phone's own picker), a segmented switch, a switch row, banners,
 * and the one input each `ProfileFieldSpec` type renders as.
 *
 * Neutral palette only; amber for warnings and red for errors and destructive
 * actions. Every control has a visible focus ring and a bound label.
 */

import React from "react";
import { AlertTriangle, Info, X } from "lucide-react";

import type { ProfileFieldSpec } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import { useEditorWide, useTouch } from "./env";

export const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500";

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export const Field: React.FC<{
  id: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: React.ReactNode;
  error?: string;
  /** Right of the label (a counter, a small action). */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ id, label, required, optional, hint, error, aside, className, children }) => (
  <div className={cn("min-w-0 space-y-1.5", className)}>
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={id} className="text-xs font-medium text-neutral-300">
        {label}
        {required ? (
          <span className="text-neutral-500" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
        {optional ? <span className="font-normal text-neutral-500"> (optional)</span> : null}
      </label>
      {aside}
    </div>
    {children}
    {error ? (
      <p id={`${id}-error`} className="text-xs text-danger">
        {error}
      </p>
    ) : hint ? (
      <p id={`${id}-hint`} className="text-[11px] leading-4 text-neutral-500">
        {hint}
      </p>
    ) : null}
  </div>
);

/** `aria-describedby` for a field's input: its error, else its hint. */
export function describedBy(id: string, error?: string, hint?: React.ReactNode): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const inputBase = (touch: boolean, invalid: boolean, mono: boolean): string =>
  cn(
    "block w-full min-w-0 rounded-md border bg-neutral-900 px-2.5 text-neutral-100 placeholder:text-neutral-500",
    FOCUS_RING,
    touch ? "h-10 text-base" : "h-8 text-sm",
    mono && "font-mono",
    mono && !touch && "text-[13px]",
    invalid ? "border-danger-500/70" : "border-neutral-700"
  );

export const TextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }
>(({ invalid = false, mono = false, className, ...props }, ref) => {
  const touch = useTouch();
  return (
    <input
      ref={ref}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-invalid={invalid || undefined}
      className={cn(inputBase(touch, invalid, mono), className)}
      {...props}
    />
  );
});
TextInput.displayName = "TextInput";

export const TextArea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }
>(({ invalid = false, mono = false, className, ...props }, ref) => {
  const touch = useTouch();
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "block w-full min-w-0 resize-y rounded-md border bg-neutral-900 px-2.5 py-2 leading-5 text-neutral-100 placeholder:text-neutral-500",
        FOCUS_RING,
        touch ? "text-base" : "text-sm",
        mono && "font-mono",
        mono && !touch && "text-[13px]",
        invalid ? "border-danger-500/70" : "border-neutral-700",
        className
      )}
      {...props}
    />
  );
});
TextArea.displayName = "TextArea";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export const SelectInput: React.FC<{
  id: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
}> = ({ id, value, options, onChange, invalid = false, disabled, describedBy: described }) => {
  const touch = useTouch();
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={described}
      onChange={(event) => onChange(event.target.value)}
      className={cn(inputBase(touch, invalid, false), "pr-8 disabled:opacity-50")}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
};

// ---------------------------------------------------------------------------
// Segmented, switch
// ---------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  /** Used when the editor is narrow ("Copy" for "Copy from agent"). */
  shortLabel?: string;
  disabled?: boolean;
  title?: string;
}

/** The rail's segmented switch, finger-sized on a phone and never wider than the editor. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): React.ReactElement {
  const touch = useTouch();
  const wide = useEditorWide();
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 items-center gap-0.5 rounded-lg bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800"
    >
      {options.map((option) => {
        const active = option.id === value;
        const text = !wide && option.shortLabel ? option.shortLabel : option.label;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            aria-label={text === option.label ? undefined : option.label}
            disabled={option.disabled}
            title={option.title ?? (text === option.label ? undefined : option.label)}
            onClick={() => onChange(option.id)}
            className={cn(
              "min-w-0 flex-1 truncate rounded-md px-1.5 font-medium transition-colors",
              FOCUS_RING,
              touch ? "h-10 text-sm" : "h-7 text-xs",
              "disabled:cursor-not-allowed disabled:opacity-40",
              active ? "bg-neutral-700/70 text-neutral-50" : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** A switch with its label and help, the whole row finger-sized on a phone. */
export const SwitchRow: React.FC<{
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ id, label, help, checked, onChange }) => {
  const touch = useTouch();
  return (
    <div className={cn("flex items-center justify-between gap-3", touch && "min-h-10")}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-xs font-medium text-neutral-300">
          {label}
        </label>
        {help ? <p className="text-[11px] leading-4 text-neutral-500">{help}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full",
          FOCUS_RING,
          touch ? "h-10 w-12" : "h-6 w-10"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
            checked ? "bg-neutral-200" : "bg-neutral-700"
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 transform rounded-full bg-neutral-950 transition-transform",
              checked ? "translate-x-[18px]" : "translate-x-[3px]"
            )}
          />
        </span>
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export const SmallButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "danger" | "primary" }
> = ({ tone = "default", className, children, ...props }) => {
  const touch = useTouch();
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 font-medium transition-colors",
        FOCUS_RING,
        "disabled:cursor-not-allowed disabled:opacity-50",
        touch ? "h-10 text-sm" : "h-7 text-xs",
        tone === "primary"
          ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-50"
          : tone === "danger"
            ? "border border-danger-500/50 text-danger hover:bg-danger-500/10"
            : "border border-neutral-700 text-neutral-200 hover:bg-neutral-800",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};

/** A square icon-only button ("Remove"): 40 px on a phone. */
export const IconAction: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "danger";
}> = ({ label, onClick, children, tone = "default" }) => {
  const touch = useTouch();
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors",
        FOCUS_RING,
        touch ? "h-10 w-10" : "h-8 w-8",
        tone === "danger" ? "hover:bg-danger-500/10 hover:text-danger" : "hover:bg-neutral-800 hover:text-neutral-100"
      )}
    >
      {children}
    </button>
  );
};

export const RemoveIcon: React.FC = () => <X size={15} aria-hidden />;

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export const Banner: React.FC<{
  tone: "error" | "warn" | "info";
  title?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ tone, title, children, actions }) => {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex min-w-0 gap-2.5 rounded-md border px-3 py-2 text-xs leading-5",
        tone === "error" && "border-danger-500/40 bg-danger-500/10 text-danger",
        tone === "warn" && "border-warn-500/40 bg-warn-500/10 text-warn",
        tone === "info" && "border-neutral-800 bg-neutral-900/60 text-neutral-300"
      )}
    >
      <Icon size={14} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="break-words">{children}</div> : null}
        {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
};

/** A section heading inside a form ("Environment", "Advanced"). */
export const SectionHeading: React.FC<{ children: React.ReactNode; aside?: React.ReactNode }> = ({ children, aside }) => (
  <div className="flex items-center justify-between gap-2 pt-1">
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">{children}</h3>
    {aside}
  </div>
);

// ---------------------------------------------------------------------------
// ProfileFieldSpec → input
// ---------------------------------------------------------------------------

export const SpecInput: React.FC<{
  id: string;
  spec: ProfileFieldSpec;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  error?: string;
  autoFocus?: boolean;
}> = ({ id, spec, value, onChange, error, autoFocus }) => {
  if (spec.type === "boolean") {
    return <SwitchRow id={id} label={spec.label} help={spec.help} checked={value === true} onChange={onChange} />;
  }
  const text = typeof value === "string" ? value : "";
  const hint =
    spec.type === "string-list" ? spec.help ?? "One per line" : spec.help;
  const described = describedBy(id, error, hint);
  return (
    <Field id={id} label={spec.label} required={spec.required} hint={hint} error={error}>
      {spec.type === "text" || spec.type === "string-list" ? (
        <TextArea
          id={id}
          rows={spec.type === "text" ? 2 : 3}
          value={text}
          placeholder={spec.placeholder}
          invalid={Boolean(error)}
          mono={spec.type === "string-list"}
          aria-describedby={described}
          aria-required={spec.required || undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <TextInput
          id={id}
          value={text}
          inputMode={spec.type === "number" ? "decimal" : undefined}
          placeholder={spec.placeholder}
          invalid={Boolean(error)}
          aria-describedby={described}
          aria-required={spec.required || undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
};
