/**
 * The workflow editor's form vocabulary: fields, inputs, a segmented switch,
 * radio cards, chips, toggles, collapsible sections, callouts, help tips,
 * key/value tables and small icon buttons — the rail's and the composer's
 * look (neutral scale, 8 px radii, 12–13 px type), sized for a 320–640 px
 * inspector.
 */

import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  Plus,
  Trash2
} from "lucide-react";

import { cn } from "../../../lib/cn";
import { copyText } from "../../../lib/clipboard";
import {
  canonicalDuration,
  convertDuration,
  displayUnitFor,
  formatDurationIn,
  formatUnitCount,
  type DurationUnit
} from "../../../lib/workflows/durations";
import { Popover } from "./Popover";

export const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export const INPUT_CLASS = cn(
  "h-8 w-full min-w-0 rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 text-[13px] text-neutral-100",
  "placeholder:text-neutral-600 hover:border-neutral-700 focus:border-neutral-600 focus:outline-none",
  "disabled:opacity-50"
);

const INVALID_CLASS = "border-danger/60 hover:border-danger/70";

/** Whether an optional ReactNode prop has something to show ("" and false count as nothing). */
function present(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}

// ---------------------------------------------------------------------------
// Field id wiring

interface FieldControl {
  id: string;
  describedBy: string | undefined;
  /** The label element's id, for the claiming control's `aria-labelledby`. */
  labelId: string;
  /** The one control that took the id (the first to ask), so siblings don't duplicate it. */
  owner: { current: string | null };
}

/** What a control inside a `Field` puts on its focusable element (see `useFieldControl`). */
export interface FieldControlProps {
  id: string | undefined;
  describedBy: string | undefined;
  /** The Field label's id: set it as `aria-labelledby` unless the control has its own `aria-label`. */
  labelledBy: string | undefined;
}

const FieldContext = createContext<FieldControl | null>(null);

/**
 * How a control inside a `Field` wires itself to the label: `explicit` when
 * given; otherwise the Field's generated id, its message id for
 * `aria-describedby` and its label id for `aria-labelledby`, for the FIRST
 * control that asks — later controls get nothing, so ids never repeat.
 * Outside a Field, `explicit` or nothing.
 *
 * The label names its control with `aria-labelledby` (plus click-to-focus),
 * not `<label for>`: the label renders before its children, so it can't know
 * whether any control will claim the id — a `for` would dangle around a chip
 * group or radio cards, and would point at a non-labelable element for a
 * contenteditable editor.
 */
export function useFieldControl(explicit?: string): FieldControlProps {
  const field = useContext(FieldContext);
  const me = useId();
  const [, rewire] = useState(0);
  useEffect(() => {
    if (!field || explicit !== undefined) return;
    // The control that held the id went away after this one rendered (a select swapped for a text
    // input): take it over and render again, now wired.
    if (field.owner.current === null) {
      field.owner.current = me;
      rewire((count) => count + 1);
    }
    return () => {
      if (field.owner.current === me) field.owner.current = null;
    };
  }, [field, explicit, me]);
  if (explicit !== undefined || !field) return { id: explicit, describedBy: undefined, labelledBy: undefined };
  // Claimed during render so the first paint is already wired; idempotent for the same component.
  if (field.owner.current === null) field.owner.current = me;
  return field.owner.current === me
    ? { id: field.id, describedBy: field.describedBy, labelledBy: field.labelId }
    : { id: undefined, describedBy: undefined, labelledBy: undefined };
}

/** Stops a collection control's inner inputs (table rows, chips…) from taking the enclosing Field's id. */
const NoFieldId: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <FieldContext.Provider value={null}>{children}</FieldContext.Provider>
);

// ---------------------------------------------------------------------------
// Read-only regions

const ReadOnlyContext = createContext(false);

/**
 * A `<fieldset disabled>` around a read-only form. The browser disables the
 * native form controls in it (inputs, selects, textareas, buttons); the
 * view-only buttons built on `ViewButton` (help tips, copy chips, section and
 * "More options" toggles) keep working, so a read-only form can still be
 * explored. It does NOT stop editors that aren't form controls
 * (contenteditable / CodeMirror): those read `useReadOnly()` and make
 * themselves read-only.
 */
export const ReadOnlyFieldset: React.FC<{ readOnly: boolean; className?: string; children: React.ReactNode }> = ({
  readOnly,
  className,
  children
}) => (
  <fieldset disabled={readOnly} className={className}>
    <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>
  </fieldset>
);

