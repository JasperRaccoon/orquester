import React from "react";
import { TriangleAlert, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import type { DisclosureState } from "../../../lib/agent-chat/contracts";
import { useAgentChatDrillIn } from "../../../lib/agent-chat/hooks";
import { isActiveChatTab } from "../../../lib/agent-chat-active-tab";
import { resolveChatShortcut } from "../../../lib/agent-chat/keybindings.logic";
import { peekThreadStore } from "../../../lib/agent-chat/store";
import type { ChatTimelineProps, TimelineScrollPosition } from "../contracts";
import { ChatIconButton, ScrollToBottomButton } from "../primitives";
import { TimelineRowContext, type TimelineRowContextValue } from "./context";
import { TimelineRow } from "./TimelineRow";
import { findFirstVisibleIndex, offsetWithinRow, type RowMetric } from "./anchor";
import { nextFollowState, shouldAnimateFollow } from "./follow";

/**
 * How long a scroll settles before its position is written into the §7.2 LRU.
 *
 * Long enough that a flick is one write instead of sixty, short enough that a
 * tab switch a moment after scrolling still records where the user was — and
 * the pending write is flushed on unmount regardless, so nothing is lost.
 */
const REMEMBER_SCROLL_DEBOUNCE_MS = 200;

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
  // Two surfaces, one component. The drill-in sources its rows from the
  // per-agent projection (§7.6) rather than from the `rows` prop, so the
  // subscription that projection needs is not paid for by the parent
  // timeline — hence a separate component rather than a conditional hook.
  // The branch is fixed per mount site (W15 never passes `agentId`, W14
  // always does), so nothing remounts.
  return props.agentId === undefined ? (
    <TimelineSurface {...props} rows={props.rows} />
  ) : (
    <DrillInTimeline {...props} agentId={props.agentId} />
  );
}

/**
 * The drill-in's rows come from `useAgentChatDrillIn`, which reuses the
 * parent's slice and holds its own projection so a streamed token in the
 * child's timeline changes one row object — exactly as in the parent. Filtering
 * the parent's already-projected rows here would rebuild the whole list on
 * every frame and would lose the per-agent turn grouping.
 */
function DrillInTimeline(props: ChatTimelineProps & { agentId: string }): React.ReactElement {
  const { rows } = useAgentChatDrillIn(props.sessionId, props.agentId);
  // The projection is the source of truth; the prop is the fallback for a
  // caller that already resolved the child's rows another way, so a surface
  // that has rows never renders the empty state because the hook has none.
  return <TimelineSurface {...props} rows={rows.length > 0 ? rows : props.rows} readOnly />;
}

