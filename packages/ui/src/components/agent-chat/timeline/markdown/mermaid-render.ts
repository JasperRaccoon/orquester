// Ported from T3 Code (MIT): apps/web/src/components/chat/MermaidDiagram.tsx
// (render queue, cache and hardened configuration), without its React `use()`.

/**
 * The Mermaid render pipeline, minus React and minus the DOM (spec §4).
 *
 * Mermaid is ~1 MB, so it is `import()`ed the first time a diagram is shown
 * and never otherwise. Three properties are load-bearing:
 *
 *  1. **Renders are serialised.** `mermaid.initialize()` mutates global
 *     configuration and `render()` reads it, so two diagrams rendering
 *     together with different themes would draw each other's colours.
 *  2. **Results are cached by theme + source** in a small LRU, so scrolling a
 *     long thread or re-mounting a row never re-renders. A render that is
 *     still pending is never evicted: a suspended reader must get the same
 *     promise back when React retries.
 *  3. **The engine is configured defensively.** Diagram text is untrusted
 *     model output: `securityLevel: "strict"`, no HTML labels, and a `secure`
 *     list that stops a diagram's own `%%{init: …}%%` directive from undoing
 *     any of it. The SVG then goes through a DOMPurify pass
 *     (`mermaid-svg.ts`) before it is ever mounted.
 */

export type MermaidTheme = "light" | "dark";

export type MermaidRenderResult =
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "error"; readonly message: string; readonly retryable: boolean };

/** The two members of the Mermaid API this renderer calls. */
export interface MermaidEngine {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

export interface MermaidRendererDeps {
  loadMermaid: () => Promise<MermaidEngine>;
  /** The second, DOMPurify pass over Mermaid's own output. */
  sanitize: (svg: string) => string;
  fontFamily: () => string;
  /** Mermaid leaves a scratch element behind when a render throws. */
  cleanup?: (id: string) => void;
  maxCached?: number;
}

export interface MermaidRenderer {
  /** Settled result, or the pending promise (thrown, for `Suspense`). */
  read(source: string, theme: MermaidTheme): MermaidRenderResult;
  start(source: string, theme: MermaidTheme): Promise<MermaidRenderResult>;
  /** Forgets one entry so the next read renders again (a failed load). */
  invalidate(source: string, theme: MermaidTheme): void;
  readonly size: number;
}

export const MAX_CACHED_RENDERS = 64;

/**
 * Directives that must stay fixed. `secure` keys cannot be overridden by a
 * diagram's `%%{init}%%` block. HTML labels and theme CSS are mounted while
 * Mermaid lays a diagram out, before any sanitising.
 */
export const MERMAID_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "themeCSS"
] as const;

export function mermaidConfig(theme: MermaidTheme, fontFamily: string): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    secure: [...MERMAID_SECURE_KEYS],
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: theme === "dark" ? "dark" : "default",
    fontFamily
  };
}

/** `react-markdown` hands a fence's first info word over as `language-<word>`. */
export function isMermaidFence(language: string): boolean {
  return language.toLowerCase() === "mermaid";
}

export function mermaidRenderKey(source: string, theme: MermaidTheme): string {
  return `${theme}\n${source.trim()}`;
}

/** Mermaid lazy-loads diagram chunks inside `render()`; a lost network is worth a retry, a syntax error is not. */
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script|failed to fetch/i;

export function createMermaidRenderer(deps: MermaidRendererDeps): MermaidRenderer {
  const maxCached = deps.maxCached ?? MAX_CACHED_RENDERS;
  // Map insertion order is the LRU order: a hit is deleted and re-set.
  const cache = new Map<string, Promise<MermaidRenderResult>>();
  const settled = new WeakMap<Promise<MermaidRenderResult>, MermaidRenderResult>();
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;

  async function renderNow(source: string, theme: MermaidTheme): Promise<MermaidRenderResult> {
    const id = `mermaid-diagram-${nextId++}`;
    let engine: MermaidEngine;
    try {
      engine = await deps.loadMermaid();
    } catch {
      return { status: "error", message: "Mermaid failed to load.", retryable: true };
    }
    try {
      engine.initialize(mermaidConfig(theme, deps.fontFamily()));
      const { svg } = await engine.render(id, source);
      return { status: "rendered", svg: deps.sanitize(svg) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The diagram could not be rendered.";
      return { status: "error", message, retryable: CHUNK_LOAD_ERROR.test(message) };
    } finally {
      deps.cleanup?.(id);
    }
  }

  function evictSettled(): void {
    for (const [key, promise] of cache) {
      if (cache.size <= maxCached) return;
      if (settled.has(promise)) cache.delete(key);
    }
  }

  function start(source: string, theme: MermaidTheme): Promise<MermaidRenderResult> {
    const key = mermaidRenderKey(source, theme);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    // Recording the result inside the chain itself (not in a later `.then`)
    // means a reader woken by this promise always finds it settled.
    const promise: Promise<MermaidRenderResult> = queue
      .then(() => renderNow(source.trim(), theme))
      .then((result) => {
        settled.set(promise, result);
        evictSettled();
        return result;
      });
    queue = promise;
    cache.set(key, promise);
    evictSettled();
    return promise;
  }

  return {
    start,
    read(source, theme) {
      const promise = start(source, theme);
      const result = settled.get(promise);
      if (result) return result;
      // Suspense protocol: React waits on the thrown promise, then reads again.
      throw promise;
    },
    invalidate(source, theme) {
      cache.delete(mermaidRenderKey(source, theme));
    },
    get size() {
      return cache.size;
    }
  };
}
