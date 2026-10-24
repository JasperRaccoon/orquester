/**
 * Finding the row the reading position is anchored to (§7.2, §7.3).
 *
 * The naive version — walk every `[data-timeline-row-id]` calling
 * `getBoundingClientRect()` until one's bottom clears the viewport top — is
 * O(rows) **forced layout flushes per scroll event**. There is no virtualiser
 * (§7.3 starts plain on purpose), so on a thread at the retention cap that is
 * ~2 500 rect reads per scroll tick, and scrolling near the bottom is the worst
 * case because the loop breaks only after passing everything above the
 * viewport.
 *
 * Rows are laid out in document order, so their offsets are monotonically
 * non-decreasing and a **binary search** answers the same question in
 * O(log rows) reads. This module is the pure half so the search itself is
 * testable without a DOM.
 */

import type { Turn } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow, RememberedTimelinePosition } from "../../../lib/agent-chat/contracts";
import { rowTurnId } from "../../../lib/agent-chat/history.logic";

/** What the search needs to know about one child of the rows container. */
export interface RowMetric {
  /** Offset of the row's top edge from the top of the scrollable content. */
  top: number;
  height: number;
}

/**
 * The index of the first visible row, read through a lazy accessor.
 * Returns -1 for an empty list and the last index beyond the content.
 *
 * It matters that this **never materialises every metric**: reading `offsetTop`
 * on one element flushes layout once, and then only the ~log₂(n) probed
 * elements are touched. Building an array of all of them first would put the
 * O(rows) cost straight back.
 */
export function findFirstVisibleIndex(
  count: number,
  metricAt: (index: number) => RowMetric,
  scrollTop: number
): number {
  if (count === 0) return -1;
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = metricAt(mid);
    if (row.top + row.height > scrollTop) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found === -1 ? count - 1 : found;
}

/**
 * How far into that row the viewport top sits. Never negative: a row that
 * starts below the fold is anchored at its own top.
 */
export function offsetWithinRow(row: RowMetric, scrollTop: number): number {
  return Math.max(0, scrollTop - row.top);
}

/** The two things {@link scrollRowTo} reads off a scroller — a structural type, so it runs without a DOM. */
export interface ScrollHost {
  scrollTop: number;
  getBoundingClientRect(): { top: number };
}

/**
 * Scroll so the viewport's top edge sits `offset` px into `row` — a negative
 * offset leaves the row's top that far BELOW the edge.
 *
 * Measured against where the row is NOW and written as an absolute target, so
 * whatever moved above it (a history page prepended, the load row going away)
 * is absorbed exactly once — including when the browser's own scroll
 * anchoring has already moved the scroll for us (design 2026-09-23 "Client").
 */
export function scrollRowTo(
  scroller: ScrollHost,
  row: { getBoundingClientRect(): { top: number } },
  offset: number
): void {
  const rowTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop = scroller.scrollTop + rowTop + offset;
}

/** The rendered element of a timeline row, or null (not rendered, or no `CSS.escape` here). */
export function findRowElement(scroller: ParentNode, rowId: string): HTMLElement | null {
  // `CSS.escape` is not universal (and absent in a non-DOM render): a row id
  // we cannot safely quote is simply not found, rather than throwing inside a
  // layout effect.
  if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
    return null;
  }
  return scroller.querySelector<HTMLElement>(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
}

/** What a restore reads off the remembered reading position. */
export type RememberedScroll = Pick<
  RememberedTimelinePosition,
  "rowId" | "turnId" | "offsetWithinRow" | "scrollOffset"
>;

/** The prompt that opened `turnId`, as the fold names it; null for none. */
export function promptIdOfTurn(turns: readonly Turn[], turnId: string): string | null {
  return turns.find((turn) => turn.turnId === turnId)?.userMessageId ?? null;
}

/**
 * The turn a restore whose row is gone should page back in: the remembered
 * row's turn, when the list holds rows but not that turn — none of it, or
 * only rows kept out of it without its prompt (the stream's bounded snapshot
 * keeps a few; retention too) — so the pixel offset would land in some other
 * turn. `null` otherwise: a drill-in (it has no history), a list not painted
 * yet, a row of no remembered turn, or a turn the list shows with its prompt,
 * where the offset is the better guess.
 */
export function restoreTurnOf(
  scroll: { readonly turnId?: string | undefined },
  rows: readonly AgentChatTimelineRow[],
  agentId: string | undefined,
  promptOf: (turnId: string) => string | null = () => null
): string | null {
  const turnId = scroll.turnId;
  if (agentId !== undefined || turnId === undefined || rows.length === 0) return null;
  if (!rows.some((row) => rowTurnId(row) === turnId)) return turnId;
  const promptId = promptOf(turnId);
  return promptId === null || rows.some((row) => row.kind === "message" && row.id === promptId) ? null : turnId;
}
