/**
 * Knowledge Graph linking — pair checks: contradictions an LLM confirms (phase 2 spec, "Pair
 * checks"). Implements `KnowledgePairChecksPort` (read by insights and similar entries, W3).
 *
 * Candidates ({@link pairCheckCandidates}), taken tier by tier ({@link PAIR_CHECK_REASONS}), closest
 * first within a tier, at most {@link PAIR_CHECK_MAX_PER_RUN} new ones per round, each pair checked
 * once per pair of content hashes:
 * 1. joined by a `contradicts` edge between their concepts (any similarity): the check confirms the
 *    graph's guess (`checked`) or drops it (consistent/unrelated);
 * 2. opposite advice, at cosine ≥ the model's `good`: a concept and its negation ("One trial per IP"
 *    / "Never one-trial-per-IP"), or different values for the same decision — one is among the
 *    other's {@link PAIR_CHECK_ALTERNATIVE_NEIGHBOURS} nearest, by different authors, and a Tool or
 *    Tactic of each (not shared) names the same subject in {@link PAIR_CHECK_ALTERNATIVE_WORDS}+
 *    words ("Outlook/Proton email for TikTok account" / "Create TikTok accounts with a fresh Gmail");
 * 3. close (≥ `good`) and sharing a concept of a claim-like type ({@link PAIR_CHECK_TYPES}).
 * Meta entries are left out: a survey entry (a synthesis, or a note titled as a map, audit, hub or
 * index: `isSurveyEntry`, as contradictions read them) never takes part, and an entry linked to
 * both concepts of a `contradicts` edge is not paired through that edge (it reports the
 * disagreement, it takes no side).
 *
 * The same rounds answer the tasks of `KnowledgeRoundTaskSource`s (concept merge checks, cluster
 * names): {@link writeRoundTask} writes them into this inbox with their payload, and
 * {@link harvestPairCheckInbox} hands an answer left before a restart to its source.
 *
 * A check is a daemon-written task in the pair checks' own inbox (`knowledgePairChecksInboxDir`,
 * the same `agent_inbox/<id>.task.json` envelope myKG writes, step {@link PAIR_CHECK_STEP}, plus the
 * pair and its hashes), answered by the indexer's worker chats through the same broker and worker
 * tools, between linking runs only (`service.ts`): never while a run or a save waits, and only
 * while an account can take it (a pool that pauses ends the round). The answer must be exactly
 * `{verdict, note}` ({@link validatePairCheckAnswer}); anything else is refused like an answer that
 * does not parse. Results persist in `pair-checks.json` (`knowledgePairChecksPath`, tolerant, see
 * `@orquester/config` `knowledge-linking.ts`), keyed by the pair, with both content hashes: a check
 * of an entry edited since is stale (`all`/`get` leave it out) until the pair is checked again.
 *
 * The task shows each entry's title and body; a body longer than {@link PAIR_CHECK_BODY_CHARS} as
 * its opening and the passages most relevant to the other entry ({@link pairCheckExcerpt},
 * `search/excerpts.ts`), the pair's focus concepts' first. A check records its input version
 * ({@link PAIR_CHECK_INPUT_VERSION}); a `consistent` or `unrelated` one asked on version 1 (each
 * body's opening only) of a body that version cut is a candidate again, once
 * ({@link pairCheckNeedsRecheck}).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  KNOWLEDGE_PAIR_CHECK_VERDICTS,
  emptyKnowledgePairChecksFile,
  readKnowledgePairChecksFile,
  serializeKnowledgePairChecksFile,
  type KnowledgePairCheckRecord,
  type KnowledgePairChecksFile,
  type KnowledgeRoundAttemptRecord
} from "@orquester/config";
import type { KnowledgeConceptRef, KnowledgeEntry } from "@orquester/api";
import type { KnowledgePairCheck, KnowledgePairChecksPort, KnowledgeRoundTask, KnowledgeRoundTaskSource } from "../ports.ts";
import { isSurveyEntry } from "../search/contradictions.ts";
import { relevantExcerpt, type Excerpt } from "../search/excerpts.ts";
import { normalizeAuthor } from "../search/filters.ts";
import type { KnowledgeLinkGraphView } from "./context.ts";
import { INBOX_DIR, OUTBOX_DIR, readEnvelope, type InboxTaskEnvelope } from "./inbox.ts";

export const PAIR_CHECK_STEP = "pair-check";
/** New pairs checked per linking run at most. */
export const PAIR_CHECK_MAX_PER_RUN = 30;
/**
 * Each entry's body is shown whole up to this many characters; a longer one as its opening and the
 * passages most relevant to the other entry within it ({@link pairCheckInput}). About 750 tokens
 * per body at most (the opening-only 2,000 of input version 1 was about 500).
 */
export const PAIR_CHECK_BODY_CHARS = 3_000;
/**
 * The version of a check's input, recorded with it (`inputVersion`). 1 (absent): each body's first
 * {@link PAIR_CHECK_V1_BODY_CHARS} characters. 2: relevant excerpts ({@link pairCheckInput}).
 */
