// Geometry of the Usage view's trend chart: a "nice" y scale, monotone cubic curves
// (smooth, but never overshooting the data: no dip below zero, no bump above a peak),
// and the line and area paths, in a fixed viewBox the SVG stretches to its box.

export const CHART_WIDTH = 960;
export const CHART_HEIGHT = 260;
/** Headroom so the top gridline and a peak's stroke aren't clipped. */
export const CHART_TOP = 8;
/** Target number of intervals on the y axis. */
const TICK_COUNT = 4;

export interface ChartPoint {
  x: number;
  y: number;
}

export interface CurveSegment {
  from: ChartPoint;
  c1: ChartPoint;
  c2: ChartPoint;
  to: ChartPoint;
}

export interface ChartScale {
  max: number;
  ticks: number[];
}

/** Ticks 0, step, 2·step … covering `peak`, with a 1/2/5 × 10ⁿ step for ~`count` intervals. */
export function niceScale(peak: number, count = TICK_COUNT): ChartScale {
  if (!(peak > 0) || !Number.isFinite(peak)) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= max + step * 1e-6; i += 1) ticks.push(i * step);
  return { max, ticks };
}

/** The y (in viewBox units) of `value` on a scale topping out at `max`. */
export function valueToY(value: number, max: number): number {
  return max <= 0 ? CHART_HEIGHT : CHART_HEIGHT - (value / max) * (CHART_HEIGHT - CHART_TOP);
}

/**
 * Hermite tangents that keep each segment monotone (Fritsch–Carlson): flat at local
 * extrema and on flat runs, and scaled down where they would overshoot.
 */
function monotoneTangents(points: readonly ChartPoint[]): number[] {
  const n = points.length;
  if (n < 2) return new Array<number>(n).fill(0);
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    slopes.push(dx === 0 ? 0 : (points[i + 1]!.y - points[i]!.y) / dx);
  }
  const t = new Array<number>(n).fill(0);
  t[0] = slopes[0]!;
  t[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    const before = slopes[i - 1]!;
    const after = slopes[i]!;
    t[i] = before * after <= 0 ? 0 : (before + after) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    const s = slopes[i]!;
    if (s === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / s;
    const b = t[i + 1]! / s;
    const m = a * a + b * b;
    if (m > 9) {
      const k = 3 / Math.sqrt(m);
      t[i] = k * a * s;
      t[i + 1] = k * b * s;
    }
  }
  return t;
}

/** Cubic Bézier segments through `points` (x ascending) that never leave each segment's y range. */
function monotoneCurve(points: readonly ChartPoint[]): CurveSegment[] {
  if (points.length < 2) return [];
  const t = monotoneTangents(points);
  const out: CurveSegment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    out.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + (t[i]! * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - (t[i + 1]! * dx) / 3 },
      to
    });
  }
  return out;
}

const f = (v: number) => (Math.round(v * 100) / 100).toString();

/** The SVG path of a curve; a single point draws as a flat line across the plot. */
export function linePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M0,${f(points[0]!.y)} L${CHART_WIDTH},${f(points[0]!.y)}`;
  const segments = monotoneCurve(points);
  let d = `M${f(segments[0]!.from.x)},${f(segments[0]!.from.y)}`;
  for (const s of segments) d += ` C${f(s.c1.x)},${f(s.c1.y)} ${f(s.c2.x)},${f(s.c2.y)} ${f(s.to.x)},${f(s.to.y)}`;
  return d;
}

/** The line closed down to the baseline, for the translucent fill under it. */
export function areaPath(line: string): string {
  return line === "" ? "" : `${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`;
}

export interface ChartSeriesInput {
  id: string;
  values: readonly number[];
}

export interface ChartSeriesPath {
  id: string;
  total: number;
  line: string;
  area: string;
}

export interface ChartGeometry {
  scale: ChartScale;
  /** Horizontal distance between periods (0 with fewer than two). */
  stepX: number;
  /** Largest window total first, so it draws underneath and smaller series stay visible. */
  paths: ChartSeriesPath[];
}

/**
 * Overlaid series, each anchored at zero, on one scale over the largest single-series
 * value (summing would waste plot height: the series are not stacked).
 */
export function buildChart(series: readonly ChartSeriesInput[], periods: number): ChartGeometry {
  let peak = 0;
  for (const s of series) for (const v of s.values) if (v > peak) peak = v;
  const scale = niceScale(peak);
  const stepX = periods < 2 ? 0 : CHART_WIDTH / (periods - 1);
  const paths = series.map((s) => {
    const points = Array.from({ length: periods }, (_, i) => ({ x: i * stepX, y: valueToY(s.values[i] ?? 0, scale.max) }));
    const line = linePath(points);
    return { id: s.id, total: s.values.reduce((sum, v) => sum + v, 0), line, area: areaPath(line) };
  });
  paths.sort((a, b) => b.total - a.total);
  return { scale, stepX, paths };
}

/** The period nearest to a pointer at `fraction` (0–1) of the plot's width. */
export function nearestPeriod(fraction: number, periods: number): number {
  if (periods <= 1) return 0;
  const i = Math.round(Math.min(1, Math.max(0, fraction)) * (periods - 1));
  return Math.min(periods - 1, Math.max(0, i));
}

/**
 * Where the tooltip goes: right of / below the pointer by `gap`, flipped left / above when
 * it would overflow the plot, then clamped inside it.
 */
export function tooltipPosition(
  pointer: ChartPoint,
  tooltip: { width: number; height: number },
  plot: { width: number; height: number },
  gap = 12
): ChartPoint {
  const left = pointer.x + gap + tooltip.width <= plot.width ? pointer.x + gap : pointer.x - gap - tooltip.width;
  const top = pointer.y + gap + tooltip.height <= plot.height ? pointer.y + gap : pointer.y - gap - tooltip.height;
  return {
    x: Math.min(Math.max(0, left), Math.max(0, plot.width - tooltip.width)),
    y: Math.min(Math.max(0, top), Math.max(0, plot.height - tooltip.height))
  };
}
