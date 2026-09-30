import React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * The shared building blocks every Settings page is made of, so the nine pages
 * read as one surface: a page header, titled sections holding a bordered card
 * of rows, and a handful of controls (segmented picker, badge, notice, empty
 * state) that were previously re-styled by hand in each page.
 */

/**
 * False where the surrounding chrome already names the page (the mobile
 * header), so {@link SettingsPage} does not print the title twice.
 */
export const SettingsPageTitleContext = React.createContext(true);

/** Page wrapper: title + one-line description, optional header actions. */
export const SettingsPage: React.FC<{
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Wider reading width for dashboard-like pages (usage, host status). */
  wide?: boolean;
  children: React.ReactNode;
}> = ({ title, description, actions, wide, children }) => {
  const showTitle = React.useContext(SettingsPageTitleContext);
  return (
    <div className={cn("mx-auto w-full pb-6", showTitle ? "space-y-8" : "space-y-6", wide ? "max-w-5xl" : "max-w-3xl")}>
      {(showTitle || description || actions) && (
        <header
          className={cn(
            "flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap",
            // Clear the desktop modal's floating close button.
            showTitle && "pr-8"
          )}
        >
          <div className="min-w-0">
            {showTitle && <h2 className="text-lg font-semibold tracking-tight text-neutral-100">{title}</h2>}
            {description && (
              <p className={cn("text-sm text-neutral-500", showTitle && "mt-0.5")}>{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
};

/**
 * A titled group. Children render inside a bordered card with row dividers
 * unless `bare` is set (for content that brings its own layout — grids,
 * tables, cards).
 */
export const SettingsSection: React.FC<{
  title?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  bare?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ title, description, actions, bare, className, children }) => (
  <section className={cn("space-y-3", className)}>
    {(title || actions) && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {title && <h3 className="text-sm font-medium text-neutral-200">{title}</h3>}
          {description && <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    )}
    {bare ? children : <SettingsCard>{children}</SettingsCard>}
  </section>
);

/** The bordered card rows sit in; dividers between direct children. */
export const SettingsCard: React.FC<{ className?: string; children: React.ReactNode }> = ({
  className,
  children
}) => (
  <div
    className={cn(
      "divide-y divide-neutral-800/80 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40",
      className
    )}
  >
    {children}
  </div>
);

/**
 * One setting: label + description on the left, control on the right. `stacked`
 * puts the control under the text for wide controls (inputs, pickers). On
 * narrow screens a non-stacked row still wraps its control below the text.
 */
export const SettingRow: React.FC<{
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  stacked?: boolean;
  /** Id of the control, so clicking the label focuses it. */
  htmlFor?: string;
  className?: string;
  children?: React.ReactNode;
}> = ({ label, description, icon, stacked, htmlFor, className, children }) => (
  <div
    className={cn(
      "px-4 py-3.5",
      stacked ? "space-y-2.5" : "flex flex-wrap items-center justify-between gap-x-6 gap-y-2",
      className
    )}
  >
    <div className={cn("flex min-w-0 gap-3", !stacked && "flex-1 basis-60")}>
      {icon && (
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-800/80 text-neutral-400">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm text-neutral-200">
            {label}
          </label>
        ) : (
          <p className="text-sm text-neutral-200">{label}</p>
        )}
        {description && <div className="mt-0.5 text-xs leading-relaxed text-neutral-500">{description}</div>}
      </div>
    </div>
    {children !== undefined && children !== null && (
      <div className={cn(stacked ? "min-w-0" : "flex shrink-0 items-center gap-2")}>{children}</div>
    )}
  </div>
);

/** Read-only key/value row (runtime, versions, paths). */
export const InfoRow: React.FC<{ label: React.ReactNode; value: React.ReactNode; mono?: boolean }> = ({
  label,
  value,
  mono
}) => (
  <div className="flex items-center justify-between gap-4 px-4 py-2.5">
    <span className="shrink-0 text-sm text-neutral-400">{label}</span>
    <span className={cn("min-w-0 truncate text-right text-sm text-neutral-200", mono && "font-mono text-xs")}>
      {value}
    </span>
  </div>
);

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}

/** A pill group for picking one of a few values (replaces the ad-hoc copies). */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
  ariaLabel,
  className
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: "xs" | "sm";
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex max-w-full flex-wrap rounded-lg bg-neutral-800/60 p-0.5", className)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
              selected
                ? "bg-neutral-700 text-neutral-100 shadow-sm"
                : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "bg-neutral-800 text-neutral-400",
  ok: "bg-ok-soft/40 text-ok",
  warn: "bg-warn-soft/40 text-warn",
  danger: "bg-danger-soft/50 text-danger",
  info: "bg-info-soft/40 text-info"
};

/** Small status pill: "Installed", "Default", "Needs re-auth", "Expires in 3d". */
export const Badge: React.FC<{
  tone?: Tone;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = "neutral", icon, title, className, children }) => (
  <span
    title={title}
    className={cn(
      "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium",
      BADGE_TONE[tone],
      className
    )}
  >
    {icon}
    {children}
  </span>
);

const NOTICE_TONE: Record<Exclude<Tone, "neutral">, { box: string; icon: React.ReactNode }> = {
  info: { box: "border-info-900/60 bg-info-soft/15 text-neutral-300", icon: <Info size={14} className="text-info" /> },
  ok: { box: "border-ok-900/60 bg-ok-soft/15 text-neutral-300", icon: <CheckCircle2 size={14} className="text-ok" /> },
  warn: {
    box: "border-warn-900/60 bg-warn-soft/20 text-neutral-300",
    icon: <AlertTriangle size={14} className="text-warn" />
  },
  danger: {
    box: "border-danger-900/60 bg-danger-soft/25 text-neutral-300",
    icon: <XCircle size={14} className="text-danger" />
  }
};

/** Inline callout for context the user should read before acting. */
export const Notice: React.FC<{
  tone?: Exclude<Tone, "neutral">;
  title?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}> = ({ tone = "info", title, action, className, children }) => (
  <div
    role={tone === "danger" ? "alert" : undefined}
    className={cn(
      "flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border px-3 py-2.5 text-xs",
      NOTICE_TONE[tone].box,
      className
    )}
  >
    <span className="mt-px shrink-0">{NOTICE_TONE[tone].icon}</span>
    <div className="min-w-0 flex-1 space-y-0.5 leading-relaxed">
      {title && <p className="font-medium text-neutral-200">{title}</p>}
      {children}
    </div>
    {/* Phones: the action drops under the text instead of squeezing it. */}
    {action && <div className="shrink-0 self-center max-sm:basis-full max-sm:pl-6">{action}</div>}
  </div>
);

/** Centered placeholder for an empty list, with an optional call to action. */
export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}> = ({ icon, title, description, action, className }) => (
  <div className={cn("flex flex-col items-center gap-2 px-4 py-8 text-center", className)}>
    {icon && (
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
        {icon}
      </span>
    )}
    <p className="text-sm text-neutral-300">{title}</p>
    {description && <p className="max-w-sm text-xs leading-relaxed text-neutral-500">{description}</p>}
    {action && <div className="pt-1">{action}</div>}
  </div>
);

/** Label + control stack for forms inside settings (connect account, etc.). */
export const FormField: React.FC<{
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ label, hint, htmlFor, className, children }) => (
  <div className={cn("space-y-1.5", className)}>
    <label htmlFor={htmlFor} className="block text-xs font-medium text-neutral-300">
      {label}
    </label>
    {children}
    {hint && <p className="text-[11px] leading-relaxed text-neutral-500">{hint}</p>}
  </div>
);