export const PAIR_CHECK_INPUT_VERSION = 2;
/** What input version 1 showed of a body: a longer one was cut there (see {@link pairCheckNeedsRecheck}). */
export const PAIR_CHECK_V1_BODY_CHARS = 2_000;
/** Weights of the other entry's concept names when choosing excerpts: a concept both are linked to counts double. */
const OTHER_CONCEPT_WEIGHT = 1;
const SHARED_CONCEPT_WEIGHT = 2;
/** Concept types whose sharing makes two close entries worth checking (claims that can disagree). */
export const PAIR_CHECK_TYPES: ReadonlySet<string> = new Set(["Tactic", "Rule", "Guideline", "Metric", "Result"]);
const NOTE_MAX = 500;
const YIELD_EVERY_MS = 40;
/**
 * Rounds that may hand out one item (the same input) and end without an acceptable answer before
 * it is given up on: no round asks it again (`KnowledgePairChecks.gaveUp`).
 */
export const ROUND_TASK_MAX_ATTEMPTS = 3;
/** Chats that may give up on one task within a round before the round hands it out no more (below the pool's 3 failures in a row). */
export const ROUND_TASK_MAX_GIVE_UPS = 2;
/** Attempt records kept at most (the least recent go first). */
const ROUND_ATTEMPTS_MAX = 2_000;

/** A pair check's item key for the attempt records: the pair at its content hashes (the same input). */
export function pairCheckItemKey(pair: PairKey): string {
  const [a, b] = sorted(pair.a, pair.b);
  const swapped = a !== pair.a;
  return `pair ${a} ${b} ${swapped ? pair.hashB : pair.hashA} ${swapped ? pair.hashA : pair.hashB}`;
}

export const PAIR_CHECK_SYSTEM = [
  "You compare two saved knowledge entries and decide whether they contradict each other.",
  "A long entry is shown as excerpts: its opening and the passages chosen for their relevance to the other entry, in document order, with […] where text is left out. A disagreement in any excerpt counts, wherever it is; text that is left out is no sign that the entries agree.",
  'Answer with ONLY a JSON object, no prose and no other keys: {"verdict": "contradicts" | "consistent" | "unrelated", "note": "<one sentence>"}.',
  "- contradicts: they make claims, numbers or recommendations about the same thing that cannot both hold. The note names the point of disagreement.",
  "- consistent: they are about the same thing and agree with or complement each other. The note says what they share.",
  "- unrelated: they are not about the same thing. The note says why.",
  `The note is one sentence of at most ${NOTE_MAX} characters.`
].join("\n");

export type PairCheckVerdict = (typeof KNOWLEDGE_PAIR_CHECK_VERDICTS)[number];

/** `null` when `value` is a valid verdict, else why not (the worker is asked to answer again). */
export function validatePairCheckAnswer(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 'The answer must be a JSON object {"verdict": …, "note": …}.';
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "verdict" && key !== "note");
  if (extra.length > 0) return `The answer has keys it must not have (${extra.slice(0, 3).join(", ")}): only "verdict" and "note".`;
  if (typeof record.verdict !== "string" || !(KNOWLEDGE_PAIR_CHECK_VERDICTS as readonly string[]).includes(record.verdict)) {
    return '"verdict" must be one of "contradicts", "consistent", "unrelated".';
  }
  if (typeof record.note !== "string" || record.note.trim() === "") return '"note" must be a one-sentence string.';
  if (record.note.length > NOTE_MAX) return `"note" must be at most ${NOTE_MAX} characters.`;
  return null;
}

/** A validated answer, or null. */
export function parsePairCheckAnswer(text: string): { verdict: PairCheckVerdict; note: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (validatePairCheckAnswer(value) !== null) return null;
  const record = value as { verdict: PairCheckVerdict; note: string };
  return { verdict: record.verdict, note: record.note.trim() };
}

export interface PairKey {
  /** Sorted: `a` < `b`. */
  a: string;
  b: string;
  hashA: string;
  hashB: string;
}

