/**
 * Concept families (quality round 5, `KnowledgeConceptDetail.family`). myKG splits one question
 * across many concepts of one type, each one guide's answer: "Warm up the account for 48 hours
 * before posting" (jason), "Warm up each account for 3 days" (yanme), "3-5 days of warming up"
 * (Evgeniy), "Warm up the TikTok account for 5-7 days" (Ema). They are not duplicates (merges keep
 * them apart: their numbers differ) and each concept's summary sees only its own entries, so the
 * spread across guides was never put together. A family groups them: concepts of one claim type
 * ({@link FAMILY_TYPES}) that answer the same question.
 *
 * - The rule ({@link familiesOf}, deterministic): two concepts of one type are linked when their
 *   vectors are close ({@link ConceptFamilyParams.near}, below the merge and similar-concept bars)
 *   AND their names share a topic word ({@link familyWords}: no glue or generic words, no numbers).
 *   A word on many names ({@link familyVocabulary}: "account", "tiktok", "device") links only with a
 *   second one, when the names say little else (the shorter nothing more, or each one word the
 *   other lacks), at {@link ConceptFamilyParams.commonNear};
 *   a word on very many ("app", "guideline") never. A link is worth its cosine, less when what the
 *   names share is not specific ({@link ConceptFamilyParams.specific}). Concepts are then grouped by
 *   average linkage over the links (a missing link counts 0): two groups join, best first, while
 *   the mean over every pair across them is at least {@link ConceptFamilyParams.link}, up to
 *   {@link ConceptFamilyParams.maxSize} concepts, so one shared word cannot chain two questions
 *   together. A family has at least 2 concepts and 2 different entries; a concept left out (alone,
 *   or in a group of one guide's steps) joins the family it links best to on average, at `link`.
 * - Over the current graph (after the merge overlay); a merged concept's vector is the closest of
 *   its sources', its words those of every source's name.
 * - {@link KnowledgeConceptFamilies}: computed in the background after every complete vector
 *   computation and merge change; {@link KnowledgeConceptFamilies.familyOf} answers the member ids.
 *
 * Calibrated on the live graph of 2026-10-28: see {@link E5_SMALL_FAMILY_PARAMS}.
 */

import { createHash } from "node:crypto";
import { EMBEDDING_MODEL_ID } from "../install/pins.ts";
import type { KnowledgeLogger } from "../store/errors.ts";
import { conceptNameTokens } from "./concept-merges.ts";
import type { GraphConcept } from "./graph.ts";

/** Types grouped into families: claims and the things claims are about (concept summaries' `CLAIM_TYPES`). */
export const FAMILY_TYPES: ReadonlySet<string> = new Set(["Tactic", "Tool", "Metric", "Result", "Guideline"]);

export interface ConceptFamilyParams {
  /** Cosine at or above which two concepts sharing a topic word are linked. */
  near: number;
  /** Cosine at or above which two concepts sharing only common words are linked. */
  commonNear: number;
  /** Average linkage: two groups join while the mean link over every pair across them is at least this. */
  link: number;
  /** Concepts in one family at most. */
  maxSize: number;
  /**
   * The specificity ({@link FamilyVocabulary.weight}, summed over the shared words) at which a link
   * is worth its whole cosine; below it, that share of it. One word on 6 names ("Scamalytics") is
   * worth 7.1, on 20 ("IP") 6.0, "device" + "account" 9.1.
   */
  specific: number;
}

