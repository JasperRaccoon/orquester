/**
 * Family names and summaries (quality round 5, `KnowledgeConceptDetail.family`): a concept family
 * (`concept-families.ts`) is asked about once per member set — the question its concepts answer
 * ("Warm-up length before the first post", 3–8 words), one or two neutral sentences, and each
 * entry's own answer across ALL its members' entries, in the shape of a concept summary
 * (`KnowledgeConceptSummary`). A `KnowledgeRoundTaskSource`, step {@link FAMILY_SUMMARY_STEP}, at most
 * {@link FAMILY_SUMMARY_MAX_PER_ROUND} a round in linking's idle rounds (rounds give up on an item
 * after a few unanswered attempts: `skip`).
 *
 * - Which families: every family now, those with the most source entries first; due when its record
 *   is missing or was written from other concepts or entries (a member joined or left, an entry was
 *   edited or added).
 * - The task: the family's type and member names, and up to {@link FAMILY_SUMMARY_MAX_ENTRIES} of
 *   their entries — each member's best own entry first (so every answer is read), then surveys last,
 *   an author's own post the graph links only through the author (`concept-attribution.ts`) first,
 *   those naming the members best — each with the members it backs and the passages naming them
 *   (`excerpts.ts`, about {@link FAMILY_SUMMARY_ENTRY_CHARS} characters).
 * - The answer ({@link validateFamilySummaryAnswer}): exactly `{name, text, positions}`; `name` of
 *   {@link FAMILY_NAME_MIN_WORDS}–{@link FAMILY_NAME_MAX_WORDS} words with no entry's numbers; `text`
 *   and claims as a concept summary's (`concept-summaries.ts`).
 * - Persisted in `concept-families.json` (`knowledgeConceptFamiliesPath`; tolerant: `@orquester/config`
 *   `knowledge-concept-families.ts`) by family id, with the member concepts and every entry's
 *   content hash; a new record replaces those of the family and of families sharing a member.
 *
 * Visibility ({@link KnowledgeConceptFamilySummaries.familyFor}), as concept summaries: the family
 * lists only the member concepts the caller can see (none at all below two). Its name, text and
 * claims were written from every entry of every member (and the entries attributed to them, and the
 * entries attributing them), so they are served only to a caller who can see every one of them and
 * only while the family has the members they were written for; anyone else reads the family under
 * {@link FAMILY_FALLBACK_NAME}, without a summary. Positions are those of entries still behind a
 * member the caller can see (or attributed), unchanged since.
 */

import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import type { KnowledgeConceptFamily, KnowledgeConceptRef, KnowledgeConceptSummary, KnowledgeEntryMeta } from "@orquester/api";
import {
  emptyKnowledgeConceptFamiliesFile,
  readKnowledgeConceptFamiliesFile,
  serializeKnowledgeConceptFamiliesFile,
  type KnowledgeConceptFamiliesFile,
  type KnowledgeConceptFamilyRecord
} from "@orquester/config";
import type { KnowledgeRoundTask, KnowledgeRoundTaskOptions, KnowledgeRoundTaskSource } from "../ports.ts";
import type { KnowledgeLogger } from "../store/errors.ts";
import { writeFileAtomic } from "../store/fs.ts";
import type { ConceptAttribution } from "./concept-attribution.ts";
import type { ConceptFamily } from "./concept-families.ts";
import { conceptExcerpt } from "./concept-merge-checks.ts";
import { ATTRIBUTED_NOTE, CONCEPT_SUMMARY_CLAIM_MAX, CONCEPT_SUMMARY_TEXT_MAX, attributedMembers, conceptMembersHash } from "./concept-summaries.ts";
import { isSurveyEntry } from "./contradictions.ts";
import { relevantExcerpt } from "./excerpts.ts";
import type { GraphConcept } from "./graph.ts";

