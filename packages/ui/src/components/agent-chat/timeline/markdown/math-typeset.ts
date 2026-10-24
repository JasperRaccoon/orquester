/**
 * Typesetting a formula: KaTeX, loaded on first use, and a cache of what it
 * produced.
 *
 *  - **Lazy.** KaTeX and its CSS live in `katex-engine.ts`, reached only by
 *    `import()` from {@link loadMathEngine}. The first formula to mount starts
 *    the load and shows its TeX source until KaTeX arrives; every formula then
 *    re-renders typeset. A failed load is forgotten, so the next formula to
 *    mount tries again.
 *  - **Cached.** The timeline remounts messages (load older turns, switching
 *    tabs, a stream settling), and typesetting is the expensive part of a
 *    formula, so the HTML is kept in a size-aware LRU keyed on mode and TeX.
 *    `""` records a formula KaTeX cannot parse, which renders as its source.
 *    *T3: `apps/web/src/components/chat/MathTypeset.tsx` (same limits).*
 *
 * The HTML is KaTeX's own output, never provider text: KaTeX escapes the TeX
 * it renders, and `trust: false` (`KATEX_OPTIONS`) keeps it from emitting
 * links or attributes of the formula's choosing.
 */

import React from "react";

import { SizedLruCache } from "./highlight-core";
import { KATEX_OPTIONS } from "./math";

/** The part of KaTeX this file uses. */
export interface MathEngine {
  renderToString(tex: string, options: Record<string, unknown>): string;
}

const TYPESET_CACHE_MAX_ENTRIES = 1000;
const TYPESET_CACHE_MAX_BYTES = 4 * 1024 * 1024;

let typesetCache = new SizedLruCache<string>(TYPESET_CACHE_MAX_ENTRIES, TYPESET_CACHE_MAX_BYTES);

let engine: MathEngine | null = null;
let loading: Promise<MathEngine> | null = null;
const listeners = new Set<() => void>();

const defaultLoader = (): Promise<MathEngine> =>
  import("./katex-engine").then((module) => module.default as unknown as MathEngine);
let loader: () => Promise<MathEngine> = defaultLoader;

/** Loads KaTeX once; every typeset formula re-renders when it arrives. */
export function loadMathEngine(): Promise<MathEngine> {
  if (engine) return Promise.resolve(engine);
  loading ??= loader().then(
    (loaded) => {
      engine = loaded;
      for (const listener of listeners) listener();
      return loaded;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    }
  );
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isLoaded = (): boolean => engine !== null;

/**
 * KaTeX's HTML for a formula: `null` while KaTeX is not loaded, `""` when it
 * cannot parse the formula (mid-stream, or wrong).
 */
export function typesetMath(tex: string, display: boolean): string | null {
  if (!engine) return null;
  const key = `${display ? "display" : "inline"}:${tex}`;
  const cached = typesetCache.get(key);
  if (cached !== null) return cached;
  let html = "";
  try {
    html = engine.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
  } catch {
    // Unfinished or unsupported TeX stays readable as its source.
  }
  // Two bytes a character, for the key and the markup.
  typesetCache.set(key, html, (key.length + html.length) * 2);
  return html;
}

/** {@link typesetMath} for a component: starts the load, re-renders once KaTeX is in. */
export function useTypesetMath(tex: string, display: boolean): string | null {
  const loaded = React.useSyncExternalStore(subscribe, isLoaded, isLoaded);
  React.useEffect(() => {
    // A failed load is retried by the next formula to mount.
    if (!loaded) loadMathEngine().catch(() => undefined);
  }, [loaded]);
  return React.useMemo(() => (loaded ? typesetMath(tex, display) : null), [loaded, tex, display]);
}

/**
 * Test seam: swaps how KaTeX is loaded and forgets the loaded engine and the
 * cache (pass `null` to restore the real `import()`).
 */
export function setMathEngineLoader(next: (() => Promise<MathEngine>) | null): void {
  loader = next ?? defaultLoader;
  engine = null;
  loading = null;
  typesetCache = new SizedLruCache<string>(TYPESET_CACHE_MAX_ENTRIES, TYPESET_CACHE_MAX_BYTES);
}
