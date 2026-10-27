/**
 * Automatic concept merges (phase 2 spec docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md,
 * "C — Concept merges"): myKG often extracts one thing under several names. Concepts of the same
 * type whose vectors ({@link ConceptVectors}) are close AND whose names pass the guards below are
 * merged into one; the merges live in `concept-merges.json`, an overlay the graph re-applies at
 * every load (`KnowledgeGraph.setConceptMerges`), since myKG rewrites its output on every run.
 *
 * - the rule: {@link conceptMergeRefusal} (type, similarity, lexical guard, numbers, negation,
 *   lists, Person) and {@link planConceptMerges} (transitive per type, the kept concept), plus the
 *   deterministic Person rule ({@link personRuleGroups}: the same handle, or a handle written out as
 *   another Person's name; never two different full names, never chained) and the pairs LLM checks confirmed (`concept-merge-checks.ts`; merges `source: "checked"`,
 *   the answers kept in the file's `checks`);
 * - the file: read tolerant (`@orquester/config` `parseKnowledgeConceptMergesFile`), written atomically;
 * - {@link KnowledgeConceptMerges}: plans after every complete vector computation, applies the
 *   overlay, lists and undoes merges (an undone merge is never made again), and answers similar
 *   concepts for concept details.
 */

import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import type { KnowledgeConceptMerge } from "@orquester/api";
import {
  emptyKnowledgeConceptMergesFile,
  parseKnowledgeConceptMergesFile,
  serializeKnowledgeConceptMergesFile,
  type KnowledgeConceptMergeCheck,
  type KnowledgeConceptMergeRecord,
  type KnowledgeConceptMergeRejection,
  type KnowledgeConceptMergesFile
} from "@orquester/config";
import { EMBEDDING_MODEL_ID } from "../install/pins.ts";
import { KnowledgeError, type KnowledgeLogger } from "../store/errors.ts";
import { writeFileAtomic } from "../store/fs.ts";
import { ConceptVectors, type ConceptVectorSet } from "./concept-vectors.ts";
import type { KnowledgeEmbedderSource } from "./embedder.ts";
import type { GraphConcept, KnowledgeGraph } from "./graph.ts";
import type { KnowledgeScope } from "./visibility.ts";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** A model's cosine bars for concept vectors (not entry chunks: names score differently). */
export interface ConceptMergeThresholds {
  /** Auto-merge bar (the name guards must hold too). */
  merge: number;
  /** Listed as a similar concept (when not merged with it). */
  similar: number;
}

/**
 * multilingual-e5-small, calibrated on the live graph of 2026-10-27 (4,161 concepts, 34 types,
 * session 2026-10-27T03-33-47; nodes.jsonl copied read-only) with concept texts as
 * {@link conceptEmbeddingText} builds them:
 *
 * - e5 squeezes concept texts of one type together: 845k same-type pairs score ≥ 0.85 and 40k
 *   ≥ 0.90, and cosine alone cannot tell a duplicate from a sibling ("Toyota" ~ "Tabari" 0.994,
 *   "Opt-in visitor-to-trial" ~ "Opt-out visitor-to-trial" 0.979, "Guideline 4.7.4" ~ "4.7.5"
 *   0.985). So the name guards ({@link conceptMergeRefusal}) do most of the work, and cosine only
 *   has to keep same-worded but differently-meant names apart.
 * - Of the pairs passing every guard, everything ≥ 0.91 read as the same thing (175 pairs): e.g.
 *   "Location services off" = "Keep location services off" 0.920, "Transparent upstream proxy on
 *   the router" = "Upstream proxy on router" 0.923, "Conversion events for signup and payment" =
 *   "Conversion event for signup and one for payment" 0.911, "Warm up TikTok account" = "Warm up the
 *   TikTok account" 0.976. Below it the first wrong ones appear: "sign_in_with_apple package" (a
 *   Tool) ~ "Sign in with Apple" 0.904, "Share of subscription revenue by plan" ~ "Weekly plans'
 *   share of subscription revenue" 0.896. → `merge` 0.91: 118 merges folding 153 concepts.
 * - Nearest same-type neighbours stay on topic down to about 0.93 ("Proper warm-up of TikTok
 *   accounts" → "Account warm-up on the US feed" 0.970, "Production A/B DAU lift" → "Production
 *   A/B lessons lift" 0.941) and drift below it ("Tracking phone silent mode at notification
 *   arrival" → "No SIM in the phone" 0.922). → `similar` 0.93 (3 concepts in 5 have one or more).
 *   It is above `merge` because a merge also needs the name guards: a similar concept is any
 *   unmerged one at or above it.
 */
export const E5_SMALL_CONCEPT_THRESHOLDS: ConceptMergeThresholds = { merge: 0.91, similar: 0.93 };

