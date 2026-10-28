/**
 * Source-entry attribution (quality round 5): a research note says "Alex recommends Gmail only", so
 * myKG links Person "Alex Nguyen" to "Use Gmail only", while Alex's own post sits on other concepts
 * ("Gmail", "Create a new iCloud account with fresh Gmail and Apple ID"). The concept's summary then
 * never reads Alex's own words. {@link conceptAttributions} finds, for each claim concept, the
 * entries of the Persons linked to it that the graph does not put behind it, so concept and family
 * summaries read them as position sources. The graph itself is not changed.
 *
 * - The link: an edge from a Person (after the merge overlay) to a concept of a claim type
 *   (`recommends`, `uses_tool`, `reports_result`: whatever the Person says about it), with the
 *   entries it comes from (its basis: a caller must see them too, as they name the Person's position).
 * - The Person's entries: an entry whose handle is one of the Person's handles (its `handle`
 *   attribute, a handle-shaped name or alias), or whose author is one of its names or aliases
 *   (compared without case, accents, spaces or punctuation) unless the entry's handle is another
 *   one. Machine slugs ("person-personematotaro") are no names. Surveys (`isSurveyEntry`) are no one's
 *   own position, nor research notes.
 * - Only when no entry of that Person is behind the concept already, and only the Person's entry
 *   most about it: the one linking the most concepts that share a topic word with it
 *   (`familyWords`, common words aside), at least one; the newest on a tie.
 */

import type { KnowledgeEntryMeta } from "@orquester/api";
import { familyVocabulary, familyWords, type FamilyVocabulary } from "./concept-families.ts";
import { isSurveyEntry } from "./contradictions.ts";
import { type GraphConcept, isMachineSlug } from "./graph.ts";

/** Types an attributed entry is read for (concept summaries' `CLAIM_TYPES`). */
const ATTRIBUTED_TYPES: ReadonlySet<string> = new Set(["Tactic", "Tool", "Metric", "Result", "Guideline"]);
/** Kinds of entries that report on others ("research note", "synthesis"): no one's own position. */
const RESEARCH_KINDS = /research|synthesis/i;

/** One entry attributed to a concept. */
export interface ConceptAttribution {
  entryId: string;
  /** The Person whose entry it is (the graph's id). */
  personId: string;
  /** The entries the Person's link to the concept comes from (null: the edge has no provenance). */
  basis: readonly string[];
}

export interface ConceptAttributionInput {
  /** The graph's concepts after the merge overlay. */
  concepts: readonly GraphConcept[];
  /** Edges (any ids: they are read through `canonical`), with the entries they come from. */
  edges: readonly { from: string; to: string; entryIds: readonly string[] | null }[];
  canonical(conceptId: string): string;
  /** Every entry. */
  entries: readonly KnowledgeEntryMeta[];
  /** The concepts (the graph's ids) linked to an entry. */
  conceptsOfEntry(entryId: string): readonly string[];
  /** Topic word counts (default: of `concepts`' names). */
  vocabulary?: FamilyVocabulary;
}

/** A name as compared: no case, accents, spaces or punctuation, no leading "@". */
function key(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const out = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return out.length >= 2 ? out : null;
}

const HANDLE_SHAPE = /^@?[A-Za-z0-9_.-]{3,}$/;

/** A Person's names and handles as compared (every source of a merge). */
function personKeys(person: GraphConcept): { names: Set<string>; handles: Set<string> } {
  const names = new Set<string>();
  const handles = new Set<string>();
  const sources = person.merge?.sources ?? [person];
  for (const source of sources) {
    const handle = key(source.attributes.handle?.value);
    if (handle) handles.add(handle);
    for (const name of [source.name, ...source.aliases]) {
      if (name === source.id || isMachineSlug(name, person.type)) continue;
      const k = key(name);
      if (!k) continue;
      names.add(k);
      if (HANDLE_SHAPE.test(name.trim()) && !/\s/.test(name.trim())) handles.add(k);
    }
  }
  return { names, handles };
}

