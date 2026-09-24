import React from "react";
import { MessageSquareText } from "lucide-react";
import type { ThreadSearchHit } from "@orquester/api/agent-chat";

import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/relative-time";
import { RegistryIcon } from "../../icons";
import type { ProjectSummary, RegistryKind } from "../../types";
import { searchHitKindLabel, snippetSegments, type SearchNotice } from "./conversation-search";

/** One search hit as the palette lists it. */
export interface ConversationSearchRow {
  key: string;
  hit: ThreadSearchHit;
  /** The tab's current title where this client knows the tab, else the index's. */
  title: string;
  /** Where the hit lives — also what a pick navigates to. */
  project: ProjectSummary;
  /** The tab's registry identity for its icon; null where the tab is unknown. */
  icon: { kind: RegistryKind; refId: string } | null;
}

export interface ConversationSearchResultsProps {
  rows: readonly ConversationSearchRow[];
  /** What to say instead of the rows — or, for `truncated`, under them. */
  notice: SearchNotice | null;
  highlighted: number;
  /** The option's DOM id, so the input's `aria-activedescendant` can name it. */
  optionId: (row: ConversationSearchRow) => string;
  highlightedRef?: React.Ref<HTMLButtonElement>;
  onHover: (index: number) => void;
  onSelect: (row: ConversationSearchRow) => void;
  /** Re-run a search whose request failed; offered on an `error` notice only. */
  onRetry?: () => void;
}

/** A hit's snippet with the host's `«…»` marks turned into highlights. */
function Snippet({ snippet }: { snippet: string }): React.ReactElement {
  return (
    <>
      {snippetSegments(snippet).map((segment, index) =>
        segment.match ? (
          <span key={index} data-snippet-match="" className="font-medium text-warn-300">
            {segment.text}
          </span>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        )
      )}
    </>
  );
}

/**
 * The palette's "Search conversations" results (design 2026-09-23 §C
 * "Search"): one option per hit — the thread, its project, who said it, the
 * matched words and when — or one line saying why there are none.
 */
export function ConversationSearchResults({
  rows,
  notice,
  highlighted,
  optionId,
  highlightedRef,
  onHover,
  onSelect,
  onRetry
}: ConversationSearchResultsProps): React.ReactElement {
  const blocking = notice !== null && notice.kind !== "truncated";
  return (
    <>
      {blocking ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6">
          <p data-search-notice={notice.kind} className="text-center text-xs text-neutral-500">
            {notice.text}
          </p>
          {notice.kind === "error" && onRetry !== undefined ? (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRetry}
              className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200 focus:outline-none"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {!blocking && rows.length > 0 ? (
        <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
          Conversations
        </p>
      ) : null}
      {blocking
        ? null
        : rows.map((row, index) => {
            const selected = index === highlighted;
            return (
              <button
                key={row.key}
                id={optionId(row)}
                ref={selected ? highlightedRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(row)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  selected ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
                )}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
                  {row.icon ? (
                    <RegistryIcon kind={row.icon.kind} refId={row.icon.refId} size={14} />
                  ) : (
                    <MessageSquareText size={14} aria-hidden />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                    <span className="min-w-0 shrink truncate text-xs text-neutral-500">
                      {row.project.name}
                    </span>
                    <time dateTime={row.hit.at} className="shrink-0 text-[11px] text-neutral-600">
                      {relativeTime(row.hit.at)}
                    </time>
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-neutral-400">
                    <span className="shrink-0 rounded bg-neutral-800/80 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                      {searchHitKindLabel(row.hit)}
                    </span>
                    <span className="min-w-0 truncate">
                      <Snippet snippet={row.hit.snippet} />
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
      {notice?.kind === "truncated" ? (
        <p data-search-notice="truncated" className="px-2.5 pb-1 pt-2 text-[10px] text-neutral-600">
          {notice.text}
        </p>
      ) : null}
    </>
  );
}

/**
 * The mode chip beside the input: the pointer's way into (and out of) the
 * search mode that typing `?` first enters. `tabIndex={-1}` like the rows —
 * the input stays the palette's only tab stop — and a mouse-down never takes
 * the focus away from it.
 */
export function ConversationSearchChip({
  active,
  onToggle
}: {
  active: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-pressed={active}
      aria-label="Search conversations"
      title={active ? "Back to sessions and projects" : "Search conversations (or type ? first)"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors focus:outline-none",
        active
          ? "border-neutral-600 bg-neutral-800 text-neutral-100"
          : "border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
      )}
    >
      <MessageSquareText size={12} aria-hidden />
      <span className="hidden sm:inline">Conversations</span>
    </button>
  );
}