/** Calibrated models only: another model's vectors make no merges and no similar concepts. */
const THRESHOLDS_BY_MODEL: Readonly<Record<string, ConceptMergeThresholds>> = { [EMBEDDING_MODEL_ID]: E5_SMALL_CONCEPT_THRESHOLDS };

export function conceptThresholdsFor(modelId: string): ConceptMergeThresholds | null {
  return THRESHOLDS_BY_MODEL[modelId] ?? null;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * Glue words left out of the token sets. "in", "on", "off", "out" stay: "Opt-in" and "Opt-out" are
 * different things.
 */
const STOPWORDS = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "with", "by", "at", "from", "as", "is", "your", "you", "its", "it"]);
/** Words that turn a name around ("Do not offer a free trial"): both names need the same ones. */
const NEGATIONS = new Set(["not", "no", "never", "avoid", "without", "dont", "don", "cannot", "cant", "stop", "against", "non", "nor"]);
/**
 * Lexical guard bars (stricter than the spec's "one contains the other, or Jaccard ≥ 0.5", which
 * passes "Vercel citations on Gemini" ~ "Replit citations on Gemini" 0.967, "App Store" ~ "Mac App
 * Store" 0.927, "TikTok" ~ "TikTok slideshows" 0.969): when one name's tokens contain the other's
 * the overlap must still be ≥ 0.75; otherwise ≥ 0.7, and never when each name has just one word
 * the other lacks (a swap: "Utah age assurance law" ~ "Louisiana age assurance law").
 */
const CONTAINED_MIN_JACCARD = 0.75;
const OVERLAP_MIN_JACCARD = 0.7;

function fold(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "");
}

