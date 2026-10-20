/**
 * A delegated chat's roster row (§7.6): a task this chat gave another chat (`create_session` with
 * `delegate: true`), listed beside the provider's own subagents in the same three-line, fixed
 * height shape — identity, its latest word, agent · model · account — with the same status dot.
 * It is a chat tab, not a task of this thread: the row opens that tab instead of a drill-in.
 */

import React from "react";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "../../../lib/cn";
import { isDelegateLive, type DelegateChildView } from "../../../lib/agent-chat/delegates.logic";
import { ElapsedTicker, StatusDot } from "../primitives";
import { DelegateAvatar, delegateStatusVisual, openDelegateTab, useDelegateMetaLine } from "../delegates/DelegateParts";

/** The grid every roster row shares (`AgentRosterRow`): changing one changes all of them. */
const ROW_GRID = cn(
  "grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto]",
  "grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left"
);

export function DelegateRosterRow({
  view,
  fading = false
}: {
  view: DelegateChildView;
  /** Rendered, but on its way out after the parent's turn settled. */
  fading?: boolean;
}): React.ReactElement {
  const visual = delegateStatusVisual(view.status);
  const meta = useDelegateMetaLine(view);
  const live = isDelegateLive(view.status);
  const threadId = view.ref.threadId;
  return (
    <button
      type="button"
      onClick={() => {
        if (threadId !== null) openDelegateTab(threadId);
      }}
      disabled={threadId === null}
      aria-label={`${view.title} — delegated chat, ${visual.label}. Open its tab`}
      data-delegate-child={threadId ?? view.ref.callId}
      data-status={view.status}
      className={cn(
        "group ac-press ac-enter",
        ROW_GRID,
        "transition-opacity duration-300 motion-reduce:transition-none",
        "hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1",
        "focus-visible:ring-inset focus-visible:ring-neutral-500",
        fading ? "pointer-events-none opacity-0" : !live && "opacity-70 hover:opacity-100"
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot tone={visual.tone} size="xs" pulse={visual.pulse} ping={visual.ping} />
      </span>

      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <DelegateAvatar refId={view.refId} className="h-4 w-4 bg-transparent ring-0" />
        <span className="min-w-0 truncate text-sm font-medium text-neutral-200">{view.title}</span>
        <span className="shrink-0 rounded-sm border border-neutral-800 px-1 font-mono text-[10px] text-neutral-500">chat</span>
      </span>

      <span className="col-start-3 row-start-1 flex items-center gap-1 text-right font-mono text-[11px] text-neutral-500">
        <span className="inline-flex min-w-14 items-center justify-end gap-1">
          <ElapsedTicker startedAt={view.startedAt} endedAt={view.endedAt} live={live} />
          {view.status === "done" ? <Check size={12} aria-hidden className="shrink-0 text-ok" /> : null}
        </span>
        <span className="flex w-3 shrink-0 items-center justify-center">
          <ChevronRight size={12} aria-hidden className="ac-reveal text-neutral-500" />
        </span>
      </span>

      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          view.status === "needs-input" ? "text-warn-300" : view.status === "failed" ? "text-danger-300" : "text-neutral-500"
        )}
      >
        {view.status === "needs-input" ? `Needs input${view.preview ? ` · ${view.preview}` : ""}` : (view.preview ?? visual.label)}
      </span>
      <span className="ac-tabular col-start-2 col-end-4 row-start-3 truncate font-mono text-[11px] text-neutral-500">
        {meta || "delegated chat"}
      </span>
      <span className="sr-only">{visual.label}</span>
    </button>
  );
}
