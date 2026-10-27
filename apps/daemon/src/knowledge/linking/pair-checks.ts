/**
 * Knowledge Graph linking — pair checks: contradictions an LLM confirms (phase 2 spec, "Pair
 * checks"). Implements `KnowledgePairChecksPort` (read by insights and similar entries, W3).
 *
 * Candidates ({@link pairCheckCandidates}): pairs of linked entries that are close in meaning
 * (cosine ≥ the model's `good`) and share at least one concept of a claim-like type
 * ({@link PAIR_CHECK_TYPES}), or that are joined by a `contradicts` edge between their concepts (any
 * similarity); closest first, at most {@link PAIR_CHECK_MAX_PER_RUN} new ones per linking run, each
 * pair checked once per pair of content hashes.
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
import type { KnowledgeEntry } from "@orquester/api";
import type { KnowledgePairCheck, KnowledgePairChecksPort } from "../ports.ts";
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

export interface PairCandidate extends PairKey {
  /** Cosine of the two entry vectors; null when either has none (a `contradicts` edge alone). */
  similarity: number | null;
}

export interface PairCheckCandidatesOptions {
  /** Linked entries. */
  ids: readonly string[];
  view: KnowledgeLinkGraphView;
  hashOf(entryId: string): string | null;
  isChecked(pair: PairKey): boolean;
  limit: number;
}

/** New candidate pairs, closest first (see the module header). Yields to the event loop on large sets. */
export async function pairCheckCandidates(options: PairCheckCandidatesOptions): Promise<PairCandidate[]> {
  const index = options.view.vectors();
  const good = index.thresholds()?.good ?? null;
  const typed = new Map<string, Set<string>>();
  const entriesOfConcept = new Map<string, string[]>();
  for (const id of options.ids) {
    const set = new Set<string>();
    for (const concept of options.view.conceptsOf(id)) {
      if (PAIR_CHECK_TYPES.has(concept.type)) set.add(concept.id);
      const list = entriesOfConcept.get(concept.id);
      if (list) list.push(id);
      else entriesOfConcept.set(concept.id, [id]);
    }
    typed.set(id, set);
  }
  const vectors = new Map<string, Float32Array>();
  for (const id of options.ids) {
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
  const consider = (x: string, y: string, sim: number | null): void => {
    const [a, b] = sorted(x, y);
    const key = `${a} ${b}`;
    if (found.has(key)) return;
    const hashA = options.hashOf(a);
    const hashB = options.hashOf(b);
    if (!hashA || !hashB) return;
    const pair = { a, b, hashA, hashB };
    if (options.isChecked(pair)) return;
    found.set(key, { ...pair, similarity: sim });
  };
  let since = performance.now();
  const breathe = async (): Promise<void> => {
    if (performance.now() - since < YIELD_EVERY_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
  // Close in meaning and sharing a claim-like concept.
  if (good !== null) {
    const rows = [...vectors.keys()].filter((id) => (typed.get(id)?.size ?? 0) > 0);
    for (let i = 0; i < rows.length; i += 1) {
      const a = rows[i]!;
      const conceptsA = typed.get(a)!;
      for (let j = i + 1; j < rows.length; j += 1) {
        const b = rows[j]!;
        const sim = similarity(a, b);
        if (sim === null || sim < good) continue;
        let shared = false;
        for (const concept of typed.get(b)!) {
          if (conceptsA.has(concept)) {
            shared = true;
            break;
          }
        }
        if (shared) consider(a, b, sim);
      }
      await breathe();
    }
  }
  // Joined by a `contradicts` edge between their concepts.
  const contradicting = new Map<string, readonly string[]>();
  for (const [concept, entries] of entriesOfConcept) {
    let others = contradicting.get(concept);
    if (!others) {
      others = options.view.contradicting(concept);
      contradicting.set(concept, others);
    }
    for (const other of others) {
      for (const a of entries) {
        for (const b of entriesOfConcept.get(other) ?? []) if (a !== b) consider(a, b, similarity(a, b));
      }
    }
    await breathe();
  }
  return [...found.values()]
    .sort((x, y) => (y.similarity ?? -2) - (x.similarity ?? -2) || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1))
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
  const user = pairCheckInput(entries.a, entries.b);
  const label = `${PAIR_CHECK_STEP} ${pair.a} ${pair.b}`;
  const id = createHash("sha256").update(`${PAIR_CHECK_SYSTEM}\n--user--\n${user}\n--ctx--\n${label}`).digest("hex");
  const envelope: PairCheckEnvelope = {
    task_id: id,
    step: PAIR_CHECK_STEP,
    context_label: label,
    system: PAIR_CHECK_SYSTEM,
    user,
    max_tokens: 1_024,
    timeout_seconds: 0,
    created_at: now.toISOString(),
    pair
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
 * before a restart) and removes every task file, answered or not — a pair still worth checking is
 * written again. Answers how many answers were recorded.
 */
export async function harvestPairCheckInbox(inboxDir: string, checks: Pick<KnowledgePairChecks, "record">): Promise<number> {
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