/** A name's normalized words: lower case, no accents or glue words, a plural "s" dropped. */
export function conceptNameTokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const word of fold(name).split(/[^a-z0-9]+/)) {
    if (word.length === 0 || STOPWORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return out;
}

/**
 * The numbers and item marks in a name: "48-hour" → 48, "Guideline 3.1.2" → 3.1.2,
 * "2.4.5(iii)" → 2.4.5 and iii, "App Completeness (b)" → b.
 */
export function conceptNameNumbers(name: string): Set<string> {
  const folded = fold(name);
  const out = new Set<string>(folded.match(/\d+(?:[.,]\d+)*/g) ?? []);
  for (const match of folded.matchAll(/\(([a-z]|[ivx]{1,5})\)/g)) out.add(`(${match[1]!})`);
  return out;
}

/** The negating words of a name ("Do not offer a free trial" → not). */
export function conceptNameNegations(name: string): Set<string> {
  return new Set([...conceptNameTokens(name)].filter((t) => NEGATIONS.has(t)));
}

/** Whether a name lists several things ("AI Overviews and AI Mode", "Social / UGC"). */
function listsThings(name: string): boolean {
  return /\b(?:and|or)\b|[&+/,;]/.test(fold(name));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export type ConceptMergeRefusal = "type" | "similarity" | "lexical" | "numbers" | "negation" | "list" | "person";

/**
 * Why two concepts must not be merged automatically, or null when they may (phase 2 spec,
 * "Auto-merge rule"): same type; cosine ≥ `merge`; the lexical guard; the same numbers; the same
 * negations; both or neither a list; never two Persons unless their names are equal after
 * normalization.
 */
export function conceptMergeRefusal(
  a: { type: string; name: string },
  b: { type: string; name: string },
  similarity: number,
  thresholds: ConceptMergeThresholds
): ConceptMergeRefusal | null {
  if (a.type !== b.type) return "type";
  if (!(similarity >= thresholds.merge)) return "similarity";
  const ta = conceptNameTokens(a.name);
  const tb = conceptNameTokens(b.name);
  if (a.type === "Person" && !sameSet(ta, tb)) return "person";
  if (!sameSet(conceptNameNumbers(a.name), conceptNameNumbers(b.name))) return "numbers";
  if (!sameSet(new Set([...ta].filter((t) => NEGATIONS.has(t))), new Set([...tb].filter((t) => NEGATIONS.has(t))))) return "negation";
  if (ta.size === 0 || tb.size === 0) return "lexical";
  if (!sameSet(ta, tb)) {
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared += 1;
    const jaccard = shared / (ta.size + tb.size - shared);
    const contained = shared === ta.size || shared === tb.size;
    if (contained ? jaccard < CONTAINED_MIN_JACCARD : jaccard < OVERLAP_MIN_JACCARD || (ta.size - shared <= 1 && tb.size - shared <= 1)) return "lexical";
  }
  if (listsThings(a.name) !== listsThings(b.name)) return "list";
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** A concept as the planner sees it (myKG's, before any merge). */
export interface PlanConcept {
  id: string;
  type: string;
  name: string;
  /** Entries it came from. */
  entryCount: number;
  /** A Person's `handle` attribute ({@link personRulePair}). */
  handle?: string | null;
}

/** A pair an LLM check found to be one thing (`concept-merge-checks.ts`): merged like a rule's pair. */
export interface CheckedConceptPair {
  a: string;
  b: string;
  similarity: number;
  /** The concept the checker would keep; honoured when the merge is just these two. */
  keep: string | null;
}

/** One word of letters, digits, "_", "." or "-": the shape of a handle. */
const HANDLE_SHAPE = /^[\p{L}\p{N}_.-]{3,}$/u;
/** A plain capitalized word ("Sam", "Alex"): a first name, never taken for a handle. */
const FIRST_NAME_SHAPE = /^\p{Lu}\p{Ll}+$/u;

/** A handle's text: trimmed, no leading "@"; null unless it has the shape of a handle ({@link HANDLE_SHAPE}). */
function handleText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const bare = value.normalize("NFKC").trim().replace(/^@+/, "");
  return HANDLE_SHAPE.test(bare) ? bare : null;
}

/**
 * A handle as compared: trimmed, no leading "@", lower case (handles are case-insensitive); null
 * unless it is one word of letters, digits, "_", "." or "-" of 3+ characters. Punctuation stays:
 * "danielhangan_" and "danielhangan" are different accounts.
 */
export function personHandle(value: string | null | undefined): string | null {
  return handleText(value)?.toLowerCase() ?? null;
}

/** A Person's own name, or null when it has none (the graph then names it by its id). */
function realName(person: PlanConcept): string | null {
  const name = person.name.normalize("NFKC").trim();
  return name.length > 0 && name !== person.id ? name : null;
}

/**
 * The handle a Person's name is written as, compared like {@link personHandle}: "@jasonugc", or a
 * name with the shape of a handle that is not a plain capitalized word ("jasonugc", "KCodes7777";
 * not "Sam"). Whether it IS a given handle also needs the case to match ({@link nameIsHandle}).
 */
function nameAsHandle(name: string | null): string | null {
  if (name === null) return null;
  if (name.startsWith("@")) return personHandle(name);
  return HANDLE_SHAPE.test(name) && !FIRST_NAME_SHAPE.test(name) ? name.toLowerCase() : null;
}

/** Whether a name is exactly this handle written out: "@JasonUGC" for jasonugc, or "jasonugc" itself (case kept). */
function nameIsHandle(name: string | null, handle: string | null | undefined): boolean {
  const text = handleText(handle);
  if (name === null || text === null) return false;
  if (name.startsWith("@")) return personHandle(name) === text.toLowerCase();
  return nameAsHandle(name) !== null && name === text;
}

/** A name of two words or more ("Alex Nguyen"), as its token set; null for none or one word. */
function fullName(person: PlanConcept): Set<string> | null {
  const name = realName(person);
  return name === null || name.split(/\s+/).length < 2 ? null : conceptNameTokens(name);
}

/**
 * The Person rule for two Persons (deterministic, no LLM): the same handle ("@jasonugc" and
 * "JasonUGC"), or one's handle written out as the other's name ("jason", handle jasonugc, and a
 * Person named "jasonugc"). Never two Persons whose full names (two words or more) differ: "Alex
 * Nguyen" (@alex) and "Alex Chen" (handle alex) share a handle on different platforms. A first name
 * is never a handle: "Sam" is not "Samantha Lee" (handle sam).
 */
export function personRulePair(x: PlanConcept, y: PlanConcept): boolean {
  if (x.type !== "Person" || y.type !== "Person" || x.id === y.id) return false;
  const fx = fullName(x);
  const fy = fullName(y);
  if (fx && fy && !sameSet(fx, fy)) return false;
  const hx = personHandle(x.handle);
  if (hx !== null && hx === personHandle(y.handle)) return true;
  return nameIsHandle(realName(y), x.handle) || nameIsHandle(realName(x), y.handle);
}

/** Whether two Persons may be in one merge: the same name (the cosine rule's), or the Person rule's pair. */
function personsJoin(x: PlanConcept, y: PlanConcept): boolean {
  return sameSet(conceptNameTokens(x.name), conceptNameTokens(y.name)) || personRulePair(x, y);
}

/** The Person rule's pairs ({@link personRulePair}) as concept ids, each once, in a stable order. */
export function personHandlePairs(concepts: readonly PlanConcept[]): [string, string][] {
  const persons = concepts.filter((c) => c.type === "Person");
  // Only Persons sharing a handle key (their handle, or their name written as a handle) can pair.
  const byKey = new Map<string, PlanConcept[]>();
  for (const person of persons) {
    for (const key of new Set([personHandle(person.handle), nameAsHandle(realName(person))])) {
      if (key === null) continue;
      const list = byKey.get(key);
      if (list) list.push(person);
      else byKey.set(key, [person]);
    }
  }
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [x, y] = [list[i]!, list[j]!];
        const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
        const pairKey = `${a}\u0000${b}`;
        if (seen.has(pairKey) || !personRulePair(x, y)) continue;
        seen.add(pairKey);
        out.push([a, b]);
      }
    }
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
}

/**
 * The merges the Person rule makes, without chaining: Persons that pair with exactly the same
 * Persons (each other included) are one group, so every two in a group are a pair of the rule.
 * Persons its pairs connect form one group when every two of them pair; otherwise only the ones
 * that cannot be told apart are merged: two unnamed Persons with one handle merge, while "alexdev"
 * pairing with both "Alex Nguyen" and "Alex Chen" (who do not pair) joins neither. Sorted ids, in a
 * stable order.
 */
export function personRuleGroups(concepts: readonly PlanConcept[]): string[][] {
  const partners = new Map<string, Set<string>>();
  for (const [a, b] of personHandlePairs(concepts)) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let set = partners.get(x);
      if (!set) partners.set(x, (set = new Set([x])));
      set.add(y);
    }
  }
  const byNeighbourhood = new Map<string, string[]>();
  for (const [id, set] of partners) {
    const key = [...set].sort().join("\u0000");
    const list = byNeighbourhood.get(key);
    if (list) list.push(id);
    else byNeighbourhood.set(key, [id]);
  }
  return [...byNeighbourhood.values()]
    .filter((group) => group.length >= 2)
    .map((group) => group.sort())
    .sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0));
}