/** Whether this renders inside a read-only `ReadOnlyFieldset` (for editors a fieldset can't disable, e.g. CodeMirror). */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/**
 * A button that only changes what is shown (opens help, copies text, expands a
 * section; marked `data-view-button`, so "focus this field" skips it). Inside
 * a read-only `ReadOnlyFieldset` it renders as a
 * `role="button"` span (Enter / Space click it), which a disabled fieldset
 * leaves alone; everywhere else it is a plain `<button type="button">`.
 */
export const ViewButton = React.forwardRef<HTMLElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ type: _type, disabled, onClick, onKeyDown, ...props }, ref) => {
    const readOnly = useContext(ReadOnlyContext);
    if (!readOnly) {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          disabled={disabled}
          onClick={onClick}
          onKeyDown={onKeyDown}
          {...props}
          data-view-button=""
        />
      );
    }
    const click = onClick as unknown as React.MouseEventHandler<HTMLSpanElement> | undefined;
    const keyDown = onKeyDown as unknown as React.KeyboardEventHandler<HTMLSpanElement> | undefined;
    return (
      <span
        ref={ref as React.Ref<HTMLSpanElement>}
        role="button"
        tabIndex={0}
        {...(props as React.HTMLAttributes<HTMLSpanElement>)}
        data-view-button=""
        onClick={click}
        onKeyDown={(event) => {
          keyDown?.(event);
          if (event.defaultPrevented || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      />
    );
  }
);
ViewButton.displayName = "ViewButton";

// ---------------------------------------------------------------------------
// Help tip

/**
 * A small (i) button that opens an anchored popover with an explanation, on
 * click or tap (Escape or an outside press closes it). `label` names what it
 * explains: the button reads "About <label>".
 */
export const HelpTip: React.FC<{
  label: string;
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}> = ({ label, children, align = "start", className }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const ignoreOutside = useCallback((target: Node) => triggerRef.current?.contains(target) ?? false, []);
  return (
    <>
      <ViewButton
        ref={triggerRef}
        aria-label={`About ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:text-neutral-200",
          "[.wf-touch_&]:h-7 [.wf-touch_&]:w-7",
          open && "text-neutral-200",
          FOCUS_RING,
          className
        )}
      >
        <Info size={12} aria-hidden />
      </ViewButton>
      {open ? (
        <Popover
          open
          anchor={{ element: triggerRef.current }}
          onClose={() => setOpen(false)}
          align={align}
          role="dialog"
          ariaLabel={label}
          ignoreOutside={ignoreOutside}
          className="w-max max-w-[min(280px,calc(100vw-16px))]"
        >
          <div className="space-y-1.5 overflow-y-auto px-3 py-2.5 text-[12px] leading-[18px] text-neutral-300">{children}</div>
        </Popover>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------
// Field

/**
 * A labelled control. `help` adds a HelpTip by the label, `optional` a muted
 * "optional" tag, `defaultNote` a "Default: …" note after the hint. The error
 * and the warning (each when given) show under the control, the hint under
 * them. Without `htmlFor` the label gets a generated id that the first input
 * inside takes (`useFieldControl`).
 */
export const Field: React.FC<{
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  warning?: string | null;
  aside?: React.ReactNode;
  help?: React.ReactNode;
  optional?: boolean;
  defaultNote?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, hint, error, warning, aside, help, optional, defaultNote, className, children }) => {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hasHint = present(hint);
  const hasDefault = present(defaultNote);
  const hasNotes = Boolean(error) || Boolean(warning) || hasHint || hasDefault;
  const notesId = hasNotes ? `${id}-notes` : undefined;
  const labelId = `${id}-label`;
  const owner = useRef<string | null>(null);
  const control = useMemo<FieldControl | null>(
    () => (htmlFor === undefined ? { id, describedBy: notesId, labelId, owner } : null),
    [htmlFor, id, notesId, labelId]
  );
  const footnote =
    hasHint || hasDefault ? (
      <p className="text-[11px] leading-4 text-neutral-500">
        {hasHint ? hint : null}
        {hasHint && hasDefault ? " · " : null}
        {hasDefault ? <>Default: {defaultNote}</> : null}
      </p>
    ) : null;
  return (
    <div className={cn("space-y-1.5", className)} data-field-error={error ? "" : undefined}>
      <div className="flex min-h-4 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {htmlFor !== undefined ? (
            <label htmlFor={htmlFor} id={labelId} className="text-xs font-medium text-neutral-400">
              {label}
            </label>
          ) : (
            // Names the control that claimed the id (`aria-labelledby`); a click focuses it, as `for` would.
            <label
              id={labelId}
              onClick={() => {
                if (owner.current !== null) document.getElementById(id)?.focus();
              }}
              className="text-xs font-medium text-neutral-400"
            >
              {label}
            </label>
          )}
          {optional ? <span className="text-[10.5px] text-neutral-600">optional</span> : null}
          {present(help) ? <HelpTip label={typeof label === "string" ? label : "this setting"}>{help}</HelpTip> : null}
        </div>
        {aside}
      </div>
      {/* With an explicit htmlFor the caller wires ids itself; an outer Field's id must not leak in either. */}
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      {hasNotes ? (
        <div id={notesId} className="space-y-0.5">
          {error ? <p className="text-[11px] leading-4 text-danger">{error}</p> : null}
          {warning ? <p className="text-[11px] leading-4 text-warn">{warning}</p> : null}
          {footnote}
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inputs

export const TextInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
    value: string;
    onValue: (value: string) => void;
    invalid?: boolean;
  }
>(({ value, onValue, invalid, className, id, ...props }, ref) => {
  const control = useFieldControl(id);
  return (
    <input
      ref={ref}
      aria-describedby={control.describedBy}
      aria-labelledby={props["aria-label"] ? undefined : control.labelledBy}
      {...props}
      id={control.id}
      value={value}
      spellCheck={false}
      onChange={(event) => onValue(event.target.value)}
      className={cn(INPUT_CLASS, invalid && INVALID_CLASS, className)}
    />
  );
});
TextInput.displayName = "TextInput";

/**
 * A multi-line text field styled like the inputs. `mono` for code or JSON,
 * `rows` for its starting height (default 3), `autosize` grows it with its
 * content up to `maxRows` (default 12) — the user can still drag it taller.
 */
export const TextArea = React.forwardRef<
  HTMLTextAreaElement,
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
    value: string;
    onValue: (value: string) => void;
    invalid?: boolean;
    mono?: boolean;
    autosize?: boolean;
    maxRows?: number;
  }
>(({ value, onValue, invalid, mono, autosize, maxRows = 12, rows = 3, className, id, ...props }, forwarded) => {
  const control = useFieldControl(id);
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inner.current = element;
      if (typeof forwarded === "function") forwarded(element);
      else if (forwarded) forwarded.current = element;
    },
    [forwarded]
  );
  useEffect(() => {
    const element = inner.current;
    if (!autosize || !element) return;
    const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, line * maxRows + 14)}px`;
  }, [autosize, maxRows, value]);
  return (
    <textarea
      ref={setRef}
      aria-describedby={control.describedBy}
      aria-labelledby={props["aria-label"] ? undefined : control.labelledBy}
      {...props}
      id={control.id}
      rows={rows}
      value={value}
      spellCheck={mono ? false : props.spellCheck}
      onChange={(event) => onValue(event.target.value)}
      className={cn(
        "block w-full min-w-0 resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-1.5 text-[13px] leading-5 text-neutral-100",
        "placeholder:text-neutral-600 hover:border-neutral-700 focus:border-neutral-600 focus:outline-none disabled:opacity-50",
        mono && "font-mono text-[12px] leading-[18px]",
        invalid && INVALID_CLASS,
        className
      )}
    />
  );
});
TextArea.displayName = "TextArea";

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
  invalid?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}> = ({ value, onValue, min, max, step, placeholder, suffix, id, className, allowEmpty = true, invalid, ...rest }) => {
  const control = useFieldControl(id);
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
        id={control.id}
        type="text"
        inputMode="decimal"
        aria-label={rest["aria-label"]}
        aria-labelledby={rest["aria-labelledby"] ?? (rest["aria-label"] ? undefined : control.labelledBy)}
        aria-describedby={rest["aria-describedby"] ?? control.describedBy}
        aria-invalid={invalid || undefined}
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
        className={cn(INPUT_CLASS, "tabular-nums", suffix && "pr-10", invalid && INVALID_CLASS)}
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
> = ({ className, onValue, children, id, ...props }) => {
  const control = useFieldControl(id);
  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        aria-describedby={control.describedBy}
        aria-labelledby={props["aria-label"] ? undefined : control.labelledBy}
        {...props}
        id={control.id}
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
};

/**
 * A native time-of-day picker ("HH:MM", 24 h). Clearing it does not write: a
 * schedule always has a time, so an emptied field keeps the last one.
 */
export const TimeInput: React.FC<{
  value: string;
  onValue: (value: string) => void;
  ariaLabel?: string;
  id?: string;
  invalid?: boolean;
  className?: string;
}> = ({ value, onValue, ariaLabel, id, invalid, className }) => {
  const control = useFieldControl(id);
  return (
    <input
      type="time"
      id={control.id}
      value={value}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : control.labelledBy}
      aria-describedby={control.describedBy}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        if (event.target.value) onValue(event.target.value);
      }}
      className={cn(
        "h-8 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 text-[13px] tabular-nums text-neutral-100 [color-scheme:inherit]",
        "hover:border-neutral-700 focus:border-neutral-600 focus:outline-none disabled:opacity-50",
        invalid && INVALID_CLASS,
        className
      )}
    />
  );
};