function sorted(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

function pairKey(a: string, b: string): string {
  const [x, y] = sorted(a, b);
  return `${x} ${y}`;
}

export interface KnowledgePairChecksOptions {
  /** `knowledgePairChecksPath(appdir)`. */
  path: string;
  /** An entry's current content hash, null when it is gone. */
  hashOf(entryId: string): string | null;
  now(): Date;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** `pair-checks.json` in memory, and the port insights read. */
export class KnowledgePairChecks implements KnowledgePairChecksPort {
  private file: KnowledgePairChecksFile = emptyKnowledgePairChecksFile();
  private readonly byKey = new Map<string, KnowledgePairCheckRecord>();
  /** Round task items without an acceptable answer yet, by item key. */
  private readonly attempts = new Map<string, KnowledgeRoundAttemptRecord>();
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: KnowledgePairChecksOptions) {}

  /** Reads the file; one that does not parse is moved aside (`.unreadable-<time>`) and the checks start empty. */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch {
      text = null;
    }
    let file = emptyKnowledgePairChecksFile();
    if (text !== null) {
      try {
        file = readKnowledgePairChecksFile(JSON.parse(text));
      } catch {
        const aside = `${this.options.path}.unreadable-${this.options.now().toISOString().replace(/[:.]/g, "-")}`;
        await rename(this.options.path, aside).catch(() => undefined);
        this.options.logger?.warn("knowledge pair checks: pair-checks.json did not read; moved aside", { aside });
      }
    }
    this.file = file;
    this.byKey.clear();
    for (const record of file.checks) this.byKey.set(pairKey(record.a, record.b), record);
    this.attempts.clear();
    for (const record of file.attempts) this.attempts.set(record.key, record);
    this.emit();
  }

  /** Whether rounds gave up on this item ({@link ROUND_TASK_MAX_ATTEMPTS}): no round asks it again. */
  gaveUp(itemKey: string): boolean {
    return this.attempts.get(itemKey)?.gaveUpAt != null;
  }

  /** Items rounds gave up on, most recent first (status, tests). */
  givenUp(): readonly KnowledgeRoundAttemptRecord[] {
    return [...this.attempts.values()].filter((record) => record.gaveUpAt != null).sort((x, y) => (y.gaveUpAt! < x.gaveUpAt! ? -1 : 1));
  }

  /**
   * A round handed this item out and ended without an acceptable answer: counted, persisted, and
   * after {@link ROUND_TASK_MAX_ATTEMPTS} such rounds it is given up on. Answers whether it is now.
   */
  async failedAttempt(item: { key: string; step: string; label: string }): Promise<boolean> {
    const previous = this.attempts.get(item.key);
    if (previous?.gaveUpAt != null) return true;
    const at = this.options.now().toISOString();
    const failures = (previous?.failures ?? 0) + 1;
    const record: KnowledgeRoundAttemptRecord = {
      ...(previous ?? {}),
      key: item.key,
      step: item.step,
      label: item.label,
      failures,
      lastAt: at,
      gaveUpAt: failures >= ROUND_TASK_MAX_ATTEMPTS ? at : null
    };
    this.attempts.delete(item.key);
    this.attempts.set(item.key, record);
    // The least recent go first (Map order is the order of their last attempt).
    while (this.attempts.size > ROUND_ATTEMPTS_MAX) this.attempts.delete(this.attempts.keys().next().value!);
    this.file = { ...this.file, attempts: [...this.attempts.values()] };
    await this.save();
    if (record.gaveUpAt !== null) {
      this.options.logger?.warn("knowledge pair checks: a round task got no acceptable answer in several rounds; it is not asked again", {
        step: item.step,
        label: item.label,
        failures
      });
    }
    return record.gaveUpAt !== null;
  }

  /** The item was answered: its failed attempts are forgotten. */
  async answered(itemKey: string): Promise<void> {
    if (!this.attempts.delete(itemKey)) return;
    this.file = { ...this.file, attempts: [...this.attempts.values()] };
    await this.save();
  }

  all(): readonly KnowledgePairCheck[] {
    const out: KnowledgePairCheck[] = [];
    for (const record of this.byKey.values()) if (this.current(record)) out.push(toCheck(record));
    return out;
  }

  get(a: string, b: string): KnowledgePairCheck | null {
    const record = this.byKey.get(pairKey(a, b));
    return record && this.current(record) ? toCheck(record) : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Whether this pair was checked at exactly these content hashes, on an input that still counts:
   * given `longBody` (whether an entry's body is longer than {@link PAIR_CHECK_V1_BODY_CHARS}), a
   * check {@link pairCheckNeedsRecheck} reads as not checked, so the pair is a candidate again.
   */
  isChecked(pair: PairKey, longBody?: (entryId: string) => boolean): boolean {
    const record = this.byKey.get(pairKey(pair.a, pair.b));
    if (record === undefined || record.hashA !== pair.hashA || record.hashB !== pair.hashB) return false;
    return longBody === undefined || !pairCheckNeedsRecheck(record, longBody);
  }

  /**
   * The entries of current checks that may need asking again ({@link pairCheckNeedsRecheck}): those
   * of `consistent` or `unrelated` checks on input version 1. Their bodies' lengths decide.
   */
  recheckEntryIds(): string[] {
    const out = new Set<string>();
    for (const record of this.byKey.values()) {
      if (!this.current(record) || !pairCheckNeedsRecheck(record, () => true)) continue;
      out.add(record.a);
      out.add(record.b);
    }
    return [...out].sort();
  }

  /** Records a check on input `inputVersion` (replacing the pair's earlier one) and persists it. */
  async record(pair: PairKey, verdict: PairCheckVerdict, note: string | null, inputVersion: number = PAIR_CHECK_INPUT_VERSION): Promise<void> {
    const [a, b] = sorted(pair.a, pair.b);
    const swapped = a !== pair.a;
    const key = `${a} ${b}`;
    const previous = this.byKey.get(key);
    const record: KnowledgePairCheckRecord = {
      ...(previous ?? {}),
      a,
      b,
      hashA: swapped ? pair.hashB : pair.hashA,
      hashB: swapped ? pair.hashA : pair.hashB,
      verdict,
      note,
      checkedAt: this.options.now().toISOString(),
      inputVersion
    };
    this.byKey.set(key, record);
    this.file = { ...this.file, checks: [...this.byKey.values()] };
    await this.save();
    this.emit();
  }

  /** Entries were edited or deleted: checks involving them may have gone stale. */
  entriesChanged(ids: readonly string[]): void {
    const changed = new Set(ids);
    for (const record of this.byKey.values()) {
      if (changed.has(record.a) || changed.has(record.b)) {
        this.emit();
        return;
      }
    }
  }

  /** Resolves once every write asked for so far has landed. */
  flush(): Promise<void> {
    return this.chain;
  }

  private current(record: KnowledgePairCheckRecord): boolean {
    return this.options.hashOf(record.a) === record.hashA && this.options.hashOf(record.b) === record.hashB;
  }

  private save(): Promise<void> {
    if (this.file.readOnly) return this.chain;
    const text = serializeKnowledgePairChecksFile(this.file);
    const path = this.options.path;
    const write = async (): Promise<void> => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, path);
    };
    const next = this.chain.then(write, write);
    this.chain = next.catch((error: unknown) => this.options.logger?.warn("knowledge pair checks: pair-checks.json could not be written", { error: String(error) }));
    return this.chain;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.options.logger?.warn("knowledge pair checks: a listener failed", { error: String(error) });
      }
    }
  }
}