export interface ConceptMergePlanInput {
  concepts: readonly PlanConcept[];
  /** Concept id → L2-normalized vector; concepts without one are never merged anew. */
  vectors: ReadonlyMap<string, Float32Array>;
  thresholds: ConceptMergeThresholds;
  /** The merges made so far (kept: their concepts stay together). */
  existing: readonly KnowledgeConceptMergeRecord[];
  /** Undone merges: no two concepts of one are merged again. */
  rejected: readonly KnowledgeConceptMergeRejection[];
  /** Pairs LLM checks confirmed (merged with `source: "checked"`, whatever the name guards say). */
  checked?: readonly CheckedConceptPair[];
  now: string;
  /** Awaited every few hundred rows of comparisons (default: one turn of the event loop). */
  pause?: () => Promise<void>;
}

/** The merge id of a set of concepts: stable, so re-planning the same merge keeps its id. */
export function conceptMergeId(type: string, conceptIds: readonly string[]): string {
  const key = `${type}\u0000${[...conceptIds].sort().join("\u0000")}`;
  return `cm_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12)}`;
}

/** The concept a merge keeps: the most entries, then the shortest name, then the smallest id. */
export function keptConcept<T extends PlanConcept>(concepts: readonly T[]): T {
  return [...concepts].sort((a, b) => b.entryCount - a.entryCount || a.name.length - b.name.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

const PAUSE_EVERY_ROWS = 16;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The merges after a planning pass: every existing merge stays (its concepts that exist are seeded
 * together), and same-type pairs that pass {@link conceptMergeRefusal} join them, closest first,
 * transitively (union-find) — except across an undone merge. A group equal to an existing merge
 * keeps that record; a new or grown group becomes a new record (replacing the merges it absorbed)
 * with the kept concept of {@link keptConcept} and the lowest similarity that joined it. Merges
 * whose concepts are gone are kept as they are. `changed`: whether the list differs from `existing`.
 *
 * Beside the cosine pairs: the Person rule's groups ({@link personRuleGroups}) and the pairs LLM
 * checks confirmed (`checked`) join groups first, never across an undone merge. Persons join a
 * group only when every two of it are one person (the same name, or a pair of the Person rule), and
 * an earlier Person merge (not a checked one) that is no longer so is dropped. A new group one of
 * them joined is `source: "checked"` when a checked pair (or a checked merge it absorbed) is in it;
 * a group of exactly one checked pair keeps the concept the checker chose.
 */
export async function planConceptMerges(input: ConceptMergePlanInput): Promise<{ merges: KnowledgeConceptMergeRecord[]; changed: boolean }> {
  const pause = input.pause ?? nextTurn;
  const byId = new Map(input.concepts.map((c) => [c.id, c]));
  const parent = new Map<string, string>();
  const members = new Map<string, string[]>();
  const minSimilarity = new Map<string, number>();
  /** Roots of groups a checked pair (or a checked merge) joined. */
  const checkedRoots = new Set<string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let at = id;
    while (at !== root) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const concept of input.concepts) {
    parent.set(concept.id, concept.id);
    members.set(concept.id, [concept.id]);
  }
  const forbidden = new Map<string, Set<string>>();
  for (const rejection of input.rejected) {
    for (const a of rejection.concepts) {
      for (const b of rejection.concepts) {
        if (a === b) continue;
        let set = forbidden.get(a);
        if (!set) forbidden.set(a, (set = new Set()));
        set.add(b);
      }
    }
  }
  /** Two Persons join only when every two of the joined group are one person ({@link personsJoin}): no chains. */
  const personsApart = (ma: readonly string[], mb: readonly string[]): boolean => {
    const x0 = byId.get(ma[0]!);
    if (x0?.type !== "Person") return false;
    return ma.some((x) => mb.some((y) => !personsJoin(byId.get(x)!, byId.get(y)!)));
  };
  const union = (a: string, b: string, similarity: number, checkForbidden: boolean): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    const ma = members.get(ra)!;
    const mb = members.get(rb)!;
    if (checkForbidden && ma.some((x) => mb.some((y) => forbidden.get(x)?.has(y)))) return false;
    if (checkForbidden && personsApart(ma, mb)) return false;
    const [root, child] = ma.length >= mb.length ? [ra, rb] : [rb, ra];
    parent.set(child, root);
    members.set(root, [...members.get(root)!, ...members.get(child)!]);
    members.delete(child);
    minSimilarity.set(root, Math.min(minSimilarity.get(ra) ?? Infinity, minSimilarity.get(rb) ?? Infinity, similarity));
    minSimilarity.delete(child);
    if (checkedRoots.delete(child)) checkedRoots.add(root);
    return true;
  };

  // Seed the merges made so far (a concept already claimed by an earlier one stays there, as the
  // graph applies them).
  const claimed = new Set<string>();
  const presentOf = new Map<KnowledgeConceptMergeRecord, string[]>();
  /** Person merges an earlier rule made that the Person rule no longer allows (different people): undone. */
  const dropped = new Set<KnowledgeConceptMergeRecord>();
  for (const record of input.existing) {
    const present = [record.into, ...record.merged].filter((id, i, all) => all.indexOf(id) === i && byId.get(id)?.type === record.type && !claimed.has(id));
    if (!byId.has(record.into) || present[0] !== record.into || present.length < 2) continue;
    if (record.type === "Person" && record.source !== "checked" && personsApart(present, present)) {
      dropped.add(record);
      continue;
    }
    for (const id of present) claimed.add(id);
    presentOf.set(record, present);
    for (const id of present.slice(1)) union(record.into, id, record.similarity, false);
    if (record.source === "checked") checkedRoots.add(find(record.into));
  }

  // The Person rule, then the pairs LLM checks confirmed.
  const vectorDot = (a: string, b: string): number => {
    const x = input.vectors.get(a);
    const y = input.vectors.get(b);
    return x && y && x.length === y.length ? dot(x, y) : 1;
  };
  for (const group of personRuleGroups(input.concepts)) {
    for (const id of group.slice(1)) union(group[0]!, id, vectorDot(group[0]!, id), true);
  }
  const keepOf = new Map<string, string>();
  for (const pair of input.checked ?? []) {
    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    if (!a || !b || a.type !== b.type) continue;
    const joined = union(pair.a, pair.b, pair.similarity, true);
    if (joined || find(pair.a) === find(pair.b)) {
      if (joined) checkedRoots.add(find(pair.a));
      if (pair.keep === pair.a || pair.keep === pair.b) keepOf.set([pair.a, pair.b].sort().join("\u0000"), pair.keep);
    }
  }

  // Same-type candidate pairs, closest first.
  const byType = new Map<string, { concept: PlanConcept; vector: Float32Array }[]>();
  for (const concept of input.concepts) {
    const vector = input.vectors.get(concept.id);
    if (!vector) continue;
    let list = byType.get(concept.type);
    if (!list) byType.set(concept.type, (list = []));
    list.push({ concept, vector });
  }
  const candidates: { a: string; b: string; similarity: number }[] = [];
  let rows = 0;
  for (const list of byType.values()) {
    for (let i = 0; i < list.length; i += 1) {
      if (++rows % PAUSE_EVERY_ROWS === 0) await pause();
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]!;
        const similarity = dot(a.vector, b.vector);
        if (similarity < input.thresholds.merge) continue;
        if (conceptMergeRefusal(a.concept, b.concept, similarity, input.thresholds) === null) {
          candidates.push({ a: a.concept.id, b: b.concept.id, similarity });
        }
      }
    }
  }
  candidates.sort((x, y) => y.similarity - x.similarity || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  for (const candidate of candidates) union(candidate.a, candidate.b, candidate.similarity, true);

  // Groups → records.
  const groupKey = (ids: readonly string[]): string => [...ids].sort().join("\u0000");
  const recordByGroup = new Map<string, KnowledgeConceptMergeRecord>();
  for (const [record, present] of presentOf) recordByGroup.set(groupKey(present), record);
  const keptRecords = new Set<KnowledgeConceptMergeRecord>();
  const added: KnowledgeConceptMergeRecord[] = [];
  for (const [root, ids] of members) {
    if (ids.length < 2) continue;
    const same = recordByGroup.get(groupKey(ids));
    if (same) {
      keptRecords.add(same);
      continue;
    }
    const concepts = ids.map((id) => byId.get(id)!);
    const chosen = ids.length === 2 ? keepOf.get([...ids].sort().join("\u0000")) : undefined;
    const keep = (chosen !== undefined ? byId.get(chosen) : undefined) ?? keptConcept(concepts);
    const merged = concepts
      .filter((c) => c.id !== keep.id)
      .sort((a, b) => b.entryCount - a.entryCount || a.name.length - b.name.length || (a.id < b.id ? -1 : 1))
      .map((c) => c.id);
    added.push({
      id: conceptMergeId(keep.type, ids),
      type: keep.type,
      into: keep.id,
      merged,
      similarity: Math.round((minSimilarity.get(root) ?? input.thresholds.merge) * 10_000) / 10_000,
      createdAt: input.now,
      ...(checkedRoots.has(root) ? { source: "checked" } : {})
    });
  }
  // An existing merge stays unless a new group absorbed it; one whose concepts are gone stays too.
  const merges = input.existing.filter((record) => !dropped.has(record) && (keptRecords.has(record) || !presentOf.has(record)));
  const ids = new Set(merges.map((m) => m.id));
  for (const record of added) if (!ids.has(record.id)) merges.push(record);
  const changed = merges.length !== input.existing.length || merges.some((record, i) => record !== input.existing[i]);
  return { merges, changed };
}

