import React from "react";
import { ClipboardList, Download, Minimize2 } from "lucide-react";

import { cn } from "../../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { COMPACTING_LABEL, compactionLabel, planFileName, proposedPlanTitle } from "../row-format";
import { ChatIconButton, CopyButton, DisclosureChevron, WorkingIndicator } from "../../primitives";
import { useTimelineRowContext } from "../context";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { ChangedFilesCard } from "./ChangedFilesCard";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

/**
 * A hairline that carries a centred label: "everything above this was
 * summarised".
 *
 * Three markers exist and only two reach this row: `compacted` is this
 * hairline, `compaction-failed` is the same hairline in the danger tone with
 * the provider's own reason under it — the conversation is *unchanged* after a
 * failure and the user has to be able to tell that from a successful one —
 * and `compacting` never projects a row at all (it is the live placeholder's
 * label; see `rows.logic.ts`).
 *
 * A successful marker also **carries the provider's summary**, and this row is
 * the only place it can be read: after a compaction it is the agent's entire
 * memory of the conversation above, and everything else is gone. Collapsed by
 * default, exactly as the CLI's own `ctrl+o` keeps it — the marker is a
 * divider, not a wall of text — and rendered as markdown, because that is what
 * the provider wrote. A summary long enough to have met §5.6's wire cap says
 * so and offers the full read (`GET …/items/:itemId`, the same path a
 * truncated tool output uses).
 */
