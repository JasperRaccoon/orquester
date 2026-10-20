/**
 * The subagent strip: the chats this one delegated tasks to in one turn (`create_session` with
 * `delegate: true`), as one live card — overlapping agent avatars, "N subagents", a status line
 * ("4 working · 1 done") and an elapsed timer while any of them works; expanded, one line per
 * child with its status, agent, model and account, its latest progress or result, and "Open".
 *
 * The row holds ids only (`delegate-group`, rows.logic); everything live comes from the children's
 * tab summaries in the store, kept fresh by the `sessions` bus. A child whose tab was closed keeps
 * its line, shown closed, with Open disabled.
 *
 * *T3: `MessagesTimeline.tsx` `V2SubagentGroup` and `V2LifecycleRow`.*
 */

import React from "react";
import { ArrowUpRight } from "lucide-react";

import { cn } from "../../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import {
  delegateGroupLabel,
  delegateGroupTiming,
  summarizeDelegateStatuses,
  type DelegateChildView
} from "../../../../lib/agent-chat/delegates.logic";
import { DisclosureChevron, ElapsedTicker, StatusDot } from "../../primitives";
import {
  DelegateAvatar,
  DelegateAvatars,
  delegateStatusVisual,
  delegateSummaryTone,
  openDelegateTab,
  useDelegateChildViews,
  useDelegateMetaLine
} from "../../delegates/DelegateParts";
import { useTimelineRowContext } from "../context";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

export const DelegateGroupRow = React.memo(function DelegateGroupRow({
  row
}: {
  row: Row<"delegate-group">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const expanded = ctx.isExpanded(row.groupId);
  const views = useDelegateChildViews(row.children);
  const statuses = views.map((view) => view.status);
  const summary = summarizeDelegateStatuses(statuses);
  const timing = delegateGroupTiming(views);
  const label = delegateGroupLabel(views.length);
  const panelId = `${row.groupId}:children`;
  // A settled group with no end any child reports claims no duration.
  const showTimer = timing.startedAt !== null && (timing.live || timing.endedAt !== null);

  return (
    <section
      aria-label={label}
      data-delegate-group={row.groupId}
      className="my-0.5 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`${label}: ${summary}`}
        onClick={() => ctx.setExpanded(row.groupId, !expanded)}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 px-2.5 py-2 text-left transition-colors",
          "hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
        )}
      >
        <DelegateAvatars refIds={views.map((view) => view.refId)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-neutral-200">{label}</span>
          <span className={cn("block truncate text-[11px]", delegateSummaryTone(statuses))}>{summary}</span>
        </span>
        {showTimer ? (
          <span className="shrink-0 font-mono text-[11px] text-neutral-500">
            <ElapsedTicker startedAt={timing.startedAt} endedAt={timing.endedAt} live={timing.live} />
          </span>
        ) : null}
        <DisclosureChevron open={expanded} />
      </button>
      {expanded ? (
        <ul id={panelId} className="flex flex-col gap-0.5 border-t border-neutral-800/80 p-1">
          {views.map((view) => (
            <DelegateChildLine key={view.ref.callId} view={view} />
          ))}
        </ul>
      ) : null}
    </section>
  );
});

/** One child: status dot, agent, title and status word, agent · model · account, preview, Open. */
function DelegateChildLine({ view }: { view: DelegateChildView }): React.ReactElement {
  const visual = delegateStatusVisual(view.status);
  const meta = useDelegateMetaLine(view);
  const threadId = view.ref.threadId;
  const openable = threadId !== null && view.status !== "closed";
  return (
    <li
      data-delegate-child={threadId ?? view.ref.callId}
      data-status={view.status}
      className={cn("flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5", view.status === "closed" && "opacity-70")}
    >
      <span className="flex h-5 shrink-0 items-center">
        <StatusDot tone={visual.tone} size="xs" pulse={visual.pulse} ping={visual.ping} label={visual.label} />
      </span>
      <DelegateAvatar refId={view.refId} className="h-5 w-5 ring-0" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-sm text-neutral-200" title={view.title}>
            {view.title}
          </span>
          <span
            className={cn(
              "shrink-0 text-[11px]",
              view.status === "needs-input"
                ? "text-warn-300"
                : view.status === "failed"
                  ? "text-danger-300"
                  : "text-neutral-500"
            )}
          >
            {visual.label}
          </span>
        </span>
        {meta ? <span className="block truncate font-mono text-[11px] text-neutral-500">{meta}</span> : null}
        {view.preview ? (
          <span className="mt-0.5 line-clamp-2 block break-words text-xs leading-relaxed text-neutral-400">{view.preview}</span>
        ) : view.status === "closed" ? (
          <span className="mt-0.5 block text-xs text-neutral-500">Its tab was closed.</span>
        ) : null}
      </span>
      <button
        type="button"
        disabled={!openable}
        onClick={() => {
          if (threadId !== null) openDelegateTab(threadId);
        }}
        title={openable ? `Open “${view.title}”` : view.status === "closed" ? "That chat's tab was closed" : "Opening the chat…"}
        aria-label={openable ? `Open ${view.title}` : `${view.title} cannot be opened`}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-0.5 rounded px-1.5 text-[11px] transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          openable
            ? "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-100"
            : "cursor-not-allowed text-neutral-600"
        )}
      >
        Open
        <ArrowUpRight size={11} strokeWidth={1.8} aria-hidden />
      </button>
    </li>
  );
}