const UNIT_WORDS: Readonly<Record<DurationUnit, [string, string]>> = {
  seconds: ["second", "seconds"],
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"]
};
const UNIT_ORDER: readonly DurationUnit[] = ["seconds", "minutes", "hours", "days"];

/**
 * A duration as a number and a unit. The config keeps one canonical `unit`
 * (min/max are in it too); the field shows the largest of `units` that holds
 * the value whole (240 min → "4 hours"), converts on write, clamps like
 * NumberInput, and writes `undefined` when emptied. Changing the unit keeps
 * the typed number ("4" minutes → 4 hours). The readout adds "= 1 h 30 min"
 * when the unit alone doesn't say it plainly, and "max 7 days" at the limit
 * or while empty (`readout={false}` hides it).
 */
export const DurationInput: React.FC<{
  value: number | undefined;
  unit: "seconds" | "minutes" | "hours";
  units: readonly DurationUnit[];
  onValue: (value: number | undefined) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  invalid?: boolean;
  ariaLabel?: string;
  id?: string;
  readout?: boolean;
  className?: string;
}> = ({ value, unit, units, onValue, min, max, placeholder, invalid, ariaLabel, id, readout = true, className }) => {
  const control = useFieldControl(id);
  const offered = UNIT_ORDER.filter((candidate) => units.includes(candidate));
  const [shownUnit, setShownUnit] = useState<DurationUnit>(() => displayUnitFor(value, unit, offered));
  // A value this field did not write (undo, another block) picks its best unit again. Not while
  // the user is in the field, and not for the answer to its own write — a caller that rounds or
  // defaults what it was given (240.5 → 241, empty → 0) must not flip the unit mid-typing.
  const written = useRef(value);
  const answering = useRef(false);
  const focused = useRef(false);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const external = value !== written.current && !answering.current && !focused.current;
    answering.current = false;
    written.current = value;
    if (external) setShownUnit(displayUnitFor(value, unit, offered));
  }
  // A write the caller ignored (same value) must not make a later undo look like our own answer.
  useEffect(() => {
    answering.current = false;
  });
  const shown = offered.includes(shownUnit) ? shownUnit : displayUnitFor(value, unit, offered);

  const write = (count: number | undefined, inUnit: DurationUnit): void => {
    const next = count === undefined ? undefined : canonicalDuration(count, inUnit, unit, min, max);
    written.current = next;
    answering.current = true;
    onValue(next);
  };

  const count = value === undefined ? undefined : convertDuration(value, unit, shown);
  const notes: string[] = [];
  if (readout && value !== undefined && value > 0) {
    const exact = formatDurationIn(value, unit);
    if (exact !== formatUnitCount(convertDuration(value, unit, shown), shown)) notes.push(`= ${exact}`);
  }
  if (readout && max !== undefined && (value === undefined || value >= max)) notes.push(`max ${formatDurationIn(max, unit)}`);

  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focused.current = false;
      }}
    >
      {/* Bounds apply in the canonical unit (in `write`), so the number box takes what is typed. */}
      <NumberInput
        id={control.id}
        value={count}
        onValue={(next) => write(next, shown)}
        placeholder={placeholder}
        invalid={invalid}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : control.labelledBy}
        aria-describedby={control.describedBy}
        className="w-20"
      />
      {offered.length > 1 ? (
        <SelectInput
          value={shown}
          aria-label={`${ariaLabel ?? "Duration"} unit`}
          onValue={(next) => {
            const nextUnit = next as DurationUnit;
            setShownUnit(nextUnit);
            if (count !== undefined) write(count, nextUnit);
          }}
          className="w-[6.5rem]"
        >
          {offered.map((option) => (
            <option key={option} value={option}>
              {UNIT_WORDS[option][count === 1 ? 0 : 1]}
            </option>
          ))}
        </SelectInput>
      ) : (
        <span className="text-[12px] text-neutral-400">{UNIT_WORDS[shown][count === 1 ? 0 : 1]}</span>
      )}
      {notes.length > 0 ? (
        <span className="text-[11px] tabular-nums text-neutral-500">
          {notes.join(" · ")}
        </span>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Choices

export interface SegmentOption<T extends string> {
  id: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
  /** Shown under the control while this option is selected. */
  description?: React.ReactNode;
}

/**
 * A one-of-few switch (role=radiogroup). `wrap` lets the options flow onto
 * more rows instead of squeezing at narrow widths; the selected option's
 * `description`, when it has one, shows under the control. `onChange` fires
 * only for a different option — clicking the active one does nothing.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  wrap = false,
  className
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  wrap?: boolean;
  className?: string;
}): React.ReactElement {
  const hasDescriptions = options.some((option) => present(option.description));
  const selected = options.find((option) => option.id === value);
  const group = (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "flex items-center gap-0.5 rounded-lg bg-neutral-950/60 p-0.5 ring-1 ring-neutral-800",
        wrap && "flex-wrap",
        !hasDescriptions && className
      )}
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
            onClick={() => {
              // Re-picking the active option changes nothing (callers may rebuild config on a change).
              if (!active) onChange(option.id);
            }}
            className={cn(
              "flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 font-medium transition-colors",
              wrap ? "flex-auto" : "flex-1",
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
  if (!hasDescriptions) return group;
  return (
    <div className={cn("space-y-1.5", className)}>
      {group}
      {selected && present(selected.description) ? <p className="text-[11px] leading-4 text-neutral-500">{selected.description}</p> : null}
    </div>
  );
}

export interface RadioCardOption<T extends string> {
  value: T;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  /** Why it can't be picked; shown on the card, not only as a tooltip. */
  disabledReason?: React.ReactNode;
  /** Sub-choices shown inside the card while it is selected. */
  children?: React.ReactNode;
}

/**
 * Stacked radio cards for 2–4 choices that need a line of explanation each
 * (role=radiogroup; arrow keys, Home and End move the choice). The selected
 * card is highlighted and shows its `children`.
 */
export function RadioCards<T extends string>({
  value,
  options,
  onValue,
  ariaLabel,
  className
}: {
  value: T;
  options: readonly RadioCardOption<T>[];
  onValue: (value: T) => void;
  ariaLabel: string;
  className?: string;
}): React.ReactElement {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const enabled = options.filter((option) => !option.disabled);
  const focusable = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;
  const move = (from: T, key: string): void => {
    if (enabled.length === 0) return;
    const at = enabled.findIndex((option) => option.value === from);
    let index: number;
    if (key === "Home") index = 0;
    else if (key === "End") index = enabled.length - 1;
    else if (key === "ArrowDown" || key === "ArrowRight") index = (at + 1) % enabled.length;
    else index = (at - 1 + enabled.length) % enabled.length;
    const next = enabled[index]!.value;
    if (next !== value) onValue(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("space-y-1.5", className)}>
      <NoFieldId>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <div
              key={option.value}
              className={cn(
                "rounded-lg border transition-colors",
                active ? "border-neutral-600 bg-neutral-900" : "border-neutral-800",
                !active && !option.disabled && "hover:border-neutral-700",
                option.disabled && "opacity-60"
              )}
            >
              <button
                ref={(element) => {
                  if (element) buttons.current.set(option.value, element);
                  else buttons.current.delete(option.value);
                }}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={option.disabled}
                tabIndex={option.value === focusable ? 0 : -1}
                onClick={() => {
                  // Re-picking the selected card changes nothing (callers may rebuild config on a change).
                  if (!active) onValue(option.value);
                }}
                onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  move(option.value, event.key);
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left disabled:cursor-not-allowed",
                  FOCUS_RING
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-neutral-100" : "border-neutral-600"
                  )}
                >
                  {active ? <span className="h-1.5 w-1.5 rounded-full bg-neutral-100" /> : null}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-[13px] font-medium", active ? "text-neutral-50" : "text-neutral-200")}>{option.label}</span>
                  {present(option.description) ? (
                    <span className="mt-0.5 block text-[11.5px] leading-4 text-neutral-500">{option.description}</span>
                  ) : null}
                  {option.disabled && present(option.disabledReason) ? (
                    <span className="mt-0.5 block text-[11px] leading-4 text-neutral-500">{option.disabledReason}</span>
                  ) : null}
                </span>
              </button>
              {active && present(option.children) ? <div className="space-y-3 pb-3 pl-9 pr-3">{option.children}</div> : null}
            </div>
          );
        })}
      </NoFieldId>
    </div>
  );
}

