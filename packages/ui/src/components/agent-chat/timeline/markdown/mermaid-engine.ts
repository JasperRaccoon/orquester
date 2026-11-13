// Adapted from T3 Code (MIT): apps/web/src/components/chat/MermaidDiagram.tsx
// (loading pele per diagram type, and the KaTeX resolver for `$$` labels).

import type { DiagramType, MathResolver, MountOptions, Mounted } from "pele/lazy";

import { KATEX_OPTIONS } from "./math";
import { loadMathEngine } from "./math-typeset";

/**
 * Loading the diagram renderer (spec §4). `pele` draws Mermaid syntax to SVG
 * synchronously, with no runtime dependencies; this file only decides what to
 * download and when.
 *
 *  - **Lazy, per type.** `pele/lazy` is `import()`ed the first time a diagram
 *    is shown, and each diagram type is its own chunk, fetched by `load(type)`
 *    the first time a diagram of that type is: a chat with one flowchart loads
 *    the flowchart parser and layout and nothing else. A failed load is
 *    forgotten (here for the core, by pele for a type), so Retry fetches again.
 *  - **No queue, no cache.** Pele has no global configuration to serialise
 *    around, and its colours are CSS variables (`--pele-*`, set in
 *    `agent-chat.css`), so a theme switch repaints without a re-render.
 *  - **Math is the chat's KaTeX.** `$$…$$` labels are typeset by the same
 *    lazily loaded KaTeX as chat math (`math-typeset.ts`), as MathML, and only
 *    for a diagram that has `$$` in it.
 */

/** The part of `pele/lazy` the chat uses. */
export interface PeleEngine {
  detectType(text: string): DiagramType | null;
  registered(type: DiagramType): boolean;
  load(type: DiagramType | null): Promise<boolean>;
  mount(element: HTMLElement, text: string, options?: MountOptions): Mounted;
}

export type { DiagramType, MathResolver, MountOptions, Mounted };

const defaultLoader = (): Promise<PeleEngine> => import("pele/lazy");
let loader: () => Promise<PeleEngine> = defaultLoader;
let engine: PeleEngine | null = null;
let loading: Promise<PeleEngine> | null = null;

/** Pele's core (the detector, the mount and the shared layout), loaded once. */
export function loadPele(): Promise<PeleEngine> {
  if (engine) return Promise.resolve(engine);
  loading ??= loader().then(
    (loaded) => {
      engine = loaded;
      return loaded;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    }
  );
  return loading;
}

/** The loaded core, or `null` before {@link loadPele} has settled. */
export function loadedPele(): PeleEngine | null {
  return engine;
}

/** The diagram type the source declares, or `null` for one pele does not know. */
export function detectDiagramType(pele: PeleEngine, source: string): DiagramType | null {
  try {
    return pele.detectType(source);
  } catch {
    return null;
  }
}

/** `react-markdown` hands a fence's first info word over as `language-<word>`. */
export function isMermaidFence(language: string): boolean {
  return language.toLowerCase() === "mermaid";
}

// ---------------------------------------------------------------------------
// $$…$$ labels
// ---------------------------------------------------------------------------

/** Distinct (size, TeX) pairs kept typeset; pele asks again on every layout, resizes included. */
const MATH_CACHE_MAX_ENTRIES = 500;

/**
 * A pele `MathResolver` that also takes where to measure: `probeParent`, the
 * node its off-screen probe is appended to — `document.body` when absent.
 * Pele calls it with two arguments; a diagram binds the third
 * ({@link mathProbeParentOf}).
 */
export type ChatMathResolver = (tex: string, size: number, probeParent?: ParentNode) => ReturnType<MathResolver>;

let mathResolver: ChatMathResolver | null = null;
let mathLoading: Promise<ChatMathResolver | null> | null = null;

/**
 * Where a diagram drawn into `node` measures its labels: the shadow root it
 * renders in — an embedded chat must not write into its host page's body —
 * else the document's body, as always.
 */
export function mathProbeParentOf(node: Node): ParentNode {
  const root = node.getRootNode();
  return root.nodeType === root.DOCUMENT_FRAGMENT_NODE ? (root as ParentNode) : (node.ownerDocument ?? document).body;
}

/**
 * A pele `MathResolver` over the chat's KaTeX: the label as MathML (no CSS or
 * fonts needed), measured in an off-screen probe (one per probe parent). The
 * `<annotation>` that repeats the TeX is removed (the sanitiser would keep its
 * text). A label KaTeX cannot parse resolves to `null`, and pele shows its
 * source. Resolves to `null` when KaTeX fails to load.
 */
export function loadMathResolver(): Promise<ChatMathResolver | null> {
  if (mathResolver) return Promise.resolve(mathResolver);
  mathLoading ??= loadMathEngine().then(
    (katex) => {
      const typeset = new Map<string, ReturnType<MathResolver>>();
      const probes = new WeakMap<ParentNode, HTMLDivElement>();
      mathResolver = (tex, size, probeParent = document.body) => {
        const key = `${size}:${tex}`;
        if (typeset.has(key)) return typeset.get(key);
        let markup: ReturnType<MathResolver> = null;
        try {
          let probe = probes.get(probeParent);
          if (!probe || !probe.isConnected) {
            probe = document.createElement("div");
            probe.setAttribute("aria-hidden", "true");
            probe.style.cssText =
              "position:absolute;left:-9999px;top:0;visibility:hidden;display:inline-block;white-space:nowrap";
            probeParent.append(probe);
            probes.set(probeParent, probe);
          }
          probe.style.fontSize = `${size}px`;
          probe.innerHTML = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: true, output: "mathml" });
          const expression = probe.querySelector("math");
          expression?.querySelector("annotation")?.remove();
          if (expression) {
            const { width, height } = expression.getBoundingClientRect();
            markup = { html: expression.outerHTML, width, height };
          }
        } catch {
          // Unsupported TeX stays readable as its source.
        }
        if (typeset.size >= MATH_CACHE_MAX_ENTRIES) typeset.clear();
        typeset.set(key, markup);
        return markup;
      };
      return mathResolver;
    },
    () => {
      mathLoading = null;
      return null;
    }
  );
  return mathLoading;
}

/** The resolver, or `null` before {@link loadMathResolver} has settled. */
export function loadedMathResolver(): ChatMathResolver | null {
  return mathResolver;
}

/** Test seam: swaps how pele is loaded and forgets what was (pass `null` for the real `import()`). */
export function setPeleLoader(next: (() => Promise<PeleEngine>) | null): void {
  loader = next ?? defaultLoader;
  engine = null;
  loading = null;
}
