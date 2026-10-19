// repo-identities.json — a user-chosen label and icon per git repository (`RepoIdentity` in
// @orquester/api `repo-identities.ts`, spec 2026-10-18 §2), owned by the daemon so every client
// shares one identity per repo. Image icons are files in `repoIconsDir` (index.ts), named by
// the record's `file`.
//
// This module imports only zod: the path helpers live in index.ts, which re-exports this file.
//
// Tolerance (AGENTS.md), the `parseSavedPromptsConfig` pattern: every object is `passthrough`, so
// a field a newer build added survives this build's rewrite; a record this build cannot read (a
// hand edit, an icon kind a newer build added, a repoKey an earlier record already has) is kept
// VERBATIM in `rejected` and written back unchanged; the outer shape THROWS, so the daemon moves
// the file aside rather than writing an empty store over it.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";

/**
 * An icon file's name: a generated id plus an extension, never derived from the repo key. Strict
 * on purpose — it is joined onto the icons directory, so no separator, no dot segment, no other
 * shape is ever read or deleted.
 */
export const REPO_ICON_FILE_PATTERN = /^[a-z0-9-]+\.(png|jpg|webp|svg|ico)$/;

export function isRepoIconFileName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && REPO_ICON_FILE_PATTERN.test(value);
}

/** The stored icon content types; mirrors `REPO_ICON_STORED_TYPES` in @orquester/api. */
export const REPO_ICON_STORED_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon"
] as const;

const repoIconEmojiSchema = z.object({ kind: z.literal("emoji"), value: z.string().min(1) }).passthrough();

const repoIconImageSchema = z
  .object({
    kind: z.literal("image"),
    file: z.string().refine(isRepoIconFileName, "not a generated icon file name"),
    contentType: z.enum(REPO_ICON_STORED_CONTENT_TYPES),
    version: z.string().min(1),
    /** Absent: the user uploaded it. */
    source: z.object({ kind: z.literal("favicon"), domain: z.string().min(1) }).passthrough().optional()
  })
  .passthrough();

/**
 * One stored identity. Checks SHAPE, not the editor's limits (label length, emoji size): those
 * are enforced when an identity is written, and a read that re-applied them would hide one a
 * build with other limits stored.
 */
export const repoIdentityRecordSchema = z
  .object({
    repoKey: z.string().min(1),
    label: z.string().min(1).optional(),
    icon: z.discriminatedUnion("kind", [repoIconEmojiSchema, repoIconImageSchema]).optional(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .passthrough();

export type RepoIdentityRecord = z.infer<typeof repoIdentityRecordSchema>;
export type RepoIdentityIconRecord = NonNullable<RepoIdentityRecord["icon"]>;

/**
 * A read `repo-identities.json`: the identities, plus everything in the file this build cannot
 * use, kept VERBATIM so every rewrite puts it back unchanged.
 */
export interface RepoIdentitiesFile {
  version: 1;
  identities: RepoIdentityRecord[];
  /**
   * The `identities` entries not in `identities`, exactly as found, in file order: each one that
   * fails the record schema, and each whose repoKey an earlier record already has.
   */
  rejected: unknown[];
  /** Every top-level key but `version` and `identities`, exactly as found. */
  extra: Record<string, unknown>;
}

/** Entry-wise tolerant; the outer shape (a `version` other than 1 included) throws. */
export function parseRepoIdentitiesConfig(raw: unknown): RepoIdentitiesFile {
  const outer = z
    .object({ version: z.literal(1).default(1), identities: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success) {
    const issue = outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 repo identities file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const identities: RepoIdentityRecord[] = [];
  const rejected: unknown[] = [];
  const keys = new Set<string>();
  for (const entry of outer.data.identities) {
    const parsed = repoIdentityRecordSchema.safeParse(entry);
    if (parsed.success && !keys.has(parsed.data.repoKey)) {
      keys.add(parsed.data.repoKey);
      identities.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "version" && key !== "identities")
  );
  return { version: 1, identities, rejected, extra };
}

/**
 * The icon file a raw (possibly rejected) entry names, if it names a well-formed one: the daemon
 * keeps such files when it sweeps orphans, so a record only a newer build reads keeps its image.
 */
export function repoIconFileOfEntry(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const icon = (entry as { icon?: unknown }).icon;
  if (typeof icon !== "object" || icon === null) return null;
  const file = (icon as { file?: unknown }).file;
  return isRepoIconFileName(file) ? file : null;
}
