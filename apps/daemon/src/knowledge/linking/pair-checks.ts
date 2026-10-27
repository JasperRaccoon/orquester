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
 * Meta entries never take part: a `synthesis`, or an entry linked to both concepts of a
 * `contradicts` edge (it reports the disagreement, it takes no side).
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
  type KnowledgePairChecksFile
} from "@orquester/config";
import type { KnowledgeConceptRef, KnowledgeEntry } from "@orquester/api";
import type { KnowledgePairCheck, KnowledgePairChecksPort, KnowledgeRoundTask, KnowledgeRoundTaskSource } from "../ports.ts";
import { normalizeAuthor } from "../search/filters.ts";
import type { KnowledgeLinkGraphView } from "./context.ts";
import { INBOX_DIR, OUTBOX_DIR, readEnvelope, type InboxTaskEnvelope } from "./inbox.ts";

export const PAIR_CHECK_STEP = "pair-check";
/** New pairs checked per linking run at most. */
export const PAIR_CHECK_MAX_PER_RUN = 30;
/** Each entry's body is trimmed to this many characters in the task. */
export const PAIR_CHECK_BODY_CHARS = 2_000;
/** Concept types whose sharing makes two close entries worth checking (claims that can disagree). */
export const PAIR_CHECK_TYPES: ReadonlySet<string> = new Set(["Tactic", "Rule", "Guideline", "Metric", "Result"]);
const NOTE_MAX = 500;
const YIELD_EVERY_MS = 40;

