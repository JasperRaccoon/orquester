// cluster-labels.json — topic names an LLM gave the similarity graph's clusters (Knowledge Graph
// plugin, phase 2 quality: `apps/daemon/src/knowledge/search/cluster-labels.ts`). One record per
// cluster asked about: the member set it was named from (`members`, sorted entry ids; `key` = a hash
// of them) and the label. A record is reused for a cluster whose members are mostly the same, so a
// label stays put as entries are added.
//
// This module imports only zod: the path helper (`knowledgeClusterLabelsPath`) lives in index.ts,
// which re-exports this file.
//
// Tolerance (AGENTS.md), as `pair-checks.json`: records are `passthrough`; a record this build cannot
// read is kept verbatim and written back; unknown top-level keys too. A file of a newer version is
// read for what this build knows and never written. Anything that is not an object reads as empty.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

export const KNOWLEDGE_CLUSTER_LABELS_VERSION = 1;

export const knowledgeClusterLabelRecordSchema = z
  .object({
    /** A hash of the sorted member ids (`members`). */
    key: z.string().min(1),
    /** Entry ids the cluster had when it was named, sorted. */
    members: z.array(z.string().min(1)).min(1),
    label: z.string().min(1),
    labeledAt: z.string().catch("")
  })
  .passthrough();
export type KnowledgeClusterLabelRecord = z.infer<typeof knowledgeClusterLabelRecordSchema>;

export interface KnowledgeClusterLabelsFile {
  version: number;
  labels: KnowledgeClusterLabelRecord[];
  /** Records this build could not read, written back as they were. */
  unreadable: unknown[];
  /** Unknown top-level keys, written back as they were. */
  extra: Record<string, unknown>;
  /** A newer build's file: read, never written. */
  readOnly: boolean;
}

export function emptyKnowledgeClusterLabelsFile(): KnowledgeClusterLabelsFile {
  return { version: KNOWLEDGE_CLUSTER_LABELS_VERSION, labels: [], unreadable: [], extra: {}, readOnly: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a `cluster-labels.json` value; anything that is not an object reads as an empty file. */
export function readKnowledgeClusterLabelsFile(value: unknown): KnowledgeClusterLabelsFile {
  if (!isPlainObject(value)) return emptyKnowledgeClusterLabelsFile();
  const version = Number.isInteger(value.version) ? (value.version as number) : KNOWLEDGE_CLUSTER_LABELS_VERSION;
  const labels: KnowledgeClusterLabelRecord[] = [];
  const unreadable: unknown[] = [];
  const keys = new Set<string>();
  for (const item of Array.isArray(value.labels) ? value.labels : []) {
    const parsed = knowledgeClusterLabelRecordSchema.safeParse(item);
    if (parsed.success && !keys.has(parsed.data.key)) {
      keys.add(parsed.data.key);
      labels.push(parsed.data);
    } else {
      unreadable.push(item);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "version" && key !== "labels"));
  return {
    version: Math.max(version, KNOWLEDGE_CLUSTER_LABELS_VERSION),
    labels,
    unreadable,
    extra,
    readOnly: version > KNOWLEDGE_CLUSTER_LABELS_VERSION
  };
}

export function serializeKnowledgeClusterLabelsFile(file: KnowledgeClusterLabelsFile): string {
  return `${JSON.stringify({ version: file.version, labels: [...file.labels, ...file.unreadable], ...file.extra }, null, 2)}\n`;
}