// ---------------------------------------------------------------------------
// The service part
// ---------------------------------------------------------------------------

export interface KnowledgeConceptMergesOptions {
  graph: KnowledgeGraph;
  embedders: KnowledgeEmbedderSource;
  /** `knowledgeConceptMergesPath(appdir)`. */
  path: string;
  /** `<knowledgeIndexDir(appdir)>/concepts`: the concept vector cache. */
  vectorsDir: string;
  logger?: KnowledgeLogger;
  now?: () => Date;
  /** The bars of a model (tests); default {@link conceptThresholdsFor}. */
  thresholds?: (modelId: string) => ConceptMergeThresholds | null;
  /** Awaited between embedding batches and planning rows (default: one turn of the event loop). */
  pause?: () => Promise<void>;
}

/** The merge records a graph overlay applies: the file's, in order. */
function overlayOf(file: KnowledgeConceptMergesFile): KnowledgeConceptMergeRecord[] {
  return file.merges;
}

/**
 * Concept merges on one knowledge base: reads `concept-merges.json` and applies it to the graph
 * before the first load ({@link start}), follows every load with concept vectors, plans merges
 * once they are complete, and serves the merges routes and similar concepts. Every change of the
 * merges in effect re-applies the overlay (the graph revision moves) and calls {@link onChange}.
 */
