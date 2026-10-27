/**
 * LLM-confirmed concept merges: same-type concepts that are almost certainly one thing to the
 * embedder but that the automatic rule's name guards refused ("48-hour account warm-up" / "Warm up
 * the account for 48 hours before posting", "Proxy risk check" / "Check proxy fraud score on
 * IPQualityScore and Scamalytics") are asked about, one pair per task, in linking's idle rounds
 * (a `KnowledgeRoundTaskSource`, step {@link CONCEPT_CHECK_STEP}). An answer that they are the same
 * becomes a merge with `source: "checked"` (`KnowledgeConceptMerges.recordCheck`; undone like any
 * merge, and then never made again); either answer is remembered in `concept-merges.json`
 * (`checks`), so a pair is asked once per pair of names.
 *
 * Candidates ({@link conceptCheckCandidates}): same type (never Person: the deterministic Person
 * rule covers handles, and names alone cannot tell two people apart); cosine ≥ the model's bar
 * ({@link E5_SMALL_CONCEPT_CHECK_BARS}: higher for concepts that share no entry); refused by a name
 * guard that an LLM can overrule — `lexical`, `list`, `numbers` only when one name has no number,
 * `negation` only when both names negate (one negated name is never the same as a plain one); at
 * least one name word in common; not merged together already, not in an undone merge, not checked
 * at these names. Names that nearly coincide ({@link CONCEPT_CHECK_ALIKE_WORDS}+ words in common, at
 * least half of their words) are asked about at a lower bar (`alikeNames`), with or without a shared
 * entry: two entries often name one thing in two wordings ("US App Store download and warm-up" /
 * "… plus warm-up"). Sharing an entry first (myKG often extracts one thing twice from one entry),
 * then closest first; at most {@link CONCEPT_CHECK_MAX_PER_ROUND} a round. Linking's rounds follow
 * one another while a round answered something (`linking/service.ts`), so the candidates are asked
 * about round after round until none is left.
 *
 * Each concept is shown with an excerpt of one of its entries: the passage naming it best among its
 * first entries ({@link conceptExcerptFor}), not an entry's opening. A check records its input
 * version ({@link CONCEPT_CHECK_INPUT_VERSION}).
 */

import type { KnowledgeConceptMergeCheck, KnowledgeConceptMergeRejection } from "@orquester/config";
import { EMBEDDING_MODEL_ID } from "../install/pins.ts";
import type { KnowledgeRoundTask, KnowledgeRoundTaskOptions, KnowledgeRoundTaskSource } from "../ports.ts";
import {
  conceptMergeRefusal,
  conceptNameNegations,
  conceptNameNumbers,
  conceptNameTokens,
  type ConceptMergeRefusal,
  type ConceptMergeThresholds,
  type KnowledgeConceptMerges
} from "./concept-merges.ts";
import type { GraphConcept } from "./graph.ts";

export const CONCEPT_CHECK_STEP = "concept-check";
/** Concept pairs asked about per round at most. */
export const CONCEPT_CHECK_MAX_PER_ROUND = 40;
/** Characters of an entry shown beside a concept. */
export const CONCEPT_CHECK_EXCERPT_CHARS = 360;
/** A concept's entries searched (in order) for the passage that names it best. */
export const CONCEPT_CHECK_EXCERPT_ENTRIES = 3;
/**
 * The version of a check's input, recorded with it (`inputVersion`). 1 (absent): the sentence of
 * the concept's first entry with the most of its name's words. 2: the passage naming it best, by
 * its name or an alias whole, else the largest share of one's words, among its first
 * {@link CONCEPT_CHECK_EXCERPT_ENTRIES} entries ({@link conceptExcerpt}). Version 1 answers are not
 * asked again: on the live graph every one of them showed a sentence with the concept's words.
 */
export const CONCEPT_CHECK_INPUT_VERSION = 2;
const REASON_MAX = 300;
/** Types never checked (see the module header). */
const SKIP_TYPES: ReadonlySet<string> = new Set(["Person"]);
/** Guards an LLM may overrule (`type`, `similarity` and `person` it may not). */
const CHECKABLE: ReadonlySet<ConceptMergeRefusal> = new Set(["lexical", "list", "numbers", "negation"]);

/** A model's cosine bars for asking about a pair (concept vectors, as `ConceptMergeThresholds`). */
export interface ConceptCheckBars {
  /** The two concepts come from at least one same entry. */
  sharedEntry: number;
  /** They share no entry. */
  alone: number;
  /**
   * Their names nearly coincide ({@link CONCEPT_CHECK_ALIKE_WORDS}+ name words in common, at least
   * half of their words), whether or not they share an entry. Absent: no lower bar for them.
   */
  alikeNames?: number;
}

