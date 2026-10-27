/**
 * Entries that disagree (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Contradictions"), read by similar entries, the similarity graph and insights:
 *
 * - `graph`: a concept of A `contradicts` a concept of B in the concept graph (either direction,
 *   after merges), A ≠ B, both visible, the edge itself visible; note = the edge's `context`;
 * - `checked`: an LLM pair check said `contradicts` (its note first, the graph's pairs kept).
 *
 * A pair check that found the two `consistent` or `unrelated` overrides the graph's guess: the
 * checker read both entries, the graph only their extracted concepts.
 *
 * The graph's guesses are filtered for what makes an entry a side of a disagreement:
 *
 * - An entry linked to both concepts of a `contradicts` edge discusses the disagreement (it quotes
 *   both sides) rather than taking one: it is never a side for that edge.
 * - A survey entry ({@link isSurveyEntry}: a synthesis, or a note titled as a map, audit, hub,
 *   register, index or cross-links) restates what other entries say, so its concepts are theirs: a
 *   disagreement it seems to take part in is one between its sources, which are listed themselves.
 *   It is never a side of the graph's guesses (an LLM pair check that read it still counts).
 * - An edge whose context says the conflict is only apparent or resolved ({@link isResolvedNote})
 *   is not a disagreement: it adds no pair (the edge itself stays in the concept graph). Dropped
 *   rather than kept as "resolved": every reader of these pairs (insights, similar entries, the
 *   similarity graph's `contradicts` edges) means entries that disagree now.
 * - A context that says nothing ({@link isFillerNote}: "n/a", "placeholder", "Unresolved; …",
 *   two words or fewer) is no note: the pair stays, its note is null.
 */

import type { KnowledgeConceptRef, KnowledgeEntryMeta } from "@orquester/api";
import type { KnowledgePairChecksPort } from "../ports.ts";
import type { GraphEdge, KnowledgeGraph } from "./graph.ts";
import type { KnowledgeScope } from "./visibility.ts";

/** The concept-graph relation that says one concept contradicts another. */
export const CONTRADICTS_RELATION = "contradicts";
/** Concept pairs kept per contradiction (the first ones found, in graph order). */
export const CONTRADICTION_PAIRS_MAX = 3;

export interface KnowledgeContradictionFound {
  /** Sorted: `a` < `b`. */
  a: string;
  b: string;
  source: "graph" | "checked";
  pairs: { from: KnowledgeConceptRef; to: KnowledgeConceptRef }[];
  note: string | null;
}

export type ContradictionGraph = Pick<KnowledgeGraph, "visibleEdgesOfType" | "visibleEntriesOf" | "conceptRef" | "conceptIdsOfEntry">;

export interface FindContradictionsOptions {
  graph: ContradictionGraph;
  scope: KnowledgeScope;
  pairChecks: KnowledgePairChecksPort | null;
  /** Entries that may take part (already visible in `scope`; e.g. the drawn nodes). */
  accept: (entryId: string) => boolean;
  /** Only pairs with this entry (similar entries); absent: every pair. */
  entryId?: string;
  /** An entry's kind and title ({@link isSurveyEntry}); absent or null: it may take a side. */
  entryMeta?: (entryId: string) => Pick<KnowledgeEntryMeta, "kind" | "title"> | null;
}

/** Kinds of notes whose title can mark them as a survey of other entries ({@link isSurveyEntry}). */
const NOTE_KINDS = /^(research[ _-]?)?notes?$/i;
/** Title words that mark a note as a survey of other entries. */
const SURVEY_TITLE = /\b(map|audit|hub|register|index|cross[ -]?links?|overview)\b/i;

/**
 * Whether an entry surveys other entries rather than making claims of its own: kind `synthesis`,
 * or a (research) note whose title calls it a map, audit, hub, register, index, cross-links or
 * overview. Its concepts restate its sources', so it is never a side of a disagreement the concept
 * graph guesses, nor the single source of a claim.
 */