/**
 * Whether a check is asked again: a `consistent` or `unrelated` verdict on input version 1 where
 * either body was longer than that version showed ({@link PAIR_CHECK_V1_BODY_CHARS}), so the check
 * saw a cut text. A `contradicts` verdict stands (the next check of the pair replaces it anyway).
 * A check asked again is recorded on the current version: it is asked again once.
 */
export function pairCheckNeedsRecheck(
  record: Pick<KnowledgePairCheckRecord, "a" | "b" | "verdict" | "inputVersion">,
  longBody: (entryId: string) => boolean
): boolean {
  if ((record.inputVersion ?? 1) >= 2 || record.verdict === "contradicts") return false;
  return longBody(record.a) || longBody(record.b);
}

function toCheck(record: KnowledgePairCheckRecord): KnowledgePairCheck {
  return { a: record.a, b: record.b, verdict: record.verdict, note: record.note, checkedAt: record.checkedAt };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Why a pair is worth checking, in priority order ({@link PAIR_CHECK_REASONS}). */
export type PairCandidateReason = "contradicts" | "negation" | "alternatives" | "shared";
/**
 * Candidates are taken tier by tier, closest first within a tier: the concept graph already says
 * they disagree (`contradicts` edge: a check confirms or drops it), then concept-level signs of
 * opposite advice (a concept and its negation; different values for the same decision), then the
 * close pairs sharing a claim.
 */
export const PAIR_CHECK_REASONS: readonly PairCandidateReason[] = ["contradicts", "negation", "alternatives", "shared"];

export interface PairCandidate extends PairKey {
  /** Cosine of the two entry vectors; null when either has none (a `contradicts` edge alone). */
  similarity: number | null;
  reason: PairCandidateReason;
  /**
   * The concepts the pair was found through, for `contradicts`, `negation` and `alternatives` (the
   * two ends of the edge, the concept and its negation, the two values): their passages are shown
   * first ({@link pairCheckInput}). Empty for `shared`.
   */
  focus: KnowledgeConceptRef[];
}

/** What candidates read of an entry beside its concepts (`KnowledgeEntryMeta`). */
export interface PairCheckEntryInfo {
  kind: string;
  /** Its title (a note titled as a map, audit, hub or index is a survey: `isSurveyEntry`); absent: none. */
  title?: string | null;
  author: string | null;
  handle: string | null;
}

export interface PairCheckCandidatesOptions {
  /** Linked entries. */
  ids: readonly string[];
  view: KnowledgeLinkGraphView;
  hashOf(entryId: string): string | null;
  isChecked(pair: PairKey): boolean;
  limit: number;
  /** An entry's kind, title and author (survey entries and the same author are left out); absent: neither applies. */
  entryOf?(entryId: string): PairCheckEntryInfo | null;
}

/**
 * Whether an entry surveys others rather than taking a side (a synthesis, or a note titled as a
 * map, audit, hub, register, index or overview: `isSurveyEntry`, the same test contradictions use):
 * never checked.
 */
export function isPairCheckMetaEntry(info: PairCheckEntryInfo | null): boolean {
  return info !== null && isSurveyEntry({ kind: info.kind, title: info.title ?? "" });
}
/** "Different values for the same decision": the other entry is among an entry's this many nearest by meaning. */
export const PAIR_CHECK_ALTERNATIVE_NEIGHBOURS = 6;
/** … and a Tool or Tactic of each, not shared, names the same subject: at least this many content words in common. */
export const PAIR_CHECK_ALTERNATIVE_WORDS = 2;
const ALTERNATIVE_TYPES: ReadonlySet<string> = new Set(["Tool", "Tactic"]);
/**
 * Concept types whose negation reads as opposite advice. Not Rule or Guideline: those are named
 * after what they forbid ("Hidden Features" / "No hidden, dormant, or undocumented features").
 */
const NEGATION_TYPES: ReadonlySet<string> = new Set(["Tactic", "Tool", "Metric", "Result"]);
/** Words that turn advice around ("Never one trial per IP"); the rest of the names must overlap this much. */
const NEGATION_WORDS: ReadonlySet<string> = new Set(["not", "no", "never", "avoid", "without", "dont", "don", "cannot", "cant", "stop", "against", "non", "nor"]);
const NEGATION_MIN_JACCARD = 0.5;
const GLUE_WORDS: ReadonlySet<string> = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "with", "by", "at", "from", "as", "is", "your", "you", "its", "it", "in", "on", "use", "using", "used", "via", "per", "into"]);