function TimelineSurface(props: ChatTimelineProps): React.ReactElement {
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
    skills,
    projectPath,
    scroll,
    onScrollPositionChange
  } = props;

  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  /**
   * Until when a scroll event is **ours**, not the user's.
   *
   * This is load-bearing for the smooth follow: a `behavior: "smooth"` scroll
   * fires scroll events for its whole animation, and every intermediate frame
   * is outside the 40 px band — so without this window, animating the follow
   * would disarm the follow. A real gesture (wheel, touch, a key in the
   * scroller) clears the window immediately, so the user always wins.
   */
  const ignoreScrollUntilRef = React.useRef(0);
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
      skills: skills ?? [],
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
      roster,
      skills
    ]
  );

  // -------------------------------------------------------------------------
  // Follow
  // -------------------------------------------------------------------------

  const scrollToEnd = React.useCallback((animate: boolean) => {
    const node = scrollerRef.current;
    if (!node) return;
    // A smooth scroll animates for a few hundred ms and fires a scroll event
    // per frame; an instant one fires exactly one, on the next tick.
    ignoreScrollUntilRef.current = Date.now() + (animate ? 700 : 80);
    node.scrollTo({ top: node.scrollHeight, behavior: animate ? "smooth" : "auto" });
  }, []);

  /** Any real gesture ends the window at once: the user outranks the follow. */
  const releaseScrollSuppression = React.useCallback(() => {
    ignoreScrollUntilRef.current = 0;
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

  /**
   * Writes the reading position through W11's store action, debounced.
   *
   * The `onScrollPositionChange` prop feeds the shell's own paint-hold copy;
   * **this** is what lands in the §7.2 100-entry LRU. Two rules:
   *
   *  - it is debounced, so a flick is one write rather than sixty, and the
   *    pending write is flushed on unmount so leaving a tab still records where
   *    the user was;
   *  - a **drill-in never writes**. The child view reuses the parent's slice,
   *    so recording the child's scroll offset would overwrite the parent
   *    thread's remembered position with a position in a different list.
   */
  const pendingScroll = React.useRef<TimelineScrollPosition | null>(null);
  const rememberTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushRememberScroll = React.useCallback(() => {
    if (rememberTimer.current !== null) {
      clearTimeout(rememberTimer.current);
      rememberTimer.current = null;
    }
    const position = pendingScroll.current;
    pendingScroll.current = null;
    if (position === null) return;
    // Read the store at call time rather than subscribing: a scroll must not
    // re-render the timeline, and the actions object is stable anyway.
    peekThreadStore(sessionId)?.getState().actions.rememberScroll(position);
  }, [sessionId]);

  const rememberScroll = React.useCallback(
    (position: TimelineScrollPosition) => {
      if (agentId !== undefined) return;
      pendingScroll.current = position;
      if (rememberTimer.current !== null) return;
      rememberTimer.current = setTimeout(() => {
        rememberTimer.current = null;
        flushRememberScroll();
      }, REMEMBER_SCROLL_DEBOUNCE_MS);
    },
    [agentId, flushRememberScroll]
  );

  // Flush on unmount and on a thread switch, so the outgoing thread's last
  // position is the one that is remembered.
  React.useEffect(() => flushRememberScroll, [flushRememberScroll]);

  /**
   * The anchor row, found by binary search over the rows container's children.
   *
   * The children are in document order and `offsetTop` is monotonic, so this
   * reads O(log rows) offsets instead of calling `getBoundingClientRect()` on
   * every row above the viewport (Q2-6). `offsetTop` is relative to a shared
   * `offsetParent`, so the container's own offset is subtracted rather than
   * assumed to be zero. The two spacers carry no row id; the walk forward past
   * them is bounded by their count, not by the row count.
   */
  const anchorAtOffset = React.useCallback(
    (scrollOffset: number): { rowId: string | null; offsetWithinRow: number } => {
      const container = contentRef.current;
      if (!container) return { rowId: null, offsetWithinRow: 0 };
      const children = container.children;
      const base = container.offsetTop;
      const metricAt = (index: number): RowMetric => {
        const element = children[index] as HTMLElement;
        return { top: element.offsetTop - base, height: element.offsetHeight };
      };
      let index = findFirstVisibleIndex(children.length, metricAt, scrollOffset);
      if (index < 0) return { rowId: null, offsetWithinRow: 0 };
      // Land on a real row, never on a spacer.
      while (index < children.length) {
        const element = children[index] as HTMLElement;
        const rowId = element.dataset["timelineRowId"];
        if (rowId !== undefined) {
          return { rowId, offsetWithinRow: offsetWithinRow(metricAt(index), scrollOffset) };
        }
        index += 1;
      }
      return { rowId: null, offsetWithinRow: 0 };
    },
    []
  );

  const publishPosition = React.useCallback(
    (scrollOffset: number, atEnd: boolean) => {
      const anchor = anchorAtOffset(scrollOffset);
      const position: TimelineScrollPosition = {
        rowId: anchor.rowId,
        offsetWithinRow: anchor.offsetWithinRow,
        scrollOffset,
        atEnd
      };
      onScrollPositionChange?.(position);
      rememberScroll(position);
    },
    [anchorAtOffset, onScrollPositionChange, rememberScroll]
  );

  /**
   * One measurement per animation frame, never one per scroll event.
   *
   * A flick fires scroll events far faster than the compositor paints, and each
   * measurement forces a layout flush; coalescing to a frame is the difference
   * between a smooth flick and a janky one (Q2-6). The follow flag is
   * consequently decided from the frame's position, which is the one the user
   * actually sees.
   */
  const scrollFrame = React.useRef<number | null>(null);

  const measureScroll = React.useCallback(() => {
    const metrics = readMetrics();
    if (metrics === null) return;
    const next = nextFollowState(metrics);
    if (next !== follow) onFollowChange(next);
    publishPosition(metrics.scroll, next);
  }, [follow, onFollowChange, publishPosition, readMetrics]);

  const handleScroll = React.useCallback(() => {
    if (Date.now() < ignoreScrollUntilRef.current) return;
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      measureScroll();
    });
  }, [measureScroll]);

  React.useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    },
    []
  );

  // Restore the remembered reading position on mount and on every thread
  // switch. A thread that was left at the end is re-pinned to the end rather
  // than to its old pixel offset, because its content has grown since.
  React.useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    ignoreScrollUntilRef.current = Date.now() + 80;
    if (!scroll || scroll.atEnd) {
      node.scrollTop = node.scrollHeight;
    } else if (scroll.rowId !== null) {
      // `CSS.escape` is not universal (and absent in a non-DOM render): a row
      // id we cannot safely quote falls back to the pixel offset rather than
      // throwing inside a layout effect.
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(scroll.rowId)
          : null;
      const target =
        escaped === null
          ? null
          : node.querySelector<HTMLElement>(`[data-timeline-row-id="${escaped}"]`);
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

  /**
   * `mod+J` — the keyboard half of the scroll-to-end pill (R7-8).
   *
   * The shared table has always resolved this chord; nothing implemented it, so
   * the composer advertised a shortcut that did nothing. It re-arms follow
   * through the same `reArmFollow` the pill uses, because §7.3 wants exactly
   * one place that scrolls the user back.
   *
   * **It acts only for the visible tab.** Every chat tab stays mounted
   * (`MainView` shows and hides), so a naive `window` listener would fire once
   * per open thread. `isActiveChatTab` is the shell's answer to "am I the one
   * on screen?", and the layout check behind it covers the drill-in, which
   * mounts a second timeline for the *same* session id while the parent's is
   * still mounted — only the one with a layout box may take the chord.
   */
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (!isActiveChatTab(sessionId)) return;
      const command = resolveChatShortcut(event);
      if (command?.kind !== "scroll-to-end") return;
      const node = scrollerRef.current;
      if (!node || node.offsetParent === null) return;
      event.preventDefault();
      reArmFollow();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [reArmFollow, sessionId]);

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
        // A deliberate gesture ends the follow-scroll's own suppression window
        // immediately, so scrolling up mid-stream disarms follow on the very
        // first event rather than after the animation finishes.
        onWheel={releaseScrollSuppression}
        onTouchStart={releaseScrollSuppression}
        onKeyDown={releaseScrollSuppression}
        data-agent-chat-timeline={sessionId}
        {...(agentId === undefined ? {} : { "data-agent-id": agentId })}
        className="ac-scroll-thin ac-fade-top min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-5"
      >
        {/* One provider for the whole list, not one per row: the value is
            already memoised, and a provider per row would be N context nodes
            re-rendering on every change to it. */}
        <TimelineRowContext.Provider value={context}>
          <div ref={contentRef} className="ac-rows flex flex-col">
            <div className="h-3 shrink-0 sm:h-4" aria-hidden />
            {rows.map((row) => (
              <TimelineRow key={row.id} row={row} enter={enterFlag(row.id)} />
            ))}
            {rows.length === 0 ? (
              <div className="mx-auto w-full max-w-3xl py-12 text-center text-sm italic text-neutral-600">
                {agentId === undefined
                  ? "No messages yet."
                  : "This agent has not reported anything yet."}
              </div>
            ) : null}
            {/* The footer spacer reserves exactly what the composer overlay hides. */}
            <div aria-hidden style={{ height: bottomInset }} />
            <div className="h-3 shrink-0 sm:h-4" aria-hidden />
          </div>
        </TimelineRowContext.Provider>
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
