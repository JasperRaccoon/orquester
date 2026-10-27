// The Knowledge Graph plugin's persisted records (spec
// docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md, "Storage"):
//
// - `collections.json` — `{ version: 1, collections: [...] }`, a tolerant store;
// - `entries/<entryId>.md` — one file per entry, its YAML frontmatter validated by
//   `knowledgeEntryFrontmatterSchema` (the daemon parses the YAML; this package has no YAML dep).
//
// This module imports only zod. `@orquester/config` does not depend on `@orquester/api`, so the
// id formats and the colour palette are MIRRORED from `packages/api/src/knowledge.ts`; keep them in
// step.
//
// Tolerance (AGENTS.md), the `parseSecretVaultsConfig` pattern: every object is `passthrough`, so a
// field a newer build added survives this build's rewrite; a collection this build cannot read (a
// hand edit, a newer shape, a repeated id) is kept VERBATIM in `rejected` and written back
// unchanged; the outer shape THROWS, so the daemon moves the file aside rather than writing an
// empty store over it. A bare array (the spec's first sketch of the file) is read as version 1.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

/**
 * `ke_` + 12 lowercase characters (mirrors the contract and `parseKnowledgeCitationHref`). The
 * daemon mints base32 (`a-z2-7`); any lowercase alphanumeric is read. Also the entry's file stem.
 */
export const KNOWLEDGE_ENTRY_ID_PATTERN = /^ke_[a-z0-9]{12}$/;
/** `kc_` + 10 lowercase characters (minted as base32, read as any lowercase alphanumeric). */
export const KNOWLEDGE_COLLECTION_ID_PATTERN = /^kc_[a-z0-9]{10}$/;
/** sha256 hex of an entry's normalized body. */
export const KNOWLEDGE_CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Mirrors `KNOWLEDGE_COLORS` in @orquester/api. */
export const KNOWLEDGE_COLOR_KEYS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"] as const;

/** Whether a stored collection colour is one of this build's palette keys. */
export function isKnowledgeColorKey(value: unknown): value is (typeof KNOWLEDGE_COLOR_KEYS)[number] {
  return typeof value === "string" && (KNOWLEDGE_COLOR_KEYS as readonly string[]).includes(value);
}