/** A concept name's words: lower case, no accents, plurals folded ("proxies" → "proxy"). */
function nameWords(name: string): string[] {
  const out: string[] = [];
  for (const word of name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/)) {
    if (word.length === 0) continue;
    out.push(word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return out;
}

/** Words that say what a name is about: no glue words, numbers or words under 3 letters. */
function contentWords(name: string): Set<string> {
  return new Set(nameWords(name).filter((w) => w.length >= 3 && !GLUE_WORDS.has(w) && !NEGATION_WORDS.has(w) && !/^\d+$/.test(w)));
}

/**
 * Whether one name is the other turned around: exactly one negates, and the rest overlaps (Jaccard
 * ≥ 0.5). What a name says in parentheses is a clarification ("One strong page per claim (no
 * thousands of thin pages)"), not part of it.
 */
export function negatedNames(x: string, y: string): boolean {
  return negatedWords(negationWords(x), negationWords(y));
}

/** What {@link negatedNames} reads of a name: whether it negates, and its other words. */
interface NegationWords {
  negates: boolean;
  rest: ReadonlySet<string>;
}

function negationWords(name: string): NegationWords {
  const words = nameWords(name.replace(/\([^)]*\)/g, " "));
  return { negates: words.some((w) => NEGATION_WORDS.has(w)), rest: new Set(words.filter((w) => !NEGATION_WORDS.has(w) && !GLUE_WORDS.has(w))) };
}

function negatedWords(x: NegationWords, y: NegationWords): boolean {
  if (x.negates === y.negates) return false;
  let shared = 0;
  for (const w of x.rest) if (y.rest.has(w)) shared += 1;
  const union = x.rest.size + y.rest.size - shared;
  return union > 0 && shared / union >= NEGATION_MIN_JACCARD;
}

const authorKey = (value: string): string => normalizeAuthor(value);

/**
 * New candidate pairs (see the module header), tier by tier in {@link PAIR_CHECK_REASONS} order,
 * closest first within a tier; meta entries left out (a survey entry never takes part:
 * {@link isPairCheckMetaEntry}; an entry linked to both concepts of a `contradicts` edge is not
 * paired through it). Memory stays linear in the entries plus the close pairs (each entry's nearest
 * neighbours are kept bounded), and it yields to the event loop every {@link YIELD_EVERY_MS} ms.
 */
