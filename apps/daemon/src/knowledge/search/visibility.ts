import type { KnowledgeEntryMeta, KnowledgeVisibility } from "@orquester/api";

/** The `unfiled` pseudo-collection of the entries and graph filters (only `all` callers see it). */
export const UNFILED = "unfiled";

/**
 * What one request may see, resolved once per request (spec goal 2, "Querying"):
 *
 * - `canSee` — collections the caller can see (`null`: every collection — visibility `all`).
 * - `filter` — the request's own narrowing (`null`: none). Always intersected with `canSee`.
 * - `unfiled` — whether entries with no (existing) collection are in scope: only for `all`
 *   callers, and only when the narrowing (if any) names `unfiled`.
 * - `known` — the collections that exist; an id an entry still carries but no collection has any
 *   more counts for nothing (the entry is Unfiled if it has no other).
 *
 * An entry is in scope iff it is Unfiled and `unfiled` holds, or one of its existing collections
 * passes both `canSee` and `filter`.
 */
export interface KnowledgeScope {
  canSee: ReadonlySet<string> | null;
  filter: ReadonlySet<string> | null;
  unfiled: boolean;
  known: ReadonlySet<string>;
}

export function knowledgeScope(
  visibility: KnowledgeVisibility,
  known: Iterable<string>,
  filter?: readonly string[] | null
): KnowledgeScope {
  const knownSet = new Set(known);
  const all = visibility.kind === "all";
  const canSee = all ? null : new Set(visibility.ids.filter((id) => knownSet.has(id)));
  const filterSet = filter ? new Set(filter.filter((id) => id !== UNFILED)) : null;
  const unfiled = all && (!filter || filter.includes(UNFILED));
  return { canSee, filter: filterSet, unfiled, known: knownSet };
}

function passes(scope: KnowledgeScope, id: string): boolean {
  return scope.known.has(id) && (scope.canSee === null || scope.canSee.has(id)) && (scope.filter === null || scope.filter.has(id));
}

export function entryInScope(meta: Pick<KnowledgeEntryMeta, "collections">, scope: KnowledgeScope): boolean {
  let filed = false;
  for (const id of meta.collections) {
    if (!scope.known.has(id)) continue;
    filed = true;
    if (passes(scope, id)) return true;
  }
  return !filed && scope.unfiled;
}

/** The entry's collections the caller can see (the request's narrowing does not hide labels). */
export function visibleCollections(meta: Pick<KnowledgeEntryMeta, "collections">, scope: KnowledgeScope): string[] {
  return meta.collections.filter((id) => scope.known.has(id) && (scope.canSee === null || scope.canSee.has(id)));
}

/** The collection ids a request ran over (`searched`), in `order`. */
export function scopeCollectionIds(scope: KnowledgeScope, order: readonly string[]): string[] {
  return order.filter((id) => passes(scope, id));
}
