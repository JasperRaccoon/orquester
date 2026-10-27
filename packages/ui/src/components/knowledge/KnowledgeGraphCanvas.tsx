// The Knowledge view's graph canvas: Cytoscape (bundled, canvas renderer), laid
// out by a force simulation in a worker (`graph-layout.worker.ts`). Loaded with the first
// graph the Knowledge view shows, so neither library is in the app's main bundle.

import React, { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from "cytoscape";
import { Loader2, Maximize2, Minus, Plus } from "lucide-react";
import { KNOWLEDGE_COLORS, type KnowledgeColor, type KnowledgeEdge } from "@orquester/api";

import { IconButton } from "../ui";
import { cn } from "../../lib/cn";
import type { CanvasNode } from "./graph.logic";
import { knowledgeColorProperty } from "./knowledge.logic";
import { DeferredFit, FIT_PADDING, Layouts, seedPositions, warmStart, type LayoutWorkerLike } from "./graph-layout";
import LayoutWorker from "./graph-layout.worker.ts?worker";

export interface KnowledgeGraphCanvasProps {
  nodes: readonly CanvasNode[];
  edges: readonly KnowledgeEdge[];
  /** The selected concept: it, its edges and its neighbours stand out, the rest fades. */
  selectedId: string | null;
  /** Concepts to mark (search hits, the selected entry's concepts). */
  highlightIds: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  /** The view is shown (a hidden container has no size: resize when it comes back). */
  active: boolean;
}

const PIE_SLICES = 6;
/** Above this many concepts, panning draws a cached texture and hides edges. */
const BIG_GRAPH = 600;

interface Palette {
  lanes: Record<KnowledgeColor, string>;
  neutralNode: string;
  label: string;
  labelOutline: string;
  edge: string;
  edgeStrong: string;
  ring: string;
  hit: string;
}

/** `"96 165 250"` (a theme triple) → `"rgb(96,165,250)"`; fallback when the property is unset. */
function triple(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = style.getPropertyValue(name).trim();
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  return parts.length === 3 ? `rgb(${parts.join(",")})` : fallback;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const lanes = {} as Record<KnowledgeColor, string>;
  for (const color of KNOWLEDGE_COLORS) lanes[color] = triple(style, knowledgeColorProperty(color), "rgb(120,120,120)");
  return {
    lanes,
    neutralNode: triple(style, "--n-500", "rgb(115,115,115)"),
    label: triple(style, "--n-200", "rgb(229,229,229)"),
    labelOutline: triple(style, "--n-950", "rgb(10,10,10)"),
    edge: triple(style, "--n-700", "rgb(64,64,64)"),
    edgeStrong: triple(style, "--n-300", "rgb(212,212,212)"),
    ring: triple(style, "--n-100", "rgb(245,245,245)"),
    hit: triple(style, "--sem-warn-400", "rgb(251,191,36)")
  };
}

function stylesheet(p: Palette): StylesheetJson {
  const pie: Record<string, string> = {};
  for (let i = 1; i <= PIE_SLICES; i += 1) {
    pie[`pie-${i}-background-color`] = `data(c${i})`;
    pie[`pie-${i}-background-size`] = `data(p${i})`;
  }
  return [
    {
      selector: "node",
      style: {
        width: "data(size)",
        height: "data(size)",
        "background-color": "data(bg)",
        "border-width": 0,
        label: "",
        color: p.label,
        "font-size": 11,
        "text-valign": "bottom",
        "text-margin-y": 3,
        "text-outline-color": p.labelOutline,
        "text-outline-width": 2,
        "min-zoomed-font-size": 7,
        "text-max-width": "140px",
        "text-wrap": "ellipsis"
      }
    },
    { selector: "node.mixed", style: { "pie-size": "100%", ...pie } },
    { selector: "node.labelled, node.hover, node.focus, node.near, node.hit", style: { label: "data(label)" } },
    { selector: "node.hit", style: { "border-width": 2, "border-color": p.hit } },
    { selector: "node.focus", style: { "border-width": 3, "border-color": p.ring, "z-index": 10 } },
    { selector: "node.faded", style: { opacity: 0.18 } },
    {
      selector: "edge",
      style: { width: 1, "line-color": p.edge, opacity: 0.55, "curve-style": "haystack", "haystack-radius": 0 }
    },
    { selector: "edge.near", style: { width: 1.6, "line-color": p.edgeStrong, opacity: 0.95, "z-index": 9 } },
    { selector: "edge.faded", style: { opacity: 0.06 } }
  ];
}

function nodeData(node: CanvasNode, p: Palette): ElementDefinition["data"] {
  const colors = node.colors.map((c) => p.lanes[c]);
  const bg = colors[0] ?? p.neutralNode;
  const data: Record<string, string | number> = { id: node.id, label: node.label, size: node.size, bg };
  const share = colors.length > 1 ? 100 / colors.length : 0;
  for (let i = 1; i <= PIE_SLICES; i += 1) {
    data[`c${i}`] = colors[i - 1] ?? bg;
    data[`p${i}`] = i <= colors.length ? share : 0;
  }
  return data as ElementDefinition["data"];
}

const nodeClasses = (node: CanvasNode) => [node.labelled ? "labelled" : "", node.colors.length > 1 ? "mixed" : ""].filter(Boolean).join(" ");

function elementsOf(nodes: readonly CanvasNode[], edges: readonly KnowledgeEdge[], p: Palette): ElementDefinition[] {
  const out: ElementDefinition[] = nodes.map((node) => ({ group: "nodes", data: nodeData(node, p), classes: nodeClasses(node) }));
  for (const edge of edges) out.push({ group: "edges", data: { id: `e:${edge.id}`, source: edge.from, target: edge.to } });
  return out;
}

const topologyKey = (nodes: readonly CanvasNode[], edges: readonly KnowledgeEdge[]) =>
  `${nodes.map((n) => n.id).join("\u0000")}\u0001${edges.map((e) => e.id).join("\u0000")}`;

/** The layout worker, where the runtime has workers (every app target does). */
const createLayoutWorker = typeof Worker === "undefined" ? null : (): LayoutWorkerLike => new LayoutWorker() as unknown as LayoutWorkerLike;

const KnowledgeGraphCanvas: React.FC<KnowledgeGraphCanvasProps> = ({ nodes, edges, selectedId, highlightIds, onSelect, active }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const topologyRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const layoutsRef = useRef<Layouts | null>(null);
  /** Where the last finished layout (and any drag since) put each concept: the next one starts there. */
  const placedRef = useRef(new Map<string, { x: number; y: number }>());
  const fitRef = useRef(new DeferredFit());
  const [arranging, setArranging] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  // One Cytoscape instance per mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const palette = readPalette();
    paletteRef.current = palette;
    const cy = cytoscape({
      container,
      style: stylesheet(palette),
      minZoom: 0.05,
      maxZoom: 4,
      boxSelectionEnabled: false,
      autounselectify: true,
      textureOnViewport: false,
      hideEdgesOnViewport: false,
      motionBlur: false
    });
    cyRef.current = cy;
    const layouts = new Layouts(createLayoutWorker);
    layoutsRef.current = layouts;
    cy.on("tap", "node", (event) => onSelectRef.current(event.target.id() as string));
    cy.on("tap", (event) => {
      if (event.target === cy) onSelectRef.current(null);
    });
    cy.on("mouseover", "node", (event) => event.target.addClass("hover"));
    cy.on("mouseout", "node", (event) => event.target.removeClass("hover"));
    cy.on("dragfree", "node", (event) => {
      if (placedRef.current.has(event.target.id())) placedRef.current.set(event.target.id(), { ...event.target.position() });
    });

    // Theme changes (light/dark, scheme) restyle in place.
    const observer = new MutationObserver(() => {
      const next = readPalette();
      paletteRef.current = next;
      cy.style(stylesheet(next));
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const colors = (n.scratch("_kgColors") as KnowledgeColor[] | undefined) ?? [];
          const data = nodeData({ id: n.id(), label: n.data("label"), size: n.data("size"), labelled: false, colors }, next);
          n.data(data);
        });
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-scheme", "style", "class"] });

    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cy.resize();
            fitRef.current.whenSized(cy);
          });
    resize?.observe(container);
    return () => {
      observer.disconnect();
      resize?.disconnect();
      layouts.dispose();
      layoutsRef.current = null;
      cy.destroy();
      cyRef.current = null;
      topologyRef.current = null;
    };
  }, []);

  // Elements: a new topology is laid out again; the same one (a recolour) is updated in place.
  useEffect(() => {
    const cy = cyRef.current;
    const palette = paletteRef.current;
    if (!cy || !palette) return;
    const big = nodes.length > BIG_GRAPH;
    // Renderer options are read at render time; Cytoscape has no public setter for them.
    const renderer = (cy as unknown as { renderer?: () => { textureOnViewport?: boolean; hideEdgesOnViewport?: boolean } }).renderer?.();
    if (renderer) {
      renderer.textureOnViewport = big;
      renderer.hideEdgesOnViewport = big;
    }
    const key = topologyKey(nodes, edges);
    if (key === topologyRef.current) {
      cy.batch(() => {
        for (const node of nodes) {
          const element = cy.getElementById(node.id);
          element.scratch("_kgColors", node.colors);
          element.data(nodeData(node, palette));
          element.classes(nodeClasses(node));
        }
      });
      return;
    }
    topologyRef.current = key;
    const request = { nodes: nodes.map((n) => ({ id: n.id, size: n.size })), edges: edges.map((e) => ({ source: e.from, target: e.to })) };
    // The same graph grown (entries being linked): start from where it is, keep the viewport, and
    // show it meanwhile, new concepts beside their neighbours. Another graph is laid out afresh.
    const initial = warmStart(request.nodes.map((n) => n.id), placedRef.current);
    if (!initial) placedRef.current = new Map();
    const seeds = initial ? seedPositions(request.nodes, request.edges, initial) : null;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elementsOf(nodes, edges, palette));
      for (const node of nodes) {
        const element = cy.getElementById(node.id);
        element.scratch("_kgColors", node.colors);
        const at = seeds?.[node.id];
        if (at) element.position(at);
      }
    });
    const layouts = layoutsRef.current;
    layouts?.cancel();
    setLayoutError(null);
    if (nodes.length === 0 || !layouts) {
      setArranging(false);
      return;
    }
    if (!initial) setArranging(true);
    layouts.run(
      initial ? { ...request, initial } : request,
      (positions) => {
        if (cyRef.current !== cy) return;
        placedRef.current = new Map(Object.entries(positions));
        if (initial && !big) cy.layout({ name: "preset", positions, fit: false, animate: true, animationDuration: 300 }).run();
        else {
          cy.batch(() => {
            cy.nodes().forEach((n) => {
              const at = positions[n.id()];
              if (at) n.position(at);
            });
          });
        }
        if (!initial) fitRef.current.fit(cy);
        setArranging(false);
      },
      (message) => {
        if (cyRef.current !== cy) return;
        // Something is better than nothing: a grid (a warm start keeps its seeds).
        if (!initial) {
          cy.layout({ name: "grid", fit: false }).run();
          fitRef.current.fit(cy);
        }
        setLayoutError(message);
        setArranging(false);
      }
    );
  }, [nodes, edges]);

  // Selection and highlights.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("focus near faded hit");
      for (const id of highlightIds) cy.getElementById(id).addClass("hit");
      if (!selectedId) return;
      const node = cy.getElementById(selectedId);
      if (node.empty()) return;
      const hood = node.closedNeighborhood();
      cy.elements().not(hood).addClass("faded");
      hood.addClass("near");
      node.addClass("focus");
    });
  }, [selectedId, highlightIds, nodes, edges]);

  // A new selection (or the layout it waited for) brings the concept into view; a refetch does not.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedId || arranging) return;
    const node = cy.getElementById(selectedId);
    if (node.nonempty()) cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 250 });
  }, [selectedId, arranging]);

  // The view shown again: the container has its size back.
  useEffect(() => {
    const cy = cyRef.current;
    if (!active || !cy) return;
    cy.resize();
    fitRef.current.whenSized(cy);
  }, [active]);

  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className={cn("absolute inset-0 transition-opacity", arranging ? "opacity-0" : "opacity-100")} />
      {layoutError && (
        <p className="pointer-events-none absolute bottom-3 right-3 max-w-xs text-right text-[11px] text-neutral-500">
          Could not arrange the graph ({layoutError}); showing a grid.
        </p>
      )}
      {arranging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-neutral-500">
          <Loader2 size={14} className="motion-safe:animate-spin" /> Arranging {nodes.length.toLocaleString("en-US")} concepts…
        </div>
      )}
      <div className="absolute bottom-3 left-3 flex flex-col gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/90 p-0.5 shadow-sm">
        <IconButton label="Zoom in" onClick={() => zoomBy(1.25)}>
          <Plus size={14} />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => zoomBy(0.8)}>
          <Minus size={14} />
        </IconButton>
        <IconButton label="Fit the graph" onClick={() => cyRef.current?.fit(undefined, FIT_PADDING)}>
          <Maximize2 size={13} />
        </IconButton>
      </div>
    </div>
  );
};

export default KnowledgeGraphCanvas;
