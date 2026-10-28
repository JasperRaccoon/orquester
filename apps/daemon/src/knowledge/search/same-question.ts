/**
 * Concepts that answer the same question ("How long to warm up?": "Warm up the account for 48
 * hours", "3-5 days of warming up"; "SIM or no SIM?": "Remove the SIM card and stay on VPN 24/7",
 * "No SIM in the phone"), and what a claim's topic is. Read by an entry's novelty and insights'
 * single-source claims (a claim another visible entry answers too is neither new nor single-source)
 * and by pair checks' numbers tier (two answers with different figures are worth checking).
 *
 * The rule is injected: `KnowledgeGraph.setSameQuestion` takes any {@link SameQuestion} (concept
 * families, when there are some: {@link sameQuestionWithFamilies}); without one the graph answers
 * with {@link sameQuestionByVectors}, this module's fallback: same type, concept vectors at
 * {@link SAME_QUESTION_MIN_SIMILARITY} and a telling name word in common ({@link questionWords}).
 * Callers only ever ask about two concepts of one type.
 *
 * Plugging in concept families (`search/concept-families.ts`, whose `familyOf(conceptId)` answers a
 * family's member concept ids): in `knowledge/service.ts`, once the families are loaded (after
 * `concepts.start()`, which gives the fallback its vectors), call
 * `graph.setSameQuestion(sameQuestionWithFamilies(familyOf, (a, b) => graph.sameQuestionFallback(a, b)))`,
 * and call it again whenever the families change: it moves `KnowledgeGraph.backingRevision`, which
 * insights' caches are keyed on (an entry's novelty is computed per read). The ids asked about are the
 * graph's own (`canonicalConceptId`: a merged concept under the one kept); map family members through
 * it if they are not. Nothing else changes: novelty, single-source claims and the pair checks'
 * numbers tier all ask `graph.sameQuestion`.
 */

import type { KnowledgeConceptRef } from "@orquester/api";
import { compoundParts, conceptNameTokens } from "./concept-merges.ts";
import { tokenize } from "./text.ts";

/** What the rule reads of a concept: the graph's id (merged concepts under the one kept), its type and name. */
export type SameQuestionConcept = Pick<KnowledgeConceptRef, "id" | "type" | "name">;

/** Whether two concepts answer the same question (symmetric; any concept answers its own). */
export type SameQuestion = (a: SameQuestionConcept, b: SameQuestionConcept) => boolean;

/**
 * Concept vectors at least this close, with a telling name word in common ({@link questionWords}),
 * answer the same question (multilingual-e5-small; live graph of 2026-10-28, 1,861 claim concepts on
 * 126 entries, same-type pairs on different entries sharing such a word). At ≥ 0.93, 310 pairs; of
 * 30 drawn at random 24 name one subject ("Warm up the account for 48 hours before posting" ~ "3-5
 * days of warming up" 0.933, "Simulate real user behavior" ~ "Warm up and post by hand, spacing likes
 * and follows like a real user" 0.956, "Ask for a review only after a win" ~ "Ask for a review right
 * after a win through requestReview" 0.934), the rest one word and no more ("Add Privacy Policy URL in
 * App Store Connect" ~ "Update the App Privacy answers in App Store Connect"). In 0.92–0.93, 242
 * pairs, about 2 in 3 ("Crypto mining (even background)…" ~ "Offering crypto for completing tasks");
 * below 0.92 most share a word and nothing else ("Surveillance pricing" ~ "Offer a free trial in
 * pricing configuration" 0.891). The same bar as concept merges' `similar` (nearest same-type
 * neighbours stay on topic down to it). Synonyms below it ("Use an erased iPhone" ~ "Factory reset the
 * iPhone" 0.893, "Use a new email" ~ "Use Outlook or Proton" 0.908) need concept families.
 */
export const SAME_QUESTION_MIN_SIMILARITY = 0.93;

/**
 * Words that say what is done, not to what ("Remove the SIM card" and "No SIM in the phone" answer
 * one question): left out of {@link questionWords}, like glue words, units and numbers.
 */
const ACTION_WORDS: ReadonlySet<string> = new Set(
  (
    "use using used add set make get create keep check run build start stop turn take put give try remove enable disable install buy pick choose " +
    "do does go stay avoid need instead what own always never via into per each every first only after before up out off all any treat show let " +
    "both either also just even more less"
  ).split(" ")
);
/**
 * Words that only say what a number counts ("3-5 days", "15-30 min", "a number"): "Post daily"
 * answers no warm-up question, "One new device for each US number" none about which number to use.
 */
