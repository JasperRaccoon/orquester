// concept-summaries.json — neutral summaries an LLM wrote of concepts with several entries
// (Knowledge Graph plugin, quality round 4: `apps/daemon/src/knowledge/search/concept-summaries.ts`).
// One record per concept (`conceptId`, the graph's id after the merge overlay): every entry behind
// it when it was written, with their content hashes (`members`; `hash` = a hash of them, so a
// summary is written again only when its entries change), the entries the writer was shown
// (`inputs`), the neutral text and each entry's own position.
//
// This module imports only zod: the path helper (`knowledgeConceptSummariesPath`) lives in index.ts,
// which re-exports this file.
//
// Tolerance (AGENTS.md), as `cluster-labels.json`: records are `passthrough`; a record this build
// cannot read is kept verbatim and written back; unknown top-level keys too. A file of a newer
// version is read for what this build knows and never written. Anything that is not an object
// reads as empty.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

export const KNOWLEDGE_CONCEPT_SUMMARIES_VERSION = 1;

export const knowledgeConceptSummaryRecordSchema = z
  .object({
    /** The concept (the graph's id after the merge overlay: a merge's kept concept). */
    conceptId: z.string().min(1),
    /** A hash of `members` (ids and content hashes). */
    hash: z.string().min(1),
    /** Every entry behind the concept when the summary was written, with its content hash. */
    members: z.array(z.object({ id: z.string().min(1), contentHash: z.string() }).passthrough()).min(1),
    /** The entries the writer was shown (a subset of `members`). */
    inputs: z.array(z.string().min(1)),
    text: z.string().min(1),
    positions: z.array(z.object({ entryId: z.string().min(1), claim: z.string().min(1) }).passthrough()),
    writtenAt: z.string().catch("")
  })
  .passthrough();
export type KnowledgeConceptSummaryRecord = z.infer<typeof knowledgeConceptSummaryRecordSchema>;

export interface KnowledgeConceptSummariesFile {
  version: number;
  summaries: KnowledgeConceptSummaryRecord[];
  /** Records this build could not read, written back as they were. */
  unreadable: unknown[];
  /** Unknown top-level keys, written back as they were. */
  extra: Record<string, unknown>;
  /** A newer build's file: read, never written. */
  readOnly: boolean;
}

export function emptyKnowledgeConceptSummariesFile(): KnowledgeConceptSummariesFile {
  return { version: KNOWLEDGE_CONCEPT_SUMMARIES_VERSION, summaries: [], unreadable: [], extra: {}, readOnly: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a `concept-summaries.json` value; anything that is not an object reads as an empty file. A concept's first readable record wins. */
export function readKnowledgeConceptSummariesFile(value: unknown): KnowledgeConceptSummariesFile {
  if (!isPlainObject(value)) return emptyKnowledgeConceptSummariesFile();
  const version = Number.isInteger(value.version) ? (value.version as number) : KNOWLEDGE_CONCEPT_SUMMARIES_VERSION;
  const summaries: KnowledgeConceptSummaryRecord[] = [];
  const unreadable: unknown[] = [];
  const concepts = new Set<string>();
  for (const item of Array.isArray(value.summaries) ? value.summaries : []) {
    const parsed = knowledgeConceptSummaryRecordSchema.safeParse(item);
    if (parsed.success && !concepts.has(parsed.data.conceptId)) {
      concepts.add(parsed.data.conceptId);
      summaries.push(parsed.data);
    } else {
      unreadable.push(item);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "version" && key !== "summaries"));
  return {
    version: Math.max(version, KNOWLEDGE_CONCEPT_SUMMARIES_VERSION),
    summaries,
    unreadable,
    extra,
    readOnly: version > KNOWLEDGE_CONCEPT_SUMMARIES_VERSION
  };
}

export function serializeKnowledgeConceptSummariesFile(file: KnowledgeConceptSummariesFile): string {
  return `${JSON.stringify({ version: file.version, summaries: [...file.summaries, ...file.unreadable], ...file.extra }, null, 2)}\n`;
}