export function isSurveyEntry(meta: Pick<KnowledgeEntryMeta, "kind" | "title"> | null | undefined): boolean {
  if (!meta) return false;
  const kind = (meta.kind ?? "").trim();
  if (kind.toLowerCase() === "synthesis") return true;
  return NOTE_KINDS.test(kind) && SURVEY_TITLE.test(meta.title);
}

/** Words that say nothing about the disagreement ("n/a", "placeholder", "unresolved"). */
const FILLER_WORDS = new Set(["n/a", "na", "none", "null", "nil", "placeholder", "unknown", "unresolved", "unclear", "tbd", "todo", "empty", "-", "?"]);
const fillerWord = (word: string): boolean => FILLER_WORDS.has(word.toLowerCase().replace(/^[^\p{L}\p{N}/?-]+|[.,;:!]+$/gu, ""));

/**
 * Whether a `contradicts` context says nothing: empty, two words or fewer, only filler words
 * ("n/a", "None.", "TBD - placeholder"), or a filler word set apart as a heading ("Unresolved;
 * notes disagree", "N/A: …"). A note that merely starts with such a word says something ("Unknown
 * proxy provider recommended over a known one").
 */
export function isFillerNote(note: string): boolean {
  const words = note.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= 2) return true;
  if (words.every((word) => fillerWord(word) || /^[^\p{L}\p{N}]+$/u.test(word))) return true;
  return fillerWord(words[0]!) && /[;:]$/.test(words[0]!);
}

/**
 * Phrases that say the two do not really disagree. Not bare "consistent" or "compatible": "the
 * claims are not consistent" and "not compatible strategies" are disagreements.
 */
const RESOLVED_NOTE =
  /\b(apparent(ly)? only|only apparent(ly)?|not (a |an )?(real|true|genuine|actual) (conflict|contradiction|disagreement)|no (real|true|genuine|actual) (conflict|contradiction|disagreement)|both (are |can be )?(true|right|valid|correct)|both can work|not either\/or|everyone agrees|resolved)\b/gi;