export const PAIR_CHECK_SYSTEM = [
  "You compare two saved knowledge entries and decide whether they contradict each other.",
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
    this.emit();
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

  /** Whether this pair was checked at exactly these content hashes. */
  isChecked(pair: PairKey): boolean {
    const record = this.byKey.get(pairKey(pair.a, pair.b));
    return record !== undefined && record.hashA === pair.hashA && record.hashB === pair.hashB;
  }

  /** Records a check (replacing the pair's earlier one) and persists it. */
  async record(pair: PairKey, verdict: PairCheckVerdict, note: string | null): Promise<void> {
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
      checkedAt: this.options.now().toISOString()
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
}

/** What candidates read of an entry beside its concepts (`KnowledgeEntryMeta`). */
export interface PairCheckEntryInfo {
  kind: string;
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
  /** An entry's kind and author (meta entries and the same author are left out); absent: neither applies. */
  entryOf?(entryId: string): PairCheckEntryInfo | null;
}

/** Entry kinds that quote both sides rather than take one (a synthesis of other entries): never checked. */
export const PAIR_CHECK_META_KINDS: ReadonlySet<string> = new Set(["synthesis"]);
/** "Different values for the same decision": the other entry is among an entry's this many nearest by meaning. */
export const PAIR_CHECK_ALTERNATIVE_NEIGHBOURS = 6;
/** … and a Tool or Tactic of each, not shared, names the same subject: at least this many content words in common. */
export const PAIR_CHECK_ALTERNATIVE_WORDS = 2;
const ALTERNATIVE_TYPES: ReadonlySet<string> = new Set(["Tool", "Tactic"]);
/** Concept types whose negation reads as opposite advice. */
const NEGATION_TYPES: ReadonlySet<string> = new Set([...PAIR_CHECK_TYPES, "Tool"]);
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

/** Whether one name is the other turned around: exactly one negates, and the rest overlaps (Jaccard ≥ 0.5). */
export function negatedNames(x: string, y: string): boolean {
  const wx = nameWords(x);
  const wy = nameWords(y);
  const nx = wx.some((w) => NEGATION_WORDS.has(w));
  const ny = wy.some((w) => NEGATION_WORDS.has(w));
  if (nx === ny) return false;
  const rx = new Set(wx.filter((w) => !NEGATION_WORDS.has(w) && !GLUE_WORDS.has(w)));
  const ry = new Set(wy.filter((w) => !NEGATION_WORDS.has(w) && !GLUE_WORDS.has(w)));
  let shared = 0;
  for (const w of rx) if (ry.has(w)) shared += 1;
  const union = rx.size + ry.size - shared;
  return union > 0 && shared / union >= NEGATION_MIN_JACCARD;
}

const authorKey = (value: string): string => normalizeAuthor(value);

/**
 * New candidate pairs (see the module header), tier by tier in {@link PAIR_CHECK_REASONS} order,
 * closest first within a tier; meta entries (kind {@link PAIR_CHECK_META_KINDS}, or linked to both
 * concepts of a `contradicts` edge: they quote both sides) never take part. Yields to the event loop
 * on large sets.
 */
export async function pairCheckCandidates(options: PairCheckCandidatesOptions): Promise<PairCandidate[]> {
  const index = options.view.vectors();
  const good = index.thresholds()?.good ?? null;
  let since = performance.now();
  const breathe = async (): Promise<void> => {
    if (performance.now() - since < YIELD_EVERY_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
  const conceptsOf = new Map<string, readonly KnowledgeConceptRef[]>();
  const entriesOfConcept = new Map<string, string[]>();
  const contradicting = new Map<string, readonly string[]>();
  const contradictingOf = (concept: string): readonly string[] => {
    let others = contradicting.get(concept);
    if (!others) contradicting.set(concept, (others = options.view.contradicting(concept)));
    return others;
  };
  const ids: string[] = [];
  for (const id of options.ids) {
    const info = options.entryOf?.(id) ?? null;
    if (info && PAIR_CHECK_META_KINDS.has(info.kind)) continue;
    const concepts = options.view.conceptsOf(id);
    const own = new Set(concepts.map((concept) => concept.id));
    // Linked to both sides of a `contradicts` edge: it reports the disagreement, it does not take a side.
    if (concepts.some((concept) => contradictingOf(concept.id).some((other) => own.has(other)))) continue;
    ids.push(id);
    conceptsOf.set(id, concepts);
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
  const consider = (x: string, y: string, sim: number | null, reason: PairCandidateReason): void => {
    if (x === y) return;
    const [a, b] = sorted(x, y);
    const key = `${a} ${b}`;
    const seen = found.get(key);
    if (seen) {
      if (PAIR_CHECK_REASONS.indexOf(reason) < PAIR_CHECK_REASONS.indexOf(seen.reason)) seen.reason = reason;
      return;
    }
    const hashA = options.hashOf(a);
    const hashB = options.hashOf(b);
    if (!hashA || !hashB) return;
    const pair = { a, b, hashA, hashB };
    if (options.isChecked(pair)) return;
    found.set(key, { ...pair, similarity: sim, reason });
  };

  // Joined by a `contradicts` edge between their concepts (any similarity).
  for (const [concept, entries] of entriesOfConcept) {
    for (const other of contradictingOf(concept)) {
      for (const a of entries) {
        for (const b of entriesOfConcept.get(other) ?? []) if (a !== b) consider(a, b, similarity(a, b), "contradicts");
      }
    }
    await breathe();
  }

  if (good !== null) {
    // Every close pair once, and each entry's nearest neighbours (for "alternatives").
    const rows = [...vectors.keys()];
    const near = new Map<string, { id: string; sim: number }[]>();
    const close: { a: string; b: string; sim: number }[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const sim = similarity(rows[i]!, rows[j]!);
        if (sim === null) continue;
        for (const [x, y] of [[rows[i]!, rows[j]!], [rows[j]!, rows[i]!]] as const) {
          let list = near.get(x);
          if (!list) near.set(x, (list = []));
          list.push({ id: y, sim });
        }
        if (sim >= good) close.push({ a: rows[i]!, b: rows[j]!, sim });
      }
      await breathe();
    }
    const nearest = new Map<string, Set<string>>();
    for (const [id, list] of near) {
      list.sort((x, y) => y.sim - x.sim || (x.id < y.id ? -1 : 1));
      nearest.set(id, new Set(list.slice(0, PAIR_CHECK_ALTERNATIVE_NEIGHBOURS).map((n) => n.id)));
    }
    const wordsOf = new Map<string, Set<string>>();
    const words = (concept: KnowledgeConceptRef): Set<string> => {
      let set = wordsOf.get(concept.id);
      if (!set) wordsOf.set(concept.id, (set = contentWords(concept.name)));
      return set;
    };
    let rowsSince = 0;
    for (const { a, b, sim } of close) {
      if (++rowsSince % 256 === 0) await breathe();
      const ca = conceptsOf.get(a)!;
      const cb = conceptsOf.get(b)!;
      const idsA = new Set(ca.map((c) => c.id));
      const idsB = new Set(cb.map((c) => c.id));
      // Sharing a claim-like concept.
      if (ca.some((c) => PAIR_CHECK_TYPES.has(c.type) && idsB.has(c.id))) consider(a, b, sim, "shared");
      // A concept and its negation ("One trial per IP" / "Never one trial per IP").
      let negation = false;
      for (const x of ca) {
        if (negation || !NEGATION_TYPES.has(x.type) || idsB.has(x.id)) continue;
        for (const y of cb) {
          if (y.type === x.type && !idsA.has(y.id) && negatedNames(x.name, y.name)) {
            negation = true;
            break;
          }
        }
      }
      if (negation) consider(a, b, sim, "negation");
      // Different values for the same decision: nearest neighbours by different authors whose
      // Tools or Tactics (not shared) name the same subject ("Outlook/Proton email for TikTok
      // account" / "Create TikTok accounts with a fresh Gmail"; "ISP proxy with socks5" / "Using
      // residential, mobile or ISP proxies").
      if (!(nearest.get(a)?.has(b) || nearest.get(b)?.has(a)) || sameAuthor(a, b)) continue;
      let alternative = false;
      for (const x of ca) {
        if (alternative || !ALTERNATIVE_TYPES.has(x.type) || idsB.has(x.id)) continue;
        const wx = words(x);
        if (wx.size < PAIR_CHECK_ALTERNATIVE_WORDS) continue;
        for (const y of cb) {
          if (y.type !== x.type || idsA.has(y.id)) continue;
          let shared = 0;
          for (const w of words(y)) if (wx.has(w)) shared += 1;
          if (shared >= PAIR_CHECK_ALTERNATIVE_WORDS) {
            alternative = true;
            break;
          }
        }
      }
      if (alternative) consider(a, b, sim, "alternatives");
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

function trimBody(body: string): string {
  const text = body.trim();
  return text.length <= PAIR_CHECK_BODY_CHARS ? text : `${text.slice(0, PAIR_CHECK_BODY_CHARS).trimEnd()} […]`;
}

/** The task's user message: both entries' titles and (trimmed) bodies. */
export function pairCheckInput(a: Pick<KnowledgeEntry, "id" | "title" | "body">, b: Pick<KnowledgeEntry, "id" | "title" | "body">): string {
  const block = (label: string, entry: Pick<KnowledgeEntry, "id" | "title" | "body">): string =>
    [`${label} (${entry.id})`, "=".repeat(label.length + entry.id.length + 3), `Title: ${entry.title.replace(/\s+/g, " ").trim()}`, "", trimBody(entry.body)].join("\n");
  return `${block("ENTRY A", a)}\n\n${block("ENTRY B", b)}\n\nDo these two entries contradict each other? Answer with the JSON object only.`;
}

/** Writes one pair-check task (temp + rename, as myKG does); answers its id. */
export async function writePairCheckTask(
  inboxDir: string,
  pair: PairKey,
  entries: { a: Pick<KnowledgeEntry, "id" | "title" | "body">; b: Pick<KnowledgeEntry, "id" | "title" | "body"> },
  now: Date
): Promise<string> {
  return writeInboxTask(inboxDir, PAIR_CHECK_STEP, { label: `${PAIR_CHECK_STEP} ${pair.a} ${pair.b}`, system: PAIR_CHECK_SYSTEM, user: pairCheckInput(entries.a, entries.b) }, { pair }, now);
}

/** A {@link KnowledgeRoundTaskSource}'s task file: myKG's envelope plus the source's payload. */
export interface RoundTaskEnvelope extends InboxTaskEnvelope {
  payload: unknown;
}

/** Writes one task of a round task source into the pair checks' inbox; answers its id. */
export function writeRoundTask(inboxDir: string, step: string, task: KnowledgeRoundTask, now: Date): Promise<string> {
  return writeInboxTask(inboxDir, step, task, { payload: task.payload }, now);
}

async function writeInboxTask(
  inboxDir: string,
  step: string,
  task: { label: string; system: string; user: string },
  extra: Record<string, unknown>,
  now: Date
): Promise<string> {
  const id = createHash("sha256").update(`${task.system}\n--user--\n${task.user}\n--ctx--\n${task.label}`).digest("hex");
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
 * Before a round (no broker on the inbox): records every answered task (an answer written just
 * before a restart) — a pair check in `checks`, another step's in its source — and removes every
 * task file, answered or not: an item still worth asking is written again. Answers how many answers
 * were recorded.
 */
export async function harvestPairCheckInbox(
  inboxDir: string,
  checks: Pick<KnowledgePairChecks, "record">,
  sources: ReadonlyMap<string, Pick<KnowledgeRoundTaskSource, "validate" | "record">> = new Map()
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(join(inboxDir, INBOX_DIR));
  } catch {
    return 0;
  }
  let recorded = 0;
  for (const name of names) {
    if (!name.endsWith(".task.json")) {
      if (name.endsWith(".tmp")) await rm(join(inboxDir, INBOX_DIR, name), { force: true });
      continue;
    }
    const id = name.slice(0, -".task.json".length);
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
          recorded += 1;
        }
      }
      const parsed = envelope?.step === PAIR_CHECK_STEP && typeof answer.answer === "string" ? parsePairCheckAnswer(answer.answer) : null;
      if (pair && parsed) {
        await checks.record(pair, parsed.verdict, parsed.note);
        recorded += 1;
      }
    } catch {
      // Unanswered, or unreadable: nothing to record.
    }
    await removePairCheckTask(inboxDir, id);
  }
  return recorded;
}