/**
 * multilingual-e5-small, calibrated on the live graph of 2026-10-28 (2,979 concepts after 256
 * merges; 1,841 of the family types; nodes.jsonl and concept vectors copied read-only):
 *
 * - The audit's groups sit at 0.85–0.98 within ("3-5 days of warming up" ~ "Warm up each account
 *   for 3 days" 0.979, "No SIM rather than a foreign SIM" ~ "No SIM in the phone" 0.879, "Factory
 *   reset the iPhone" ~ "Use an erased iPhone" 0.893, "Use a new device for each account" ~ "5
 *   TikTok accounts on each iPhone" 0.881), below `similar` (0.93) and `merge` (0.91): cosine alone
 *   cannot tell them from look-alikes ("Remove entitlements you don't actively use" ~ "Use an erased
 *   iPhone" 0.931, sharing only "use"). → `near` 0.87; `commonNear` 0.88 (0.90 lost "2–3 accounts
 *   per device" ~ "5 TikTok accounts on each iPhone" 0.889).
 * - Common words alone at 0.90 (one sufficing) made 433 families, "Guideline 1.4" ~ "Guideline
 *   2.2" and "Locking accounts after chargebacks" ~ "One device per account" among them; requiring
 *   two, with little else in the names, removed those.
 * - Average linkage at 0.6 with a link worth its cosine let "IP" (20 names) pull "One trial per
 *   IP" and "Buy an ISP proxy at IPRoyal" into the Scamalytics checks and split them; `specific`
 *   6.5 lets the two-word and rarer links merge first. `link` 0.65: 0.6 and 0.7 gave the same
 *   audit groups with 5 more or 7 fewer concepts in families.
 * - Result: 365 families over 1,147 concepts (171 of 2, 1 of 11, none larger; 0.3 s); the warm-up (11:
 *   jason's 48 hours, Alex's, yanme's 3 days, Evgeniy's 3–5, Ema's 5–7, Erikas's swiping and daily
 *   scrolling, …), accounts-per-device (7, Alex's "2–3 maximum per device" with them), SIM (4),
 *   Scamalytics (4), factory reset / erased iPhone
 *   and US-number groups come out whole or nearly ("Remove the SIM card and stay on VPN 24/7" joins
 *   "Align SIM, IP, store and language"; "ISP proxy plus IPQS/Scamalytics check" the IP risk-score
 *   family; "Use a US number" the "specific numbers" one), the entitlements look-alike does not.
 */
export const E5_SMALL_FAMILY_PARAMS: ConceptFamilyParams = { near: 0.87, commonNear: 0.88, link: 0.65, maxSize: 12, specific: 6.5 };

/** Calibrated models only: another model's vectors make no families. */
const PARAMS_BY_MODEL: Readonly<Record<string, ConceptFamilyParams>> = { [EMBEDDING_MODEL_ID]: E5_SMALL_FAMILY_PARAMS };

export function familyParamsFor(modelId: string): ConceptFamilyParams | null {
  return PARAMS_BY_MODEL[modelId] ?? null;
}

