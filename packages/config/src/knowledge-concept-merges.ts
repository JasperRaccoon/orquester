// concept-merges.json — the Knowledge Graph plugin's automatic concept merges (phase 2 spec
// docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md, "Concept merges"):
// a daemon-side overlay re-applied over myKG's graph at every load, since myKG rewrites its own
// output on every run. `merges` are the merges made (in effect while their concepts exist);
// `rejected` are merges a user undid, so the same concepts are never merged again.
//
// This module imports only zod: the path helper (`knowledgeConceptMergesPath`) lives in index.ts,
// which re-exports this file.
//
// Tolerance (AGENTS.md), the `parseKnowledgeCollectionsConfig` pattern: every record is
// `passthrough`, so a field a newer build added survives this build's rewrite; a record this build
// cannot read is kept VERBATIM and written back unchanged; unknown top-level keys are kept. The
// outer shape (not an object, or a `version` other than 1) THROWS: the daemon then leaves the file
// alone and makes no merges (a newer build's file is not this build's to rewrite).
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

export const KNOWLEDGE_CONCEPT_MERGES_VERSION = 1;

/** One merge: `merged` concepts folded into `into` (all of concept type `type`). */
export const knowledgeConceptMergeRecordSchema = z
  .object({
    /** Stable id (`cm_…`), the undo handle. */
    id: z.string().min(1),
    type: z.string().min(1),
    /** The concept kept (a myKG node id). */
    into: z.string().min(1),
    /** The concepts folded into it (myKG node ids), at least one. */
    merged: z.array(z.string().min(1)).min(1),
    /** Lowest similarity among the concept pairs that justified it. */
    similarity: z.number().catch(0),
    createdAt: z.string().catch("")
  })
  .passthrough();
export type KnowledgeConceptMergeRecord = z.infer<typeof knowledgeConceptMergeRecordSchema>;

/** An undone merge: no two of `concepts` are ever merged automatically again. */
export const knowledgeConceptMergeRejectionSchema = z
  .object({
    /** The undone merge's id. */
    id: z.string().min(1),
    type: z.string().min(1),
    /** Every concept of the undone merge (its `into` first). */
    concepts: z.array(z.string().min(1)).min(2),
    rejectedAt: z.string().catch("")
  })
  .passthrough();
export type KnowledgeConceptMergeRejection = z.infer<typeof knowledgeConceptMergeRejectionSchema>;

export interface KnowledgeConceptMergesFile {
  version: 1;
  merges: KnowledgeConceptMergeRecord[];
  rejected: KnowledgeConceptMergeRejection[];
  /** `merges` / `rejected` list items this build could not read, exactly as found, in file order. */
  unreadable: { merges: unknown[]; rejected: unknown[] };
  /** Every top-level key but `version`, `merges` and `rejected`, exactly as found. */
  extra: Record<string, unknown>;
}

export function emptyKnowledgeConceptMergesFile(): KnowledgeConceptMergesFile {
  return { version: 1, merges: [], rejected: [], unreadable: { merges: [], rejected: [] }, extra: {} };
}

/** Record-wise tolerant; the outer shape (a `version` other than 1 included) throws. */
export function parseKnowledgeConceptMergesFile(raw: unknown): KnowledgeConceptMergesFile {
  const outer = z
    .object({
      version: z.literal(KNOWLEDGE_CONCEPT_MERGES_VERSION),
      merges: z.array(z.unknown()).default([]),
      rejected: z.array(z.unknown()).default([])
    })
    .safeParse(raw);
  if (!outer.success || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    const issue = outer.success ? undefined : outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-${KNOWLEDGE_CONCEPT_MERGES_VERSION} knowledge concept merges file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const file = emptyKnowledgeConceptMergesFile();
  const ids = new Set<string>();
  for (const item of outer.data.merges) {
    const parsed = knowledgeConceptMergeRecordSchema.safeParse(item);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      file.merges.push(parsed.data);
    } else {
      file.unreadable.merges.push(item);
    }
  }
  for (const item of outer.data.rejected) {
    const parsed = knowledgeConceptMergeRejectionSchema.safeParse(item);
    if (parsed.success) file.rejected.push(parsed.data);
    else file.unreadable.rejected.push(item);
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  file.extra = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "version" && key !== "merges" && key !== "rejected"));
  return file;
}

/** The file as written: what this build read, then what it could not read and the unknown keys, verbatim. */
export function serializeKnowledgeConceptMergesFile(file: KnowledgeConceptMergesFile): string {
  const value = {
    version: KNOWLEDGE_CONCEPT_MERGES_VERSION,
    merges: [...file.merges, ...file.unreadable.merges],
    rejected: [...file.rejected, ...file.unreadable.rejected],
    ...file.extra
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}
