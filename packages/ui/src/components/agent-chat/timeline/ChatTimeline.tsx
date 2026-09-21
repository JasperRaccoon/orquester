import React from "react";
import { TriangleAlert, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import type { DisclosureState } from "../../../lib/agent-chat/contracts";
import type { ChatTimelineProps, TimelineScrollPosition } from "../contracts";
import { ChatIconButton, ScrollToBottomButton } from "../primitives";
import { TimelineRowContext, type TimelineRowContextValue } from "./context";
import { TimelineRow } from "./TimelineRow";
import { nextFollowState, shouldAnimateFollow } from "./follow";

/**
 * The timeline (spec §7.3).
 *
 * **A plain scroll container, not a virtualiser.** T3 virtualises with
 * LegendList (`recycleItems` deliberately off on the main list); with threads
 * bounded at one tab's history and no recycling benefit to reclaim, we start
 * plain and adopt a virtualiser only on evidence. `content-visibility: auto` on
 * the rows (D's `ac-rows`) gives the browser the same "skip what is off-screen"
 * hint without any of the measurement machinery.
 *
 * Three behaviours carry the feel and are easy to get subtly wrong:
 *
 *  1. **Live-follow is a render-visible flag, never a ref**, re-armed only
 *     inside a 40 px band at the bottom of the content (`follow.ts`). It re-pins
 *     on new rows, row growth and layout — but *explicitly not on footer
 *     layout*, so the composer growing never moves the messages being read.
 *  2. **The thread-level error is an overlay, not a row.** It must not change
 *     the list's content height, or an error arriving mid-read would shove the
 *     page under the pointer.
 *  3. **Rows are `memo`ised on W11's stable row identity** and read everything
 *     else from a context, so one streamed token re-renders one row.
 */
export function ChatTimeline(props: ChatTimelineProps): React.ReactElement {
  const {
    sessionId,
    rows,
    follow,
    onFollowChange,
    disclosures,
    onDisclosureChange,
    bottomInset,
    canRevert,
    onRevert,
    onOpenTurnDiff,
    onOpenFile,
    onLoadFullOutput,
    onOpenAgent,
    onSendQueuedNow,
    onReturnQueuedToComposer,
    errorBanner,
    onDismissErrorBanner,
    agentId,
    readOnly,
    roster,
    projectPath,
    scroll,
    onScrollPositionChange
  } = props;

  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Suppresses the restore effect's own scroll from being read as a user
  // gesture that would disarm follow.
  const restoringRef = React.useRef(false);
  const firstPaintRef = React.useRef(true);

  // The drill-in dispatches no commands, whether or not the caller says so.
  const effectiveReadOnly = readOnly === true || agentId !== undefined;

  // A turn is live exactly when the projection says so; nothing here re-derives
  // turn state from items (§7.2: the UI renders, it does not fold).
  const working = React.useMemo(
    () =>
      rows.some(
        (row) =>
          row.kind === "working" ||
          row.kind === "thinking" ||
          ((row.kind === "activity-group" || row.kind === "work-live") && row.active)
      ),
    [rows]
  );

  const reducedMotion = usePrefersReducedMotion();
  const enterFlag = useRowEnterFlags(rows, sessionId);

  // -------------------------------------------------------------------------
  // Disclosure plumbing
  // -------------------------------------------------------------------------

  const disclosureSets = React.useMemo(
    () => ({
      groups: new Set(disclosures.expandedGroupIds),
      reasoning: new Set(disclosures.expandedReasoningIds),
      turns: new Set(disclosures.expandedTurnIds),
      agents: new Set(disclosures.expandedAgentIds)
    }),
    [disclosures]
  );

  const patchList = React.useCallback(
    (key: keyof Pick<DisclosureState, "expandedGroupIds" | "expandedReasoningIds" | "expandedTurnIds" | "expandedAgentIds">, id: string, expanded: boolean) => {
      const current = disclosures[key];
      const next = expanded
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value) => value !== id);
      if (next !== current) onDisclosureChange({ [key]: next } as Partial<DisclosureState>);
    },
    [disclosures, onDisclosureChange]
  );

  const context = React.useMemo<TimelineRowContextValue>(
    () => ({
      workspaceRoot: projectPath,
      readOnly: effectiveReadOnly,
      canRevert,
      disclosures,
      roster: roster ?? [],
      // A tool row and an activity group both live in `expandedGroupIds`: their
      // ids come from disjoint id spaces (an activity item id and a group id),
      // so one set is enough and the store keeps one list to persist.
      isExpanded: (id) => disclosureSets.groups.has(id),
      setExpanded: (id, expanded) => patchList("expandedGroupIds", id, expanded),
      isReasoningExpanded: (id) => disclosureSets.reasoning.has(id),
      setReasoningExpanded: (id, expanded) => patchList("expandedReasoningIds", id, expanded),
      isTurnExpanded: (id) => disclosureSets.turns.has(id),
      setTurnExpanded: (id, expanded) => patchList("expandedTurnIds", id, expanded),
      isAgentRowExpanded: (id) => disclosureSets.agents.has(id),
      setAgentRowExpanded: (id, expanded) => patchList("expandedAgentIds", id, expanded),
      toolOutputOffset: (id) => disclosures.toolOutputOffsets[id] ?? 0,
      setToolOutputOffset: (id, offset) => {
        if ((disclosures.toolOutputOffsets[id] ?? 0) === offset) return;
        onDisclosureChange({
          toolOutputOffsets: { ...disclosures.toolOutputOffsets, [id]: offset }
        });
      },
      onRevert: effectiveReadOnly ? NOOP_NUMBER : onRevert,
      onOpenTurnDiff,
      onOpenFile,
      onLoadFullOutput,
      onOpenAgent,
      onSendQueuedNow: effectiveReadOnly ? NOOP_STRING : onSendQueuedNow,
      onReturnQueuedToComposer: effectiveReadOnly ? NOOP_STRING : onReturnQueuedToComposer
    }),
    [
      canRevert,
      disclosureSets,
      disclosures,
      effectiveReadOnly,
      onLoadFullOutput,
      onOpenAgent,
      onOpenFile,
      onOpenTurnDiff,
      onRevert,
      onReturnQueuedToComposer,
      onSendQueuedNow,
      patchList,
      projectPath,
      roster
    ]
  );

  // -------------------------------------------------------------------------
  // Follow
  // -------------------------------------------------------------------------

  const scrollToEnd = React.useCallback((animate: boolean) => {
    const node = scrollerRef.current;
    if (!node) return;
    restoringRef.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: animate ? "smooth" : "auto" });
    // One frame is enough: the flag only has to survive this scroll's own event.
    requestAnimationFrame(() => {
      restoringRef.current = false;
    });
  }, []);

  const readMetrics = React.useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return null;
    return {
      contentLength: node.scrollHeight,
      scroll: node.scrollTop,
      scrollLength: node.clientHeight
    };
  }, []);

  const publishPosition = React.useCallback(
    (scrollOffset: number, atEnd: boolean) => {
      if (!onScrollPositionChange) return;
      const node = scrollerRef.current;
      let rowId: string | null = null;
      let offsetWithinRow = 0;
      if (node) {
        const top = node.getBoundingClientRect().top;
        for (const element of node.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
          const box = element.getBoundingClientRect();
          if (box.bottom > top) {
            rowId = element.dataset["timelineRowId"] ?? null;
            offsetWithinRow = Math.max(0, top - box.top);
            break;
          }
        }
      }
      const position: TimelineScrollPosition = { rowId, offsetWithinRow, scrollOffset, atEnd };
      onScrollPositionChange(position);
    },
    [onScrollPositionChange]
  );

  const handleScroll = React.useCallback(() => {
    if (restoringRef.current) return;
    const metrics = readMetrics();
    if (metrics === null) return;
    const next = nextFollowState(metrics);
    if (next !== follow) onFollowChange(next);
    publishPosition(metrics.scroll, next);
  }, [follow, onFollowChange, publishPosition, readMetrics]);

  // Restore the remembered reading position on mount and on every thread
  // switch. A thread that was left at the end is re-pinned to the end rather
  // than to its old pixel offset, because its content has grown since.
  React.useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    restoringRef.current = true;
    if (!scroll || scroll.atEnd) {
      node.scrollTop = node.scrollHeight;
    } else if (scroll.rowId !== null) {
      const target = node.querySelector<HTMLElement>(
        `[data-timeline-row-id="${CSS.escape(scroll.rowId)}"]`
      );
      if (target) {
        node.scrollTop =
          node.scrollTop + (target.getBoundingClientRect().top - node.getBoundingClientRect().top) - scroll.offsetWithinRow;
      } else {
        node.scrollTop = scroll.scrollOffset;
      }
    } else {
      node.scrollTop = scroll.scrollOffset;
    }
    requestAnimationFrame(() => {
      restoringRef.current = false;
      firstPaintRef.current = false;
    });
    // Only on a thread switch: a rows change must not re-run the restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentId]);

  // Re-pin on new rows. `bottomInset` is deliberately NOT a dependency — the
  // composer growing must never move the messages the user is reading (§7.3).
  React.useLayoutEffect(() => {
    if (!follow) return;
    scrollToEnd(shouldAnimateFollow({ working, reducedMotion, firstPaint: firstPaintRef.current }));
  }, [rows, follow, scrollToEnd, working, reducedMotion]);

  // Re-pin on row GROWTH and layout: a streamed paragraph grows a row that is
  // already mounted, which no render of ours observes.
  React.useEffect(() => {
    const node = contentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!follow) return;
      scrollToEnd(shouldAnimateFollow({ working, reducedMotion, firstPaint: false }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [follow, reducedMotion, scrollToEnd, working]);

  const reArmFollow = React.useCallback(() => {
    onFollowChange(true);
    scrollToEnd(false);
  }, [onFollowChange, scrollToEnd]);

  // -------------------------------------------------------------------------

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Overlaid, so an error never changes the list's content height (§7.3). */}
      {errorBanner !== null ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col px-3 pt-2 sm:px-5">
          <div className="pointer-events-auto mx-auto flex w-full max-w-3xl items-start gap-2 rounded-lg border border-danger-900/50 bg-danger-soft/40 px-2.5 py-1.5 text-xs text-danger-300 shadow-lg">
            <TriangleAlert size={12} strokeWidth={1.8} aria-hidden className="mt-0.5 shrink-0" />
            <span className="line-clamp-3 min-w-0 flex-1" title={errorBanner}>
              {errorBanner}
            </span>
            <ChatIconButton size="micro" label="Dismiss" onClick={onDismissErrorBanner}>
              <X size={12} strokeWidth={1.8} aria-hidden />
            </ChatIconButton>
          </div>
        </div>
      ) : null}

      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        data-agent-chat-timeline={sessionId}
        {...(agentId === undefined ? {} : { "data-agent-id": agentId })}
        className="ac-scroll-thin ac-fade-top min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-5"
      >
        <div ref={contentRef} className="ac-rows flex flex-col">
          <div className="h-3 shrink-0 sm:h-4" aria-hidden />
          {rows.map((row) => (
            <TimelineRowContext.Provider key={row.id} value={context}>
              <TimelineRow row={row} enter={enterFlag(row.id)} />
            </TimelineRowContext.Provider>
          ))}
          {rows.length === 0 ? (
            <div className="mx-auto w-full max-w-3xl py-12 text-center text-sm italic text-neutral-600">
              {agentId === undefined ? "No messages yet." : "This agent has not reported anything yet."}
            </div>
          ) : null}
          {/* The footer spacer reserves exactly what the composer overlay hides. */}
          <div aria-hidden style={{ height: bottomInset }} />
          <div className="h-3 shrink-0 sm:h-4" aria-hidden />
        </div>
      </div>

      {/* The single affordance that re-arms follow. Nothing else scrolls the
          user back. */}
      <ScrollToBottomButton visible={!follow} onClick={reArmFollow} bottom={bottomInset + 4} />
    </div>
  );
}

