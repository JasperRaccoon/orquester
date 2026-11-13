import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import type { StorageNode } from "@orquester/api";

/**
 * Pure half of the storage map (Settings → Host status → Storage): the
 * squarified layout, the colour of every tile, hit-testing and label fitting.
 * Free of React and of the canvas so it can be asserted with plain
 * `node --test`; `StorageTreemap.tsx` only paints what this decides.
 */

export type StorageMapMode = "light" | "dark";

/** How a tile is painted. */
export type TileRole =
  /** A dir whose children are drawn inside it: only its header and padding show. */
  | "frame"
  /** A dir drawn as one block (its children were not fetched, or it is empty). */
  | "dir"
  | "file"
  /** `smaller` / `other`: flat grey. */
  | "folded"
  /** `unaccounted`, or a dir gdu could not read: grey with diagonal hatching. */
  | "hatched";

export interface TileColors {
  /** Base fill. */
  fill: string;
  /** Cushion highlight (top-left) and shadow (bottom-right); equal to `fill` for flat tiles. */
  light: string;
  dark: string;
  /** Hatch stroke for `hatched` tiles and unreadable frames, else null. */
  hatch: string | null;
  /** Ink for a label drawn on this tile. */
  text: string;
  /** Secondary ink (the size line) on this tile. */
  textMuted: string;
}

export interface TreemapTile {
  node: StorageNode;
  /** 0 = the response root (the canvas itself), 1 = its children, … */
  depth: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Height of the folder's label strip; 0 when the tile has no header. */
  header: number;
  role: TileRole;
  colors: TileColors;
  parent: TreemapTile | null;
  /** Children that are big enough to draw, in layout order. */
  children: TreemapTile[];
}

export interface TreemapLayout {
  width: number;
  height: number;
  root: TreemapTile;
  /** Every drawable tile below the root, parents before their children (paint order). */
  tiles: TreemapTile[];
}

/** Label strip on a folder big enough to name. */
export const HEADER_HEIGHT = 16;
const HEADER_MIN_WIDTH = 56;
const HEADER_MIN_HEIGHT = 44;
/** Frame padding around a folder's children (left, right, bottom; top when no header). */
const FRAME_PADDING = 2;
/** Folders smaller than this on either side get no padding: their children fill them. */
const FRAME_MIN_SIDE = 10;
/** A tile narrower or shorter than this (CSS px) is not drawn, nor hit, nor descended into. */
const MIN_DRAWN_SIDE = 0.5;

/** Synthetic kinds have no path of their own and nothing to open. */
export function isSynthetic(node: StorageNode): boolean {
  return node.kind === "smaller" || node.kind === "other" || node.kind === "unaccounted";
}

/** A folder the shell can zoom into: a real dir with something inside it. */
export function isOpenable(node: StorageNode): boolean {
  return node.kind === "dir" && node.hasChildren;
}

/** Children sorted biggest first (the wire already does; a stale or hand-built tree may not). */
export function sortedChildren(node: StorageNode): StorageNode[] {
  return [...(node.children ?? [])].sort((a, b) => size(b) - size(a));
}

function size(node: StorageNode): number {
  return Number.isFinite(node.sizeBytes) && node.sizeBytes > 0 ? node.sizeBytes : 0;
}

// ---------------------------------------------------------------- colour

/**
 * Categorical hues (OKLCH hue angles) in a fixed order — blue, orange, aqua,
 * amber, magenta, green, violet, red — the dataviz reference order, which keeps
 * neighbours apart for colour-blind readers. Lightness and chroma are chosen
 * per mode and per role below, so every hue sits at the same perceived weight.
 */
const HUES = [255, 50, 175, 85, 350, 140, 295, 22] as const;

/**
 * Hue slot per top-level child of `root`, biggest first; synthetic children
 * (grey) take no slot. Colour follows the folder: the same tree always paints
 * the same way, and the list beneath the map uses the same slots.
 */
export function hueSlots(root: StorageNode): Map<StorageNode, number> {
  const slots = new Map<StorageNode, number>();
  let next = 0;
  for (const child of sortedChildren(root)) {
    if (!isSynthetic(child)) slots.set(child, next++);
  }
  return slots;
}

