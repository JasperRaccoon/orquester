import React from "react";
import { ClipboardList, Download, Minimize2 } from "lucide-react";

import { cn } from "../../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { ChatIconButton, CopyButton, DisclosureChevron, WorkingIndicator } from "../../primitives";
import { useTimelineRowContext } from "../context";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { ChangedFilesCard } from "./ChangedFilesCard";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

/** Compact token counts: `128k`, `12.4k`, `840`. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = tokens / 1000;
  return thousands >= 100 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * The compaction label.
 *
 * DELIBERATE DIFFERENCE FROM T3: T3 bakes the before/after counts into the
 * label server-side and the row never sees the numbers
 * (`ProviderRuntimeIngestion.ts:863-868`). We carry `beforeTokens`/`afterTokens`
 * on the event and format here, so the same event renders in whatever unit the
 * client prefers and an older row without numbers still reads correctly.
 */
export function compactionLabel(row: Pick<Row<"context-compaction">, "label" | "beforeTokens" | "afterTokens">): string {
  const { beforeTokens, afterTokens } = row;
  if (typeof beforeTokens === "number" && typeof afterTokens === "number") {
    return `${row.label} · ${formatTokenCount(beforeTokens)} → ${formatTokenCount(afterTokens)} tokens`;
  }
  return row.label;
}

/** A hairline that carries a centred label: "everything above this was summarised". */
export const CompactionRow = React.memo(function CompactionRow({
  row
}: {
  row: Row<"context-compaction">;
}): React.ReactElement {
  const label = compactionLabel(row);
  return (
    <div role="separator" aria-label={label} className="ac-hairline py-1 text-xs text-neutral-500">
      <span className="flex shrink-0 items-center gap-1.5">
        <Minimize2 size={12} strokeWidth={1.8} aria-hidden />
        {label}
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
 * restarts the shimmer and re-measures the line, so the handoff stutters.
 */
export const WorkingRow = React.memo(function WorkingRow({
  row
}: {
  row: Row<"working">;
}): React.ReactElement {
  return (
    <WorkingIndicator
      divider
      live
      label={row.createdAt === null ? "Working…" : "Working for"}
      startedAt={row.createdAt}
    />
  );
});

/** Reserves the activity row's height while nothing has arrived yet. */
export const ThinkingRow = React.memo(function ThinkingRow(): React.ReactElement {
  return (
    <div className="min-h-7">
      <WorkingIndicator live label="Thinking" />
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

export function proposedPlanTitle(markdown: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (heading !== undefined && heading.length > 0) return heading;
  const firstLine = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine !== undefined && firstLine.length > 0 ? firstLine.slice(0, 80) : "Proposed plan";
}

export function planFileName(markdown: string): string {
  const slug = proposedPlanTitle(markdown)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug.length > 0 ? slug : "plan"}.md`;
}

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
