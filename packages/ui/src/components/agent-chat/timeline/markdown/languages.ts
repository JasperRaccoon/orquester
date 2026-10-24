/**
 * Lazy language resolution for chat code blocks (spec §7.3).
 *
 * `@codemirror/language-data` is a catalog of `LanguageDescription`s whose
 * `load()` dynamic-imports the grammar package. Nothing is pulled into the
 * first paint: a thread with no fenced code never loads a parser, and a thread
 * full of TypeScript loads exactly one.
 *
 * (The "no lazy dynamic `import()`" rule in COORDINATION.md §1.10 is about the
 * **agent host**, whose surviving process must never load changed source after
 * a deploy. It does not apply to the browser bundle, where this is the whole
 * point of `language-data`.)
 *
 * The browser half lives here so `highlight-core.ts` stays importable from
 * plain node. The catalog itself (`language-catalog.ts`) reaches
 * `@codemirror/language`, which reaches `@codemirror/view`, so it is
 * `import()`ed too, by the first fenced block that asks for a parser.
 */

import type { Parser } from "@lezer/common";
import React from "react";

import { resolveLanguageEntry } from "./highlight-core";
import type { CatalogEntry } from "./language-catalog";

/** The catalog once loaded; `null` before. */
let catalog: readonly CatalogEntry[] | null = null;
let catalogLoad: Promise<readonly CatalogEntry[] | null> | null = null;

/** Loads the catalog once; `null` when its chunk fails (a later block tries again). */
function loadCatalog(): Promise<readonly CatalogEntry[] | null> {
  catalogLoad ??= import("./language-catalog").then(
    (module) => (catalog = module.ENTRIES),
    () => {
      catalogLoad = null;
      return null;
    }
  );
  return catalogLoad;
}

/** Resolved parsers, by canonical language name. `null` = tried and unavailable. */
const parsers = new Map<string, Parser | null>();
const inFlight = new Map<string, Promise<Parser | null>>();

/**
 * Resolves a fence info string to a parser, loading the grammar on first use.
 *
 * Resolves to `null` for an unknown fence name **and** for a grammar that
 * fails to load — an unhighlighted block is a supported outcome (§7.3), and a
 * chunk that 404s after a deploy must not take the message down with it.
 */
export async function loadLanguageParser(info: string | undefined): Promise<Parser | null> {
  // A fence with no language name never loads the catalog.
  if ((info ?? "").trim().length === 0) return null;
  const entries = catalog ?? (await loadCatalog());
  if (entries === null) return null;
  const entry = resolveLanguageEntry(info, entries);
  if (entry === null) return null;
  const key = entry.name;
  const known = parsers.get(key);
  if (known !== undefined) return known;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const load = entry.description
    .load()
    .then((support) => {
      const parser = support.language.parser;
      parsers.set(key, parser);
      return parser;
    })
    .catch(() => {
      parsers.set(key, null);
      return null;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, load);
  return load;
}

/** The parser if it is already resolved, without starting a load. */
function resolvedLanguageParser(info: string | undefined): Parser | null {
  if (catalog === null) return null;
  const entry = resolveLanguageEntry(info, catalog);
  if (entry === null) return null;
  return parsers.get(entry.name) ?? null;
}

/**
 * The parser for a fence, or `null` until it has loaded.
 *
 * Renders the block unhighlighted for exactly one frame per *language per
 * session* — the resolved map is module-level, so every later block in that
 * language is highlighted on its first render with no flash.
 */
export function useLanguageParser(info: string | undefined): Parser | null {
  const [parser, setParser] = React.useState<Parser | null>(() => resolvedLanguageParser(info));

  React.useEffect(() => {
    let cancelled = false;
    const already = resolvedLanguageParser(info);
    if (already !== null) {
      setParser(already);
      return () => {
        cancelled = true;
      };
    }
    setParser(null);
    void loadLanguageParser(info).then((loaded) => {
      if (!cancelled) setParser(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [info]);

  return parser;
}
