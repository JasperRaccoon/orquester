// The Knowledge view's bottom bar: entry, concept and collection counts, and
// the linking state (idle, queued, "Linking N entries…" with progress, paused
// with the reason, or idle with "N entries could not be linked").

import React, { useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, Clock, Loader2, PauseCircle } from "lucide-react";
import type { KnowledgeStatus } from "@orquester/api";

import { cn } from "../../lib/cn";
import { knowledgeCountsText, linkingView } from "./knowledge.logic";

/** A display tick while a countdown is shown (not a wait). */
function useSecondTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export const KnowledgeStatusBar: React.FC<{ status: KnowledgeStatus }> = ({ status }) => {
  const now = useSecondTick(status.linking.state === "queued");
  const runs = status.lastRun ? [status.lastRun, ...status.recentRuns] : status.recentRuns;
  const view = linkingView(status.linking, runs, now, status.failedEntries);
  const icon =
    view.tone === "running" ? (
      <Loader2 size={12} className="motion-safe:animate-spin" />
    ) : view.tone === "queued" ? (
      <Clock size={12} />
    ) : view.tone === "paused" ? (
      <PauseCircle size={12} />
    ) : view.tone === "failed" ? (
      <AlertTriangle size={12} />
    ) : (
      <CircleCheck size={12} />
    );
  return (
    <div
      role="status"
      aria-label="Knowledge status"
      className="flex h-7 shrink-0 items-center gap-3 border-t border-neutral-800 bg-neutral-950 px-3 text-[11.5px] text-neutral-500"
    >
      <span className="min-w-0 truncate tabular-nums">{knowledgeCountsText(status)}</span>
      <span className="flex-1" />
      <span
        title={view.detail ?? undefined}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5",
          view.tone === "paused" || view.tone === "failed" ? "text-warn" : view.tone === "running" ? "text-neutral-300" : null
        )}
      >
        {icon}
        <span className="truncate">{view.label}</span>
        {(view.tone === "paused" || view.tone === "failed") && view.detail && (
          <span className="hidden truncate text-neutral-500 md:inline">— {view.detail}</span>
        )}
      </span>
      {view.progress !== null && (
        <span
          role="progressbar"
          aria-label="Linking progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(view.progress * 100)}
          className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-neutral-800"
        >
          <span className="block h-full rounded-full bg-neutral-300" style={{ width: `${Math.round(view.progress * 100)}%` }} />
        </span>
      )}
    </div>
  );
};