/** Whether an entry is the Person's own (see the module header). */
function authoredBy(meta: KnowledgeEntryMeta, keys: { names: Set<string>; handles: Set<string> }): boolean {
  const handle = key(meta.handle);
  if (handle && keys.handles.has(handle)) return true;
  // A different account under the same display name is someone else.
  if (handle && keys.handles.size > 0 && !keys.handles.has(handle)) return false;
  const author = key(meta.author);
  return author !== null && (keys.names.has(author) || keys.handles.has(author));
}

/** For every claim concept (the graph's ids) the entries attributed to it, in a stable order. */
export function conceptAttributions(input: ConceptAttributionInput): Map<string, ConceptAttribution[]> {
  const byId = new Map(input.concepts.map((concept) => [concept.id, concept]));
  const vocabulary = input.vocabulary ?? familyVocabulary(input.concepts.map((concept) => concept.name));
  const telling = (name: string): Set<string> => new Set([...familyWords(name)].filter((word) => !vocabulary.common.has(word) && !vocabulary.frequent.has(word)));
  const wordsMemo = new Map<string, Set<string>>();
  const wordsOf = (concept: GraphConcept): Set<string> => {
    let words = wordsMemo.get(concept.id);
    if (!words) {
      words = new Set<string>();
      for (const name of [concept.name, ...(concept.merge?.sources.map((source) => source.name) ?? [])]) for (const word of telling(name)) words.add(word);
      wordsMemo.set(concept.id, words);
    }
    return words;
  };
  // Persons and their own entries (surveys aside), once.
  const ownEntries = new Map<string, KnowledgeEntryMeta[]>();
  const persons = input.concepts.filter((concept) => concept.type === "Person");
  for (const person of persons) {
    const keys = personKeys(person);
    if (keys.names.size === 0 && keys.handles.size === 0) continue;
    const own = input.entries.filter((meta) => !isSurveyEntry(meta) && !RESEARCH_KINDS.test(meta.kind) && authoredBy(meta, keys));
    if (own.length > 0) ownEntries.set(person.id, own);
  }
  const out = new Map<string, ConceptAttribution[]>();
  const seen = new Set<string>();
  for (const edge of input.edges) {
    const personId = input.canonical(edge.from);
    const conceptId = input.canonical(edge.to);
    const own = ownEntries.get(personId);
    const concept = byId.get(conceptId);
    if (!own || !concept || !ATTRIBUTED_TYPES.has(concept.type) || byId.get(personId)?.type !== "Person") continue;
    const pairKey = `${personId}\u0000${conceptId}`;
    if (seen.has(pairKey)) {
      // Another edge of the same pair: its entries count as basis too.
      const known = out.get(conceptId)?.find((a) => a.personId === personId);
      if (known && edge.entryIds) (known.basis as string[]).push(...edge.entryIds.filter((id) => !known.basis.includes(id)));
      continue;
    }
    seen.add(pairKey);
    const behind = new Set(concept.entryIds);
    // The Person's own position is behind it already.
    if (own.some((meta) => behind.has(meta.id))) continue;
    const words = wordsOf(concept);
    if (words.size === 0) continue;
    let best: { meta: KnowledgeEntryMeta; score: number } | null = null;
    for (const meta of own) {
      let score = 0;
      for (const otherId of input.conceptsOfEntry(meta.id)) {
        const other = byId.get(otherId);
        if (!other || other.type === "Person" || other.id === concept.id) continue;
        for (const word of wordsOf(other)) {
          if (words.has(word)) {
            score += 1;
            break;
          }
        }
      }
      if (score === 0) continue;
      const newer = best !== null && (meta.postedAt ?? meta.savedAt).localeCompare(best.meta.postedAt ?? best.meta.savedAt) > 0;
      if (!best || score > best.score || (score === best.score && newer)) best = { meta, score };
    }
    if (!best) continue;
    let list = out.get(conceptId);
    if (!list) out.set(conceptId, (list = []));
    list.push({ entryId: best.meta.id, personId, basis: [...(edge.entryIds ?? [])] });
  }
  for (const list of out.values()) list.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  return out;
}