/** A note that opens with the verdict "compatible" or "consistent" ("Compatible only because …", "Consistent: …"). */
const RESOLVED_VERDICT = /^\s*(compatible|consistent)(\s+(only|after all|overall)\b|\s*[:;,.—–-])/i;
/** A negation within the two words before a phrase turns it around ("Not resolved", "isn't really resolved"). */
const NEGATED = /(?:^|\s)(?:not|never|no|\S+n['’]t)(?:\s+\S+)?\s*$/i;

/**
 * Whether a `contradicts` context says the conflict is only apparent or resolved ("Apparent only;
 * …", "both true", "not a real conflict", "resolved by …", a note opening with the verdict
 * "Compatible only because …"); a phrase never counts when a negation comes within two
 * words before it ("Not resolved: sources disagree", "isn't really resolved").
 */
export function isResolvedNote(note: string): boolean {
  if (RESOLVED_VERDICT.test(note)) return true;
  for (const match of note.matchAll(RESOLVED_NOTE)) {
    const raw = note.slice(0, match.index);
    if (/\bun-?$/i.test(raw)) continue; // "un-resolved"
    const before = raw.replace(/[^\p{L}\p{N}'’\s]+/gu, " ").trimEnd();
    if (!NEGATED.test(before)) return true;
  }
  return false;
}

export const pairKeyOf = (x: string, y: string): string => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/** The edge's `context` (graph.ts reads myKG's attribute as text) as one line, or null. */
function contextOf(edge: GraphEdge): string | null {
  if (typeof edge.context !== "string") return null;
  const text = edge.context.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/** The edge's context as a note: null when it says nothing ({@link isFillerNote}). */
function noteOf(edge: GraphEdge): string | null {
  const text = contextOf(edge);
  return text === null || isFillerNote(text) ? null : text;
}

function refOf(graph: ContradictionGraph, id: string, scope: KnowledgeScope): KnowledgeConceptRef | null {
  const ref = graph.conceptRef(id, scope);
  return ref ? { id: ref.id, name: ref.name, type: ref.type } : null;
}

/** Contradicting entry pairs by {@link pairKeyOf}; every entry and concept named is visible in `scope`. */
export function findContradictions(options: FindContradictionsOptions): Map<string, KnowledgeContradictionFound> {
  const { graph, scope, entryId } = options;
  const survey = new Map<string, boolean>();
  /** Entries that may be a side of the graph's guesses (not a survey). */
  const side = (id: string): boolean => {
    let is = survey.get(id);
    if (is === undefined) survey.set(id, (is = isSurveyEntry(options.entryMeta?.(id))));
    return !is && options.accept(id);
  };
  const { accept } = options;
  const found = new Map<string, KnowledgeContradictionFound & { edges: Set<string> }>();
  const entriesOf = new Map<string, string[]>();
  const visibleEntries = (conceptId: string): string[] => {
    let ids = entriesOf.get(conceptId);
    if (!ids) entriesOf.set(conceptId, (ids = graph.visibleEntriesOf(conceptId, scope).filter(side)));
    return ids;
  };
  const add = (x: string, y: string, edge: GraphEdge): void => {
    if (x === y) return;
    const key = pairKeyOf(x, y);
    let item = found.get(key);
    if (!item) {
      const [a, b] = x < y ? [x, y] : [y, x];
      found.set(key, (item = { a, b, source: "graph", pairs: [], note: null, edges: new Set() }));
    }
    if (item.edges.has(edge.id)) return;
    item.edges.add(edge.id);
    if (item.pairs.length >= CONTRADICTION_PAIRS_MAX) return;
    const from = refOf(graph, edge.from, scope);
    const to = refOf(graph, edge.to, scope);
    if (!from || !to) return;
    item.pairs.push({ from, to });
    item.note ??= noteOf(edge);
  };
  /** Whether an edge says the two disagree (its context does not say they do not). */
  const disagrees = (edge: GraphEdge): boolean => {
    const context = contextOf(edge);
    return context === null || !isResolvedNote(context);
  };

  if (entryId !== undefined) {
    if (side(entryId)) {
      const own = new Set(graph.conceptIdsOfEntry(entryId));
      for (const edge of graph.visibleEdgesOfType(CONTRADICTS_RELATION, scope, own)) {
        // Linked to both ends: it discusses this disagreement, it takes no side in it.
        if (own.has(edge.from) === own.has(edge.to) || !disagrees(edge)) continue;
        const others = new Set(visibleEntries(own.has(edge.from) ? edge.from : edge.to));
        for (const other of visibleEntries(own.has(edge.from) ? edge.to : edge.from)) if (!others.has(other)) add(entryId, other, edge);
      }
    }
  } else {
    for (const edge of graph.visibleEdgesOfType(CONTRADICTS_RELATION, scope)) {
      if (!disagrees(edge)) continue;
      const fromAll = visibleEntries(edge.from);
      const toAll = visibleEntries(edge.to);
      // An entry linked to both ends discusses the disagreement: a side of neither.
      const toSet = new Set(toAll);
      const fromSet = new Set(fromAll);
      const froms = fromAll.filter((id) => !toSet.has(id));
      if (froms.length === 0) continue;
      for (const to of toAll) {
        if (fromSet.has(to)) continue;
        for (const from of froms) add(from, to, edge);
      }
    }
  }

  for (const check of options.pairChecks?.all() ?? []) {
    if (entryId !== undefined && check.a !== entryId && check.b !== entryId) continue;
    if (check.a === check.b || !accept(check.a) || !accept(check.b)) continue;
    const key = pairKeyOf(check.a, check.b);
    if (check.verdict !== "contradicts") {
      found.delete(key);
      continue;
    }
    const item = found.get(key);
    const note = check.note?.replace(/\s+/g, " ").trim() || null;
    if (item) {
      item.source = "checked";
      item.note = note ?? item.note;
    } else {
      const [a, b] = check.a < check.b ? [check.a, check.b] : [check.b, check.a];
      found.set(key, { a, b, source: "checked", pairs: [], note, edges: new Set() });
    }
  }

  const out = new Map<string, KnowledgeContradictionFound>();
  for (const [key, { edges: _edges, ...item }] of found) out.set(key, item);
  return out;
}