/** Name words two concepts must have in common for the `alikeNames` bar; and at least half of their words (Jaccard). */
export const CONCEPT_CHECK_ALIKE_WORDS = 3;
const ALIKE_MIN_JACCARD = 0.5;

function alikeNames(x: ReadonlySet<string>, y: ReadonlySet<string>): boolean {
  let shared = 0;
  for (const token of x) if (y.has(token)) shared += 1;
  return shared >= CONCEPT_CHECK_ALIKE_WORDS && shared / (x.size + y.size - shared) >= ALIKE_MIN_JACCARD;
}

/**
 * multilingual-e5-small, calibrated on the live graph of 2026-10-27 (4,161 concepts, 126 entries;
 * a read-only copy). e5 packs concept texts of one type together, so a bar like the spec's 0.93 is
 * far too low: 10,789 same-type pairs at ≥ 0.93 are refused by a name guard (lexical 6,612, numbers
 * 3,970, negation 186, list 21), mostly siblings ("Copilot" ~ "Stable Diffusion" 0.965, "Reddit
 * cited by ChatGPT" ~ "YouTube cited by ChatGPT" 0.965). Duplicates almost always share an entry
 * (myKG extracts one thing twice, under two wordings, from one document): "48-hour account
 * warm-up" ~ "Warm up the account for 48 hours before posting" 0.985, "Proxy risk check" ~ "Check
 * proxy fraud score on IPQualityScore and Scamalytics" 0.983, "Make any phone hit a US audience on
 * TikTok" ~ "… (used iPhone, ISP proxy, Shadowrocket)" 0.972. With the filters of the module
 * header, ≥ 0.96 sharing an entry or ≥ 0.975 alone leaves ~430 pairs (418 sharing an entry): about
 * eleven rounds once, then only what new entries bring.
 *
 * Once those were asked (the live graph of the evening: 2,918 concepts, 122 candidates, all
 * checked, 5 the same), the duplicates still visible were mostly two entries naming one thing in two
 * wordings, at 0.94–0.975 with no shared entry: "US App Store download and warm-up" ~ "… plus
 * warm-up" 0.964, "ISP proxy with IPQS/Scamalytics risk check" ~ "ISP proxy that passes IPQS and
 * Scamalytics" 0.947, "Buying press releases that point at your site" ~ "… pointing to your site"
 * 0.974. Names sharing 3+ words and half of their words, at ≥ 0.94, add 101 pairs (82 sharing no
 * entry; siblings among them, "… health data …" ~ "… financial data …", which the check tells
 * apart): three rounds.
 */
export const E5_SMALL_CONCEPT_CHECK_BARS: ConceptCheckBars = { sharedEntry: 0.96, alone: 0.975, alikeNames: 0.94 };

const BARS_BY_MODEL: Readonly<Record<string, ConceptCheckBars>> = { [EMBEDDING_MODEL_ID]: E5_SMALL_CONCEPT_CHECK_BARS };

export function conceptCheckBarsFor(modelId: string): ConceptCheckBars | null {
  return BARS_BY_MODEL[modelId] ?? null;
}

export interface ConceptCheckCandidate {
  a: GraphConcept;
  b: GraphConcept;
  similarity: number;
  sharesEntry: boolean;
  refusal: ConceptMergeRefusal;
}