export const FAMILY_SUMMARY_STEP = "family-summary";
/** Families named per round at most. */
export const FAMILY_SUMMARY_MAX_PER_ROUND = 10;
/** Entries shown to the writer at most. */
export const FAMILY_SUMMARY_MAX_ENTRIES = 12;
/** Characters of an entry's text shown (a longer one: its opening and the passages naming the members). */
export const FAMILY_SUMMARY_ENTRY_CHARS = 1_400;
export const FAMILY_NAME_MIN_WORDS = 3;
export const FAMILY_NAME_MAX_WORDS = 8;
export const FAMILY_NAME_MAX = 80;
/** The name a family goes by for a caller who may not read its written name (or before it is written). */
export const FAMILY_FALLBACK_NAME = "Concepts answering the same question";
/** Kinds of entries that write about other sources (a research note) rather than being one. */
const SECONDARY_KINDS = /note|research|synthesis/i;

export const FAMILY_SUMMARY_SYSTEM = [
  "You name and summarize a family of concepts from a knowledge base: concepts of one type that answer the same question in different ways, usually each one source's answer. Say which question they answer, neutrally, and what each source entry answers.",
  'Answer with ONLY a JSON object, no prose and no other keys: {"name": "<the question>", "text": "<one or two sentences>", "positions": [{"entryId": "<an entry id from the input>", "claim": "<one sentence>"}]}.',
  `- name: the question the concepts answer, as a short noun phrase of ${FAMILY_NAME_MIN_WORDS} to ${FAMILY_NAME_MAX_WORDS} words (e.g. "Warm-up length before the first post", "How many accounts per device"). No entry's answer and no numbers.`,
  `- text: one or two neutral sentences (at most ${CONCEPT_SUMMARY_TEXT_MAX} characters) on what the question is about. It must hold for every entry: no entry's numbers, durations, thresholds, verdicts or recommendations, and no "the author".`,
  `- positions: for each entry that answers the question, that entry's own answer in one sentence (at most ${CONCEPT_SUMMARY_CLAIM_MAX} characters), with its specific numbers, conditions and verdict (e.g. "Warm up for 48 hours before the first post", "2–3 accounts per device at most"). Leave out an entry that does not answer it. At most one position per entry; entryId exactly as given.`,
  "- An entry of kind synthesis, or a research, map, audit or overview note, reports other sources: give what it reports or concludes, naming whom it attributes a claim to.",
  "- Write in the language of the entries; do not invent anything the entries do not say."
].join("\n");

/** An entry as the task shows it. */
export interface FamilySummaryEntry {
  id: string;
  title: string;
  author: string | null;
  handle: string | null;
  kind: string;
  /** The member concepts it backs (names). */
  backs: readonly string[];
  /** Linked through its author (`concept-attribution.ts`), not by the graph. */
  attributed?: boolean;
  text: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The task's user message. */
export function familySummaryInput(family: { type: string; concepts: readonly string[] }, entries: readonly FamilySummaryEntry[]): string {
  const lines = ["FAMILY", "======", `Type: ${oneLine(family.type)}`, `Concepts (${family.concepts.length}), each one way of answering the question:`];
  for (const name of family.concepts) lines.push(`- ${oneLine(name)}`);
  lines.push("", `ENTRIES (${entries.length})`);
  for (const entry of entries) {
    const by = [entry.author ? oneLine(entry.author) : null, entry.handle ? `@${oneLine(entry.handle).replace(/^@+/, "")}` : null].filter((part) => part !== null).join(" ");
    lines.push(
      "",
      `ENTRY ${entry.id}`,
      `Title: ${oneLine(entry.title) || "(untitled)"}`,
      `By: ${by || "unknown"}`,
      `Kind: ${oneLine(entry.kind) || "note"}`,
      ...(entry.backs.length > 0 ? [`Backs: ${entry.backs.map(oneLine).join("; ")}`] : []),
      ...(entry.attributed ? [ATTRIBUTED_NOTE] : []),
      "Text:",
      entry.text
    );
  }
  lines.push("", "Name the question, summarize it and give each entry's answer. Answer with the JSON object only.");
  return lines.join("\n");
}

/** The numbers of a text ("1–2 days" → 1, 2; "$5/mo" → 5; "4.3" → 4.3). */
function numbersOf(text: string): Set<string> {
  return new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []);
}

/** Numbers every member name has (the question's own: "Guideline 4.3"); any other is an entry's. */
function sharedNumbers(names: readonly string[]): Set<string> {
  const [first, ...rest] = names.map(numbersOf);
  return new Set([...(first ?? [])].filter((n) => rest.every((set) => set.has(n))));
}