/** OKLCH (L 0–1, C, h degrees) → "#rrggbb", clamped into sRGB. */
export function oklchToHex(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  ];
  return `#${linear
    .map((v) => {
      const x = Math.max(0, Math.min(1, v));
      const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/**
 * A small stable shade step in [-1, 1] (seven levels) from a name, so
 * neighbouring siblings of one hue stay apart.
 */
function jitter(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 7) - 3) / 3;
}

interface Tone {
  l: number;
  c: number;
}

/** Lightness/chroma per role and mode. Frames sit darker than the blocks inside them in both modes. */
function tone(role: "frame" | "dir" | "file", depth: number, mode: StorageMapMode): Tone {
  const nest = Math.max(0, Math.min(depth, 8) - 1);
  if (mode === "dark") {
    if (role === "frame") return { l: Math.min(0.5, 0.36 + 0.045 * nest), c: 0.075 };
    if (role === "dir") return { l: 0.57, c: 0.105 };
    return { l: 0.65, c: 0.095 };
  }
  if (role === "frame") return { l: Math.min(0.74, 0.6 + 0.045 * nest), c: 0.09 };
  if (role === "dir") return { l: 0.74, c: 0.1 };
  return { l: 0.83, c: 0.075 };
}

const INK_DARK = "#0b0b0c";
const INK_LIGHT = "#fafafa";

function inkFor(l: number): { text: string; textMuted: string } {
  return l >= 0.6
    ? { text: INK_DARK, textMuted: "rgba(11,11,12,0.68)" }
    : { text: INK_LIGHT, textMuted: "rgba(250,250,250,0.72)" };
}

function cushion(l: number, c: number, h: number, flat: boolean): Pick<TileColors, "fill" | "light" | "dark"> {
  const fill = oklchToHex(l, c, h);
  if (flat) return { fill, light: fill, dark: fill };
  return { fill, light: oklchToHex(Math.min(0.97, l + 0.055), c * 0.95, h), dark: oklchToHex(Math.max(0, l - 0.07), c, h) };
}

const colorCache = new Map<string, TileColors>();

/** Colours of one tile. `slot` is its top-level ancestor's hue slot (see {@link hueSlots}). */
export function tileColors(
  node: StorageNode,
  role: TileRole,
  depth: number,
  slot: number | undefined,
  mode: StorageMapMode
): TileColors {
  const grey = role === "folded" || role === "hatched" || slot === undefined;
  const j = !grey && depth > 1 ? jitter(node.name) : 0;
  const unreadableFrame = role === "frame" && node.kind === "dir" && node.unreadable === true;
  // Past the eighth folder the hues come round again, shifted and a step darker.
  const hueIndex = grey ? 0 : slot % HUES.length;
  const repeat = !grey && slot >= HUES.length;
  // Thousands of tiles share a few hundred colours: compute each once.
  const key = grey
    ? `${mode}|${role === "hatched" ? "hatched" : "grey"}`
    : `${mode}|${role}|${Math.min(depth, 8)}|${hueIndex}|${repeat}|${j}|${unreadableFrame}`;
  const cached = colorCache.get(key);
  if (cached) return cached;
  let colors: TileColors;
  if (grey) {
    const l = role === "hatched" ? (mode === "dark" ? 0.31 : 0.89) : mode === "dark" ? 0.44 : 0.8;
    colors = {
      ...cushion(l, 0, 0, true),
      hatch: role === "hatched" ? oklchToHex(mode === "dark" ? 0.43 : 0.76, 0, 0) : null,
      ...inkFor(l)
    };
  } else {
    const { l, c } = tone(role === "frame" ? "frame" : role === "dir" ? "dir" : "file", depth, mode);
    const hue = HUES[hueIndex]! + j * 9 + (repeat ? 18 : 0);
    const shade = l + j * 0.03 - (repeat ? 0.06 : 0);
    // An unreadable folder still drawn with its readable contents: its own strip is hatched over its hue.
    const hatch = unreadableFrame ? (mode === "dark" ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.22)") : null;
    colors = { ...cushion(shade, c, hue, role === "frame"), hatch, ...inkFor(shade) };
  }
  colorCache.set(key, colors);
  return colors;
}

/** Swatch for a list row: the colour its block has at the top of the map. */
export function swatchColor(node: StorageNode, slot: number | undefined, mode: StorageMapMode): string {
  // The tone of the blocks inside a folder, not its darker frame: that is the colour the eye takes from the map.
  const role = roleOf(node, false);
  return tileColors(node, role === "hatched" && node.kind === "dir" && node.children?.length ? "dir" : role, 1, slot, mode).fill;
}

function roleOf(node: StorageNode, drawsChildren: boolean): TileRole {
  if (node.kind === "unaccounted" || (node.kind === "dir" && node.unreadable && !drawsChildren)) return "hatched";
  if (node.kind === "smaller" || node.kind === "other") return "folded";
  if (node.kind === "dir") return drawsChildren ? "frame" : "dir";
  return "file";
}

// ---------------------------------------------------------------- layout

/**
 * Squarified, nested layout of `root` in a `width`×`height` box (CSS px).
 * Area ∝ `sizeBytes`; a dir whose children add up to less than its size keeps
 * the rest as its own frame area. Tiles too small to see are dropped together
 * with everything below them.
 */
export function layoutTreemap(root: StorageNode, width: number, height: number, mode: StorageMapMode): TreemapLayout {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const h = Number.isFinite(height) ? Math.max(0, height) : 0;
  const empty: TreemapTile = {
    node: root,
    depth: 0,
    x0: 0,
    y0: 0,
    x1: w,
    y1: h,
    header: 0,
    role: "frame",
    colors: tileColors(root, "folded", 0, undefined, mode),
    parent: null,
    children: []
  };
  const h0 = hierarchy(root, (n) => (n.kind === "dir" && n.children?.length ? sortedChildren(n) : null)).sum((n) => {
    const own = size(n);
    if (n.kind !== "dir" || !n.children?.length) return own;
    const inside = n.children.reduce((total, child) => total + size(child), 0);
    return Math.max(0, own - inside);
  });
  if (w < 1 || h < 1 || !(h0.value! > 0)) {
    return { width: w, height: h, root: empty, tiles: [] };
  }

  const roomy = (n: HierarchyRectangularNode<StorageNode>) =>
    n.x1 - n.x0 >= FRAME_MIN_SIDE && n.y1 - n.y0 >= FRAME_MIN_SIDE;
  const hasHeader = (n: HierarchyRectangularNode<StorageNode>) =>
    n.depth > 0 && n.x1 - n.x0 >= HEADER_MIN_WIDTH && n.y1 - n.y0 >= HEADER_MIN_HEIGHT;
  const pad = (n: HierarchyRectangularNode<StorageNode>) => (n.depth === 0 || !roomy(n) ? 0 : FRAME_PADDING);

  const laidOut = treemap<StorageNode>()
    .tile(treemapSquarify)
    .size([w, h])
    .paddingInner((n) => (n.depth === 0 ? 2 : roomy(n) ? 1 : 0))
    .paddingTop((n) => (hasHeader(n) ? HEADER_HEIGHT : pad(n)))
    .paddingLeft(pad)
    .paddingRight(pad)
    .paddingBottom(pad)(h0);

  const slots = hueSlots(root);
  const tiles: TreemapTile[] = [];
  const rootTile: TreemapTile = { ...empty, x0: laidOut.x0, y0: laidOut.y0, x1: laidOut.x1, y1: laidOut.y1 };

  const visit = (n: HierarchyRectangularNode<StorageNode>, parent: TreemapTile, slot: number | undefined) => {
    for (const child of n.children ?? []) {
      if (child.x1 - child.x0 < MIN_DRAWN_SIDE || child.y1 - child.y0 < MIN_DRAWN_SIDE) continue;
      const childSlot = child.depth === 1 ? slots.get(child.data) : slot;
      const drawsChildren = Boolean(child.children?.length);
      const role = roleOf(child.data, drawsChildren);
      const tile: TreemapTile = {
        node: child.data,
        depth: child.depth,
        x0: child.x0,
        y0: child.y0,
        x1: child.x1,
        y1: child.y1,
        header: drawsChildren && hasHeader(child) ? HEADER_HEIGHT : 0,
        role,
        colors: tileColors(child.data, role, child.depth, childSlot, mode),
        parent,
        children: []
      };
      parent.children.push(tile);
      tiles.push(tile);
      visit(child, tile, childSlot);
    }
  };
  visit(laidOut, rootTile, undefined);
  return { width: w, height: h, root: rootTile, tiles };
}

/** The deepest drawn tile under (x, y) in CSS px, or null over the root's gaps or outside. */
export function hitTest(layout: TreemapLayout, x: number, y: number): TreemapTile | null {
  let found: TreemapTile | null = null;
  let level: TreemapTile[] = layout.root.children;
  for (;;) {
    const next = level.find((t) => x >= t.x0 && x < t.x1 && y >= t.y0 && y < t.y1);
    if (!next) return found;
    found = next;
    level = next.children;
  }
}

// ---------------------------------------------------------------- labels

export type Measure = (text: string) => number;

/**
 * `text` cut with an ellipsis to fit `maxWidth`, or null when not even a
 * couple of characters would fit (a stub like "…" says nothing).
 */
export function fitLabel(text: string, maxWidth: number, measure: Measure, minChars = 2): string | null {
  if (!(maxWidth > 0) || !text) return null;
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo >= Math.min(minChars, text.length) ? `${text.slice(0, lo).trimEnd()}…` : null;
}

export interface TileLabel {
  /** Name line (fitted), drawn at the tile's top-left. */
  name: string;
  /** Size, beside the name in a header strip or on the second line of a block; null when it does not fit. */
  size: string | null;
  /** True for a folder header: one line, size right-aligned. */
  inHeader: boolean;
}

const LABEL_PAD_X = 4;
const BLOCK_MIN_WIDTH = 30;
const BLOCK_NAME_HEIGHT = 15;
const BLOCK_TWO_LINE_HEIGHT = 28;

/** What text a tile carries, if any: only what fits, cut with an ellipsis. */
export function tileLabel(tile: TreemapTile, sizeText: string, measure: Measure): TileLabel | null {
  const width = tile.x1 - tile.x0 - LABEL_PAD_X * 2;
  const height = tile.y1 - tile.y0;
  if (tile.header > 0) {
    const sizeWidth = measure(sizeText);
    const name = fitLabel(tile.node.name, width - sizeWidth - 8, measure);
    if (name) return { name, size: sizeText, inHeader: true };
    const alone = fitLabel(tile.node.name, width, measure);
    return alone ? { name: alone, size: null, inHeader: true } : null;
  }
  if (tile.role === "frame" || tile.x1 - tile.x0 < BLOCK_MIN_WIDTH || height < BLOCK_NAME_HEIGHT) return null;
  const name = fitLabel(tile.node.name, width, measure);
  if (!name) return null;
  const sizeFits = height >= BLOCK_TWO_LINE_HEIGHT && measure(sizeText) <= width;
  return { name, size: sizeFits ? sizeText : null, inHeader: false };
}

// ---------------------------------------------------------------- text

/** Share of the root ("41%", "3.2%", "<0.1%"); null when the root has no size. */
export function formatShare(part: number, whole: number): string | null {
  if (!(whole > 0) || !Number.isFinite(part)) return null;
  const pct = (Math.max(0, part) / whole) * 100;
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(Math.min(100, pct))}%`;
}

/** "1 item" / "12,345 items". */
export function formatItems(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return `${n.toLocaleString("en-US")} item${n === 1 ? "" : "s"}`;
}

/** One-line description of what a synthetic or unreadable entry is, or null for a plain entry. */
export function nodeNote(node: StorageNode): string | null {
  switch (node.kind) {
    case "unaccounted":
      return "Used space the scan could not read — other users' files, /home and /root hidden from the service.";
    case "smaller":
      return `Entries too small to keep in the scan, folded together (${formatItems(node.items)} inside).`;
    case "other":
      return `Entries too small to draw at this zoom, folded together (${formatItems(node.items)} inside).`;
    default:
      return node.kind === "dir" && node.unreadable
        ? "Not fully readable — part of its contents is missing from this size."
        : null;
  }
}
