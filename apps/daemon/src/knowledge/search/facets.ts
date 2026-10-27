/**
 * Facet counts (retrieval spec docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md,
 * "Facets (R4)"): kinds, authors, collections and years over a set of entries the caller can see.
 * Shared by `POST /api/knowledge/facets` and search's `facets: true`.
 */

import { KNOWLEDGE_FACET_MAX_VALUES, type KnowledgeCollection, type KnowledgeEntryMeta, type KnowledgeFacetCount, type KnowledgeFacets } from "@orquester/api";
import { entryYear, normalizeAuthor } from "./filters.ts";
import { type KnowledgeScope, UNFILED, visibleCollections } from "./visibility.ts";

/** One facet value being counted: the spellings seen for it, so the most used one names it. */
interface Bucket {
  count: number;
  /** Raw spelling → uses, in first-seen order. */
  spellings: Map<string, number>;
  /** Author buckets: display names seen with a handle → uses. */
  names?: Map<string, number>;
}

function bump(buckets: Map<string, Bucket>, key: string, spelling: string, name?: string | null): void {
  let bucket = buckets.get(key);
  if (!bucket) buckets.set(key, (bucket = { count: 0, spellings: new Map() }));
  bucket.count += 1;
  bucket.spellings.set(spelling, (bucket.spellings.get(spelling) ?? 0) + 1);
  if (name) {
    bucket.names ??= new Map();
    bucket.names.set(name, (bucket.names.get(name) ?? 0) + 1);
  }
}

/** The most used key of a tally; the first seen on a tie. */
function mostUsed(tally: ReadonlyMap<string, number>): string {
  let best = "";
  let uses = -1;
  for (const [value, n] of tally) {
    if (n > uses) {
      best = value;
      uses = n;
    }
  }
  return best;
}

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Most frequent first, then by label, then by value; at most KNOWLEDGE_FACET_MAX_VALUES. */
function topByCount(values: KnowledgeFacetCount[]): KnowledgeFacetCount[] {
  return values
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, KNOWLEDGE_FACET_MAX_VALUES);
}

/**
 * Count `metas` (already visible and filtered) by:
 * - kind — compared case-insensitively and trimmed (the filter's rule); named by its most used spelling;
 * - author — by handle when the entry has one (label "Name (@handle)", or "@handle" with no name),
 *   else by display name (label "Name"); value = the handle, else the name (what the `authors` filter takes);
 * - collection — the entry's collections the caller can see (label = the collection's name), plus
 *   `unfiled` for entries with no existing collection when the caller sees everything;
 * - year — of `postedAt`, else `savedAt`, newest year first.
 *
 * Kinds, authors and collections are ordered by count (desc), then label. Each list keeps at most
 * KNOWLEDGE_FACET_MAX_VALUES values.
 */
export function computeKnowledgeFacets(
  metas: readonly KnowledgeEntryMeta[],
  scope: KnowledgeScope,
  collections: readonly KnowledgeCollection[]
): KnowledgeFacets {
  const kinds = new Map<string, Bucket>();
  const authors = new Map<string, Bucket>();
  const byCollection = new Map<string, number>();
  const years = new Map<string, number>();
  let unfiled = 0;
  const seesUnfiled = scope.canSee === null;

  for (const meta of metas) {
    const kind = collapse(meta.kind);
    if (kind.length > 0) bump(kinds, kind.toLowerCase(), kind);

    const handle = meta.handle ? collapse(meta.handle).replace(/^@+/, "") : "";
    const author = meta.author ? collapse(meta.author) : "";
    if (handle.length > 0) bump(authors, `@${normalizeAuthor(handle)}`, handle, author || null);
    else if (author.length > 0) bump(authors, normalizeAuthor(author), author);

    const visible = visibleCollections(meta, scope);
    for (const id of new Set(visible)) byCollection.set(id, (byCollection.get(id) ?? 0) + 1);
    if (seesUnfiled && !meta.collections.some((id) => scope.known.has(id))) unfiled += 1;

    const year = entryYear(meta);
    years.set(year, (years.get(year) ?? 0) + 1);
  }

  const kindCounts = [...kinds.values()].map((bucket): KnowledgeFacetCount => {
    const value = mostUsed(bucket.spellings);
    return { value, label: value, count: bucket.count };
  });

  const authorCounts = [...authors].map(([key, bucket]): KnowledgeFacetCount => {
    const value = mostUsed(bucket.spellings);
    if (!key.startsWith("@")) return { value, label: value, count: bucket.count };
    const name = bucket.names ? mostUsed(bucket.names) : "";
    return { value, label: name ? `${name} (@${value})` : `@${value}`, count: bucket.count };
  });

  const names = new Map(collections.map((c) => [c.id, c.name]));
  const collectionCounts: KnowledgeFacetCount[] = [...byCollection].map(([id, count]) => ({ value: id, label: names.get(id) ?? id, count }));
  if (unfiled > 0) collectionCounts.push({ value: UNFILED, label: "Unfiled", count: unfiled });

  const yearCounts = [...years]
    .map(([year, count]): KnowledgeFacetCount => ({ value: year, label: year, count }))
    .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))
    .slice(0, KNOWLEDGE_FACET_MAX_VALUES);

  return {
    kinds: topByCount(kindCounts),
    authors: topByCount(authorCounts),
    collections: topByCount(collectionCounts),
    years: yearCounts
  };
}