/**
 * `null` when `value` is a valid answer for a task over these entries about a family with these
 * member names, else why not (the worker answers again).
 */
export function validateFamilySummaryAnswer(value: unknown, entryIds: readonly string[], names: readonly string[] = []): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 'The answer must be a JSON object {"name": …, "text": …, "positions": […]}.';
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "name" && key !== "text" && key !== "positions");
  if (extra.length > 0) return `The answer has keys it must not have (${extra.slice(0, 3).join(", ")}): only "name", "text" and "positions".`;
  const allowed = sharedNumbers(names);
  if (typeof record.name !== "string" || record.name.trim() === "") return `"name" must be the question, ${FAMILY_NAME_MIN_WORDS} to ${FAMILY_NAME_MAX_WORDS} words.`;
  const name = oneLine(record.name);
  const words = name.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (words < FAMILY_NAME_MIN_WORDS || words > FAMILY_NAME_MAX_WORDS || name.length > FAMILY_NAME_MAX) return `"name" must be ${FAMILY_NAME_MIN_WORDS} to ${FAMILY_NAME_MAX_WORDS} words (at most ${FAMILY_NAME_MAX} characters); it has ${words}.`;
  const nameNumbers = [...numbersOf(name)].filter((n) => !allowed.has(n));
  if (nameNumbers.length > 0) return `"name" must not carry an entry's numbers (${nameNumbers.slice(0, 3).join(", ")}): it is the question, not an answer.`;
  if (typeof record.text !== "string" || record.text.trim() === "") return '"text" must be one or two sentences.';
  const text = record.text.trim();
  if (text.length > CONCEPT_SUMMARY_TEXT_MAX) return `"text" must be at most ${CONCEPT_SUMMARY_TEXT_MAX} characters.`;
  const foreign = [...numbersOf(text)].filter((n) => !allowed.has(n));
  if (foreign.length > 0) return `"text" must not carry an entry's numbers (${foreign.slice(0, 3).join(", ")}): put them in that entry's position.`;
  if (!Array.isArray(record.positions)) return '"positions" must be an array (empty when no entry answers the question).';
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
export function parseFamilySummaryAnswer(
  text: string,
  entryIds: readonly string[],
  names: readonly string[] = []
): { name: string; text: string; positions: { entryId: string; claim: string }[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (validateFamilySummaryAnswer(value, entryIds, names) !== null) return null;
  const record = value as { name: string; text: string; positions: { entryId: string; claim: string }[] };
  return { name: oneLine(record.name).replace(/[.]+$/, ""), text: oneLine(record.text), positions: record.positions.map((p) => ({ entryId: p.entryId, claim: oneLine(p.claim) })) };
}

/** The hash of a family's member concepts and entries. */
export function familyMembersHash(concepts: readonly string[], members: readonly { id: string; contentHash: string }[]): string {
  return createHash("sha256")
    .update(`${[...concepts].sort().join("\n")}\u0001${conceptMembersHash(members)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** What a family-summary task carries back with its answer. */
interface FamilyPayload {
  familyId: string;
  concepts: string[];
  hash: string;
  members: { id: string; contentHash: string }[];
  inputs: string[];
  attributed: string[];
  /** The members' names (numbers all of them have may appear in the name and text). */
  names: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readPayload(value: unknown): FamilyPayload | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.familyId !== "string" || typeof v.hash !== "string" || !Array.isArray(v.members)) return null;
  const members = v.members.filter(
    (m): m is { id: string; contentHash: string } => m !== null && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && typeof (m as { contentHash?: unknown }).contentHash === "string"
  );
  const inputs = strings(v.inputs);
  const concepts = strings(v.concepts);
  if (members.length === 0 || inputs.length === 0 || concepts.length < 2) return null;
  return {
    familyId: v.familyId,
    concepts,
    hash: v.hash,
    members: members.map(({ id, contentHash }) => ({ id, contentHash })),
    inputs,
    attributed: strings(v.attributed).filter((id) => inputs.includes(id)),
    names: strings(v.names)
  };
}

/** What a caller of {@link KnowledgeConceptFamilySummaries.familyFor} can see. */
export interface FamilyCaller {
  /** A concept as the caller sees it (the graph's id); null when it cannot. */
  concept(conceptId: string): KnowledgeConceptRef | null;
  /** An entry's metadata when it exists and the caller can see it, else null. */
  visible(entryId: string): KnowledgeEntryMeta | null;
  /** The entries behind a concept the caller can see. */
  behind(conceptId: string): readonly string[];
}

/** What concept details read (optional: absent, no concept has a family). */
export interface KnowledgeConceptFamilySummariesPort {
  /** The family of a concept (the graph's id after the overlay) as one caller may read it, or null. */
  familyFor(conceptId: string, caller: FamilyCaller): KnowledgeConceptFamily | null;
}

export interface KnowledgeConceptFamilySummariesOptions {
  /** `knowledgeConceptFamiliesPath(appdir)`. */
  path: string;
  /** The live families (`KnowledgeConceptFamilies`). */
  families: { families(): readonly ConceptFamily[]; family(conceptId: string): ConceptFamily | null };
  /** The graph's concepts after the merge overlay (`KnowledgeGraph.currentConcepts`). */
  concepts(): readonly GraphConcept[];
  /** An entry's metadata (every entry, unscoped); null when gone. */
  meta(entryId: string): KnowledgeEntryMeta | null;
  /** An entry's body; null when gone. */
  body(entryId: string): Promise<string | null>;
  /** Entries attributed to concepts through their authors (`concept-attribution.ts`; read once per round). */
  attributed?(): ReadonlyMap<string, readonly ConceptAttribution[]>;
  /** Called when the families may have changed: new work. */
  onFamiliesChange?(listener: () => void): () => void;
  limit?: number;
  now?: () => Date;
  logger?: KnowledgeLogger;
}

/** A family due for a name and summary. */
interface Due {
  family: ConceptFamily;
  concepts: GraphConcept[];
  members: { id: string; contentHash: string }[];
  /** Entries attributed to a member, behind none of them. */
  attributed: string[];
  /** Of those, the members (names) each is attributed to. */
  attributedTo: Map<string, string[]>;
  /** Entries a position may come from (the members' and the attributed ones). */
  sources: number;
  hash: string;
}

/** The family names and summaries: the port concept details read and the round task source (see the module header). */
export class KnowledgeConceptFamilySummaries implements KnowledgeConceptFamilySummariesPort, KnowledgeRoundTaskSource {
  readonly step = FAMILY_SUMMARY_STEP;
  private file: KnowledgeConceptFamiliesFile = emptyKnowledgeConceptFamiliesFile();
  private byFamily = new Map<string, KnowledgeConceptFamilyRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();
  private readonly logger: KnowledgeLogger;

  constructor(private readonly options: KnowledgeConceptFamilySummariesOptions) {
    this.logger = options.logger ?? console;
  }

  /** Reads the file; one that does not parse is moved aside and the records start empty. Never rejects. */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch {
      text = null;
    }
    let file = emptyKnowledgeConceptFamiliesFile();
    if (text !== null) {
      try {
        file = readKnowledgeConceptFamiliesFile(JSON.parse(text));
      } catch {
        const aside = `${this.options.path}.unreadable-${this.now().getTime()}`;
        await rename(this.options.path, aside).catch(() => undefined);
        this.logger.warn(`knowledge: concept-families.json did not read; moved to ${aside}`);
      }
    }
    this.setFile(file);
  }

  /** Called after a family was named. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onWork(listener: () => void): () => void {
    return this.options.onFamiliesChange?.(listener) ?? (() => {});
  }

  familyFor(conceptId: string, caller: FamilyCaller): KnowledgeConceptFamily | null {
    const family = this.options.families.family(conceptId);
    if (!family) return null;
    const refs: KnowledgeConceptRef[] = [];
    for (const id of family.concepts) {
      const ref = caller.concept(id);
      if (ref) refs.push(ref);
    }
    if (refs.length < 2 || !family.concepts.includes(conceptId)) return null;
    const record = this.byFamily.get(family.id);
    // Written for these members, from every one of these entries: anyone else reads none of it.
    const servable =
      record !== undefined &&
      record.concepts.length === family.concepts.length &&
      record.concepts.every((id) => family.concepts.includes(id)) &&
      record.members.every((member) => caller.visible(member.id) !== null);
    if (!record || !servable) return { id: family.id, name: FAMILY_FALLBACK_NAME, concepts: refs };
    const hashes = new Map(record.members.map((member) => [member.id, member.contentHash]));
    const sources = new Set(record.attributed ?? []);
    for (const ref of refs) for (const id of caller.behind(ref.id)) sources.add(id);
    const positions: KnowledgeConceptSummary["positions"] = [];
    for (const position of record.positions) {
      const meta = caller.visible(position.entryId);
      if (!meta || !sources.has(position.entryId) || meta.contentHash !== hashes.get(position.entryId)) continue;
      positions.push({ entryId: meta.id, title: meta.title, author: meta.author ?? (meta.handle ? `@${meta.handle}` : null), claim: position.claim });
    }
    const summary = record.positions.length > 0 && positions.length === 0 ? null : { text: record.text, positions };
    return { id: family.id, name: record.name, concepts: refs, ...(summary ? { summary } : {}) };
  }

  /** Families due for a name now, most first (tests, the live evaluation). */
  due(): { familyId: string; concepts: string[]; entries: number }[] {
    return this.dueFamilies().map((due) => ({ familyId: due.family.id, concepts: due.family.concepts, entries: due.sources }));
  }

  async tasks(options: KnowledgeRoundTaskOptions = {}): Promise<KnowledgeRoundTask[]> {
    if (this.file.readOnly) return [];
    const limit = this.options.limit ?? FAMILY_SUMMARY_MAX_PER_ROUND;
    const tasks: KnowledgeRoundTask[] = [];
    for (const due of this.dueFamilies()) {
      if (tasks.length >= limit) break;
      const task = await this.task(due);
      // Rounds gave up on it as it is: its next item takes its place (a changed family is a new item).
      if (task && !options.skip?.(task)) tasks.push(task);
    }
    return tasks;
  }

  validate(value: unknown, payload: unknown): string | null {
    const task = readPayload(payload);
    return validateFamilySummaryAnswer(value, task?.inputs ?? [], task?.names ?? []);
  }

  async record(payload: unknown, answer: string): Promise<void> {
    const task = readPayload(payload);
    const parsed = task ? parseFamilySummaryAnswer(answer, task.inputs, task.names) : null;
    if (!task || !parsed) return;
    const run = this.chain.then(async () => {
      if (this.file.readOnly) return;
      const record: KnowledgeConceptFamilyRecord = {
        familyId: task.familyId,
        concepts: task.concepts,
        hash: task.hash,
        members: task.members,
        inputs: task.inputs,
        ...(task.attributed.length > 0 ? { attributed: task.attributed } : {}),
        name: parsed.name,
        text: parsed.text,
        positions: parsed.positions,
        writtenAt: this.now().toISOString()
      };
      // The family's earlier record, and those of families it took members from, are outdated.
      const members = new Set(record.concepts);
      const kept = this.file.families.filter((r) => r.familyId !== record.familyId && !r.concepts.some((id) => members.has(id)));
      const next: KnowledgeConceptFamiliesFile = { ...this.file, families: [...kept, record] };
      await writeFileAtomic(this.options.path, serializeKnowledgeConceptFamiliesFile(next));
      this.setFile(next);
    });
    this.chain = run.catch(() => undefined);
    await run.catch((error: unknown) => this.logger.warn(`knowledge: a family summary could not be saved (${String(error)})`));
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`knowledge: a family summaries listener failed (${String(error)})`);
      }
    }
  }

  private setFile(file: KnowledgeConceptFamiliesFile): void {
    this.file = file;
    this.byFamily = new Map(file.families.map((record) => [record.familyId, record]));
  }

  /** Families whose record is missing or was written for other members or entries, most source entries first. */
  private dueFamilies(): Due[] {
    const byId = new Map(this.options.concepts().map((concept) => [concept.id, concept]));
    const attributions = this.options.attributed?.() ?? new Map<string, readonly ConceptAttribution[]>();
    const meta = (id: string) => this.options.meta(id);
    const out: Due[] = [];
    for (const family of this.options.families.families()) {
      const concepts = family.concepts.map((id) => byId.get(id)).filter((concept): concept is GraphConcept => concept !== undefined);
      if (concepts.length < 2) continue;
      const own = new Set(concepts.flatMap((concept) => concept.entryIds));
      const members = new Map<string, string>();
      const attributedTo = new Map<string, string[]>();
      for (const concept of concepts) {
        const found = attributedMembers(concept.entryIds, attributions.get(concept.id) ?? [], meta);
        for (const member of found.members) members.set(member.id, member.contentHash);
        for (const id of found.attributed) if (!own.has(id)) attributedTo.set(id, [...(attributedTo.get(id) ?? []), concept.name]);
      }
      const sources = [...own].filter((id) => members.has(id)).length + attributedTo.size;
      if (sources < 2) continue;
      const list = [...members].map(([id, contentHash]) => ({ id, contentHash }));
      const hash = familyMembersHash(family.concepts, list);
      if (this.byFamily.get(family.id)?.hash === hash) continue;
      out.push({ family, concepts, members: list, attributed: [...attributedTo.keys()].sort(), attributedTo, sources, hash });
    }
    return out.sort((x, y) => y.sources - x.sources || (x.family.id < y.family.id ? -1 : 1));
  }

  /** The task for a family due; null when too few of its entries can be read. */
  private async task(due: Due): Promise<KnowledgeRoundTask | null> {
    const { attributedTo } = due;
    type Read = { meta: KnowledgeEntryMeta; body: string; backs: GraphConcept[]; score: number; survey: boolean; note: boolean; attributed: boolean };
    const read: Read[] = [];
    for (const id of new Set([...due.concepts.flatMap((concept) => concept.entryIds), ...due.attributed])) {
      const meta = this.options.meta(id);
      const body = meta ? await this.options.body(id).catch(() => null) : null;
      if (!meta || body === null) continue;
      const backs = due.concepts.filter((concept) => concept.entryIds.includes(id));
      const score = Math.max(0, ...backs.map((concept) => conceptExcerpt(body, concept).score));
      read.push({ meta, body, backs, score, survey: isSurveyEntry(meta), note: SECONDARY_KINDS.test(meta.kind), attributed: due.attributed.includes(id) });
    }
    if (read.length < 2) return null;
    const order = (x: Read, y: Read): number =>
      Number(x.survey) - Number(y.survey) ||
      Number(y.attributed) - Number(x.attributed) ||
      y.score - x.score ||
      Number(x.note) - Number(y.note) ||
      (y.meta.postedAt ?? y.meta.savedAt).localeCompare(x.meta.postedAt ?? x.meta.savedAt) ||
      (x.meta.id < y.meta.id ? -1 : 1);
    read.sort(order);
    // Every member's answer first: its best entry, in the family's order; then the rest in order.
    const shown: Read[] = [];
    for (const concept of due.concepts) {
      const best = read.find((item) => item.backs.includes(concept) && !shown.includes(item));
      if (best && shown.length < FAMILY_SUMMARY_MAX_ENTRIES) shown.push(best);
    }
    for (const item of read) if (shown.length < FAMILY_SUMMARY_MAX_ENTRIES && !shown.includes(item)) shown.push(item);
    shown.sort(order);
    const names = due.concepts.map((concept) => concept.name);
    const query = { text: names.join("\n"), concepts: names.map((name) => ({ name, weight: 2 })), focus: names };
    const entries: FamilySummaryEntry[] = shown.map(({ meta, body, backs, attributed }) => ({
      id: meta.id,
      title: meta.title,
      author: meta.author,
      handle: meta.handle,
      kind: meta.kind,
      backs: attributed ? (attributedTo.get(meta.id) ?? []) : backs.map((concept) => concept.name),
      ...(attributed ? { attributed: true } : {}),
      text: relevantExcerpt(body, query, FAMILY_SUMMARY_ENTRY_CHARS).text
    }));
    const user = familySummaryInput({ type: due.family.type, concepts: names }, entries);
    const payload: FamilyPayload = {
      familyId: due.family.id,
      concepts: [...due.family.concepts],
      hash: due.hash,
      members: due.members,
      inputs: entries.map((entry) => entry.id),
      attributed: entries.filter((entry) => entry.attributed).map((entry) => entry.id),
      names
    };
    return { label: `${FAMILY_SUMMARY_STEP} ${due.family.id}`, system: FAMILY_SUMMARY_SYSTEM, user, payload };
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