export class KnowledgeConceptMerges {
  private readonly graph: KnowledgeGraph;
  private readonly path: string;
  private readonly logger: KnowledgeLogger;
  private readonly now: () => Date;
  private readonly thresholdsOf: (modelId: string) => ConceptMergeThresholds | null;
  private readonly pause: (() => Promise<void>) | undefined;
  readonly vectors: ConceptVectors;
  private file: KnowledgeConceptMergesFile = emptyKnowledgeConceptMergesFile();
  /** Set when the file is not this build's to write (a newer version): nothing is merged or undone. */
  private readOnly: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly plannedListeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private byType: { revision: number; map: Map<string, string[]> } | null = null;
  private stopped = false;

  constructor(options: KnowledgeConceptMergesOptions) {
    this.graph = options.graph;
    this.path = options.path;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.thresholdsOf = options.thresholds ?? conceptThresholdsFor;
    this.pause = options.pause;
    this.vectors = new ConceptVectors({
      embedders: options.embedders,
      dir: options.vectorsDir,
      logger: this.logger,
      ...(options.pause ? { pause: options.pause } : {})
    });
  }

  /** Read the file and apply it; then follow graph loads. Never rejects. Call before the graph's first load. */
  async start(): Promise<void> {
    await this.read();
    // Nothing to overlay leaves the graph (and its revision) as it is.
    if (this.file.merges.length > 0) this.graph.setConceptMerges(overlayOf(this.file));
    this.graph.setSimilarConcepts((id) => this.similar(id));
    this.unsubscribe.push(this.graph.onLoad(() => this.graphLoaded()));
    this.unsubscribe.push(this.vectors.onComputed(() => void this.plan()));
    this.vectors.start();
    if (this.graph.loadRevision() > 0) this.graphLoaded();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.graph.setSimilarConcepts(null);
    await this.vectors.stop();
    await this.chain.catch(() => undefined);
  }

