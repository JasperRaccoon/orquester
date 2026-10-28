/**
 * Neutral, attributed concept summaries (quality round 4, `KnowledgeConceptDetail.summary`). myKG
 * describes a concept from the one entry it was extracted from first, so a generic concept carries
 * one author's claim: "TikTok account warm-up" said "… first video after 1–2 days" while five guides
 * say 48 hours, 1–2, 3, 3–5 and 5–7 days; "NordVPN" said "Shared-IP VPN the author advises against".
 * So a concept with {@link CONCEPT_SUMMARY_MIN_ENTRIES}+ entries is asked about once per member set:
 * one or two neutral sentences on what it is, and each entry's own position on it (a
 * `KnowledgeRoundTaskSource`, step {@link CONCEPT_SUMMARY_STEP}, at most
 * {@link CONCEPT_SUMMARY_MAX_PER_ROUND} a round in linking's idle rounds).
 *
 * - Which concepts: every concept of the graph after the merge overlay (a merge's kept concept,
 *   with all of its sources' entries) but a Person, whose entries that exist number at least
 *   {@link CONCEPT_SUMMARY_MIN_ENTRIES}; its entries are all counted (unscoped: a summary is written
 *   once and served per caller, below). Claim-bearing types first ({@link CLAIM_TYPES}: on the live
 *   graph, counting entries alone put "Apple", "TikTok" and "Google" first), within them those two
 *   of whose entries contradict each other, then the most entries.
 * - The task: the concept (type, name, aliases, myKG's description marked as possibly one source's)
 *   and up to {@link CONCEPT_SUMMARY_MAX_ENTRIES} of its entries — surveys (`isSurveyEntry`) last, then
 *   those naming it best, sources before notes about them: title, author and handle, kind, and the
 *   entry's text — whole when short,
 *   else its opening and the passages naming the concept (`excerpts.ts`, about
 *   {@link CONCEPT_SUMMARY_ENTRY_CHARS} characters each).
 * - The answer ({@link validateConceptSummaryAnswer}): exactly `{text, positions: [{entryId, claim}]}`;
 *   `text` ≤ {@link CONCEPT_SUMMARY_TEXT_MAX} characters with no number the concept's own names do not
 *   have (an entry's numbers are its position's); each claim ≤ {@link CONCEPT_SUMMARY_CLAIM_MAX}; an
 *   entry id of the input, once.
 * - Persisted in `concept-summaries.json` (`knowledgeConceptSummariesPath`; tolerant: `@orquester/config`
 *   `knowledge-concept-summaries.ts`) by concept id, with every member entry's content hash: a summary
 *   is asked for again only when its entries change (an edit, a new entry, a merge folding in
 *   another concept's), and served meanwhile while it still holds.
 *
 * Visibility ({@link KnowledgeConceptSummaries.summaryFor}): the text and every claim were written
 * from all the entries the concept had (its name, aliases and description too), so a summary is
 * served only to a caller who can see every one of them; otherwise it is left out, whole. Its
 * positions are those of entries still behind the concept for that caller and unchanged since; a
 * summary whose positions are all gone is left out too.
 */

import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import type { KnowledgeConceptSummary, KnowledgeEntryMeta } from "@orquester/api";
import {
  emptyKnowledgeConceptSummariesFile,
  readKnowledgeConceptSummariesFile,
  serializeKnowledgeConceptSummariesFile,
  type KnowledgeConceptSummariesFile,
  type KnowledgeConceptSummaryRecord
} from "@orquester/config";
import type { KnowledgeRoundTask, KnowledgeRoundTaskOptions, KnowledgeRoundTaskSource } from "../ports.ts";
import type { KnowledgeLogger } from "../store/errors.ts";
import { writeFileAtomic } from "../store/fs.ts";
import { conceptExcerpt } from "./concept-merge-checks.ts";
import { isSurveyEntry } from "./contradictions.ts";
import { relevantExcerpt } from "./excerpts.ts";
import type { GraphConcept } from "./graph.ts";

