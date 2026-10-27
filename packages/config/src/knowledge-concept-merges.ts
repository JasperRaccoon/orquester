// concept-merges.json — the Knowledge Graph plugin's automatic concept merges (phase 2 spec
// docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md, "Concept merges"):
// a daemon-side overlay re-applied over myKG's graph at every load, since myKG rewrites its own
// output on every run. `merges` are the merges made (in effect while their concepts exist);
// `rejected` are merges a user undid, so the same concepts are never merged again; `checks` are
// the LLM's answers on pairs the name guards refused (a merge with `source: "checked"` when they
// are the same, remembered either way so the same names are never asked again).
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
    createdAt: z.string().catch(""),
    /**
     * Why it was made: absent = the automatic rule; "checked" = an LLM check confirmed a pair the
     * name guards refused. Any other text (a newer build's) reads as it is.
     */
    source: z.string().optional().catch(undefined)
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

/**
 * An LLM check of two same-type concepts the name guards kept apart: asked once per pair of names
 * (`nameA`, `nameB` as asked; a renamed concept is asked again). `a` < `b`.
 */
export const knowledgeConceptMergeCheckSchema = z
  .object({
    a: z.string().min(1),
    b: z.string().min(1),
    type: z.string().min(1),
    nameA: z.string(),
    nameB: z.string(),
    same: z.boolean(),
    /** The concept the checker would keep (`a` or `b`'s id), when `same`. */
    keep: z.string().nullable().catch(null),
    reason: z.string().catch(""),
    similarity: z.number().catch(0),
    checkedAt: z.string().catch(""),
    /** The version of the input it was asked on (the daemon's `CONCEPT_CHECK_INPUT_VERSION`); absent: 1. */
    inputVersion: z.number().int().min(1).optional().catch(undefined)
  })
  .passthrough();
export type KnowledgeConceptMergeCheck = z.infer<typeof knowledgeConceptMergeCheckSchema>;

export interface KnowledgeConceptMergesFile {
  version: 1;
  merges: KnowledgeConceptMergeRecord[];
  rejected: KnowledgeConceptMergeRejection[];
  checks: KnowledgeConceptMergeCheck[];
  /** `merges` / `rejected` / `checks` list items this build could not read, exactly as found, in file order. */
  unreadable: { merges: unknown[]; rejected: unknown[]; checks: unknown[] };
  /** Every top-level key but `version`, `merges`, `rejected` and `checks`, exactly as found. */
  extra: Record<string, unknown>;
}

export function emptyKnowledgeConceptMergesFile(): KnowledgeConceptMergesFile {
  return { version: 1, merges: [], rejected: [], checks: [], unreadable: { merges: [], rejected: [], checks: [] }, extra: {} };
}

/** Record-wise tolerant; the outer shape (a `version` other than 1 included) throws. */
export function parseKnowledgeConceptMergesFile(raw: unknown): KnowledgeConceptMergesFile {
  const outer = z
    .object({
      version: z.literal(KNOWLEDGE_CONCEPT_MERGES_VERSION),
      merges: z.array(z.unknown()).default([]),
      rejected: z.array(z.unknown()).default([]),
      // An older build of this version kept `checks` among its unknown keys: anything but a list reads as none.
      checks: z.array(z.unknown()).catch([]).default([])
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
  for (const item of outer.data.checks) {
    const parsed = knowledgeConceptMergeCheckSchema.safeParse(item);
    if (parsed.success) file.checks.push(parsed.data);
    else file.unreadable.checks.push(item);
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key. A `checks` that is
  // not a list is kept as it was (an unknown key's value).
  const checksIsList = Array.isArray((raw as Record<string, unknown>).checks);
  file.extra = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== "version" && key !== "merges" && key !== "rejected" && !(key === "checks" && checksIsList))
  );
  return file;
}

/** The file as written: what this build read, then what it could not read and the unknown keys, verbatim. */
export function serializeKnowledgeConceptMergesFile(file: KnowledgeConceptMergesFile): string {
  const value = {
    version: KNOWLEDGE_CONCEPT_MERGES_VERSION,
    merges: [...file.merges, ...file.unreadable.merges],
    rejected: [...file.rejected, ...file.unreadable.rejected],
    ...file.extra,
    // Written only once there are some (a file without checks reads exactly as before).
    ...(file.checks.length + file.unreadable.checks.length > 0 ? { checks: [...file.checks, ...file.unreadable.checks] } : {})
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}