export function isKnowledgeEntryId(value: unknown): value is string {
  return typeof value === "string" && KNOWLEDGE_ENTRY_ID_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const timestamp = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// collections.json
// ---------------------------------------------------------------------------

/**
 * Checks SHAPE, not the service's limits (name length, uniqueness across records is checked by
 * the parser below): a read that re-applied this build's limits would hide a collection another
 * build stored.
 *
 * `color` is any non-empty string: a palette key this build does not know (a newer build's) is
 * kept as stored, so a rewrite does not lose it; the daemon shows it as a {@link
 * KNOWLEDGE_COLOR_KEYS} colour (`isKnowledgeColorKey`). A missing or non-string colour is no
 * palette key at all and reads as `chart-1`.
 */
export const knowledgeCollectionRecordSchema = z
  .object({
    id: z.string().regex(KNOWLEDGE_COLLECTION_ID_PATTERN, "not a collection id"),
    name: z.string().min(1),
    description: z.string().default(""),
    color: z.string().min(1).catch("chart-1"),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .passthrough();

export type KnowledgeCollectionRecordConfig = z.infer<typeof knowledgeCollectionRecordSchema>;

export interface KnowledgeCollectionsFile {
  version: 1;
  collections: KnowledgeCollectionRecordConfig[];
  /** The `collections` entries not in `collections`, exactly as found, in file order. */
  rejected: unknown[];
  /** Every top-level key but `version` and `collections`, exactly as found. */
  extra: Record<string, unknown>;
}

/** Entry-wise tolerant; the outer shape (a `version` other than 1 included) throws. */
export function parseKnowledgeCollectionsConfig(raw: unknown): KnowledgeCollectionsFile {
  const source = Array.isArray(raw) ? { version: 1, collections: raw } : raw;
  const outer = z
    .object({ version: z.literal(1).default(1), collections: z.array(z.unknown()).default([]) })
    .safeParse(source);
  if (!outer.success || !isPlainRecord(source)) {
    const issue = outer.success ? undefined : outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 knowledge collections file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const collections: KnowledgeCollectionRecordConfig[] = [];
  const rejected: unknown[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of outer.data.collections) {
    const parsed = knowledgeCollectionRecordSchema.safeParse(entry);
    const nameKey = parsed.success ? parsed.data.name.trim().toLowerCase() : "";
    if (parsed.success && !ids.has(parsed.data.id) && !names.has(nameKey)) {
      ids.add(parsed.data.id);
      names.add(nameKey);
      collections.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "version" && key !== "collections"));
  return { version: 1, collections, rejected, extra };
}

/** The file as written: the collections, then the records this build could not read and the unknown keys, verbatim. */
export function serializeKnowledgeCollectionsFile(file: KnowledgeCollectionsFile): Record<string, unknown> {
  return { version: 1, collections: [...file.collections, ...file.rejected], ...file.extra };
}

// ---------------------------------------------------------------------------
// entries/<entryId>.md frontmatter
// ---------------------------------------------------------------------------

const nullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (typeof value === "string" && value.length > 0 ? value : null));

/**
 * `savedFrom`: the object the contract describes, or a bare session id (the spec's sketch). Its
 * unknown keys pass through, and `by` is any non-empty string: a value this build does not know (a
 * newer build's) still reads — the daemon shows a fallback and writes the stored value back.
 */
const savedFromSchema = z.union([
  z.object({ by: z.string().min(1), sessionId: z.string().min(1).optional() }).passthrough(),
  z.string().min(1).transform((sessionId) => ({ by: "agent" as const, sessionId })),
  z.null().transform(() => ({ by: "user" as const }))
]);

/**
 * One entry file's frontmatter. Unknown keys pass through (the daemon keeps them on rewrite). An
 * unknown `linkState` (a newer build's) reads as `pending`, which at worst re-links the entry.
 */
export const knowledgeEntryFrontmatterSchema = z
  .object({
    id: z.string().regex(KNOWLEDGE_ENTRY_ID_PATTERN, "not an entry id"),
    title: z.string(),
    kind: z.string().min(1).catch("note"),
    author: nullableText,
    handle: nullableText,
    url: nullableText,
    postedAt: nullableText,
    savedAt: timestamp,
    updatedAt: timestamp.optional(),
    savedFrom: savedFromSchema.optional().transform((value) => value ?? { by: "user" as const }),
    collections: z.array(z.string().min(1)).default([]),
    contentHash: z.string().regex(KNOWLEDGE_CONTENT_HASH_PATTERN, "not a content hash"),
    linkState: z.enum(["pending", "linked", "failed"]).catch("pending").default("pending")
  })
  .passthrough();

export type KnowledgeEntryFrontmatterConfig = z.infer<typeof knowledgeEntryFrontmatterSchema>;

/**
 * `linkContext` (phase 2 spec, "Context version"): the linking-context version the entry was last
 * linked with. Optional, and kept with the entry's other extra keys (written back verbatim on every
 * rewrite); a file without it, or with a value that is not a non-negative integer, reads as null
 * (linked before neighbour context existed).
 */
export const KNOWLEDGE_ENTRY_LINK_CONTEXT_KEY = "linkContext";

export function readKnowledgeLinkContext(extra: Readonly<Record<string, unknown>>): number | null {
  const value = extra[KNOWLEDGE_ENTRY_LINK_CONTEXT_KEY];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The frontmatter keys this build understands (every other key is preserved verbatim). */
export const KNOWLEDGE_ENTRY_FRONTMATTER_KEYS = [
  "id",
  "title",
  "kind",
  "author",
  "handle",
  "url",
  "postedAt",
  "savedAt",
  "updatedAt",
  "savedFrom",
  "collections",
  "contentHash",
  "linkState"
] as const;