/** A word's stem: "warming" and "warm-up"/"warmup" → "warm", "erased"/"erase" → "eras". */
function baseStem(word: string): string {
  let w = word;
  if (w.length >= 6 && w.endsWith("up")) w = w.slice(0, -2);
  if (w.length >= 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length >= 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length >= 5 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/**
 * Words that say nothing about which question a name answers: verbs any step has, quantifiers,
 * prepositions and negations ("Use an erased iPhone" and "Remove entitlements you don't actively
 * use" share "use"; "One device per account" and "One fresh Apple ID per device" share "one"), as
 * {@link familyWords} reads them.
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set(
  [
    ...conceptNameTokens(
      "use using used create make get set add do keep take run stay put go give have need want try start check " +
        "one two three new each per every first last all any only more less most many much few some other same own " +
        "up down on in off out over under into onto via than rather then when if after before during while about like just also plus versus vs instead " +
        "not no never always dont don without avoid can should must will may might " +
        "way thing step real actual actively good best better big small high low " +
        "pick choose build write find show publish treat turn call ask let send fix make take remove replace include explain test track mine"
    )
  ].flatMap((token) => [token, baseStem(token)])
);

/**
 * Stems that name one thing ("Use an erased iPhone" and "Factory reset the iPhone"; "5 TikTok
 * accounts on each iPhone" and "2–3 accounts per device").
 */
const SYNONYMS: Readonly<Record<string, string>> = { iphon: "devic", phon: "devic", smartphon: "devic", eras: "reset", wipe: "reset" };

/** The topic words of a name: {@link conceptNameTokens} without numbers, roman numerals or {@link GENERIC_WORDS}, stemmed ({@link baseStem}, {@link SYNONYMS}). */
export function familyWords(name: string): Set<string> {
  const out = new Set<string>();
  for (const token of conceptNameTokens(name)) {
    if (token.length < 2 || /^\d/.test(token) || /^[ivx]+$/.test(token) || GENERIC_WORDS.has(token)) continue;
    const stem = baseStem(token);
    if (!GENERIC_WORDS.has(stem)) out.add(SYNONYMS[stem] ?? stem);
  }
  return out;
}

/** How often topic words occur on the graph's names: what one shared word is worth. */
export interface FamilyVocabulary {
  /** On more than {@link FAMILY_COMMON_SHARE} of the names: one alone links nothing. */
  common: ReadonlySet<string>;
  /** On more than {@link FAMILY_FREQUENT_SHARE} of the names: says nothing ("app", "guideline"). */
  frequent: ReadonlySet<string>;
  /** How specific a word is (inverse document frequency over the names). */
  weight(word: string): number;
}

/** A topic word on more than this share of names is common ("account", "tiktok", "device", "post" on the live graph: 1–3%). */
export const FAMILY_COMMON_SHARE = 0.01;
/** … and frequent above this share ("app" 9%, "guideline" 4.8% on the live graph). */
export const FAMILY_FREQUENT_SHARE = 0.04;
/** A word on at most this many names is never common, however small the graph. */
const COMMON_MIN_NAMES = 3;

/** The {@link FamilyVocabulary} of a graph's names (every concept's, of every type). */
export function familyVocabulary(names: Iterable<string>): FamilyVocabulary {
  const counts = new Map<string, number>();
  let total = 0;
  for (const name of names) {
    total += 1;
    for (const word of familyWords(name)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return familyVocabularyOf(counts, total);
}

/** The {@link FamilyVocabulary} of `total` names on which each topic word occurs `counts` times (fixtures mirroring a graph). */
export function familyVocabularyOf(counts: ReadonlyMap<string, number>, total: number): FamilyVocabulary {
  // A smaller graph is read as if it had the calibration graph's size: its words are as telling.
  const names = Math.max(total, FAMILY_VOCABULARY_MIN_NAMES);
  const common = new Set<string>();
  const frequent = new Set<string>();
  for (const [word, count] of counts) {
    if (count <= COMMON_MIN_NAMES) continue;
    if (count > FAMILY_FREQUENT_SHARE * names) frequent.add(word);
    else if (count > FAMILY_COMMON_SHARE * names) common.add(word);
  }
  const weight = (count: number): number => Math.log((names + 1) / (count + 1)) + 1;
  return { common, frequent, weight: (word) => weight(counts.get(word) ?? 0) };
}

/**
 * Word shares and weights are taken over at least this many names (the calibration graph's 2,979):
 * in a knowledge base of 100 concepts, "warm" on 7 names is no more common than on 13 of 2,979, and
 * a link's {@link ConceptFamilyParams.specific} would otherwise be out of reach.
 */
export const FAMILY_VOCABULARY_MIN_NAMES = 3_000;

/** A concept as families read it. */
export interface FamilyConcept {
  id: string;
  type: string;
  name: string;
  /** Every name it goes by that says what it is (a merge's sources' names). */
  names: readonly string[];
  entryIds: readonly string[];
  /** The ids its vectors are stored under (a merge's sources; else its own id). */
  vectorIds: readonly string[];
}

/** A family: concepts of one type answering one question. */
export interface ConceptFamily {
  /** Stable while its first member (by id) stays in it. */
  id: string;
  type: string;
  /** Member concept ids (the graph's after the overlay), most entries first. */
  concepts: string[];
  /** Every entry behind a member, sorted. */
  entryIds: string[];
}

export interface ConceptFamiliesInput {
  concepts: readonly FamilyConcept[];
  vectors: ReadonlyMap<string, Float32Array>;
  params?: ConceptFamilyParams;
  /** {@link familyVocabulary} of every concept name; default: computed from `concepts`. */
  vocabulary?: FamilyVocabulary;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** The family id of a member set ({@link ConceptFamily.id}). */
export function conceptFamilyId(type: string, members: readonly string[]): string {
  const anchor = [...members].sort()[0] ?? "";
  return `family-${createHash("sha256").update(`${type}\u0000${anchor}`, "utf8").digest("hex").slice(0, 12)}`;
}

interface Prepared {
  concept: FamilyConcept;
  words: Set<string>;
  vectors: Float32Array[];
}

function prepare(input: ConceptFamiliesInput): Map<string, Prepared[]> {
  const byType = new Map<string, Prepared[]>();
  for (const concept of input.concepts) {
    if (!FAMILY_TYPES.has(concept.type) || concept.entryIds.length === 0) continue;
    const vectors = concept.vectorIds.map((id) => input.vectors.get(id)).filter((v): v is Float32Array => v !== undefined);
    if (vectors.length === 0) continue;
    const words = new Set<string>();
    for (const name of [concept.name, ...concept.names]) for (const word of familyWords(name)) words.add(word);
    if (words.size === 0) continue;
    let list = byType.get(concept.type);
    if (!list) byType.set(concept.type, (list = []));
    list.push({ concept, words, vectors });
  }
  for (const list of byType.values()) list.sort((a, b) => (a.concept.id < b.concept.id ? -1 : a.concept.id > b.concept.id ? 1 : 0));
  return byType;
}

/** The link of two concepts (0: none); see the module header. */
function linkOf(a: Prepared, b: Prepared, params: ConceptFamilyParams, vocabulary: FamilyVocabulary): number {
  let rare = false;
  let common = 0;
  let specificity = 0;
  for (const word of a.words) {
    if (!b.words.has(word) || vocabulary.frequent.has(word)) continue;
    if (vocabulary.common.has(word)) common += 1;
    else rare = true;
    specificity += vocabulary.weight(word);
  }
  if (!rare) {
    if (common < 2) return 0;
    // Common words only: the names say little else — the shorter nothing the longer does not, or
    // each one word the other lacks ("2–3 maximum per device" ~ "one per device").
    const only = (x: ReadonlySet<string>, y: ReadonlySet<string>): number => [...x].filter((word) => !vocabulary.frequent.has(word) && !y.has(word)).length;
    const [small, large] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
    const extra = only(small, large);
    if (extra > 1 || (extra === 1 && only(large, small) > 1)) return 0;
  }
  let similarity = -1;
  for (const x of a.vectors) for (const y of b.vectors) similarity = Math.max(similarity, dot(x, y));
  if (similarity < (rare ? params.near : params.commonNear)) return 0;
  return similarity * Math.min(1, specificity / params.specific);
}

/** Average linkage over one type's links (see the module header). */
function cluster(items: readonly Prepared[], links: ReadonlyMap<number, ReadonlyMap<number, number>>, params: ConceptFamilyParams): number[][] {
  // Groups by their smallest member index; sums of links between groups.
  const members = new Map<number, number[]>();
  const sums = new Map<number, Map<number, number>>();
  for (const [i, row] of links) {
    members.set(i, [i]);
    sums.set(i, new Map(row));
  }
  for (;;) {
    let best: { a: number; b: number; mean: number } | null = null;
    for (const [a, row] of sums) {
      const sizeA = members.get(a)!.length;
      for (const [b, sum] of row) {
        if (b <= a) continue;
        const sizeB = members.get(b)!.length;
        if (sizeA + sizeB > params.maxSize) continue;
        const mean = sum / (sizeA * sizeB);
        if (mean < params.link) continue;
        if (!best || mean > best.mean + 1e-12 || (Math.abs(mean - best.mean) <= 1e-12 && (a < best.a || (a === best.a && b < best.b)))) best = { a, b, mean };
      }
    }
    if (!best) break;
    const { a, b } = best;
    const [keep, drop] = a < b ? [a, b] : [b, a];
    members.get(keep)!.push(...members.get(drop)!);
    members.delete(drop);
    const rowKeep = sums.get(keep)!;
    const rowDrop = sums.get(drop)!;
    sums.delete(drop);
    rowKeep.delete(drop);
    for (const [other, sum] of rowDrop) {
      if (other === keep) continue;
      rowKeep.set(other, (rowKeep.get(other) ?? 0) + sum);
      const rowOther = sums.get(other)!;
      rowOther.set(keep, (rowOther.get(keep) ?? 0) + sum);
      rowOther.delete(drop);
    }
  }
  // A group of one guide's steps is no family; its concepts (and those left alone) may still join
  // one: each, in order, the family it links best to on average, at `link` or more.
  const entriesOf = (group: readonly number[]): number => new Set(group.flatMap((i) => items[i]!.concept.entryIds)).size;
  const families = [...members.values()].filter((group) => group.length >= 2 && entriesOf(group) >= 2);
  const placed = new Set(families.flat());
  for (const i of [...links.keys()].sort((x, y) => x - y)) {
    if (placed.has(i)) continue;
    const row = links.get(i)!;
    let best: { group: number[]; mean: number } | null = null;
    for (const group of families) {
      if (group.length >= params.maxSize) continue;
      let sum = 0;
      for (const member of group) sum += row.get(member) ?? 0;
      const mean = sum / group.length;
      if (mean >= params.link && (!best || mean > best.mean + 1e-12)) best = { group, mean };
    }
    if (best) {
      best.group.push(i);
      placed.add(i);
    }
  }
  return families;
}

/** One type's links: index → index → link (both directions). */
function linksOf(items: readonly Prepared[], params: ConceptFamilyParams, vocabulary: FamilyVocabulary, from = 0, to = items.length, into = new Map<number, Map<number, number>>()): Map<number, Map<number, number>> {
  for (let i = from; i < to; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const link = linkOf(items[i]!, items[j]!, params, vocabulary);
      if (link <= 0) continue;
      let row = into.get(i);
      if (!row) into.set(i, (row = new Map()));
      row.set(j, link);
      let back = into.get(j);
      if (!back) into.set(j, (back = new Map()));
      back.set(i, link);
    }
  }
  return into;
}

function familiesFrom(type: string, items: readonly Prepared[], groups: readonly number[][]): ConceptFamily[] {
  const out: ConceptFamily[] = [];
  for (const group of groups) {
    const concepts = group.map((i) => items[i]!.concept);
    const entries = new Set<string>();
    for (const concept of concepts) for (const id of concept.entryIds) entries.add(id);
    if (concepts.length < 2 || entries.size < 2) continue;
    concepts.sort((a, b) => b.entryIds.length - a.entryIds.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ids = concepts.map((concept) => concept.id);
    out.push({ id: conceptFamilyId(type, ids), type, concepts: ids, entryIds: [...entries].sort() });
  }
  return out;
}

function sortFamilies(families: ConceptFamily[]): ConceptFamily[] {
  return families.sort((a, b) => b.concepts.length - a.concepts.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The families of a set of concepts (see the module header), largest first; deterministic. For
 * other modules that need the rule itself; the live families are {@link KnowledgeConceptFamilies}'.
 */
export function familiesOf(input: ConceptFamiliesInput): ConceptFamily[] {
  const params = input.params ?? E5_SMALL_FAMILY_PARAMS;
  const vocabulary = input.vocabulary ?? familyVocabulary(input.concepts.map((concept) => concept.name));
  const out: ConceptFamily[] = [];
  for (const [type, items] of prepare(input)) out.push(...familiesFrom(type, items, cluster(items, linksOf(items, params, vocabulary), params)));
  return sortFamilies(out);
}

/** {@link familiesOf}, a turn of the event loop every {@link PAUSE_EVERY_ROWS} rows (the daemon's background computation). */
export async function planConceptFamilies(input: ConceptFamiliesInput, pause: () => Promise<void> = nextTurn): Promise<ConceptFamily[]> {
  const params = input.params ?? E5_SMALL_FAMILY_PARAMS;
  const vocabulary = input.vocabulary ?? familyVocabulary(input.concepts.map((concept) => concept.name));
  const out: ConceptFamily[] = [];
  for (const [type, items] of prepare(input)) {
    const links = new Map<number, Map<number, number>>();
    for (let from = 0; from < items.length; from += PAUSE_EVERY_ROWS) {
      linksOf(items, params, vocabulary, from, Math.min(items.length, from + PAUSE_EVERY_ROWS), links);
      await pause();
    }
    out.push(...familiesFrom(type, items, cluster(items, links, params)));
  }
  return sortFamilies(out);
}

const PAUSE_EVERY_ROWS = 32;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The current graph's concepts as families read them (a merge: its sources' names and vectors). */
export function familyConceptsOf(concepts: readonly GraphConcept[]): FamilyConcept[] {
  return concepts
    .filter((concept) => FAMILY_TYPES.has(concept.type))
    .map((concept) => {
      const sources = concept.merge?.sources ?? [];
      return {
        id: concept.id,
        type: concept.type,
        name: concept.name,
        names: sources.length > 0 ? sources.map((source) => source.name) : [concept.name],
        entryIds: concept.entryIds,
        vectorIds: sources.length > 0 ? sources.map((source) => source.id) : [concept.id]
      };
    });
}

// ---------------------------------------------------------------------------
// The live families
// ---------------------------------------------------------------------------

/** What other modules read (novelty, single-source claims, contradiction candidates, search, concept details). */
export interface KnowledgeConceptFamiliesPort {
  /** Every family now, largest first ([] until concept vectors from a calibrated model are complete). */
  families(): readonly ConceptFamily[];
  /** The member concept ids of the family `conceptId` (or the concept it was merged into) belongs to, itself included; null when none. */
  familyOf(conceptId: string): readonly string[] | null;
  /** The family itself; null when none. */
  family(conceptId: string): ConceptFamily | null;
  /** Moves whenever the families change. */
  revision(): number;
}

export interface KnowledgeConceptFamiliesOptions {
  /** The graph's concepts after the merge overlay (`KnowledgeGraph.currentConcepts`). */
  concepts(): readonly GraphConcept[];
  /** A concept's id after the overlay (`KnowledgeGraph.canonicalConceptId`). */
  canonical(conceptId: string): string;
  /** Moves when the concepts may have changed (`KnowledgeGraph.revision`): a read then computes the families again. */
  revision?(): number;
  /** Every concept's vector (myKG's ids, before the overlay), complete; null until then (`ConceptVectors.current`). */
  vectors(): { modelId: string; vectors: ReadonlyMap<string, Float32Array> } | null;
  /** The bars (tests); default {@link familyParamsFor} the vectors' model (none: no families). */
  params?: ConceptFamilyParams;
  pause?: () => Promise<void>;
  logger?: KnowledgeLogger;
}

/**
 * The families of the current graph: {@link update} (after a complete vector computation, a graph
 * load or a merge change) recomputes them in the background; readers get the last complete set.
 */
export class KnowledgeConceptFamilies implements KnowledgeConceptFamiliesPort {
  private list: readonly ConceptFamily[] = [];
  private byConcept = new Map<string, ConceptFamily>();
  private rev = 0;
  /** The graph revision the families were computed at. */
  private computedAt: number | undefined;
  private running: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private readonly listeners = new Set<() => void>();
  private readonly logger: KnowledgeLogger;

  constructor(private readonly options: KnowledgeConceptFamiliesOptions) {
    this.logger = options.logger ?? console;
  }

  families(): readonly ConceptFamily[] {
    this.refresh();
    return this.list;
  }

  familyOf(conceptId: string): readonly string[] | null {
    return this.family(conceptId)?.concepts ?? null;
  }

  family(conceptId: string): ConceptFamily | null {
    this.refresh();
    return this.byConcept.get(conceptId) ?? this.byConcept.get(this.options.canonical(conceptId)) ?? null;
  }

  revision(): number {
    return this.rev;
  }

  /** The graph moved since the families were computed (a merge undone): compute them again, in the background. */
  private refresh(): void {
    const revision = this.options.revision?.();
    if (revision !== undefined && revision !== this.computedAt && !this.running) this.update();
  }

  /** Called after the families changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The concepts or their vectors may have changed: recompute in the background. */
  update(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.running) return;
    const run = (async () => {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        await this.compute().catch((error: Error) => this.logger.warn(`knowledge: computing concept families failed (${error.message})`));
      }
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
  }

  /** Resolves once no computation is running or queued (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  private async compute(): Promise<void> {
    this.computedAt = this.options.revision?.();
    const set = this.options.vectors();
    const params = set ? (this.options.params ?? familyParamsFor(set.modelId)) : null;
    let families: ConceptFamily[] = [];
    if (set && params) {
      const concepts = this.options.concepts();
      families = await planConceptFamilies(
        { concepts: familyConceptsOf(concepts), vectors: set.vectors, vocabulary: familyVocabulary(concepts.map((concept) => concept.name)), params },
        this.options.pause
      );
    }
    // A newer graph or set of vectors arrived meanwhile: the next pass replaces this one.
    if (this.stopped || this.dirty) return;
    const before = JSON.stringify(this.list);
    this.list = families;
    this.byConcept = new Map(families.flatMap((family) => family.concepts.map((id) => [id, family] as const)));
    if (JSON.stringify(families) === before) return;
    this.rev += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a concept families listener failed (${(error as Error).message})`);
      }
    }
  }
}
