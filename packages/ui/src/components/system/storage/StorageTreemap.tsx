import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StorageNode } from "@orquester/api";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { formatBytes } from "../system-format";
import {
  formatItems,
  formatShare,
  hitTest,
  isOpenable,
  layoutTreemap,
  nodeNote,
  sortedChildren,
  tileLabel,
  type StorageMapMode,
  type TreemapLayout,
  type TreemapTile
} from "./storage-treemap.logic";

export interface StorageMapProps {
  /** Response root; `children` populated a few levels deep (nested dirs may have their own `children`). */
  root: StorageNode;
  /** A `dir` node was activated (click / Enter): the shell zooms into it. */
  onOpen: (node: StorageNode) => void;
  /** Right-click (or the context-menu key / Shift+F10 in the list) on any node; client coordinates. */
  onContextMenu: (node: StorageNode, at: { x: number; y: number }) => void;
  className?: string;
}

const FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const HEADER_FONT = `600 11px ${FONT_FAMILY}`;
const NAME_FONT = `500 11px ${FONT_FAMILY}`;
const SIZE_FONT = `400 10px ${FONT_FAMILY}`;
const TOOLTIP_OFFSET = 14;

/** Rounds a CSS-px edge onto the device pixel grid so tile borders stay crisp. */
const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

function hatchPattern(ctx: CanvasRenderingContext2D, fill: string | null, stroke: string): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const t = tile.getContext("2d");
  if (!t) return null;
  if (fill) {
    t.fillStyle = fill;
    t.fillRect(0, 0, 8, 8);
  }
  t.strokeStyle = stroke;
  t.lineWidth = 1.25;
  t.beginPath();
  for (const offset of [-8, 0, 8]) {
    t.moveTo(offset, 8);
    t.lineTo(offset + 8, 0);
  }
  t.stroke();
  return ctx.createPattern(tile, "repeat");
}

function paintTiles(ctx: CanvasRenderingContext2D, layout: TreemapLayout, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = "middle";
  const patterns = new Map<string, CanvasPattern | null>();
  const measure = (text: string) => ctx.measureText(text).width;

  for (const tile of layout.tiles) {
    const x = snap(tile.x0, dpr);
    const y = snap(tile.y0, dpr);
    const w = Math.max(1 / dpr, snap(tile.x1, dpr) - x);
    const h = Math.max(1 / dpr, snap(tile.y1, dpr) - y);
    const { colors } = tile;

    if (colors.light !== colors.dark && w > 3 && h > 3) {
      // WizTree's cushion, kept subtle: lit from the top-left.
      const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
      gradient.addColorStop(0, colors.light);
      gradient.addColorStop(0.45, colors.fill);
      gradient.addColorStop(1, colors.dark);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = colors.fill;
    }
    ctx.fillRect(x, y, w, h);

    if (colors.hatch) {
      const key = `${tile.role === "frame" ? "" : colors.fill}|${colors.hatch}`;
      if (!patterns.has(key)) patterns.set(key, hatchPattern(ctx, tile.role === "frame" ? null : colors.fill, colors.hatch));
      const pattern = patterns.get(key);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(x, y, w, h);
      }
    }

    const sizeText = formatBytes(tile.node.sizeBytes);
    ctx.font = tile.header > 0 ? HEADER_FONT : NAME_FONT;
    const label = tileLabel(tile, sizeText, measure);
    if (!label) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (label.inHeader) {
      const mid = y + tile.header / 2 + 0.5;
      ctx.fillStyle = colors.text;
      ctx.textAlign = "left";
      ctx.fillText(label.name, x + 4, mid);
      if (label.size) {
        ctx.font = SIZE_FONT;
        ctx.fillStyle = colors.textMuted;
        ctx.textAlign = "right";
        ctx.fillText(label.size, x + w - 4, mid);
      }
    } else {
      ctx.fillStyle = colors.text;
      ctx.textAlign = "left";
      ctx.fillText(label.name, x + 4, y + 9.5);
      if (label.size) {
        ctx.font = SIZE_FONT;
        ctx.fillStyle = colors.textMuted;
        ctx.fillText(label.size, x + 4, y + 22.5);
      }
    }
    ctx.restore();
  }
}