export async function pairCheckCandidates(options: PairCheckCandidatesOptions): Promise<PairCandidate[]> {
  const index = options.view.vectors();
  const good = index.thresholds()?.good ?? null;
  // The yielder pattern (`search/similarity.ts` `yielder`), checked inline in the hot loops: `due()`
  // is a clock read, `breathe()` one turn of the event loop once the slice is used up.
  let since = performance.now();
  const due = (): boolean => performance.now() - since >= YIELD_EVERY_MS;
  const breathe = async (): Promise<void> => {
    if (!due()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
  const conceptsOf = new Map<string, readonly KnowledgeConceptRef[]>();
  const conceptIdsOf = new Map<string, ReadonlySet<string>>();
  const entriesOfConcept = new Map<string, string[]>();
  const contradicting = new Map<string, readonly string[]>();
  const contradictingOf = (concept: string): readonly string[] => {
    let others = contradicting.get(concept);
    if (!others) contradicting.set(concept, (others = options.view.contradicting(concept)));
    return others;
  };
  const ids: string[] = [];
  for (const id of options.ids) {
    if (isPairCheckMetaEntry(options.entryOf?.(id) ?? null)) continue;
    const concepts = options.view.conceptsOf(id);
    ids.push(id);
    conceptsOf.set(id, concepts);
    conceptIdsOf.set(id, new Set(concepts.map((concept) => concept.id)));
    for (const concept of concepts) {
      const list = entriesOfConcept.get(concept.id);
      if (list) list.push(id);
      else entriesOfConcept.set(concept.id, [id]);
    }
  }
  const authorsOf = (id: string): Set<string> => {
    const info = options.entryOf?.(id) ?? null;
    return new Set([info?.author, info?.handle].filter((v): v is string => typeof v === "string" && v.trim() !== "").map(authorKey));
  };
  const sameAuthor = (a: string, b: string): boolean => {
    const x = authorsOf(a);
    for (const name of authorsOf(b)) if (x.has(name)) return true;
    return false;
  };
  const vectors = new Map<string, Float32Array>();
  for (const id of ids) {
    const vector = index.entryVector(id);
    if (vector) vectors.set(id, vector);
  }
  const similarity = (a: string, b: string): number | null => {
    const x = vectors.get(a);
    const y = vectors.get(b);
    if (!x || !y || x.length !== y.length) return null;
    let dot = 0;
    for (let d = 0; d < x.length; d += 1) dot += x[d]! * y[d]!;
    return dot;
  };
  const found = new Map<string, PairCandidate>();
  const consider = (x: string, y: string, sim: number | null, reason: PairCandidateReason, focus: readonly KnowledgeConceptRef[] = []): void => {
    if (x === y) return;
    const [a, b] = sorted(x, y);
    const key = `${a} ${b}`;
    const seen = found.get(key);
    if (seen) {
      const was = PAIR_CHECK_REASONS.indexOf(seen.reason);
      const now = PAIR_CHECK_REASONS.indexOf(reason);
      if (now < was) {
        seen.reason = reason;
        seen.focus = [];
      }
      if (now <= was) for (const concept of focus) if (!seen.focus.some((c) => c.id === concept.id)) seen.focus.push(concept);
      return;
    }
    const hashA = options.hashOf(a);
    const hashB = options.hashOf(b);
    if (!hashA || !hashB) return;
    const pair = { a, b, hashA, hashB };
    if (options.isChecked(pair)) return;
    found.set(key, { ...pair, similarity: sim, reason, focus: [...focus] });
  };
  const refOf = (entryId: string, conceptId: string): KnowledgeConceptRef[] => {
    const concept = conceptsOf.get(entryId)?.find((c) => c.id === conceptId);
    return concept ? [concept] : [];
  };

  // Joined by a `contradicts` edge between their concepts (any similarity); an entry linked to both
  // concepts of the edge reports that disagreement rather than taking a side: not for this edge.
  for (const [concept, entries] of entriesOfConcept) {
    for (const other of contradictingOf(concept)) {
      for (const a of entries) {
        if (due()) await breathe();
        if (conceptIdsOf.get(a)!.has(other)) continue;
        for (const b of entriesOfConcept.get(other) ?? []) {
          if (a !== b && !conceptIdsOf.get(b)!.has(concept)) consider(a, b, similarity(a, b), "contradicts", [...refOf(a, concept), ...refOf(b, other)]);
        }
      }
    }
    await breathe();
  }

  if (good !== null) {
    // Every close pair once, and each entry's nearest neighbours (for "alternatives"): rows in id
    // order, so a tie keeps the smaller id; a bounded best-first list per row.
    const rows = [...vectors.keys()].sort();
    const rowVectors = rows.map((id) => vectors.get(id)!);
    const n = rows.length;
    const keep = PAIR_CHECK_ALTERNATIVE_NEIGHBOURS;
    const topIndex = new Int32Array(n * keep).fill(-1);
    const topSim = new Float64Array(n * keep);
    const topCount = new Int32Array(n);
    const offer = (node: number, other: number, sim: number): void => {
      const base = node * keep;
      let at = topCount[node]!;
      if (at < keep) topCount[node] = at + 1;
      else if (sim > topSim[base + keep - 1]!) at = keep - 1;
      else return;
      while (at > 0 && topSim[base + at - 1]! < sim) {
        topSim[base + at] = topSim[base + at - 1]!;
        topIndex[base + at] = topIndex[base + at - 1]!;
        at -= 1;
      }
      topSim[base + at] = sim;
      topIndex[base + at] = other;
    };
    const closeA: number[] = [];
    const closeB: number[] = [];
    const closeSim: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const x = rowVectors[i]!;
      for (let j = i + 1; j < n; j += 1) {
        const y = rowVectors[j]!;
        if (x.length !== y.length) continue;
        let sim = 0;
        for (let d = 0; d < x.length; d += 1) sim += x[d]! * y[d]!;
        offer(i, j, sim);
        offer(j, i, sim);
        if (sim >= good) {
          closeA.push(i);
          closeB.push(j);
          closeSim.push(sim);
        }
        if ((j & 63) === 0 && due()) await breathe();
      }
      await breathe();
    }
    const isNearest = (i: number, j: number): boolean => {
      for (let r = 0; r < topCount[i]!; r += 1) if (topIndex[i * keep + r] === j) return true;
      return false;
    };
    const wordsOf = new Map<string, Set<string>>();
    const words = (concept: KnowledgeConceptRef): Set<string> => {
      let set = wordsOf.get(concept.id);
      if (!set) wordsOf.set(concept.id, (set = contentWords(concept.name)));
      return set;
    };
    const negationOf = new Map<string, NegationWords>();
    const negation = (concept: KnowledgeConceptRef): NegationWords => {
      let found = negationOf.get(concept.id);
      if (!found) negationOf.set(concept.id, (found = negationWords(concept.name)));
      return found;
    };
    for (let p = 0; p < closeA.length; p += 1) {
      if (due()) await breathe();
      const i = closeA[p]!;
      const j = closeB[p]!;
      const sim = closeSim[p]!;
      const a = rows[i]!;
      const b = rows[j]!;
      const ca = conceptsOf.get(a)!;
      const cb = conceptsOf.get(b)!;
      const idsA = conceptIdsOf.get(a)!;
      const idsB = conceptIdsOf.get(b)!;
      // Sharing a claim-like concept.
      if (ca.some((c) => PAIR_CHECK_TYPES.has(c.type) && idsB.has(c.id))) consider(a, b, sim, "shared");
      // A concept and its negation ("One trial per IP" / "Never one trial per IP").
      let negated: KnowledgeConceptRef[] | null = null;
      for (const x of ca) {
        if (negated || !NEGATION_TYPES.has(x.type) || idsB.has(x.id)) continue;
        for (const y of cb) {
          if (y.type === x.type && !idsA.has(y.id) && negatedWords(negation(x), negation(y))) {
            negated = [x, y];
            break;
          }
        }
      }
      if (negated) consider(a, b, sim, "negation", negated);
      // Different values for the same decision: nearest neighbours by different authors whose
      // Tools or Tactics (not shared) name the same subject ("Outlook/Proton email for TikTok
      // account" / "Create TikTok accounts with a fresh Gmail"; "ISP proxy with socks5" / "Using
      // residential, mobile or ISP proxies").
      if (!(isNearest(i, j) || isNearest(j, i)) || sameAuthor(a, b)) continue;
      let alternative: KnowledgeConceptRef[] | null = null;
      for (const x of ca) {
        if (alternative || !ALTERNATIVE_TYPES.has(x.type) || idsB.has(x.id)) continue;
        const wx = words(x);
        if (wx.size < PAIR_CHECK_ALTERNATIVE_WORDS) continue;
        for (const y of cb) {
          if (y.type !== x.type || idsA.has(y.id)) continue;
          let shared = 0;
          for (const w of words(y)) if (wx.has(w)) shared += 1;
          if (shared >= PAIR_CHECK_ALTERNATIVE_WORDS) {
            alternative = [x, y];
            break;
          }
        }
      }
      if (alternative) consider(a, b, sim, "alternatives", alternative);
    }
  }
  const tier = (c: PairCandidate): number => PAIR_CHECK_REASONS.indexOf(c.reason);
  return [...found.values()]
    .sort((x, y) => tier(x) - tier(y) || (y.similarity ?? -2) - (x.similarity ?? -2) || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1))
    .slice(0, options.limit);
}

