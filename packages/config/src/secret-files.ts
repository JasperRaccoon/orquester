// vaults.json — the Secret files plugin's vault index (spec 2026-10-19 §3): one record per vault,
// keyed by (workspace, repoKey), holding each managed file's versions (newest first), the excluded
// candidates, and per clone the version it last received or pushed. Content lives beside it as
// blobs named by their sha256 (`secretBlobsDir`, index.ts). Host-only: nothing here is sent to a
// client as-is.
//
// This module imports only zod (and this package's own helpers): the path helpers live in
// index.ts, which re-exports this file. `@orquester/config` does not depend on `@orquester/api`,
// so the repo-key and managed-path rules are MIRRORED below from `repoKeyProblem` and
// `secretFilePathProblem` there; keep them in step.
//
// Tolerance (AGENTS.md), the `parseRepoIdentitiesConfig` pattern: every object is `passthrough`, so
// a field a newer build added survives this build's rewrite; a vault this build cannot read (a
// hand edit, a newer shape, a (workspace, repoKey) an earlier record already has) is kept VERBATIM
// in `rejected` and written back unchanged; the outer shape THROWS, so the daemon moves the file
// aside rather than writing an empty store over it.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`.**

import { z } from "zod";
import { nullProtoRecord } from "./workflows.ts";

/** The index file's name inside `secretFilesDir`. */
export const SECRET_VAULT_INDEX_FILE = "vaults.json";
/** The content blobs' directory name inside `secretFilesDir`. */
export const SECRET_BLOBS_DIR_NAME = "blobs";

/** An opaque, random version id (what the wire calls `version`). */
export const SECRET_VAULT_VERSION_ID_PATTERN = /^v_[A-Za-z0-9_-]{8,64}$/;
/** A content hash, lowercase hex — also a blob's file name, so nothing else is ever joined onto the blobs dir. */
export const SECRET_BLOB_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isSecretBlobSha256(value: unknown): value is string {
  return typeof value === "string" && SECRET_BLOB_SHA256_PATTERN.test(value);
}

// Mirrors of @orquester/api (see the header).
const REPO_KEY_MAX = 512;
const SECRET_FILE_PATH_MAX = 512;

function repoKeyProblem(repoKey: string): string | null {
  if (repoKey.length === 0) return "The repo key is empty.";
  if (repoKey.length > REPO_KEY_MAX) return "The repo key is too long.";
  if (/[\s\u0000-\u001f\u007f]/.test(repoKey)) return "The repo key may not contain whitespace or control characters.";
  if (repoKey !== repoKey.toLowerCase()) return "The repo key must be lowercase.";
  if (/^[/\\]|^[a-z]:/i.test(repoKey) || repoKey.includes("\\")) return "The repo key may not be a path.";
  const segments = repoKey.split("/");
  if (segments.length < 3 || segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return "The repo key must look like host/owner/repo.";
  }
  return null;
}

function secretFilePathProblem(path: string): string | null {
  if (path.length === 0) return "The path is empty.";
  if (path.length > SECRET_FILE_PATH_MAX) return "The path is too long.";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "The path may not contain control characters.";
  if (path.includes("\\")) return "Use / to separate folders.";
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) return "The path must be relative to the project folder.";
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return "The path may not contain empty, '.' or '..' parts.";
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "Files inside .git can't be managed.";
  return null;
}

/** The same rule as `isValidName` (index.ts, which imports this module — so not imported here). */
function workspaceNameProblem(name: string): string | null {
  return name.length > 0 && !name.startsWith(".") && !name.includes("/") && !name.includes("\\")
    ? null
    : "not a workspace name";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A map keyed by stored text (project paths, file paths), built on a null prototype so a key such
 * as `__proto__` stays an own key. Any bad key or value fails the whole map.
 */
function stringMap<T extends z.ZodTypeAny>(value: T, keyProblem: (key: string) => string | null) {
  return z.unknown().transform((raw, ctx): Record<string, z.output<T>> => {
    if (!isPlainRecord(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected an object" });
      return z.NEVER;
    }
    const out = nullProtoRecord<z.output<T>>();
    for (const [key, entry] of Object.entries(raw)) {
      const problem = keyProblem(key);
      if (problem !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: problem });
        return z.NEVER;
      }
      const parsed = value.safeParse(entry);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: parsed.error.issues[0]?.message ?? "invalid" });
        return z.NEVER;
      }
      out[key] = parsed.data;
    }
    return out;
  });
}

const managedPath = z.string().superRefine((path, ctx) => {
  const problem = secretFilePathProblem(path);
  if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});
const versionId = z.string().regex(SECRET_VAULT_VERSION_ID_PATTERN, "not a vault version id");
const timestamp = z.string().datetime({ offset: true });

export const secretVaultUpdatedBySchema = z
  .object({
    kind: z.enum(["user", "agent"]),
    threadId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional()
  })
  .passthrough();

