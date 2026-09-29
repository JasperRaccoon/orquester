/**
 * The small pieces every run component draws with: the status glyph, the tone
 * palette (semantic tokens only, so every scheme reads native), the ticking
 * clock for live durations, and the narrow API the run components call.
 */

import React, { useEffect, useState } from "react";
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleStop,
  CircleX,
  Clock3,
  Hourglass,
  Loader2,
  OctagonX,
  type LucideIcon
} from "lucide-react";

import type { ApiClient } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import type { RunTone } from "../../../lib/workflows/format";
import type { WorkflowsApi } from "../../../lib/workflows/store";
import type { StatusIcon } from "../../../lib/workflows/run-view";

/**
 * The routes the run components call: the workflows store's own (loads,
 * Run now) and the run view's — `ApiClient` satisfies it; checks pass a fake.
 */
export type WorkflowRunsApi = WorkflowsApi &
  Pick<
    ApiClient,
    | "getWorkflowNodeOutput"
    | "openWorkflowNodeLog"
    | "readWorkflowNodeLogWindow"
    | "cancelWorkflowRun"
    | "deleteWorkflowRunTempProject"
  >;

export type RunsVariant = "docked" | "sheet";

export const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export const TONE_TEXT: Record<RunTone, string> = {
  ok: "text-ok",
  danger: "text-danger",
  warn: "text-warn",
  info: "text-info",
  neutral: "text-neutral-500"
};

/** A soft tinted surface for a status pill / a selected live row. */
export const TONE_SOFT: Record<RunTone, string> = {
  ok: "bg-ok/10 text-ok ring-ok/25",
  danger: "bg-danger/10 text-danger ring-danger/30",
  warn: "bg-warn/10 text-warn ring-warn/30",
  info: "bg-info/10 text-info ring-info/30",
  neutral: "bg-neutral-800/70 text-neutral-400 ring-neutral-700/70"
};

const ICONS: Record<StatusIcon, LucideIcon> = {
  pending: CircleDashed,
  queued: Clock3,
  running: Loader2,
  waiting: Hourglass,
  succeeded: CircleCheck,
  failed: CircleX,
  skipped: CircleSlash,
  cancelled: Ban,
  stopped: CircleStop,
  interrupted: OctagonX
};

/** A status as its icon, in its tone; a running one spins (never under reduced motion). */
export const StatusGlyph: React.FC<{ icon: StatusIcon; tone: RunTone; size?: number; className?: string }> = ({
  icon,
  tone,
  size = 14,
  className
}) => {
  const Icon = ICONS[icon] ?? CircleDashed;
  return (
    <Icon
      size={size}
      aria-hidden
      className={cn(
        "shrink-0",
        TONE_TEXT[tone],
        icon === "running" && "motion-safe:animate-spin",
        icon === "waiting" && "motion-safe:animate-pulse",
        className
      )}
    />
  );
};

/**
 * A clock for live durations: every second while `live`, else every 30 s
 * (relative times). A `fixed` clock (a caller's own, or a static render) wins
 * and runs no timer.
 */
export function useNow(live: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  const pinned = fixed !== undefined;
  useEffect(() => {
    if (pinned) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), live ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [live, pinned]);
  return fixed ?? now;
}

/** A section label inside a run panel ("ACCOUNT", "HOPS"). */
export const RunSectionLabel: React.FC<{ children: React.ReactNode; className?: string; aside?: React.ReactNode }> = ({
  children,
  className,
  aside
}) => (
  <div className={cn("flex items-center gap-2 px-0.5", className)}>
    <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{children}</span>
    {aside ? <span className="ml-auto flex items-center gap-1">{aside}</span> : null}
  </div>
);

/** Text of an unknown error, for a failed action's inline message. */
export function errorText(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