export const CONCEPT_SUMMARY_STEP = "concept-summary";
/** Concepts summarized per round at most. */
export const CONCEPT_SUMMARY_MAX_PER_ROUND = 25;
/** A concept needs at least this many entries for a summary. */
export const CONCEPT_SUMMARY_MIN_ENTRIES = 2;
/** Entries shown to the writer at most. */
export const CONCEPT_SUMMARY_MAX_ENTRIES = 8;
/** Characters of an entry's text shown (a longer one: its opening and the passages naming the concept). */
export const CONCEPT_SUMMARY_ENTRY_CHARS = 1_800;
export const CONCEPT_SUMMARY_TEXT_MAX = 400;
export const CONCEPT_SUMMARY_CLAIM_MAX = 250;
/** Types whose concepts are claims or the things claims are about: summarized first. */
export const CLAIM_TYPES: ReadonlySet<string> = new Set(["Tactic", "Tool", "Metric", "Result", "Guideline"]);
/** Types never summarized: a person's entries say what that person did, not what the person is. */
const SKIP_TYPES: ReadonlySet<string> = new Set(["Person"]);
const DESCRIPTION_MAX = 600;
/** Kinds of entries that write about other sources (a research note) rather than being one. */
const SECONDARY_KINDS = /note|research|synthesis/i;

export const CONCEPT_SUMMARY_SYSTEM = [
  "You summarize one concept from a knowledge base neutrally, and say what each of its source entries claims about it.",
  'Answer with ONLY a JSON object, no prose and no other keys: {"text": "<one or two sentences>", "positions": [{"entryId": "<an entry id from the input>", "claim": "<one sentence>"}]}.',
  `- text: one or two neutral sentences (at most ${CONCEPT_SUMMARY_TEXT_MAX} characters) saying what the concept is. It must hold for every entry: no entry's numbers, durations, thresholds, verdicts or recommendations, and no "the author". The concept's description may reflect one source only: do not copy its claims.`,
  `- positions: for each entry that makes a claim about the concept, that entry's own claim in one sentence (at most ${CONCEPT_SUMMARY_CLAIM_MAX} characters), with its specific numbers, conditions and verdict (e.g. "Post the first video after 1–2 days of scrolling", "Advises against NordVPN: its shared IPs are flagged"). Leave out an entry that only mentions the concept in passing. At most one position per entry; entryId exactly as given.`,
  "- An entry of kind synthesis, or a map, audit or overview note, reports other sources: give what it reports or concludes, naming whom it attributes a claim to.",
  "- Write in the language of the entries; do not invent anything the entries do not say."
].join("\n");

/** An entry as the task shows it. */
export interface ConceptSummaryEntry {
  id: string;
  title: string;
  author: string | null;
  handle: string | null;
  kind: string;
  text: string;
}

