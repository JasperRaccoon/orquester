/**
 * Metadata filters (retrieval spec docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md,
 * "Search", "Entries list filters", "Facets"): validated once per request, then evaluated per entry
 * inside the same predicate as visibility, so filtering happens while ranking, never after it.
 */

import { KNOWLEDGE_FILTER_MAX_VALUES, type KnowledgeEntryMeta, type KnowledgeSearchFilters } from "@orquester/api";
import { KnowledgeError } from "../store/errors.ts";

/** A validated, normalized filter set; `null` fields are not filtered on. */
export interface KnowledgeEntryFilter {
  kinds: ReadonlySet<string> | null;
  /** Normalized author names and handles (lowercase, whitespace collapsed, no leading "@"). */
  authors: ReadonlySet<string> | null;
  years: ReadonlySet<string> | null;
  postedAfter: string | null;
  postedBefore: string | null;
  savedAfter: string | null;
  savedBefore: string | null;
}

export const NO_FILTER: KnowledgeEntryFilter = Object.freeze({
  kinds: null,
  authors: null,
  years: null,
  postedAfter: null,
  postedBefore: null,
  savedAfter: null,
  savedBefore: null
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const YEAR = /^\d{4}$/;

const normalizeKind = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
/** An author display name or a handle, as compared: lowercase, whitespace collapsed, leading "@"s dropped. */
export const normalizeAuthor = (value: string): string => value.replace(/\s+/g, " ").trim().replace(/^@+/, "").toLowerCase();

function list(values: readonly string[] | undefined, what: string, normalize: (value: string) => string, check?: (value: string) => boolean): ReadonlySet<string> | null {
  if (values === undefined) return null;
  if (!Array.isArray(values)) throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} must be a list.`);
  if (values.length > KNOWLEDGE_FILTER_MAX_VALUES) throw new KnowledgeError("KNOWLEDGE_INVALID", `At most ${KNOWLEDGE_FILTER_MAX_VALUES} ${what}.`);
  const out = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} must be strings.`);
    const value = normalize(raw);
    if (value.length === 0) continue;
    if (check && !check(value)) throw new KnowledgeError("KNOWLEDGE_INVALID", `"${raw.slice(0, 40)}" is not a valid ${what.replace(/s$/, "")}.`);
    out.add(value);
  }
  return out.size > 0 ? out : null;
}

function bound(value: string | undefined, what: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} must be an ISO date.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed.slice(0, 10)))) {
    throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} is not an ISO date (YYYY-MM-DD or a date-time): "${trimmed.slice(0, 40)}".`);
  }
  return trimmed;
}

/** Validate and normalize request filters. Throws `KNOWLEDGE_INVALID` with a readable message. */
export function parseKnowledgeFilters(filters: KnowledgeSearchFilters | undefined | null): KnowledgeEntryFilter {
  if (!filters) return NO_FILTER;
  const parsed: KnowledgeEntryFilter = {
    kinds: list(filters.kinds, "kinds", normalizeKind),
    authors: list(filters.authors, "authors", normalizeAuthor),
    years: list(filters.years, "years", (value) => value.trim(), (value) => YEAR.test(value)),
    postedAfter: bound(filters.postedAfter, "postedAfter"),
    postedBefore: bound(filters.postedBefore, "postedBefore"),
    savedAfter: bound(filters.savedAfter, "savedAfter"),
    savedBefore: bound(filters.savedBefore, "savedBefore")
  };
  return isEmptyFilter(parsed) ? NO_FILTER : parsed;
}

/**
 * A filter list as the entries route's query string carries it (`encodeKnowledgeFilterList`):
 * comma-separated, or — when a value holds a comma — a JSON array of strings (a value whose trimmed
 * form starts with "["). Throws `KNOWLEDGE_INVALID` for a "[" value that is not such an array.
 */
export function splitFilterList(value: string | undefined, what = "A filter list"): string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  let parts: string[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
      throw new KnowledgeError("KNOWLEDGE_INVALID", `${what} starting with "[" must be a JSON array of strings (or send the values comma-separated).`);
    }
    parts = parsed;
  } else {
    parts = value.split(",");
  }
  const out = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return out.length > 0 ? out : undefined;
}

export function isEmptyFilter(filter: KnowledgeEntryFilter): boolean {
  return (
    filter.kinds === null &&
    filter.authors === null &&
    filter.years === null &&
    filter.postedAfter === null &&
    filter.postedBefore === null &&
    filter.savedAfter === null &&
    filter.savedBefore === null
  );
}

/**
 * Compare an entry's date with an inclusive bound: on the YYYY-MM-DD prefix when either side is a
 * bare date, else as full ISO strings. Negative = before, 0 = same, positive = after.
 */
function compareDate(value: string, boundValue: string): number {
  if (value.length <= 10 || boundValue.length <= 10) return value.slice(0, 10).localeCompare(boundValue.slice(0, 10));
  return Date.parse(value) - Date.parse(boundValue);
}

/** The year an entry is filed under: `postedAt`, else `savedAt` (the `years` facet's rule). */
export function entryYear(meta: Pick<KnowledgeEntryMeta, "postedAt" | "savedAt">): string {
  return (meta.postedAt ?? meta.savedAt).slice(0, 4);
}

/** Whether an entry passes the filter (visibility is checked separately). */
export function entryMatchesFilter(meta: Pick<KnowledgeEntryMeta, "kind" | "author" | "handle" | "postedAt" | "savedAt">, filter: KnowledgeEntryFilter): boolean {
  if (filter === NO_FILTER) return true;
  if (filter.kinds && !filter.kinds.has(normalizeKind(meta.kind))) return false;
  if (filter.authors) {
    const author = meta.author ? normalizeAuthor(meta.author) : null;
    const handle = meta.handle ? normalizeAuthor(meta.handle) : null;
    if (!(author && filter.authors.has(author)) && !(handle && filter.authors.has(handle))) return false;
  }
  if (filter.years && !filter.years.has(entryYear(meta))) return false;
  if (filter.postedAfter || filter.postedBefore) {
    if (!meta.postedAt) return false;
    if (filter.postedAfter && compareDate(meta.postedAt, filter.postedAfter) < 0) return false;
    if (filter.postedBefore && compareDate(meta.postedAt, filter.postedBefore) > 0) return false;
  }
  if (filter.savedAfter && compareDate(meta.savedAt, filter.savedAfter) < 0) return false;
  if (filter.savedBefore && compareDate(meta.savedAt, filter.savedBefore) > 0) return false;
  return true;
}

/** A stable string for the filter (part of a search cursor's fingerprint). */
export function filterKey(filter: KnowledgeEntryFilter): string {
  const sorted = (set: ReadonlySet<string> | null) => (set ? [...set].sort() : null);
  return JSON.stringify([
    sorted(filter.kinds),
    sorted(filter.authors),
    sorted(filter.years),
    filter.postedAfter,
    filter.postedBefore,
    filter.savedAfter,
    filter.savedBefore
  ]);
}
