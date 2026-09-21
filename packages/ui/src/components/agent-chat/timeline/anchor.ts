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

/** What the search needs to know about one child of the rows container. */
export interface RowMetric {
  /** Offset of the row's top edge from the top of the scrollable content. */
  top: number;
  height: number;
}

/**
 * The index of the first row whose **bottom edge** is past `scrollTop` — i.e.
 * the topmost row with any pixel visible.
 *
 * Returns `-1` for an empty list, and the last index when everything is above
 * the viewport (a scroll position past the end, which happens transiently while
 * rows are still materialising under `content-visibility: auto`).
 */
export function findFirstVisibleRowIndex(rows: readonly RowMetric[], scrollTop: number): number {
  return findFirstVisibleIndex(rows.length, (index) => rows[index] as RowMetric, scrollTop);
}

/**
 * The same search against a lazy accessor, which is the form the timeline uses.
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
