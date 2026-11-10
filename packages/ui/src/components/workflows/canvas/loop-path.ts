/**
 * How a loop edge is drawn (spec 2026-11-10 §7.4): it leaves its output to
 * the right, climbs to a lane above every card between its two ends, runs
 * back left along it and drops into the target's input — so it never cuts
 * through the cards of the loop body. Nested loops get higher lanes (an
 * outer loop wraps an inner one). Pure: the edge component feeds it the
 * handle points and the boxes React Flow measured.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room between the highest card under a loop and its lane. */
export const LOOP_CLEARANCE = 30;
/** Room between nested loops' lanes. */
export const LOOP_LEVEL_STEP = 18;
/** How far the path runs straight out of the output and into the input. */
export const LOOP_STUB = 22;

/** An SVG path through `points`, its corners rounded by up to `radius` (less where segments are short). */
export function roundedPolyline(points: readonly Point[], radius: number): string {
  if (points.length === 0) return "";
  const at = (point: Point): string => `${round(point.x)} ${round(point.y)}`;
  let path = `M ${at(points[0]!)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const corner = points[index]!;
    const next = points[index + 1]!;
    const before = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const after = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, before / 2, after / 2);
    if (r <= 0.5) {
      path += ` L ${at(corner)}`;
      continue;
    }
    const enter = { x: corner.x + ((previous.x - corner.x) / before) * r, y: corner.y + ((previous.y - corner.y) / before) * r };
    const leave = { x: corner.x + ((next.x - corner.x) / after) * r, y: corner.y + ((next.y - corner.y) / after) * r };
    path += ` L ${at(enter)} Q ${at(corner)} ${at(leave)}`;
  }
  path += ` L ${at(points[points.length - 1]!)}`;
  return path;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The lane's height: above the highest box that overlaps the span between the
 * two ends horizontally (and above both ends), raised by its nesting `level`.
 */
export function loopLane(source: Point, target: Point, boxes: readonly Box[], level = 0): number {
  const left = Math.min(source.x, target.x) - LOOP_STUB;
  const right = Math.max(source.x, target.x) + LOOP_STUB;
  let top = Math.min(source.y, target.y);
  for (const box of boxes) {
    if (box.x + box.width < left || box.x > right) continue;
    top = Math.min(top, box.y);
  }
  return top - LOOP_CLEARANCE - level * LOOP_LEVEL_STEP;
}

/** The path from an output (`source`, on a card's right) back to an input (`target`, on a card's left) along `laneY`. */
export function loopEdgePath(
  source: Point,
  target: Point,
  laneY: number,
  options: { radius?: number; stub?: number } = {}
): { path: string; labelX: number; labelY: number } {
  const stub = options.stub ?? LOOP_STUB;
  const outX = source.x + stub;
  const inX = target.x - stub;
  const points: Point[] = [source, { x: outX, y: source.y }, { x: outX, y: laneY }, { x: inX, y: laneY }, { x: inX, y: target.y }, target];
  return { path: roundedPolyline(points, options.radius ?? 14), labelX: (outX + inX) / 2, labelY: laneY };
}

/**
 * Each loop edge's nesting level: how many other loops it wraps (their span
 * lies within its own), so outer lanes run above inner ones. Spans are the
 * x-ranges between the two ends; equal spans are stacked in list order.
 */
export function loopLevels(spans: readonly { id: string; from: number; to: number }[]): Record<string, number> {
  const levels: Record<string, number> = {};
  spans.forEach((span, index) => {
    const lo = Math.min(span.from, span.to);
    const hi = Math.max(span.from, span.to);
    let level = 0;
    spans.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const oLo = Math.min(other.from, other.to);
      const oHi = Math.max(other.from, other.to);
      const inside = oLo >= lo && oHi <= hi;
      const same = oLo === lo && oHi === hi;
      if (inside && (!same || otherIndex < index)) level += 1;
    });
    levels[span.id] = level;
  });
  return levels;
}