// ---------------------------------------------------------------------------
// The pair checks' inbox
// ---------------------------------------------------------------------------

/** A pair-check task file: myKG's envelope plus the pair it checks. */
export interface PairCheckEnvelope extends InboxTaskEnvelope {
  pair: PairKey;
}

/** One side of a pair check: the entry and the concepts it is linked to (absent: none known). */
export interface PairCheckSide extends Pick<KnowledgeEntry, "id" | "title" | "body"> {
  concepts?: readonly KnowledgeConceptRef[];
}

/**
 * What a check shows of one entry's body: whole up to {@link PAIR_CHECK_BODY_CHARS}, else its
 * opening and the passages most relevant to the other entry (`search/excerpts.ts`): the other's
 * words, its concept names (those both are linked to count double), and first the `focus` concepts.
 */
export function pairCheckExcerpt(self: PairCheckSide, other: PairCheckSide, focus: readonly KnowledgeConceptRef[] = []): Excerpt {
  const own = new Set((self.concepts ?? []).map((concept) => concept.id));
  return relevantExcerpt(
    self.body,
    {
      text: `${other.title}\n${other.body}`,
      concepts: (other.concepts ?? []).map((concept) => ({ name: concept.name, weight: own.has(concept.id) ? SHARED_CONCEPT_WEIGHT : OTHER_CONCEPT_WEIGHT })),
      focus: focus.map((concept) => concept.name)
    },
    PAIR_CHECK_BODY_CHARS
  );
}

/**
 * The task's user message (input version {@link PAIR_CHECK_INPUT_VERSION}): both entries' titles
 * and bodies, a long body as excerpts chosen for relevance to the other ({@link pairCheckExcerpt}).
 */
export function pairCheckInput(a: PairCheckSide, b: PairCheckSide, focus: readonly KnowledgeConceptRef[] = []): string {
  const block = (label: string, entry: PairCheckSide, other: PairCheckSide): string => {
    const excerpt = pairCheckExcerpt(entry, other, focus);
    const heading = `${label} (${entry.id})`;
    return [
      heading,
      "=".repeat(heading.length),
      `Title: ${entry.title.replace(/\s+/g, " ").trim()}`,
      ...(excerpt.excerpted ? [`(Excerpts chosen for relevance to the other entry: the opening and the passages that bear on it, of a ${excerpt.chars.toLocaleString("en-US")}-character text.)`] : []),
      "",
      excerpt.text
    ].join("\n");
  };
  return `${block("ENTRY A", a, b)}\n\n${block("ENTRY B", b, a)}\n\nDo these two entries contradict each other? A disagreement in any excerpt counts. Answer with the JSON object only.`;
}

/** Writes one pair-check task (temp + rename, as myKG does), with its input version; answers its id. */
export async function writePairCheckTask(
  inboxDir: string,
  pair: PairKey,
  entries: { a: PairCheckSide; b: PairCheckSide; focus?: readonly KnowledgeConceptRef[] },
  now: Date
): Promise<string> {
  return writeInboxTask(
    inboxDir,
    PAIR_CHECK_STEP,
    { label: `${PAIR_CHECK_STEP} ${pair.a} ${pair.b}`, system: PAIR_CHECK_SYSTEM, user: pairCheckInput(entries.a, entries.b, entries.focus ?? []) },
    { pair, inputVersion: PAIR_CHECK_INPUT_VERSION },
    now
  );
}

