import React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../../lib/cn";

export interface DisclosureChevronProps {
  open: boolean;
  /** 12px by default — the size every T3 disclosure chevron uses. */
  size?: number;
  className?: string;
}

/**
 * The rotating chevron. 90° clockwise on open, 200ms — never 180°, which reads
 * as a different control rather than the same one opened.
 * *T3: apps/web/src/components/chat/MessagesTimeline.tsx:2777-2782*
 */
export function DisclosureChevron({
  open,
  size = 12,
  className
}: DisclosureChevronProps): React.ReactElement {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      <ChevronRight
        size={size}
        aria-hidden
        data-open={open ? "true" : "false"}
        className={cn("ac-chevron shrink-0 text-neutral-500", className)}
      />
    </span>
  );
}

export interface DisclosurePanelProps {
  open: boolean;
  children: React.ReactNode;
  className?: string;
  /** Applied to the inner clipper, where the content's own padding belongs. */
  panelClassName?: string;
  id?: string;
}

/**
 * The animated region on its own, for rows that build their own header.
 *
 * The activity-group header, for instance, is the whole row and carries no
 * chevron at all — it only needs the panel.
 * *T3: apps/web/src/components/chat/MessagesTimeline.tsx:2661-2678*
 */
export function DisclosurePanel({
  open,
  children,
  className,
  panelClassName,
  id
}: DisclosurePanelProps): React.ReactElement {
  return (
    <div id={id} data-open={open ? "true" : "false"} className={cn("ac-disclosure", className)}>
      <div className={cn("ac-disclosure-panel", panelClassName)}>{children}</div>
    </div>
  );
}

export interface DisclosureProps {
  /** Controlled. Per spec §7.2 disclosure state belongs to the thread store. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The always-visible header content, right of the chevron. */
  summary: React.ReactNode;
  children: React.ReactNode;
  /** Hide the chevron when the row communicates its state another way. */
  chevron?: boolean;
  /** Required: what the header toggles, for assistive tech. */
  label?: string;
  className?: string;
  headerClassName?: string;
  panelClassName?: string;
  /** Rendered between the chevron and the summary — a 16px lucide glyph. */
  icon?: React.ReactNode;
}

/**
 * The expand/collapse used by every activity group, tool row and reasoning
 * block.
 *
 * DELIBERATE DIFFERENCE FROM T3: T3 measures the panel in JS and animates a
 * pixel height (`AnimatedHeight.tsx`, 200ms `ease-out`), which then needs a
 * special case to stop a nested collapsible restarting its parent's transition
 * on every frame (`index.css:615-626`). We animate `grid-template-rows:
 * 0fr → 1fr` at the same 200ms. It nests for free, and — the reason it matters
 * here — it is **height-safe while content streams**: a tool whose output grows
 * inside an open panel keeps sizing to `auto`, where a measured pixel height
 * would clip the new lines until something re-measured.
 *
 * The header is a real `<button>` with `aria-expanded`, so keyboard and screen
 * readers get the disclosure for free, and the focus ring is the house recipe.
 */
export function Disclosure({
  open,
  onOpenChange,
  summary,
  children,
  chevron = true,
  label,
  className,
  headerClassName,
  panelClassName,
  icon
}: DisclosureProps): React.ReactElement {
  const panelId = React.useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "flex min-h-6 w-full min-w-0 cursor-pointer select-none items-center gap-1.5",
          "rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed",
          "transition-colors hover:bg-neutral-800/40",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          headerClassName
        )}
      >
        {icon ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500">
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {chevron ? <DisclosureChevron open={open} /> : null}
      </button>
      <DisclosurePanel id={panelId} open={open} panelClassName={panelClassName}>
        {children}
      </DisclosurePanel>
    </div>
  );
}