function paintHighlight(
  ctx: CanvasRenderingContext2D,
  layout: TreemapLayout,
  dpr: number,
  mode: StorageMapMode,
  hovered: TreemapTile | null,
  selected: TreemapTile | null
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);
  const ring = (tile: TreemapTile, width: number, color: string) => {
    const x = snap(tile.x0, dpr);
    const y = snap(tile.y0, dpr);
    const w = snap(tile.x1, dpr) - x;
    const h = snap(tile.y1, dpr) - y;
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    const inset = width / 2;
    ctx.strokeRect(x + inset, y + inset, Math.max(0, w - width), Math.max(0, h - width));
  };
  if (selected) ring(selected, 2, mode === "dark" ? "#fafafa" : "#0b0b0c");
  if (hovered) {
    const x = snap(hovered.x0, dpr);
    const y = snap(hovered.y0, dpr);
    ctx.fillStyle = mode === "dark" ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.34)";
    ctx.fillRect(x, y, snap(hovered.x1, dpr) - x, snap(hovered.y1, dpr) - y);
    if (hovered !== selected) ring(hovered, 1, mode === "dark" ? "rgba(255,255,255,0.85)" : "rgba(11,11,12,0.7)");
  }
}

/** Tracks the element's content box; zero until the first observation. */
function useElementSize(ref: React.RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number, height: number) =>
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    apply(el.clientWidth, el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) apply(Math.floor(box.width), Math.floor(box.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): void {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

/**
 * The pointer in map coordinates: relative to the container's padding box,
 * where the absolutely placed canvases and tooltip start — inside its border.
 */
function mapPoint(box: HTMLElement | null, event: { clientX: number; clientY: number }): { x: number; y: number } | null {
  if (!box) return null;
  const rect = box.getBoundingClientRect();
  return { x: event.clientX - rect.left - box.clientLeft, y: event.clientY - rect.top - box.clientTop };
}

function summary(root: StorageNode): string {
  const top = sortedChildren(root)
    .slice(0, 5)
    .map((child) => `${child.name} ${formatBytes(child.sizeBytes)}`);
  return `Storage map of ${root.name}, ${formatBytes(root.sizeBytes)}${top.length ? `. Largest: ${top.join(", ")}` : ""}. Use the list below to navigate.`;
}

/**
 * WizTree-style treemap of one directory: every level present in `root` is
 * nested inside its parent, area by disk usage, one hue per top-level entry.
 * Painted on a canvas (thousands of tiles), with hover drawn on a second
 * canvas above it so moving the pointer never repaints the map.
 */
export const StorageTreemap: React.FC<StorageMapProps> = ({ root, onOpen, onContextMenu, className }) => {
  const mode = useAppStore((s) => s.resolvedMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(containerRef);
  const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;

  const layout = useMemo(() => layoutTreemap(root, width, height, mode), [root, width, height, mode]);
  const [hovered, setHovered] = useState<StorageNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<StorageNode | null>(null);

  useEffect(() => {
    setSelectedNode(null);
    setHovered(null);
  }, [root]);

  // A new layout replaces every tile object; keep pointing at the same entries.
  const selected = useMemo(
    () => (selectedNode ? (layout.tiles.find((t) => t.node === selectedNode) ?? null) : null),
    [layout, selectedNode]
  );
  const hoveredTile = useMemo(
    () => (hovered ? (layout.tiles.find((t) => t.node === hovered) ?? null) : null),
    [layout, hovered]
  );

  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    sizeCanvas(canvas, layout.width, layout.height, dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) paintTiles(ctx, layout, dpr);
  }, [layout, dpr]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    sizeCanvas(canvas, layout.width, layout.height, dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) paintHighlight(ctx, layout, dpr, mode, hoveredTile, selected);
  }, [layout, dpr, mode, hoveredTile, selected]);

  const tileAt = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const at = mapPoint(containerRef.current, event);
      return at ? hitTest(layout, at.x, at.y) : null;
    },
    [layout]
  );

  const pointer = useRef({ x: 0, y: 0 });
  const placeTooltip = useCallback(() => {
    const tip = tooltipRef.current;
    const box = containerRef.current;
    if (!tip || !box) return;
    const { x, y } = pointer.current;
    const right = x + TOOLTIP_OFFSET + tip.offsetWidth > box.clientWidth;
    const below = y + TOOLTIP_OFFSET + tip.offsetHeight > box.clientHeight;
    const left = right ? x - TOOLTIP_OFFSET - tip.offsetWidth : x + TOOLTIP_OFFSET;
    const top = below ? y - TOOLTIP_OFFSET - tip.offsetHeight : y + TOOLTIP_OFFSET;
    tip.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }, []);
  // New content changes the tooltip's size: re-place it once it has rendered.
  useLayoutEffect(placeTooltip, [hoveredTile, placeTooltip]);

  const onPointerMove = (event: React.PointerEvent) => {
    const tile = tileAt(event);
    const at = mapPoint(containerRef.current, event);
    if (at) pointer.current = at;
    if ((tile?.node ?? null) !== hovered) setHovered(tile?.node ?? null);
    placeTooltip();
  };

  const onClick = (event: React.MouseEvent) => {
    const tile = tileAt(event);
    if (!tile) return;
    if (isOpenable(tile.node)) onOpen(tile.node);
    else setSelectedNode(tile.node);
  };

  const onRightClick = (event: React.MouseEvent) => {
    event.preventDefault();
    const tile = tileAt(event);
    if (!tile) return;
    setSelectedNode(tile.node);
    onContextMenu(tile.node, { x: event.clientX, y: event.clientY });
  };

  const tip = hoveredTile?.node;
  const note = tip ? nodeNote(tip) : null;
  const share = tip ? formatShare(tip.sizeBytes, root.sizeBytes) : null;
  const tipPath = tip && (tip.kind === "dir" || tip.kind === "file") ? tip.path : null;

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full select-none overflow-hidden rounded-lg bg-neutral-950", className)}
      style={{ cursor: hoveredTile && isOpenable(hoveredTile.node) ? "pointer" : "default" }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHovered(null)}
      onClick={onClick}
      onContextMenu={onRightClick}
    >
      <canvas
        ref={baseRef}
        role="img"
        aria-label={summary(root)}
        className="absolute left-0 top-0"
        style={{ width: layout.width, height: layout.height }}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        style={{ width: layout.width, height: layout.height }}
      />
      <div
        ref={tooltipRef}
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0 top-0 z-10 w-max max-w-[min(22rem,calc(100%-8px))] rounded-lg border border-neutral-700/80 bg-neutral-900/95 px-2.5 py-2 text-xs shadow-xl shadow-black/30 backdrop-blur-sm",
          !tip && "invisible"
        )}
      >
        {tip && (
          <>
            <div className="truncate font-medium text-neutral-100">{tip.name}</div>
            {tipPath && <div className="mt-0.5 break-all font-mono text-[11px] leading-snug text-neutral-400">{tipPath}</div>}
            <div className="mt-1.5 flex items-baseline gap-2 tabular-nums">
              <span className="font-semibold text-neutral-100">{formatBytes(tip.sizeBytes)}</span>
              {share && <span className="text-neutral-400">{share} of {root.name}</span>}
              {tip.kind === "dir" && <span className="text-neutral-500">{formatItems(tip.items)}</span>}
            </div>
            {note && <p className="mt-1.5 max-w-[18rem] leading-snug text-neutral-400">{note}</p>}
            {isOpenable(tip) && <p className="mt-1.5 text-[11px] text-neutral-500">Click to open · right-click for actions</p>}
          </>
        )}
      </div>
    </div>
  );
};
