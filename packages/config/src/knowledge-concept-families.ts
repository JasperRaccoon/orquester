// concept-families.json — the names and neutral summaries an LLM wrote of concept families
// (Knowledge Graph plugin, quality round 5: `apps/daemon/src/knowledge/search/concept-family-summaries.ts`).
// One record per family (`familyId`): its member concepts (`concepts`, the graph's ids after the
// merge overlay), every entry the family's text was written from with its content hash (`members`;
// `hash` = a hash of the concepts and members, so a family is named again only when it or its
// entries change), the entries the writer was shown (`inputs`), those of them linked through an
// author rather than the graph (`attributed`), the question it answers (`name`), the neutral text
// and each entry's own position.
//
// This module imports only zod: the path helper (`knowledgeConceptFamiliesPath`) lives in index.ts,
// which re-exports this file.
//
// Tolerance (AGENTS.md), as `concept-summaries.json`: records are `passthrough`; a record this build
// cannot read is kept verbatim and written back; unknown top-level keys too. A file of a newer
// version is read for what this build knows and never written. Anything that is not an object
// reads as empty.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

export const KNOWLEDGE_CONCEPT_FAMILIES_VERSION = 1;

export const knowledgeConceptFamilyRecordSchema = z
  .object({
    familyId: z.string().min(1),
    /** The member concepts when it was written (the graph's ids after the merge overlay). */
    concepts: z.array(z.string().min(1)).min(2),
    /** A hash of `concepts` and `members`. */
    hash: z.string().min(1),
    /** Every entry the text was written from (the members' entries, those attributed to them and the entries attributing them), with its content hash. */
    members: z.array(z.object({ id: z.string().min(1), contentHash: z.string() }).passthrough()).min(1),
    /** The entries the writer was shown (a subset of `members`). */
    inputs: z.array(z.string().min(1)),
    /** Of `inputs`, those an author's link put there rather than the graph (absent: none). */
    attributed: z.array(z.string().min(1)).optional(),
    /** The question the members answer. */
    name: z.string().min(1),
    text: z.string().min(1),
    positions: z.array(z.object({ entryId: z.string().min(1), claim: z.string().min(1) }).passthrough()),
    writtenAt: z.string().catch("")
  })
  .passthrough();
export type KnowledgeConceptFamilyRecord = z.infer<typeof knowledgeConceptFamilyRecordSchema>;

export interface KnowledgeConceptFamiliesFile {
  version: number;
  families: KnowledgeConceptFamilyRecord[];
  /** Records this build could not read, written back as they were. */
  unreadable: unknown[];
  /** Unknown top-level keys, written back as they were. */
  extra: Record<string, unknown>;
  /** A newer build's file: read, never written. */
  readOnly: boolean;
}

export function emptyKnowledgeConceptFamiliesFile(): KnowledgeConceptFamiliesFile {
  return { version: KNOWLEDGE_CONCEPT_FAMILIES_VERSION, families: [], unreadable: [], extra: {}, readOnly: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a `concept-families.json` value; anything that is not an object reads as an empty file. A family's first readable record wins. */
export function readKnowledgeConceptFamiliesFile(value: unknown): KnowledgeConceptFamiliesFile {
  if (!isPlainObject(value)) return emptyKnowledgeConceptFamiliesFile();
  const version = Number.isInteger(value.version) ? (value.version as number) : KNOWLEDGE_CONCEPT_FAMILIES_VERSION;
  const families: KnowledgeConceptFamilyRecord[] = [];
  const unreadable: unknown[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(value.families) ? value.families : []) {
    const parsed = knowledgeConceptFamilyRecordSchema.safeParse(item);
    if (parsed.success && !ids.has(parsed.data.familyId)) {
      ids.add(parsed.data.familyId);
      families.push(parsed.data);
    } else {
      unreadable.push(item);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "version" && key !== "families"));
  return {
    version: Math.max(version, KNOWLEDGE_CONCEPT_FAMILIES_VERSION),
    families,
    unreadable,
    extra,
    readOnly: version > KNOWLEDGE_CONCEPT_FAMILIES_VERSION
  };
}

export function serializeKnowledgeConceptFamiliesFile(file: KnowledgeConceptFamiliesFile): string {
  return `${JSON.stringify({ version: file.version, families: [...file.families, ...file.unreadable], ...file.extra }, null, 2)}\n`;
}