const NOOP_NUMBER = (): void => {};
const NOOP_STRING = (): void => {};

/**
 * Decides, once per row id, whether that row animates in.
 *
 * The first render of a thread is a page of history and must not replay a
 * hundred fades; every row that appears *after* it did just arrive and should
 * rise. The answer is memoised per id and never revisited, so the flag is a
 * stable prop and cannot break `TimelineRow`'s memo.
 */
function useRowEnterFlags(
  rows: readonly { id: string }[],
  sessionId: string
): (id: string) => boolean {
  const state = React.useRef<{ session: string; flags: Map<string, boolean>; primed: boolean }>({
    session: sessionId,
    flags: new Map(),
    primed: false
  });
  if (state.current.session !== sessionId) {
    state.current = { session: sessionId, flags: new Map(), primed: false };
  }
  const current = state.current;
  for (const row of rows) {
    if (!current.flags.has(row.id)) current.flags.set(row.id, current.primed);
  }
  current.primed = true;
  // Drop ids that have left, so a long-lived tab does not accumulate a flag per
  // row it ever showed.
  if (current.flags.size > rows.length * 2 + 64) {
    const live = new Set(rows.map((row) => row.id));
    for (const id of [...current.flags.keys()]) {
      if (!live.has(id)) current.flags.delete(id);
    }
  }
  return React.useCallback((id: string) => state.current.flags.get(id) === true, []);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listener = (): void => setReduced(query.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

export default ChatTimeline;
