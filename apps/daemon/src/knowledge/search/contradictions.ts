/**
 * Entries that disagree (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "Contradictions"), read by similar entries, the similarity graph and insights:
 *
 * - `graph`: a concept of A `contradicts` a concept of B in the concept graph (either direction,
 *   after merges), A ≠ B, both visible, the edge itself visible; note = the edge's `context`;
 * - `checked`: an LLM pair check said `contradicts` (its note first; of the graph's pairs, those
 *   both of whose concepts the note speaks of: {@link noteInvolves}). A note from before pair-check
 *   input version 4 that calls the sides "A" and "B" names them by author ({@link nameNoteSides});
 *   a sentence that only says what does not conflict is left out ({@link stripNonConflictSentences}).
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
 *   It is never a side: not of the graph's guesses, nor of an LLM pair check (pair checks no longer
 *   pick survey entries; a verdict recorded before involving one is left out, whatever it says).
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
import { tokenize } from "./text.ts";
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
  /**
   * An entry's kind and title ({@link isSurveyEntry}; absent or null: it may take a side), and its
   * author and handle (what names it in a checked note from before pair-check input version 4:
   * {@link nameNoteSides}; absent: a note is shown as it is).
   */
  entryMeta?: (entryId: string) => (Pick<KnowledgeEntryMeta, "kind" | "title"> & Partial<Pick<KnowledgeEntryMeta, "author" | "handle">>) | null;
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

/**
 * Phrases that comment on what does not conflict ("a difference of choice, not a conflict", "these
 * do not conflict", "both can hold", "is compatible", "they otherwise agree").
 */