const UNIT_WORDS: ReadonlySet<string> = new Set(
  "second sec minute min hour hr day daily week weekly month monthly year time max maximum minimum least most number amount count total one two three four five six seven eight nine ten twice once".split(" ")
);

/** A name word folded so its forms meet: "warming" / "warm", "erased" / "erase", "based" / "base". */
function foldWord(word: string): string {
  let out = word;
  if (out.length > 5 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith("ed")) out = out.slice(0, -2);
  if (out.length > 3 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

/**
 * The words of a concept name that say which question it answers: {@link conceptNameTokens}'s
 * (lower case, no accents or glue words, plurals folded), forms folded, without numbers, words under
 * three letters, {@link ACTION_WORDS}, {@link UNIT_WORDS}, or words common to many concept names
 * (`common`: concept merges' `commonNameWords`, "tiktok", "account", "email" on the live graph).
 */
export function questionWords(name: string, common: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const token of conceptNameTokens(name)) {
    if (token.length < 3 || /\d/.test(token) || common.has(token) || ACTION_WORDS.has(token) || UNIT_WORDS.has(token)) continue;
    const folded = foldWord(token);
    // "posting" is as common as "post".
    if (!common.has(folded) && !common.has(token.replace(/(?:ing|ed)$/, ""))) out.add(folded);
  }
  return out;
}

/** Whether two names share a {@link questionWords} word. */
export function shareQuestionWord(a: string, b: string, common: ReadonlySet<string> = new Set()): boolean {
  const words = questionWords(a, common);
  for (const word of questionWords(b, common)) if (words.has(word)) return true;
  return false;
}

/**
 * The fallback rule: two concepts of one type whose vectors (`similarity`: their cosine from a
 * calibrated model, null when either has none) are at least {@link SAME_QUESTION_MIN_SIMILARITY}
 * close, and whose names share a telling word ({@link questionWords}, `common` left out). A concept
 * answers its own question.
 */
export function sameQuestionByVectors(
  a: SameQuestionConcept,
  b: SameQuestionConcept,
  similarity: (a: string, b: string) => number | null,
  common: ReadonlySet<string>
): boolean {
  if (a.id === b.id) return true;
  if (a.type.toLowerCase() !== b.type.toLowerCase()) return false;
  const cosine = similarity(a.id, b.id);
  return cosine !== null && cosine >= SAME_QUESTION_MIN_SIMILARITY && shareQuestionWord(a.name, b.name, common);
}

/**
 * The rule with concept families: two concepts of one family answer the same question, two of
 * different families do not; a concept in no family is left to `fallback`. `familyOf` answers the
 * member ids of the family a concept (by its graph id) belongs to, the concept among them, or null
 * (or none) when it is in no family.
 */
export function sameQuestionWithFamilies(familyOf: (conceptId: string) => readonly string[] | null | undefined, fallback: SameQuestion): SameQuestion {
  return (a, b) => {
    if (a.id === b.id) return true;
    const [x, y] = [familyOf(a.id), familyOf(b.id)];
    return x && x.length > 0 && y && y.length > 0 ? x.includes(b.id) : fallback(a, b);
  };
}

/** A qualifier after a compound's first step ("… with fresh Gmail"): a detail of the step, not the step. */
const STEP_QUALIFIER = /\s+(?:with|using|via|through)\s+.*$/i;

/**
 * A compound claim's main step: what it names before a colon, whole ("UGC and slideshows system:
 * research, make a lot, kill losers" → "UGC and slideshows system"), else its first part
 * ({@link compoundParts}) without a trailing qualifier ("Create a new iCloud account with fresh Gmail
 * and Apple ID" → "Create a new iCloud account"; "Remove the SIM card and stay on VPN 24/7" →
 * "Remove the SIM card"); null for a claim of one part, or one whose "and" joins names, not steps
 * (a part of one word: "Show up on both ChatGPT and Gemini").
 */
export function compoundMainStep(name: string): string | null {
  const parts = compoundParts(name);
  if (parts.length < 2) return null;
  const colon = name.replace(/\([^)]*\)/g, (inside) => "\u0000".repeat(inside.length)).indexOf(":");
  if (colon > 0) return name.slice(0, colon).trim();
  if (parts.some((part) => conceptNameTokens(part).size < 2)) return null;
  const step = parts[0]!.replace(STEP_QUALIFIER, "").trim();
  return step.length > 0 ? step : parts[0]!;
}