/** A {@link KnowledgeRoundTaskSource}'s task file: myKG's envelope plus the source's payload. */
export interface RoundTaskEnvelope extends InboxTaskEnvelope {
  payload: unknown;
}

/** Writes one task of a round task source into the pair checks' inbox; answers its id. */
export function writeRoundTask(inboxDir: string, step: string, task: KnowledgeRoundTask, now: Date): Promise<string> {
  return writeInboxTask(inboxDir, step, task, { payload: task.payload }, now);
}

/** The id a task is written under (myKG's `_make_task_id`: its prompt and label), so the same input has the same id. */
export function roundTaskId(task: { label: string; system: string; user: string }): string {
  return createHash("sha256").update(`${task.system}\n--user--\n${task.user}\n--ctx--\n${task.label}`).digest("hex");
}

async function writeInboxTask(
  inboxDir: string,
  step: string,
  task: { label: string; system: string; user: string },
  extra: Record<string, unknown>,
  now: Date
): Promise<string> {
  const id = roundTaskId(task);
  const envelope = {
    task_id: id,
    step,
    context_label: task.label,
    system: task.system,
    user: task.user,
    max_tokens: 1_024,
    timeout_seconds: 0,
    created_at: now.toISOString(),
    ...extra
  };
  const inbox = join(inboxDir, INBOX_DIR);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await mkdir(join(inboxDir, OUTBOX_DIR), { recursive: true, mode: 0o700 });
  const path = join(inbox, `${id}.task.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return id;
}

/** A source's answer text when it parses and the source accepts it for this payload, else null. */
export function acceptedRoundAnswer(source: Pick<KnowledgeRoundTaskSource, "validate">, payload: unknown, answer: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    return null;
  }
  return source.validate(value, payload) === null ? answer : null;
}

function readPair(value: unknown): PairKey | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.a === "string" && typeof v.b === "string" && typeof v.hashA === "string" && typeof v.hashB === "string"
    ? { a: v.a, b: v.b, hashA: v.hashA, hashB: v.hashB }
    : null;
}

/** Removes one task's files (answer, `.done`, task). */
export async function removePairCheckTask(inboxDir: string, taskId: string): Promise<void> {
  await rm(join(inboxDir, OUTBOX_DIR, `${taskId}.done`), { force: true });
  await rm(join(inboxDir, OUTBOX_DIR, `${taskId}.answer.json`), { force: true });
  await rm(join(inboxDir, INBOX_DIR, `${taskId}.task.json`), { force: true });
}

/**
 * Before a round and after one (no broker on the inbox): records every answered task (an answer
 * written just before a restart, or one the round did not record) — a pair check in `checks`,
 * another step's in its source — except the tasks in `recorded` (the round recorded them already),
 * and removes every task file, answered or not: an item still worth asking is written again.
 * Answers how many answers were recorded.
 */
export async function harvestPairCheckInbox(
  inboxDir: string,
  checks: Pick<KnowledgePairChecks, "record">,
  sources: ReadonlyMap<string, Pick<KnowledgeRoundTaskSource, "validate" | "record">> = new Map(),
  recorded: ReadonlySet<string> = new Set()
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(join(inboxDir, INBOX_DIR));
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".task.json")) {
      if (name.endsWith(".tmp")) await rm(join(inboxDir, INBOX_DIR, name), { force: true });
      continue;
    }
    const id = name.slice(0, -".task.json".length);
    if (recorded.has(id)) {
      await removePairCheckTask(inboxDir, id);
      continue;
    }
    try {
      const raw = JSON.parse(await readFile(join(inboxDir, INBOX_DIR, name), "utf8")) as Record<string, unknown>;
      const envelope = readEnvelope(raw, id);
      const pair = readPair(raw.pair);
      const answer = JSON.parse(await readFile(join(inboxDir, OUTBOX_DIR, `${id}.answer.json`), "utf8")) as { answer?: unknown };
      const source = envelope ? sources.get(envelope.step) : undefined;
      if (source && typeof answer.answer === "string" && "payload" in raw) {
        const accepted = acceptedRoundAnswer(source, raw.payload, answer.answer);
        if (accepted !== null) {
          await source.record(raw.payload, accepted);
          count += 1;
        }
      }
      const parsed = envelope?.step === PAIR_CHECK_STEP && typeof answer.answer === "string" ? parsePairCheckAnswer(answer.answer) : null;
      if (pair && parsed) {
        // A task an older build wrote (no input version) was asked on version 1.
        const version = raw.inputVersion;
        const inputVersion = typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1;
        await checks.record(pair, parsed.verdict, parsed.note, inputVersion);
        count += 1;
      }
    } catch {
      // Unanswered, or unreadable: nothing to record.
    }
    await removePairCheckTask(inboxDir, id);
  }
  return count;
}