/** The concept as the task shows it. */
export interface ConceptSummaryConcept {
  type: string;
  name: string;
  aliases: readonly string[];
  description: string | null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The task's user message. */
export function conceptSummaryInput(concept: ConceptSummaryConcept, entries: readonly ConceptSummaryEntry[]): string {
  const description = concept.description ? oneLine(concept.description) : null;
  const lines = [
    "CONCEPT",
    "=======",
    `Type: ${oneLine(concept.type)}`,
    `Name: ${oneLine(concept.name)}`,
    ...(concept.aliases.length > 0 ? [`Aliases: ${concept.aliases.map(oneLine).join("; ")}`] : []),
    ...(description
      ? [`Description (may reflect one source only): ${description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX).trimEnd()} […]` : description}`]
      : []),
    "",
    `ENTRIES (${entries.length})`
  ];
  for (const entry of entries) {
    const by = [entry.author ? oneLine(entry.author) : null, entry.handle ? `@${oneLine(entry.handle).replace(/^@+/, "")}` : null].filter((part) => part !== null).join(" ");
    lines.push(
      "",
      `ENTRY ${entry.id}`,
      `Title: ${oneLine(entry.title) || "(untitled)"}`,
      `By: ${by || "unknown"}`,
      `Kind: ${oneLine(entry.kind) || "note"}`,
      "Text:",
      entry.text
    );
  }
  lines.push("", "Summarize the concept and give each entry's position. Answer with the JSON object only.");
  return lines.join("\n");
}

/** The numbers of a text ("1–2 days" → 1, 2; "$5/mo" → 5; "4.3" → 4.3). */
function numbersOf(text: string): Set<string> {
  return new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []);
}

/**
 * `null` when `value` is a valid answer for a task over these entries (`entryIds`) about a concept
 * with these names (its numbers may appear in the text), else why not (the worker answers again).
 */
export function validateConceptSummaryAnswer(value: unknown, entryIds: readonly string[], names: readonly string[] = []): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 'The answer must be a JSON object {"text": …, "positions": […]}.';
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "text" && key !== "positions");
  if (extra.length > 0) return `The answer has keys it must not have (${extra.slice(0, 3).join(", ")}): only "text" and "positions".`;
  if (typeof record.text !== "string" || record.text.trim() === "") return '"text" must be one or two sentences.';
  const text = record.text.trim();
  if (text.length > CONCEPT_SUMMARY_TEXT_MAX) return `"text" must be at most ${CONCEPT_SUMMARY_TEXT_MAX} characters.`;
  const allowed = numbersOf(names.join(" "));
  const foreign = [...numbersOf(text)].filter((n) => !allowed.has(n));
  if (foreign.length > 0) return `"text" must not carry an entry's numbers (${foreign.slice(0, 3).join(", ")}): put them in that entry's position.`;
  if (!Array.isArray(record.positions)) return '"positions" must be an array (empty when no entry makes a claim about the concept).';
  const known = new Set(entryIds);
  const seen = new Set<string>();
  for (const [i, item] of record.positions.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return `positions[${i}] must be an object {"entryId": …, "claim": …}.`;
    const position = item as Record<string, unknown>;
    const keys = Object.keys(position).filter((key) => key !== "entryId" && key !== "claim");
    if (keys.length > 0) return `positions[${i}] has keys it must not have (${keys.slice(0, 3).join(", ")}): only "entryId" and "claim".`;
    if (typeof position.entryId !== "string" || !known.has(position.entryId)) return `positions[${i}].entryId must be one of the entry ids given (${entryIds.join(", ")}).`;
    if (seen.has(position.entryId)) return `positions has ${position.entryId} twice: one position per entry.`;
    seen.add(position.entryId);
    if (typeof position.claim !== "string" || position.claim.trim() === "") return `positions[${i}].claim must be a one-sentence string.`;
    if (position.claim.trim().length > CONCEPT_SUMMARY_CLAIM_MAX) return `positions[${i}].claim must be at most ${CONCEPT_SUMMARY_CLAIM_MAX} characters.`;
  }
  return null;
}

/** A validated answer, trimmed, or null (bad JSON included). */
export function parseConceptSummaryAnswer(
  text: string,
  entryIds: readonly string[],
  names: readonly string[] = []
): { text: string; positions: { entryId: string; claim: string }[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (validateConceptSummaryAnswer(value, entryIds, names) !== null) return null;
  const record = value as { text: string; positions: { entryId: string; claim: string }[] };
  return { text: oneLine(record.text), positions: record.positions.map((p) => ({ entryId: p.entryId, claim: oneLine(p.claim) })) };
}

/** The hash of a concept's member entries (ids and content hashes, in id order). */
export function conceptMembersHash(members: readonly { id: string; contentHash: string }[]): string {
  const lines = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((m) => `${m.id}\u0000${m.contentHash}`);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 32);
}

/** What a concept-summary task carries back with its answer. */
interface SummaryPayload {
  conceptId: string;
  hash: string;
  members: { id: string; contentHash: string }[];
  inputs: string[];
  /** The concept's name and aliases (numbers in them may appear in the text). */
  names: string[];
}

function readPayload(value: unknown): SummaryPayload | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.conceptId !== "string" || typeof v.hash !== "string" || !Array.isArray(v.members) || !Array.isArray(v.inputs)) return null;
  const members = v.members.filter(
    (m): m is { id: string; contentHash: string } => m !== null && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && typeof (m as { contentHash?: unknown }).contentHash === "string"
  );
  const inputs = v.inputs.filter((id): id is string => typeof id === "string");
  const names = Array.isArray(v.names) ? v.names.filter((n): n is string => typeof n === "string") : [];
  return members.length > 0 && inputs.length > 0 ? { conceptId: v.conceptId, hash: v.hash, members: members.map(({ id, contentHash }) => ({ id, contentHash })), inputs, names } : null;
}

/** What concept details read (optional: absent, no concept has a summary). */
export interface KnowledgeConceptSummariesPort {
  /**
   * The summary of a concept (the graph's id after the overlay) as one caller may read it, or null.
   * `visible(id)`: the entry's metadata when it exists and the caller can see it, else null;
   * `behind`: the entries behind the concept the caller can see.
   */
  summaryFor(conceptId: string, caller: { visible: (entryId: string) => KnowledgeEntryMeta | null; behind: ReadonlySet<string> }): KnowledgeConceptSummary | null;
}

export interface KnowledgeConceptSummariesOptions {
  /** `knowledgeConceptSummariesPath(appdir)`. */
  path: string;
  /** The graph's concepts after the merge overlay (`KnowledgeGraph.currentConcepts`). */
  concepts(): readonly GraphConcept[];
  /** An entry's metadata (every entry, unscoped); null when gone. */
  meta(entryId: string): KnowledgeEntryMeta | null;
  /** An entry's body; null when gone. */
  body(entryId: string): Promise<string | null>;
  /** Entry pairs that contradict each other (unscoped; a concept two of whose entries do is summarized sooner). */
  contradicting?(): Iterable<{ a: string; b: string }>;
  /** Called when the concepts may have changed (graph loads, merges): new work. */
  onConceptsChange?(listener: () => void): () => void;
  limit?: number;
  now?: () => Date;
  logger?: KnowledgeLogger;
}

/** A concept due for a summary. */
interface Due {
  concept: GraphConcept;
  members: { id: string; contentHash: string }[];
  hash: string;
  /** 2 for a claim-bearing type, +1 when two of its entries contradict each other: the higher first. */
  tier: number;
}

/** The summaries: the port concept details read and the round task source (see the module header). */
export class KnowledgeConceptSummaries implements KnowledgeConceptSummariesPort, KnowledgeRoundTaskSource {
  readonly step = CONCEPT_SUMMARY_STEP;
  private file: KnowledgeConceptSummariesFile = emptyKnowledgeConceptSummariesFile();
  private byConcept = new Map<string, KnowledgeConceptSummaryRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();
  private readonly logger: KnowledgeLogger;

  constructor(private readonly options: KnowledgeConceptSummariesOptions) {
    this.logger = options.logger ?? console;
  }

  /** Reads the file; one that does not parse is moved aside and the summaries start empty. Never rejects. */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch {
      text = null;
    }
    let file = emptyKnowledgeConceptSummariesFile();
    if (text !== null) {
      try {
        file = readKnowledgeConceptSummariesFile(JSON.parse(text));
      } catch {
        const aside = `${this.options.path}.unreadable-${this.now().getTime()}`;
        await rename(this.options.path, aside).catch(() => undefined);
        this.logger.warn(`knowledge: concept-summaries.json did not read; moved to ${aside}`);
      }
    }
    this.setFile(file);
  }

  /** Called after a summary was added. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onWork(listener: () => void): () => void {
    return this.options.onConceptsChange?.(listener) ?? (() => {});
  }

  summaryFor(conceptId: string, caller: { visible: (entryId: string) => KnowledgeEntryMeta | null; behind: ReadonlySet<string> }): KnowledgeConceptSummary | null {
    const record = this.byConcept.get(conceptId);
    if (!record || caller.behind.size < CONCEPT_SUMMARY_MIN_ENTRIES) return null;
    // Written from every one of them: a caller who cannot see one of them reads none of it.
    for (const member of record.members) if (caller.visible(member.id) === null) return null;
    const hashes = new Map(record.members.map((member) => [member.id, member.contentHash]));
    const positions: KnowledgeConceptSummary["positions"] = [];
    for (const position of record.positions) {
      const meta = caller.visible(position.entryId);
      if (!meta || !caller.behind.has(position.entryId) || meta.contentHash !== hashes.get(position.entryId)) continue;
      positions.push({ entryId: meta.id, title: meta.title, author: meta.author ?? (meta.handle ? `@${meta.handle}` : null), claim: position.claim });
    }
    if (record.positions.length > 0 && positions.length === 0) return null;
    return { text: record.text, positions };
  }

  /** Concepts due for a summary now, most first (tests, the live evaluation). */
  due(): { conceptId: string; name: string; type: string; entries: number; tier: number }[] {
    return this.dueConcepts().map((due) => ({ conceptId: due.concept.id, name: due.concept.name, type: due.concept.type, entries: due.members.length, tier: due.tier }));
  }

  async tasks(options: KnowledgeRoundTaskOptions = {}): Promise<KnowledgeRoundTask[]> {
    if (this.file.readOnly) return [];
    const limit = this.options.limit ?? CONCEPT_SUMMARY_MAX_PER_ROUND;
    const tasks: KnowledgeRoundTask[] = [];
    for (const due of this.dueConcepts()) {
      if (tasks.length >= limit) break;
      const task = await this.task(due);
      // Rounds gave up on it as it is: its next item takes its place (a changed member set is a new item).
      if (task && !options.skip?.(task)) tasks.push(task);
    }
    return tasks;
  }

  validate(value: unknown, payload: unknown): string | null {
    const task = readPayload(payload);
    return validateConceptSummaryAnswer(value, task?.inputs ?? [], task?.names ?? []);
  }

  async record(payload: unknown, answer: string): Promise<void> {
    const task = readPayload(payload);
    const parsed = task ? parseConceptSummaryAnswer(answer, task.inputs, task.names) : null;
    if (!task || !parsed) return;
    const run = this.chain.then(async () => {
      if (this.file.readOnly) return;
      const record: KnowledgeConceptSummaryRecord = {
        conceptId: task.conceptId,
        hash: task.hash,
        members: task.members,
        inputs: task.inputs,
        text: parsed.text,
        positions: parsed.positions,
        writtenAt: this.now().toISOString()
      };
      const next: KnowledgeConceptSummariesFile = { ...this.file, summaries: [...this.file.summaries.filter((r) => r.conceptId !== record.conceptId), record] };
      await writeFileAtomic(this.options.path, serializeKnowledgeConceptSummariesFile(next));
      this.setFile(next);
    });
    this.chain = run.catch(() => undefined);
    await run.catch((error: unknown) => this.logger.warn(`knowledge: a concept summary could not be saved (${String(error)})`));
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a concept summaries listener failed (${String(error)})`);
      }
    }
  }

  private setFile(file: KnowledgeConceptSummariesFile): void {
    this.file = file;
    this.byConcept = new Map(file.summaries.map((record) => [record.conceptId, record]));
  }

  /** Concepts with enough entries whose summary is missing or was written from other entries, most first. */
  private dueConcepts(): Due[] {
    const contested = new Map<string, Set<string>>();
    for (const { a, b } of this.options.contradicting?.() ?? []) {
      let set = contested.get(a);
      if (!set) contested.set(a, (set = new Set()));
      set.add(b);
    }
    const out: Due[] = [];
    for (const concept of this.options.concepts()) {
      if (SKIP_TYPES.has(concept.type)) continue;
      const members: { id: string; contentHash: string }[] = [];
      for (const id of new Set(concept.entryIds)) {
        const meta = this.options.meta(id);
        if (meta) members.push({ id, contentHash: meta.contentHash });
      }
      if (members.length < CONCEPT_SUMMARY_MIN_ENTRIES) continue;
      const hash = conceptMembersHash(members);
      if (this.byConcept.get(concept.id)?.hash === hash) continue;
      const ids = new Set(members.map((m) => m.id));
      const disagree = members.some((m) => [...(contested.get(m.id) ?? [])].some((other) => ids.has(other)));
      out.push({ concept, members, hash, tier: (CLAIM_TYPES.has(concept.type) ? 2 : 0) + (disagree ? 1 : 0) });
    }
    return out.sort((x, y) => y.tier - x.tier || y.members.length - x.members.length || (x.concept.id < y.concept.id ? -1 : 1));
  }

  /** The task for a concept due; null when too few of its entries can be read. */
  private async task(due: Due): Promise<KnowledgeRoundTask | null> {
    const { concept } = due;
    const read: { meta: KnowledgeEntryMeta; body: string; score: number; survey: boolean; note: boolean }[] = [];
    for (const member of due.members) {
      const meta = this.options.meta(member.id);
      const body = meta ? await this.options.body(member.id).catch(() => null) : null;
      if (!meta || body === null) continue;
      read.push({ meta, body, score: conceptExcerpt(body, concept).score, survey: isSurveyEntry(meta), note: SECONDARY_KINDS.test(meta.kind) });
    }
    if (read.length < CONCEPT_SUMMARY_MIN_ENTRIES) return null;
    // A survey after the entries that state their own claims; naming it best first; a source before notes about sources; newest.
    read.sort(
      (x, y) =>
        Number(x.survey) - Number(y.survey) ||
        y.score - x.score ||
        Number(x.note) - Number(y.note) ||
        (y.meta.postedAt ?? y.meta.savedAt).localeCompare(x.meta.postedAt ?? x.meta.savedAt) ||
        (x.meta.id < y.meta.id ? -1 : 1)
    );
    const names = [concept.name, ...concept.aliases];
    const query = {
      text: [...names, concept.description ?? ""].join("\n"),
      concepts: names.map((name) => ({ name, weight: 2 })),
      focus: names
    };
    const shown = read.slice(0, CONCEPT_SUMMARY_MAX_ENTRIES);
    const entries: ConceptSummaryEntry[] = shown.map(({ meta, body }) => ({
      id: meta.id,
      title: meta.title,
      author: meta.author,
      handle: meta.handle,
      kind: meta.kind,
      text: relevantExcerpt(body, query, CONCEPT_SUMMARY_ENTRY_CHARS).text
    }));
    const user = conceptSummaryInput({ type: concept.type, name: concept.name, aliases: concept.aliases, description: concept.description }, entries);
    const payload: SummaryPayload = { conceptId: concept.id, hash: due.hash, members: due.members, inputs: entries.map((e) => e.id), names };
    return { label: `${CONCEPT_SUMMARY_STEP} ${concept.id}`, system: CONCEPT_SUMMARY_SYSTEM, user, payload };
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