export const secretVaultFileVersionSchema = z
  .object({
    id: versionId,
    sha256: z.string().regex(SECRET_BLOB_SHA256_PATTERN, "not a sha256"),
    updatedAt: timestamp,
    updatedBy: secretVaultUpdatedBySchema
  })
  .passthrough();

/**
 * Checks SHAPE, not the service's limits (history length, file count): a read that re-applied
 * them would hide a vault a build with other limits stored.
 */
export const secretVaultFileSchema = z
  .object({
    path: managedPath,
    versions: z
      .array(secretVaultFileVersionSchema)
      .min(1)
      .refine((versions) => new Set(versions.map((v) => v.id)).size === versions.length, "repeated version id")
  })
  .passthrough();

export const secretVaultCloneSchema = z
  .object({
    baselines: stringMap(versionId, secretFilePathProblem),
    /**
     * Since when this clone is no longer listed with the vault's repo (absent: listed). Its
     * baselines are kept through a grace period, so a clone that briefly drops out of the listing
     * keeps its `deleted` files flagged instead of getting them copied back in.
     */
    unlistedAt: timestamp.optional()
  })
  .passthrough();

export const secretVaultRecordSchema = z
  .object({
    workspace: z.string().superRefine((name, ctx) => {
      const problem = workspaceNameProblem(name);
      if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    repoKey: z.string().superRefine((key, ctx) => {
      const problem = repoKeyProblem(key);
      if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    files: z
      .array(secretVaultFileSchema)
      .refine((files) => new Set(files.map((f) => f.path)).size === files.length, "repeated file path"),
    excluded: z.array(managedPath).default([]),
    /**
     * Files the vault no longer manages (unmanaged or excluded), with their version history kept
     * for manual recovery: their content stays in the blob store. Optional (older records have
     * none); a path appears at most once, and may also be managed again (a new history).
     */
    retired: z
      .array(secretVaultFileSchema)
      .refine((files) => new Set(files.map((f) => f.path)).size === files.length, "repeated retired file path")
      .optional(),
    clones: stringMap(secretVaultCloneSchema, (key) =>
      key.length === 0 || /[\u0000-\u001f\u007f]/.test(key) ? "not a project path" : null
    )
      .optional()
      .transform((clones) => clones ?? nullProtoRecord<z.output<typeof secretVaultCloneSchema>>()),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .passthrough();

export type SecretVaultUpdatedByRecord = z.infer<typeof secretVaultUpdatedBySchema>;
export type SecretVaultFileVersionRecord = z.infer<typeof secretVaultFileVersionSchema>;
export type SecretVaultFileRecordConfig = z.infer<typeof secretVaultFileSchema>;
export type SecretVaultCloneRecordConfig = z.infer<typeof secretVaultCloneSchema>;
export type SecretVaultRecordConfig = z.infer<typeof secretVaultRecordSchema>;

/** The key a vault is identified by in maps (a NUL cannot occur in either part). */
export function secretVaultKey(workspace: string, repoKey: string): string {
  return `${workspace}\u0000${repoKey}`;
}

/**
 * A read `vaults.json`: the vaults, plus everything in the file this build cannot use, kept
 * VERBATIM so every rewrite puts it back unchanged.
 */
export interface SecretVaultsFile {
  version: 1;
  vaults: SecretVaultRecordConfig[];
  /**
   * The `vaults` entries not in `vaults`, exactly as found, in file order: each one that fails the
   * record schema, and each whose (workspace, repoKey) an earlier record already has.
   */
  rejected: unknown[];
  /** Every top-level key but `version` and `vaults`, exactly as found. */
  extra: Record<string, unknown>;
}

/** Entry-wise tolerant; the outer shape (a `version` other than 1 included) throws. */
export function parseSecretVaultsConfig(raw: unknown): SecretVaultsFile {
  const outer = z
    .object({ version: z.literal(1).default(1), vaults: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success || !isPlainRecord(raw)) {
    const issue = outer.success ? undefined : outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 secret vaults file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const vaults: SecretVaultRecordConfig[] = [];
  const rejected: unknown[] = [];
  const keys = new Set<string>();
  for (const entry of outer.data.vaults) {
    const parsed = secretVaultRecordSchema.safeParse(entry);
    const key = parsed.success ? secretVaultKey(parsed.data.workspace, parsed.data.repoKey) : "";
    if (parsed.success && !keys.has(key)) {
      keys.add(key);
      vaults.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "version" && key !== "vaults"));
  return { version: 1, vaults, rejected, extra };
}

/** The file as written: the vaults, then the entries this build could not read and the unknown keys, verbatim. */
export function serializeSecretVaultsFile(file: SecretVaultsFile): Record<string, unknown> {
  return { version: 1, vaults: [...file.vaults, ...file.rejected], ...file.extra };
}