export interface ConceptCheckCandidatesInput {
  /** myKG's concepts (before the merge overlay). */
  concepts: readonly GraphConcept[];
  vectors: ReadonlyMap<string, Float32Array>;
  thresholds: ConceptMergeThresholds;
  bars: ConceptCheckBars;
  rejected: readonly KnowledgeConceptMergeRejection[];
  checks: readonly KnowledgeConceptMergeCheck[];
  /** The concept a concept is merged into (the id itself when none). */
  canonical: (conceptId: string) => string;
  limit: number;
  /** Awaited every few rows (default: one turn of the event loop). */
  pause?: () => Promise<void>;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const PAUSE_EVERY_ROWS = 16;

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** Pairs worth asking about, best first (see the module header). */
export async function conceptCheckCandidates(input: ConceptCheckCandidatesInput): Promise<ConceptCheckCandidate[]> {
  const pause = input.pause ?? nextTurn;
  const low = Math.min(input.bars.sharedEntry, input.bars.alone, input.bars.alikeNames ?? Number.POSITIVE_INFINITY);
  const forbidden = new Set<string>();
  const pairKey = (x: string, y: string): string => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  for (const rejection of input.rejected) {
    for (const x of rejection.concepts) for (const y of rejection.concepts) if (x !== y) forbidden.add(pairKey(x, y));
  }
  const asked = new Map<string, KnowledgeConceptMergeCheck>();
  for (const check of input.checks) asked.set(pairKey(check.a, check.b), check);
  const byType = new Map<string, { concept: GraphConcept; vector: Float32Array; tokens: Set<string> }[]>();
  for (const concept of input.concepts) {
    if (SKIP_TYPES.has(concept.type)) continue;
    const vector = input.vectors.get(concept.id);
    if (!vector) continue;
    let list = byType.get(concept.type);
    if (!list) byType.set(concept.type, (list = []));
    list.push({ concept, vector, tokens: conceptNameTokens(concept.name) });
  }
  const out: ConceptCheckCandidate[] = [];
  let rows = 0;
  for (const list of byType.values()) {
    for (let i = 0; i < list.length; i += 1) {
      if (++rows % PAUSE_EVERY_ROWS === 0) await pause();
      const x = list[i]!;
      for (let j = i + 1; j < list.length; j += 1) {
        const y = list[j]!;
        const similarity = dot(x.vector, y.vector);
        if (similarity < low) continue;
        const sharesEntry = x.concept.entryIds.some((id) => y.concept.entryIds.includes(id));
        if (similarity < (sharesEntry ? input.bars.sharedEntry : input.bars.alone)) {
          const alike = input.bars.alikeNames;
          if (alike === undefined || similarity < alike || !alikeNames(x.tokens, y.tokens)) continue;
        }
        const refusal = conceptMergeRefusal(x.concept, y.concept, similarity, input.thresholds);
        if (refusal === null || !CHECKABLE.has(refusal)) continue;
        if (refusal === "numbers" && conceptNameNumbers(x.concept.name).size > 0 && conceptNameNumbers(y.concept.name).size > 0) continue;
        if (refusal === "negation" && (conceptNameNegations(x.concept.name).size === 0 || conceptNameNegations(y.concept.name).size === 0)) continue;
        let common = false;
        for (const token of x.tokens) {
          if (y.tokens.has(token)) {
            common = true;
            break;
          }
        }
        if (!common) continue;
        const key = pairKey(x.concept.id, y.concept.id);
        if (forbidden.has(key) || input.canonical(x.concept.id) === input.canonical(y.concept.id)) continue;
        const [a, b] = x.concept.id < y.concept.id ? [x.concept, y.concept] : [y.concept, x.concept];
        const check = asked.get(key);
        if (check && check.nameA === a.name && check.nameB === b.name) continue;
        out.push({ a, b, similarity, sharesEntry, refusal });
      }
    }
  }
  const score = (c: ConceptCheckCandidate): number => c.similarity + (c.sharesEntry ? 0.02 : 0);
  out.sort((p, q) => score(q) - score(p) || (p.a.id < q.a.id ? -1 : p.a.id > q.a.id ? 1 : p.b.id < q.b.id ? -1 : 1));
  return out.slice(0, input.limit);
}

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

export const CONCEPT_CHECK_SYSTEM = [
  "You decide whether two concepts extracted from a knowledge base name the same thing.",
  'Answer with ONLY a JSON object, no prose and no other keys: {"same": true | false, "keep": "a" | "b", "reason": "<one sentence>"}.',
  "- same is true only if A and B denote the same thing at the same level of specificity, so that one name could replace the other everywhere.",
  "- NOT the same: different numbers, quantities or durations (48 hours vs 7 days); one is the negation or the opposite of the other; a different scope (a part or one step vs the whole, one platform, market or product vs another, a general practice vs one specific variant of it); a list vs one of its items; two related, similar or alternative things.",
  "- When in doubt, answer false.",
  '- keep: the name that is clearer and more complete, "a" or "b" (give it even when same is false).',
  `- reason: one sentence of at most ${REASON_MAX} characters.`
].join("\n");

/** A concept as the task shows it, with a short excerpt of one of its entries. */
export interface ConceptCheckSide {
  type: string;
  name: string;
  aliases: readonly string[];
  description: string | null;
  excerpt: { title: string; text: string } | null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The task's user message. */
export function conceptCheckInput(a: ConceptCheckSide, b: ConceptCheckSide): string {
  const block = (label: string, side: ConceptCheckSide): string =>
    [
      label,
      "=".repeat(label.length),
      `Type: ${oneLine(side.type)}`,
      `Name: ${oneLine(side.name)}`,
      ...(side.aliases.length > 0 ? [`Aliases: ${side.aliases.map(oneLine).join("; ")}`] : []),
      ...(side.description ? [`Description: ${oneLine(side.description)}`] : []),
      ...(side.excerpt ? [`Excerpt from "${oneLine(side.excerpt.title)}": ${side.excerpt.text}`] : [])
    ].join("\n");
  return `${block("CONCEPT A", a)}\n\n${block("CONCEPT B", b)}\n\nAre A and B the same thing? Answer with the JSON object only.`;
}

/** A name as a phrase to look for: folded, runs of anything but letters and digits as one space. */
function phrase(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/** How well a piece of text names a concept: 2 when it has its name or an alias whole, else the largest share of one's words (0 to 1). */
function namingScore(piece: string, variants: readonly { phrase: string; tokens: ReadonlySet<string> }[]): number {
  const text = phrase(piece);
  const tokens = conceptNameTokens(piece);
  let best = 0;
  for (const variant of variants) {
    if (variant.phrase.trim().length >= 3 && text.includes(variant.phrase)) return 2;
    if (variant.tokens.size === 0) continue;
    let hit = 0;
    for (const token of variant.tokens) if (tokens.has(token)) hit += 1;
    best = Math.max(best, hit / variant.tokens.size);
  }
  return best;
}

/**
 * The part of an entry's body that best shows a concept: the sentence (or line) that names it best
 * (its name or an alias whole, else the largest share of one's words; the first such), with what
 * follows it, up to {@link CONCEPT_CHECK_EXCERPT_CHARS} characters, as one line; the body's start
 * when no sentence has any of its words (`score` 0).
 */
export function conceptExcerpt(body: string, concept: { name: string; aliases: readonly string[] }): { text: string; score: number } {
  const variants = [concept.name, ...concept.aliases].map((name) => ({ phrase: phrase(name), tokens: conceptNameTokens(name) }));
  const pieces = body.split(/(?<=[.!?])\s+|\n+/).map(oneLine).filter((piece) => piece.length > 0);
  let best = 0;
  let bestScore = 0;
  pieces.forEach((piece, i) => {
    const score = namingScore(piece, variants);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  let text = "";
  for (let i = best; i < pieces.length && text.length < CONCEPT_CHECK_EXCERPT_CHARS; i += 1) text = text ? `${text} ${pieces[i]}` : pieces[i]!;
  return { text: text.length <= CONCEPT_CHECK_EXCERPT_CHARS ? text : `${text.slice(0, CONCEPT_CHECK_EXCERPT_CHARS).trimEnd()} […]`, score: bestScore };
}

/**
 * A concept's excerpt: of its first {@link CONCEPT_CHECK_EXCERPT_ENTRIES} entries (in order), the
 * one whose passage names it best ({@link conceptExcerpt}; a tie keeps the earlier entry). Null
 * when none of them can be read.
 */
export async function conceptExcerptFor(
  concept: Pick<GraphConcept, "name" | "aliases" | "entryIds">,
  entry: (entryId: string) => Promise<{ title: string; body: string } | null>
): Promise<{ title: string; text: string; score: number } | null> {
  let best: { title: string; text: string; score: number } | null = null;
  for (const entryId of concept.entryIds.slice(0, CONCEPT_CHECK_EXCERPT_ENTRIES)) {
    const found = await entry(entryId).catch(() => null);
    if (!found) continue;
    const excerpt = conceptExcerpt(found.body, concept);
    if (best === null || excerpt.score > best.score) best = { title: found.title, ...excerpt };
    if (best.score >= 2) break;
  }
  return best;
}

/** `null` when `value` is a valid answer, else why not (the worker is asked to answer again). */
export function validateConceptCheckAnswer(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 'The answer must be a JSON object {"same": …, "keep": …, "reason": …}.';
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "same" && key !== "keep" && key !== "reason");
  if (extra.length > 0) return `The answer has keys it must not have (${extra.slice(0, 3).join(", ")}): only "same", "keep" and "reason".`;
  if (typeof record.same !== "boolean") return '"same" must be true or false.';
  if (record.keep !== "a" && record.keep !== "b") return '"keep" must be "a" or "b".';
  if (typeof record.reason !== "string" || record.reason.trim() === "") return '"reason" must be a one-sentence string.';
  if (record.reason.length > REASON_MAX) return `"reason" must be at most ${REASON_MAX} characters.`;
  return null;
}

/** A validated answer, or null (bad JSON included). */
export function parseConceptCheckAnswer(text: string): { same: boolean; keep: "a" | "b"; reason: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (validateConceptCheckAnswer(value) !== null) return null;
  const record = value as { same: boolean; keep: "a" | "b"; reason: string };
  return { same: record.same, keep: record.keep, reason: record.reason.trim() };
}

/** What a concept-check task carries back with its answer. */
export interface ConceptCheckPayload {
  a: string;
  b: string;
  type: string;
  nameA: string;
  nameB: string;
  similarity: number;
  /** {@link CONCEPT_CHECK_INPUT_VERSION} when the task was written; absent in an older build's task (1). */
  inputVersion?: number;
}

function readPayload(value: unknown): ConceptCheckPayload | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const inputVersion = typeof v.inputVersion === "number" && Number.isInteger(v.inputVersion) && v.inputVersion >= 1 ? v.inputVersion : 1;
  return typeof v.a === "string" &&
    typeof v.b === "string" &&
    typeof v.type === "string" &&
    typeof v.nameA === "string" &&
    typeof v.nameB === "string" &&
    typeof v.similarity === "number"
    ? { a: v.a, b: v.b, type: v.type, nameA: v.nameA, nameB: v.nameB, similarity: v.similarity, inputVersion }
    : null;
}

export interface ConceptMergeCheckSourceOptions {
  merges: Pick<KnowledgeConceptMerges, "checkState" | "recordCheck" | "onPlanned">;
  /** An entry's title and body (for excerpts); null when gone. */
  entry(entryId: string): Promise<{ title: string; body: string } | null>;
  /** The bars of a model (tests); default {@link conceptCheckBarsFor}. */
  bars?: (modelId: string) => ConceptCheckBars | null;
  limit?: number;
  now?: () => Date;
  pause?: () => Promise<void>;
}

/** The concept checks as a `KnowledgeRoundTaskSource` (see the module header). */
export class ConceptMergeCheckSource implements KnowledgeRoundTaskSource {
  readonly step = CONCEPT_CHECK_STEP;

  constructor(private readonly options: ConceptMergeCheckSourceOptions) {}

  async tasks(options: KnowledgeRoundTaskOptions = {}): Promise<KnowledgeRoundTask[]> {
    const state = this.options.merges.checkState();
    const bars = state ? (this.options.bars ?? conceptCheckBarsFor)(state.set.modelId) : null;
    if (!state || !bars) return [];
    const cap = this.options.limit ?? CONCEPT_CHECK_MAX_PER_ROUND;
    const candidates = await conceptCheckCandidates({
      concepts: state.concepts,
      vectors: state.set.vectors,
      thresholds: state.thresholds,
      bars,
      rejected: state.rejected,
      checks: state.checks,
      canonical: state.canonical,
      // Items rounds gave up on are skipped below: the next ones take their place.
      limit: options.skip ? Number.POSITIVE_INFINITY : cap,
      ...(this.options.pause ? { pause: this.options.pause } : {})
    });
    const tasks: KnowledgeRoundTask[] = [];
    for (const candidate of candidates) {
      if (tasks.length >= cap) break;
      const [a, b] = await Promise.all([this.side(candidate.a), this.side(candidate.b)]);
      const payload: ConceptCheckPayload = {
        a: candidate.a.id,
        b: candidate.b.id,
        type: candidate.a.type,
        nameA: candidate.a.name,
        nameB: candidate.b.name,
        similarity: Math.round(candidate.similarity * 10_000) / 10_000,
        inputVersion: CONCEPT_CHECK_INPUT_VERSION
      };
      const task: KnowledgeRoundTask = { label: `${CONCEPT_CHECK_STEP} ${candidate.a.id} ${candidate.b.id}`, system: CONCEPT_CHECK_SYSTEM, user: conceptCheckInput(a, b), payload };
      if (!options.skip?.(task)) tasks.push(task);
    }
    return tasks;
  }

  validate(value: unknown): string | null {
    return validateConceptCheckAnswer(value);
  }

  async record(payload: unknown, answer: string): Promise<void> {
    const task = readPayload(payload);
    const parsed = parseConceptCheckAnswer(answer);
    if (!task || !parsed) return;
    await this.options.merges.recordCheck({
      a: task.a,
      b: task.b,
      type: task.type,
      nameA: task.nameA,
      nameB: task.nameB,
      same: parsed.same,
      keep: parsed.keep === "a" ? task.a : task.b,
      reason: parsed.reason,
      similarity: task.similarity,
      checkedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      inputVersion: task.inputVersion ?? 1
    });
  }

  onWork(listener: () => void): () => void {
    return this.options.merges.onPlanned(listener);
  }

  private async side(concept: GraphConcept): Promise<ConceptCheckSide> {
    const excerpt = await conceptExcerptFor(concept, this.options.entry);
    return {
      type: concept.type,
      name: concept.name,
      aliases: concept.aliases,
      description: concept.description,
      excerpt: excerpt ? { title: excerpt.title, text: excerpt.text } : null
    };
  }
}