export const CompactionRow = React.memo(function CompactionRow({
  row
}: {
  row: Row<"context-compaction">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const label = compactionLabel(row);
  const failed = row.failed === true;
  const summary = failed ? undefined : row.summary;
  const expanded = ctx.isExpanded(row.id);
  return (
    <div className={cn("text-xs", failed ? "text-danger" : "text-neutral-500")}>
      <div role="separator" aria-label={label} className="ac-hairline py-1">
        <span className="flex shrink-0 items-center gap-1.5">
          <Minimize2 size={12} strokeWidth={1.8} aria-hidden />
          {label}
          {summary !== undefined ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => ctx.setExpanded(row.id, !expanded)}
              className="rounded px-1 text-[11px] text-neutral-500 underline-offset-2 transition-colors hover:text-neutral-200 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              {expanded ? "Hide summary" : "Show summary"}
            </button>
          ) : null}
        </span>
      </div>
      {failed && row.detail ? (
        <p className="select-text whitespace-pre-wrap px-1 pb-0.5 text-center leading-relaxed">
          {row.detail}
        </p>
      ) : null}
      {summary !== undefined && expanded ? (
        <div className="mb-1 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
          <ChatMarkdown text={summary} onOpenFile={ctx.onOpenFile} />
          {row.summaryTruncated === true ? (
            <button
              type="button"
              onClick={() => ctx.onLoadFullOutput(row.id)}
              className="mt-2 rounded text-[11px] text-neutral-500 transition-colors hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              Load the full summary
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * The user's own `/compact` submission (§4.6.5(b)).
 *
 * The host persists the command verbatim as a user message so the thread's
 * record is exactly what was sent; the timeline re-recognises it by string
 * comparison and renders **a compaction marker rather than a bubble** — a
 * literal `/compact` speech bubble reads as the user talking to the agent,
 * which is the one thing it is not.
 *
 * The marker that follows it carries the before/after token counts, so this one
 * deliberately says only that the compaction was asked for: request, then
 * result. It is styled as the same hairline so the pair reads as one event.
 * *T3: `ChatView.tsx:735-738` (`isCompactCommandMessage`) excludes the message
 * and places the marker in its stead.*
 */
export const CompactRequestRow = React.memo(function CompactRequestRow({
  row
}: {
  row: Row<"message">;
}): React.ReactElement {
  void row;
  return (
    <div
      role="separator"
      aria-label="Compaction requested"
      className="ac-hairline py-1 text-xs text-neutral-500"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <Minimize2 size={12} strokeWidth={1.8} aria-hidden />
        Compaction requested
      </span>
    </div>
  );
});

/** The settled-turn fold: "Worked for 3m 12s". */
export const TurnFoldRow = React.memo(function TurnFoldRow({
  row
}: {
  row: Row<"turn-fold">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-neutral-800 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={() => ctx.setTurnExpanded(row.turnId, !row.expanded)}
        className="ac-tabular flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-neutral-500 transition-colors hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        <span>{row.label}</span>
        <DisclosureChevron open={row.expanded} size={14} />
      </button>
    </div>
  );
});

/**
 * The working row: the turn is alive.
 *
 * **One element, label replaced.** The `starting → running → tool name`
 * progression is a text swap inside a stable span, never a remount — remounting
 * restarts the shimmer and re-measures the line, so the handoff stutters. The
 * compaction phase is the same swap: `Working for 31s` becomes
 * `Compacting context…` in place, in the span that is already there.
 * *T3: `MessagesTimeline.tsx:2510-2530` — "one span for every label".*
 *
 * A compaction also **drops the elapsed ticker** and grows an indeterminate
 * bar. The timer is the honest readout for a turn whose rows keep arriving; a
 * compaction produces no rows for minutes, so a climbing number beside a
 * frozen timeline is exactly what made the owner think the thread had hung.
 * The bar says "still moving" without pretending to know how far along it is.
 */
export const WorkingRow = React.memo(function WorkingRow({
  row
}: {
  row: Row<"working">;
}): React.ReactElement {
  const compacting = row.compacting === true;
  return (
    <WorkingIndicator
      divider
      live
      progress={compacting}
      icon={compacting ? <Minimize2 size={14} strokeWidth={1.8} aria-hidden /> : undefined}
      label={compacting ? COMPACTING_LABEL : row.createdAt === null ? "Working…" : "Working for"}
      startedAt={compacting ? undefined : row.createdAt}
    />
  );
});

/**
 * Reserves the activity row's height while nothing has arrived yet.
 *
 * **Silent during a compaction.** The working row above it is already saying
 * `Compacting context…` with the bar under it; a second live label repeating
 * the same fact reads as two things happening at once. The box stays so the
 * timeline does not jump when the phase ends and `Thinking` comes back.
 * *T3: `MessagesTimeline.tsx:2684-2690` (`ThinkingTimelineRow`) does exactly
 * this — it renders `null` inside the reserved height while `isCompacting`.*
 */
export const ThinkingRow = React.memo(function ThinkingRow({
  row
}: {
  row: Row<"thinking">;
}): React.ReactElement {
  return (
    <div className="min-h-7">
      {row.compacting === true ? null : <WorkingIndicator live label="Thinking" />}
    </div>
  );
});

/** The end-of-turn changed-files card. */
export const TurnDiffRow = React.memo(function TurnDiffRow({
  row
}: {
  row: Row<"turn-diff">;
}): React.ReactElement | null {
  if (row.files.length === 0) return null;
  return <ChangedFilesCard turnCount={row.turnCount} files={row.files} />;
});

// ---------------------------------------------------------------------------
// The plan proposal card
// ---------------------------------------------------------------------------

const PLAN_COLLAPSE_CHARS = 900;
const PLAN_COLLAPSE_LINES = 20;

/**
 * The plan card (§7.3).
 *
 * **The approve affordance is deliberately not on the card.** A plan is
 * retired by the turn that implements it, and that turn is started from the
 * composer's split button behind the "Plan ready" banner (§7.4) — putting an
 * Approve button here would give the user two different ways to start the same
 * turn, one of which cannot carry the draft.
 * *T3: `ProposedPlanCard.tsx:36-259` — copy / download / save only.*
 *
 * DELIBERATE DIFFERENCE FROM T3: T3's third action writes the plan into the
 * workspace through its own file-write command. The timeline has no write seam
 * (`ChatTimelineProps` exposes reads and commands only), so the card offers a
 * browser download instead; the file lands wherever the user's downloads go
 * rather than in the repo.
 */
export const ProposedPlanRow = React.memo(function ProposedPlanRow({
  row
}: {
  row: Row<"proposed-plan">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const [expanded, setExpanded] = React.useState(false);
  const markdown = row.planMarkdown;
  const canCollapse = markdown.length > PLAN_COLLAPSE_CHARS || markdown.split("\n").length > PLAN_COLLAPSE_LINES;
  const title = proposedPlanTitle(markdown);

  const download = React.useCallback(() => {
    try {
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = planFileName(markdown);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // A blocked download is not worth a toast the timeline cannot raise.
    }
  }, [markdown]);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-neutral-800 px-1 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            <ClipboardList size={11} strokeWidth={1.8} aria-hidden />
            Plan
          </span>
          <h3 className="truncate text-sm font-medium text-neutral-100">{title}</h3>
          {row.implementedAt !== null ? (
            <span className="shrink-0 text-[11px] leading-4 text-neutral-500">implemented</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <CopyButton size="xs" value={markdown} label="Copy the plan" />
          <ChatIconButton size="xs" label="Download the plan as markdown" onClick={download}>
            <Download size={12} strokeWidth={1.8} aria-hidden />
          </ChatIconButton>
        </div>
      </div>
      <div className="mt-3">
        <div className={cn("relative", canCollapse && !expanded && "max-h-[26rem] overflow-hidden")}>
          <ChatMarkdown text={markdown} onOpenFile={ctx.onOpenFile} />
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-neutral-900 via-neutral-900/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