/** A name's words as {@link namesTopic} compares them: {@link tokenize}'s, "-ing" folded ("Starting" / "Start"). */
function topicWords(text: string): Set<string> {
  return new Set(tokenize(text).map((token) => (token.length > 5 && token.endsWith("ing") ? token.slice(0, -3) : token)));
}

/**
 * The share of a concept name's words a topic (an entry's title, a cluster's label, the name of a
 * concept most of a cluster's entries link to) must hold for the concept to name that topic: half
 * ("Making a US-based TikTok account" on "How to create a US TikTok account and target only the US":
 * tiktok, account of making, based, tiktok, account).
 */
const TOPIC_SHARE = 0.5;

/**
 * Whether a concept names a topic rather than a claim made under it: two or more of its words, at
 * least {@link TOPIC_SHARE} of them, are the topic's ("Start an app from zero with $300 using used
 * iPhones and TikTok accounts" on "Starting an app from zero with $300: 3 used iPhones × 5 TikTok
 * accounts…"; "Making a US-based TikTok account" in the cluster "US TikTok account targeting").
 */
export function namesTopic(conceptName: string, topic: string): boolean {
  const words = topicWords(conceptName);
  const held = topicWords(topic);
  let count = 0;
  for (const word of words) if (held.has(word)) count += 1;
  return count >= 2 && count >= TOPIC_SHARE * words.size;
}

/** Concepts of the other visible entries, by lower-cased type: what {@link answeredElsewhereTest} compares a concept with. */
export type OtherConcepts = ReadonlyMap<string, readonly SameQuestionConcept[]>;

/** Claim types whose names may hold a compound's main step ({@link answeredElsewhereTest}). */
const MAIN_STEP_TYPES: readonly string[] = ["tactic", "rule", "guideline", "result", "metric"];

/**
 * Whether another visible entry answers the question a claim answers, against `others` (the visible
 * concepts by type; `elsewhere` says whether one is on an entry other than the claim's, default:
 * all are): one of its concepts of the same type answers the same question (`sameQuestion`; null:
 * nothing can, so none is asked), or, for a compound claim, one of its claims names the compound's
 * main step ({@link compoundMainStep}: every one of the step's {@link questionWords}, one at least,
 * "Remove the SIM card" in "No SIM in the phone"). A compound whose other parts only add details
 * ("… with fresh Gmail") is single-source only when its main step is. Names' words are read once per
 * test made.
 */
export function answeredElsewhereTest(
  others: OtherConcepts,
  sameQuestion: SameQuestion | null,
  common: ReadonlySet<string>
): (concept: SameQuestionConcept, elsewhere?: (other: SameQuestionConcept) => boolean) => boolean {
  const words = new Map<string, Set<string>>();
  const wordsOf = (concept: SameQuestionConcept): Set<string> => {
    let found = words.get(concept.id);
    if (!found) words.set(concept.id, (found = questionWords(concept.name, common)));
    return found;
  };
  return (concept, elsewhere = () => true) => {
    if (sameQuestion) {
      for (const other of others.get(concept.type.toLowerCase()) ?? []) if (other.id !== concept.id && elsewhere(other) && sameQuestion(concept, other)) return true;
    }
    const step = compoundMainStep(concept.name);
    const stepWords = step === null ? null : [...questionWords(step, common)];
    if (!stepWords || stepWords.length === 0) return false;
    for (const type of MAIN_STEP_TYPES) {
      for (const other of others.get(type) ?? []) {
        if (other.id === concept.id || !elsewhere(other)) continue;
        const theirs = wordsOf(other);
        if (stepWords.every((word) => theirs.has(word))) return true;
      }
    }
    return false;
  };
}

/** The concepts linked to `entryIds` (each once, `skip` aside), by lower-cased type ({@link OtherConcepts}). */
export function conceptsByType(entryIds: Iterable<string>, conceptsOf: (entryId: string) => readonly SameQuestionConcept[], skip?: string): OtherConcepts {
  const out = new Map<string, SameQuestionConcept[]>();
  const seen = new Set<string>();
  for (const entryId of entryIds) {
    if (entryId === skip) continue;
    for (const concept of conceptsOf(entryId)) {
      if (seen.has(concept.id)) continue;
      seen.add(concept.id);
      const type = concept.type.toLowerCase();
      let list = out.get(type);
      if (!list) out.set(type, (list = []));
      list.push(concept);
    }
  }
  return out;
}