  /** Resolves once vectors and planning have settled (tests). */
  async idle(): Promise<void> {
    for (;;) {
      await this.vectors.idle();
      const chain = this.chain;
      await chain.catch(() => undefined);
      if (chain === this.chain) {
        await this.vectors.idle();
        if (chain === this.chain) return;
      }
    }
  }

  /** Called when planning changed the merges in effect (the graph revision moved); an undo is announced by its route. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Called after every planning pass over a complete set of vectors (whether or not the merges
   * changed): the LLM concept checks may have new candidates.
   */
  onPlanned(listener: () => void): () => void {
    this.plannedListeners.add(listener);
    return () => this.plannedListeners.delete(listener);
  }

  /**
   * What the LLM concept checks (`concept-merge-checks.ts`) choose candidates from: myKG's concepts,
   * their vectors from a calibrated model, the undone merges and the checks so far; null until the
   * vectors are complete, or while the file is a newer build's.
   */
  checkState(): {
    concepts: readonly GraphConcept[];
    set: ConceptVectorSet;
    thresholds: ConceptMergeThresholds;
    rejected: readonly KnowledgeConceptMergeRejection[];
    checks: readonly KnowledgeConceptMergeCheck[];
    canonical: (conceptId: string) => string;
  } | null {
    if (this.readOnly || this.stopped) return null;
    const set = this.vectors.current();
    const thresholds = set ? this.thresholdsOf(set.modelId) : null;
    if (!set || !thresholds) return null;
    return {
      concepts: this.graph.baseConcepts(),
      set,
      thresholds,
      rejected: this.file.rejected,
      checks: this.file.checks,
      canonical: (id) => this.graph.canonicalConceptId(id)
    };
  }

  /**
   * Records an LLM check of two concepts (replacing an earlier one of the pair) and plans again: a
   * pair found to be one thing becomes a merge (`source: "checked"`). Undone like any merge.
   */
  async recordCheck(check: KnowledgeConceptMergeCheck): Promise<void> {
    const recorded = await this.serialize(async () => {
      if (this.readOnly || this.stopped) return false;
      const [a, b] = check.a < check.b ? [check.a, check.b] : [check.b, check.a];
      const swapped = a !== check.a;
      const record: KnowledgeConceptMergeCheck = { ...check, a, b, nameA: swapped ? check.nameB : check.nameA, nameB: swapped ? check.nameA : check.nameB };
      const checks = this.file.checks.filter((c) => !(c.a === a && c.b === b));
      await this.write({ ...this.file, checks: [...checks, record] });
      return true;
    });
    if (recorded && check.same) await this.plan();
  }

  /** Merges in effect on the current graph. */
  count(): number {
    return this.graph.conceptMerges().length;
  }