/**
 * Multi-select pills (weekdays, PR actions): each an aria-pressed button;
 * `onValues` gets the picked values in `options` order. With `min`, the last
 * `min` picked cannot be unpicked.
 */
export function ChipGroup<T extends string>({
  values,
  options,
  onValues,
  min = 0,
  ariaLabel,
  className
}: {
  values: readonly T[];
  options: readonly { value: T; label: React.ReactNode; title?: string }[];
  onValues: (values: T[]) => void;
  min?: number;
  ariaLabel: string;
  className?: string;
}): React.ReactElement {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap gap-1", className)}>
      {options.map((option) => {
        const on = values.includes(option.value);
        const locked = on && values.length <= min;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            title={locked ? (min === 1 ? "Keep at least one" : `Keep at least ${min}`) : option.title}
            onClick={() => {
              if (locked) return;
              const next = new Set(values);
              if (on) next.delete(option.value);
              else next.add(option.value);
              onValues(options.map((candidate) => candidate.value).filter((candidate) => next.has(candidate)));
            }}
            className={cn(
              "h-8 min-w-10 rounded-md px-2.5 text-[12px] font-medium transition-colors [.wf-touch_&]:h-10",
              FOCUS_RING,
              on ? "bg-neutral-100 text-neutral-900" : "bg-neutral-900 text-neutral-400 ring-1 ring-inset ring-neutral-800 hover:text-neutral-100"
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

// ---------------------------------------------------------------------------
// Grouping

export interface ProblemCounts {
  errors: number;
  warnings: number;
}

/** Error / warning count pills ("2 errors", "1 warning" to a screen reader); nothing when both are 0. */
export const ProblemBadge: React.FC<{ problems: ProblemCounts; className?: string }> = ({ problems, className }) => {
  if (problems.errors === 0 && problems.warnings === 0) return null;
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {problems.errors > 0 ? (
        <Pill tone="danger" title={plural(problems.errors, "error")}>
          <AlertCircle size={10} aria-hidden />
          {problems.errors}
          <span className="sr-only">{problems.errors === 1 ? " error" : " errors"}</span>
        </Pill>
      ) : null}
      {problems.warnings > 0 ? (
        <Pill tone="warn" title={plural(problems.warnings, "warning")}>
          <AlertTriangle size={10} aria-hidden />
          {problems.warnings}
          <span className="sr-only">{problems.warnings === 1 ? " warning" : " warnings"}</span>
        </Pill>
      ) : null}
    </span>
  );
};

/**
 * A titled group of fields; collapsible when `collapsible`. `description` is a
 * line under the title (always shown); `summary` a muted one-liner under the
 * title while collapsed; `problems` shows count pills and opens a collapsed
 * section when errors appear. Open state is internal (`defaultOpen`) unless
 * `open` is given; `onOpenChange` hears every toggle either way. `sticky` pins
 * the header to the top of the scrolling panel while the section is in view.
 */
export const Section: React.FC<{
  title: React.ReactNode;
  aside?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  summary?: React.ReactNode;
  description?: React.ReactNode;
  problems?: ProblemCounts;
  sticky?: boolean;
  children: React.ReactNode;
  className?: string;
}> = ({
  title,
  aside,
  collapsible = false,
  defaultOpen = true,
  open,
  onOpenChange,
  summary,
  description,
  problems,
  sticky = false,
  children,
  className
}) => {
  const errors = problems?.errors ?? 0;
  const [innerOpen, setInnerOpen] = useState(() => defaultOpen || errors > 0);
  const isOpen = open ?? innerOpen;
  const bodyId = useId();
  const change = useCallback(
    (next: boolean) => {
      if (open === undefined) setInnerOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange]
  );
  const lastErrors = useRef(errors);
  useEffect(() => {
    const before = lastErrors.current;
    lastErrors.current = errors;
    if (collapsible && before === 0 && errors > 0 && !isOpen) change(true);
  }, [errors, collapsible, isOpen, change]);

  const shown = !collapsible || isOpen;
  const summaryShown = collapsible && !isOpen && present(summary);
  const badge = problems ? <ProblemBadge problems={problems} /> : null;
  return (
    <section className={cn("border-t border-neutral-800/80 px-4 py-4 first:border-t-0", className)}>
      <div
        className={cn(
          "mb-3 flex min-h-5 justify-between gap-2",
          summaryShown ? "items-start" : "items-center",
          sticky && "sticky top-0 z-10 -mx-4 -mt-4 mb-1 bg-neutral-950 px-4 pb-2 pt-4"
        )}
      >
        <div className="flex min-w-0 items-start gap-1.5">
          {collapsible ? (
            <ViewButton
              aria-expanded={isOpen}
              aria-controls={shown ? bodyId : undefined}
              onClick={() => change(!isOpen)}
              className={cn("-ml-1 flex min-w-0 flex-col items-start rounded px-1 text-left", FOCUS_RING)}
            >
              <span className="flex min-h-5 items-center gap-1 text-[13px] font-medium text-neutral-100">
                {isOpen ? (
                  <ChevronDown size={13} className="shrink-0 text-neutral-500" />
                ) : (
                  <ChevronRight size={13} className="shrink-0 text-neutral-500" />
                )}
                {title}
              </span>
              {summaryShown ? (
                <span className="line-clamp-2 pl-[17px] text-[11.5px] font-normal leading-4 text-neutral-500">{summary}</span>
              ) : null}
            </ViewButton>
          ) : (
            <h3 className="flex min-h-5 items-center text-[13px] font-medium text-neutral-100">{title}</h3>
          )}
          {badge ? <span className="flex min-h-5 items-center">{badge}</span> : null}
        </div>
        {aside}
      </div>
      {present(description) ? <p className="-mt-1.5 mb-3 text-[11.5px] leading-4 text-neutral-500">{description}</p> : null}
      {shown ? (
        <div id={bodyId} className="space-y-4">
          {children}
        </div>
      ) : null}
    </section>
  );
};

/**
 * An inline "More options" toggle (`label` to rename it) that shows its
 * children when open. `summary` (e.g. what differs from the defaults) shows
 * beside the toggle while closed. Uncontrolled (`defaultOpen`) unless `open`
 * is given.
 */
export const Disclosure: React.FC<{
  label?: React.ReactNode;
  summary?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}> = ({ label = "More options", summary, open, defaultOpen = false, onOpenChange, children, className }) => {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const bodyId = useId();
  return (
    <div className={className}>
      <ViewButton
        aria-expanded={isOpen}
        aria-controls={isOpen ? bodyId : undefined}
        onClick={() => {
          if (open === undefined) setInnerOpen(!isOpen);
          onOpenChange?.(!isOpen);
        }}
        className={cn(
          "-ml-1 flex max-w-full items-start gap-1 rounded px-1 text-left text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-200",
          "[.wf-touch_&]:min-h-9 [.wf-touch_&]:items-center",
          FOCUS_RING
        )}
      >
        {isOpen ? (
          <ChevronDown size={13} className="mt-px shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight size={13} className="mt-px shrink-0 text-neutral-500" />
        )}
        <span className="min-w-0">
          {label}
          {!isOpen && present(summary) ? <span className="font-normal text-neutral-500"> · {summary}</span> : null}
        </span>
      </ViewButton>
      {isOpen ? (
        <div id={bodyId} className="mt-3 space-y-4">
          {children}
        </div>
      ) : null}
    </div>
  );
};

const CALLOUT_ICON = { info: Info, warn: AlertTriangle, danger: AlertCircle, ok: CheckCircle2 } as const;

/**
 * A tinted note with an icon (info / warn / danger / ok): an optional bold
 * `title`, the text, and an optional `action` (a SmallButton…) under it.
 */
export const Callout: React.FC<{
  tone: "info" | "warn" | "danger" | "ok";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}> = ({ tone, title, children, action, className }) => {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div
      role="note"
      className={cn(
        "flex gap-2 rounded-lg border px-3 py-2 text-[12px] leading-[18px] text-neutral-300",
        tone === "info" && "border-info/25 bg-info-soft/15",
        tone === "warn" && "border-warn/30 bg-warn-soft/15",
        tone === "danger" && "border-danger/40 bg-danger-soft/20",
        tone === "ok" && "border-ok/25 bg-ok-soft/15",
        className
      )}
    >
      <Icon
        size={13}
        aria-hidden
        className={cn(
          "mt-[3px] shrink-0",
          tone === "info" && "text-info",
          tone === "warn" && "text-warn",
          tone === "danger" && "text-danger",
          tone === "ok" && "text-ok"
        )}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        {present(title) ? <div className="font-medium text-neutral-100">{title}</div> : null}
        {present(children) ? <div>{children}</div> : null}
        {present(action) ? <div className="flex flex-wrap gap-1.5 pt-0.5">{action}</div> : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Buttons

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

/**
 * Monospace text (a `{{ nodes.X.output }}` reference…) that copies itself on
 * click and says "Copied" for a moment. The text wraps rather than truncates.
 */
export const CopyChip: React.FC<{ text: string; label?: string; className?: string }> = ({ text, label, className }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return (
    <ViewButton
      aria-label={label ?? `Copy ${text}`}
      title="Copy"
      onClick={() => {
        void copyText(text).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "inline-flex max-w-full items-start gap-1.5 rounded-md bg-neutral-900 px-1.5 py-0.5 text-left font-mono text-[11.5px] leading-[18px] text-neutral-300",
        "ring-1 ring-inset ring-neutral-800 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
        FOCUS_RING,
        className
      )}
    >
      <span className="min-w-0 break-all">{text}</span>
      <span className="mt-[3px] inline-flex shrink-0 items-center gap-1 font-sans text-[10.5px] leading-3 text-neutral-500" aria-live="polite">
        {copied ? (
          <>
            <Check size={11} aria-hidden className="text-ok" />
            Copied
          </>
        ) : (
          <Copy size={11} aria-hidden />
        )}
      </span>
    </ViewButton>
  );
};

// ---------------------------------------------------------------------------
// Tables and pills

export interface KeyValueRow {
  name: string;
  value: string;
}

/**
 * Name / value rows (headers, query, env): add, edit, remove. `renderValue`
 * swaps the value input; `rowMessage(index)` puts an error and/or warning
 * under that row.
 */
export const KeyValueTable: React.FC<{
  rows: readonly KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  addLabel: string;
  nameInvalid?: (name: string) => string | null;
  renderValue?: (row: KeyValueRow, index: number, update: (value: string) => void) => React.ReactNode;
  rowMessage?: (index: number) => { error?: string | null; warning?: string | null } | undefined;
  emptyText?: string;
}> = ({ rows, onChange, namePlaceholder = "Name", valuePlaceholder = "Value", addLabel, nameInvalid, renderValue, rowMessage, emptyText }) => (
  <NoFieldId>
    <div className="space-y-1.5">
      {rows.length === 0 && emptyText ? <p className="text-[11px] text-neutral-500">{emptyText}</p> : null}
      {rows.map((row, index) => {
        const problem = nameInvalid?.(row.name) ?? null;
        const message = rowMessage?.(index);
        const update = (patch: Partial<KeyValueRow>): void =>
          onChange(rows.map((current, i) => (i === index ? { ...current, ...patch } : current)));
        return (
          <div key={index} className="space-y-1">
            <div className="group flex items-start gap-1.5">
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
            {message?.error ? <p className="pr-9 text-[11px] leading-4 text-danger">{message.error}</p> : null}
            {message?.warning ? <p className="pr-9 text-[11px] leading-4 text-warn">{message.warning}</p> : null}
          </div>
        );
      })}
      <SmallButton variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...rows, { name: "", value: "" }])} className="-ml-1">
        {addLabel}
      </SmallButton>
    </div>
  </NoFieldId>
);

/** A short status pill (validation counts, run states). */
export const Pill: React.FC<{
  tone?: "neutral" | "danger" | "warn" | "ok" | "info";
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ tone = "neutral", children, className, title }) => (
  <span
    title={title}
    className={cn(
      "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium leading-4",
      tone === "neutral" && "bg-neutral-800 text-neutral-300",
      tone === "danger" && "bg-danger-soft/60 text-danger",
      tone === "warn" && "bg-warn-soft/50 text-warn",
      tone === "ok" && "bg-ok-soft/50 text-ok",
      tone === "info" && "bg-info-soft/50 text-info",
      className
    )}
  >
    {children}
  </span>
);