const NON_CONFLICT =
  /\b(differences? (of|in) (choice|method|approach|detail|tools?|providers?)|not an? (real |true |genuine |actual |direct )?(conflict|contradiction|disagreement)|no (real |true |genuine |actual |direct )?(conflict|contradiction|disagreement)|(do|does|did)(n['’]t| not) (conflict|contradict|disagree)|both can (hold|be true|be right|work|apply)|(is|are) compatible|otherwise (agree|align|consistent|compatible)|neither argues against)\b/i;
/** "The rest of their steps are compatible", "the rest … agree". */
const REST_AGREES = /\bthe rest\b.*\b(compatible|consistent|agrees?)\b/i;
/** Words with which a sentence states what a side claims ("says", "recommends", "warns", "backs"). */
const CLAIM_VERB =
  /\b(says?|said|recommends?|recommended|advises?|advised|argues?|argued|claims?|claimed|warns?|warned|tells?|told|reports?|reported|states?|stated|insists?|suggests?|backs?|urges?|calls? for)\b/i;
/** Where a note's sentences break: after ".", "!" or "?" and a space, before a word (never after "e.g.", "i.e.", "vs."). */
const SENTENCE_BREAK = /(?<!\b(?:e\.g|i\.e|vs|cf|etc)\.)(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[\p{L}\p{N}])/u;

/**
 * A `contradicts` note without its sentences that only comment on what does not conflict ("The
 * tool choices differ (ISP proxy versus NordVPN), but that is a difference of choice, not a
 * conflict."): a sentence with such a phrase ({@link NON_CONFLICT}, "the rest … compatible") and no
 * side's claim in it (no {@link CLAIM_VERB}: "X says …" always stays). A note of nothing else is
 * returned as it is. Applied when a pair check is recorded and to every stored note read.
 */
export function stripNonConflictSentences(note: string): string {
  const text = note.trim();
  const sentences = text.split(SENTENCE_BREAK);
  const kept = sentences.filter((sentence) => !((NON_CONFLICT.test(sentence) || REST_AGREES.test(sentence)) && !CLAIM_VERB.test(sentence)));
  return kept.length === sentences.length || kept.length === 0 ? text : kept.join(" ");
}

export const pairKeyOf = (x: string, y: string): string => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/**
 * A side letter of a pair-check note before input version 4: a capital "A" or "B" standing alone
 * (not "A/B", "B2B", "A-list"), possibly as "entry A", followed by "'s", ",", ":", a verb-like word
 * ending in s (says, claims, recommends, reports) or "and"/"or"/"is"/"has". An article "A" opening a
 * sentence ("A residential IP …") is not one.
 */
const SIDE_LETTER = /(?<![\p{L}\p{N}/&+-])(?:[Ee]ntry )?([AB])(?![\p{L}\p{N}/&+-])(?=['’]s\b|,|:| (?:[a-z]+s|and|or|is|was|has|did|does)\b)/gu;

/** Whether a note names the two sides "A" and "B" (both letters stand as a side: {@link SIDE_LETTER}). */
export function noteUsesSideLetters(note: string): boolean {
  const letters = new Set<string>();
  for (const match of note.matchAll(SIDE_LETTER)) letters.add(match[1]!);
  return letters.size === 2;
}

/** A word as {@link noteInvolves} compares it: {@link tokenize}'s, without "-ing" and "-ed" ("hosted" → "host"). */
const involvementWord = (token: string): string => (token.length > 5 && token.endsWith("ing") ? token.slice(0, -3) : token.length > 4 && token.endsWith("ed") ? token.slice(0, -2) : token);
const involvementWords = (text: string): string[] => tokenize(text).filter((token) => token.length >= 2 && !/^\d+$/.test(token)).map(involvementWord);

/**
 * Whether a checker's note speaks of a concept: at least half of the concept name's words (its
 * {@link tokenize} tokens, numbers aside) are in the note. "Self-host Outline VPN on Hetzner ($5/mo)
 * instead of NordVPN" is in "… recommends a self-hosted VPN on a Hetzner datacenter VPS …"; "US App
 * Store download and warm-up" is not.
 */
export function noteInvolves(note: string, conceptName: string): boolean {
  const words = new Set(involvementWords(conceptName));
  if (words.size === 0) return false;
  const said = new Set(involvementWords(note));
  let found = 0;
  for (const word of words) if (said.has(word)) found += 1;
  return found * 2 >= words.size;
}

/** What names one side of a contradiction in its note: its author or handle, or a short title. */
export type ContradictionSide = Pick<KnowledgeEntryMeta, "title"> & Partial<Pick<KnowledgeEntryMeta, "author" | "handle">>;

/** Words of a title kept in a short title. */
const SHORT_TITLE_WORDS = 6;

/** A title's first clause (before ":", " — ", " (" or " | "), at most {@link SHORT_TITLE_WORDS} words, in quotes. */
function shortTitle(title: string): string {
  const clause = title.replace(/\s+/g, " ").trim().split(/:\s| [—–|] | \(/)[0]!.trim() || title.trim();
  const words = clause.split(" ");
  return `“${words.length > SHORT_TITLE_WORDS ? `${words.slice(0, SHORT_TITLE_WORDS).join(" ")}…` : clause}”`;
}

/**
 * How a note names each side (input version 4 and {@link nameNoteSides}): its author, else its
 * handle ("@jasonugc"), else a short title; both by short title when the two names are the same.
 */
export function sideNames(a: ContradictionSide, b: ContradictionSide): [string, string] {
  const name = (side: ContradictionSide): string | null => {
    const author = side.author?.replace(/\s+/g, " ").trim();
    if (author) return author;
    const handle = side.handle?.trim().replace(/^@+/, "");
    return handle ? `@${handle}` : null;
  };
  const [x, y] = [name(a), name(b)];
  const same = x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
  return [x !== null && !same ? x : shortTitle(a.title), y !== null && !same ? y : shortTitle(b.title)];
}

/**
 * A note from before pair-check input version 4 with its "A" and "B" named ({@link sideNames}): "A"
 * is the check's `a` side (the pair's smaller id, as the check was asked), "B" its `b` side ("A says
 * … B says …" → "jason says … Alex Nguyen says …"). Only a note that uses both letters as sides
 * ({@link noteUsesSideLetters}) is changed; any other is returned as it is.
 */
export function nameNoteSides(note: string, a: ContradictionSide, b: ContradictionSide): string {
  if (!noteUsesSideLetters(note)) return note;
  const [x, y] = sideNames(a, b);
  return note.replace(SIDE_LETTER, (_match, letter: string) => (letter === "A" ? x : y));
}

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
    // A survey entry is never a side, checked or guessed: a verdict involving one is left out.
    if (check.a === check.b || !side(check.a) || !side(check.b)) continue;
    const key = pairKeyOf(check.a, check.b);
    if (check.verdict !== "contradicts") {
      found.delete(key);
      continue;
    }
    const item = found.get(key);
    // A stored note's sentences that only say what does not conflict are left out (recorded before the rule).
    const said = check.note ? stripNonConflictSentences(check.note.replace(/\s+/g, " ")) || null : null;
    // A note that calls the sides "A" and "B" (before input version 4) names them: A is the check's `a`.
    const [sideA, sideB] = [options.entryMeta?.(check.a), options.entryMeta?.(check.b)];
    const note = said !== null && sideA && sideB ? nameNoteSides(said, sideA, sideB) : said;
    if (item) {
      item.source = "checked";
      item.note = note ?? item.note;
      // The graph's concept pairs the checker's note speaks of; none when it speaks of none of them.
      if (note !== null) item.pairs = item.pairs.filter(({ from, to }) => noteInvolves(note, from.name) && noteInvolves(note, to.name));
    } else {
      const [a, b] = check.a < check.b ? [check.a, check.b] : [check.b, check.a];
      found.set(key, { a, b, source: "checked", pairs: [], note, edges: new Set() });
    }
  }

  const out = new Map<string, KnowledgeContradictionFound>();
  for (const [key, { edges: _edges, ...item }] of found) out.set(key, item);
  return out;
}