  /** `GET knowledgeRoutes.conceptMerges`: the merges whose concepts the scope can see, newest first. */
  list(scope: KnowledgeScope): KnowledgeConceptMerge[] {
    const checked = new Set(this.file.merges.filter((merge) => merge.source === "checked").map((merge) => merge.id));
    return this.graph
      .visibleConceptMerges(scope)
      .map(({ id, into, merged, similarity, createdAt }) => ({ id, into, merged, similarity, createdAt, ...(checked.has(id) ? { source: "checked" as const } : {}) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1));
  }

  /**
   * `DELETE knowledgeRoutes.conceptMerge(id)`: undo a merge the scope can see and never make it
   * again. False when there is no such merge in effect for the scope.
   */
  undo(id: string, scope: KnowledgeScope): Promise<boolean> {
    return this.serialize(async () => {
      if (!this.graph.visibleConceptMerges(scope).some((merge) => merge.id === id)) return false;
      const record = this.file.merges.find((merge) => merge.id === id);
      if (!record) return false;
      if (this.readOnly) throw new KnowledgeError("KNOWLEDGE_ERROR", this.readOnly, 409);
      const next: KnowledgeConceptMergesFile = {
        ...this.file,
        merges: this.file.merges.filter((merge) => merge !== record),
        rejected: [
          ...this.file.rejected,
          { id: record.id, type: record.type, concepts: [record.into, ...record.merged.filter((m) => m !== record.into)], rejectedAt: this.now().toISOString() }
        ]
      };
      await this.write(next);
      // The route announces it (`knowledge.changed {graph: true}`), so the listeners are not told.
      this.applyOverlay(false);
      return true;
    });
  }

  /**
   * Same-type concepts of the current graph close to `conceptId` (≥ `similar`, not merged with it),
   * best first, by its own vector; none until vectors from a calibrated model are complete.
   */
  similar(conceptId: string): { id: string; similarity: number }[] {
    const set = this.vectors.current();
    const thresholds = set ? this.thresholdsOf(set.modelId) : null;
    const vector = set?.vectors.get(conceptId);
    if (!set || !thresholds || !vector) return [];
    const type = this.graph.conceptType(conceptId);
    if (type === null) return [];
    const best = new Map<string, number>();
    for (const other of this.idsOfType(type)) {
      const otherVector = set.vectors.get(other);
      if (!otherVector || other === conceptId) continue;
      const similarity = dot(vector, otherVector);
      if (similarity < thresholds.similar) continue;
      const canonical = this.graph.canonicalConceptId(other);
      if (canonical === conceptId) continue;
      if (similarity > (best.get(canonical) ?? -Infinity)) best.set(canonical, similarity);
    }
    return [...best]
      .map(([id, similarity]) => ({ id, similarity: Math.round(similarity * 10_000) / 10_000 }))
      .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1))
      .slice(0, 50);
  }

  private idsOfType(type: string): readonly string[] {
    const revision = this.graph.loadRevision();
    if (!this.byType || this.byType.revision !== revision) {
      const map = new Map<string, string[]>();
      for (const concept of this.graph.baseConcepts()) {
        let list = map.get(concept.type);
        if (!list) map.set(concept.type, (list = []));
        list.push(concept.id);
      }
      this.byType = { revision, map };
    }
    return this.byType.map.get(type) ?? [];
  }

  private graphLoaded(): void {
    if (this.stopped) return;
    this.vectors.update(this.graph.baseConcepts().map(({ id, type, name, aliases, description }) => ({ id, type, name, aliases, description })));
  }

  /** After a complete vector computation: plan, and apply what changed. */
  private plan(): Promise<void> {
    return this.serialize(async () => {
      if (this.stopped || this.readOnly) return;
      const set = this.vectors.current();
      const thresholds = set ? this.thresholdsOf(set.modelId) : null;
      if (!set || !thresholds) return;
      const concepts = this.graph.baseConcepts().map(({ id, type, name, entryIds, attributes }) => ({
        id,
        type,
        name,
        entryCount: entryIds.length,
        handle: type === "Person" ? (attributes.handle?.value ?? null) : null
      }));
      const { merges, changed } = await planConceptMerges({
        concepts,
        vectors: set.vectors,
        thresholds,
        existing: this.file.merges,
        rejected: this.file.rejected,
        checked: this.file.checks.filter((check) => check.same).map(({ a, b, similarity, keep }) => ({ a, b, similarity, keep })),
        now: this.now().toISOString(),
        ...(this.pause ? { pause: this.pause } : {})
      });
      if (changed && !this.stopped) {
        await this.write({ ...this.file, merges });
        this.applyOverlay();
      }
      if (!this.stopped) {
        for (const listener of [...this.plannedListeners]) {
          try {
            listener();
          } catch (error) {
            this.logger.warn(`knowledge: a concept planning listener failed (${(error as Error).message})`);
          }
        }
      }
    }).catch((error: Error) => this.logger.warn(`knowledge: planning concept merges failed (${error.message})`));
  }

  /** Re-apply the file's merges; tell the listeners (when `notify`) if the merges in effect changed. */
  private applyOverlay(notify = true): void {
    const before = JSON.stringify(this.graph.conceptMerges());
    this.graph.setConceptMerges(overlayOf(this.file));
    if (!notify || JSON.stringify(this.graph.conceptMerges()) === before) return;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a concept merges listener failed (${(error as Error).message})`);
      }
    }
  }

  private async read(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.warn(`knowledge: concept-merges.json could not be read (${(error as Error).message})`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
      this.file = parseKnowledgeConceptMergesFile(raw);
      return;
    } catch (error) {
      const version = (raw as { version?: unknown } | null)?.version;
      if (typeof version === "number" && Number.isInteger(version) && version > 1) {
        // A newer build's file: not this build's to rewrite. No merges apply here.
        this.readOnly = `concept-merges.json was written by a newer version of Orquester (version ${version}); concept merges can't be changed until Orquester is updated.`;
        this.logger.warn(`knowledge: ${this.readOnly}`);
        return;
      }
      const aside = `${this.path}.corrupt-${this.now().getTime()}`;
      this.logger.error(`knowledge: concept-merges.json is unreadable (${(error as Error).message}); moved to ${aside}`);
      await rename(this.path, aside).catch(() => undefined);
    }
  }

  private async write(file: KnowledgeConceptMergesFile): Promise<void> {
    await writeFileAtomic(this.path, serializeKnowledgeConceptMergesFile(file));
    this.file = file;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
