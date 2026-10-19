/**
 * Secret files — the built-in "Secret files" plugin (spec
 * docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md).
 *
 * One **vault** per repo per workspace, identified by `(workspace, repoKey)`,
 * holds the source-of-truth copy of the repo's secret files (gitignored `.env`
 * files and any the user adds). Every clone of the repo in that workspace —
 * its non-archived projects with that `repoKey` — gets the files and is kept in
 * sync; a clone whose copy differs is flagged for Push / Reset.
 *
 * Nothing here ever carries secret CONTENT: paths, opaque version ids,
 * timestamps, states and key-name compares only. The vault lives on the daemon
 * (`<appdir>/daemon/secret-files/`).
 */

// ---------------------------------------------------------------------------
// Limits (enforced by the daemon; the UI mirrors them)
// ---------------------------------------------------------------------------

/** One secret file's content, in a clone or the vault. */
export const SECRET_FILE_MAX_BYTES = 1024 * 1024;
/** Managed files per vault. */
export const SECRET_FILES_MAX_PER_VAULT = 50;
/** A managed path, in UTF-16 units. */
export const SECRET_FILE_PATH_MAX = 512;
/** Vault versions kept per file (current + history), for manual recovery only. */
export const SECRET_FILE_HISTORY_MAX = 10;

/** Conventional secret-file names end in none of these (`.env.example` is a template, not a secret). */
export const SECRET_FILE_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"] as const;

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * One managed file in one clone (spec §4):
 * - `synced` — the clone's copy is the vault's current version.
 * - `missing` — the clone never had it; the daemon copies it in (when its parent dir exists).
 * - `missing-dir` — missing, and its parent directory doesn't exist in this clone; flagged, nothing created.
 * - `outdated` — the clone still has the vault version it last received; the daemon updates it.
 * - `modified` — the clone's copy differs from both its baseline and the vault: flagged (Push / Reset).
 * - `deleted` — the clone had it (has a baseline) and it's gone: flagged (Reset restores it).
 * - `refused` — the file can't be managed in this clone (see {@link SecretFileRefusal}).
 */
export type SecretFileState = "synced" | "missing" | "missing-dir" | "outdated" | "modified" | "deleted" | "refused";
export const SECRET_FILE_STATES: readonly SecretFileState[] = [
  "synced",
  "missing",
  "missing-dir",
  "outdated",
  "modified",
  "deleted",
  "refused"
];

/** States the user has to act on (badge, header count, project bar). */
export const SECRET_FILE_ATTENTION_STATES: readonly SecretFileState[] = ["modified", "deleted", "missing-dir", "refused"];

export function secretFileNeedsAttention(state: SecretFileState): boolean {
  return (SECRET_FILE_ATTENTION_STATES as readonly string[]).includes(state);
}

/**
 * Why a managed path can't be synced in a clone:
 * `tracked` (git tracks it there), `symlink` (the file or a parent dir is a
 * symlink), `outside` (resolves outside the clone), `not-a-file`, `too-large`
 * (over {@link SECRET_FILE_MAX_BYTES}), `unreadable`.
 */
export type SecretFileRefusal = "tracked" | "symlink" | "outside" | "not-a-file" | "too-large" | "unreadable";

// ---------------------------------------------------------------------------
// Records (wire)
// ---------------------------------------------------------------------------

export interface SecretFileUpdatedBy {
  kind: "user" | "agent";
  /** The agent chat that pushed it (`kind: "agent"`). */
  threadId?: string;
  /** The clone the content came from (its project name), when it came from a clone. */
  projectName?: string;
}

export interface SecretVaultFile {
  /** Relative to the clone root, `/`-separated (see {@link secretFilePathProblem}). */
  path: string;
  /** Opaque id of the vault's current content (never a content hash). */
  version: string;
  updatedAt: string;
  updatedBy: SecretFileUpdatedBy;
}

export interface SecretFileCloneState {
  path: string;
  state: SecretFileState;
  /** Set with `state: "refused"`. */
  refusal?: SecretFileRefusal;
}

export interface SecretFilesClone {
  /** The project directory (as `ProjectSummary.path`). */
  projectPath: string;
  projectName: string;
  files: SecretFileCloneState[];
  /** Any file in a {@link SECRET_FILE_ATTENTION_STATES} state. */
  needsAttention: boolean;
}

export interface SecretVaultSummary {
  workspace: string;
  repoKey: string;
  fileCount: number;
  /** Clones with `needsAttention`. */
  clonesNeedingAttention: number;
  /** Conventional candidates found in some clone, neither managed nor excluded. */
  newCandidates: number;
  updatedAt: string;
}

export interface SecretVaultDetail extends SecretVaultSummary {
  files: SecretVaultFile[];
  /** Candidate paths the user turned off; never suggested again. */
  excluded: string[];
  /** The new candidates' paths (see `newCandidates`). */
  candidates: string[];
  clones: SecretFilesClone[];
}

// ---------------------------------------------------------------------------
// Compare (names only, never values)
// ---------------------------------------------------------------------------

/** Relative to the vault: `added` = in the clone/left side but not the vault/right side. */
export type SecretKeyChange = "added" | "removed" | "changed" | "same";

export type SecretFileCompare =
  /** Both sides parse as KEY=VALUE (dotenv). */
  | { format: "env"; keys: Array<{ key: string; change: SecretKeyChange }> }
  /** Anything else: line counts only. */
  | { format: "lines"; linesAdded: number; linesRemoved: number }
  /** One side has no file. */
  | { format: "missing"; side: "left" | "right" };

// ---------------------------------------------------------------------------
// Setup scan (the "Secret files…" dialog's first step)
// ---------------------------------------------------------------------------

/** One distinct content of a candidate across clones (clones with identical copies share a variant). */
export interface SecretFileVariant {
  /** Opaque, valid only for this scan's answer. */
  variantId: string;
  /** The clones holding this exact content. */
  projectPaths: string[];
  /** Newest mtime among them. */
  modifiedAt: string;
  /** For `format: "env"` candidates: the variable names it has. For others: its line count. */
  keyCount?: number;
  lineCount?: number;
}

export interface SecretFileCandidate {
  path: string;
  /** Matched the conventional `.env` / `.env.*` rule (vs added by hand or managed). */
  conventional: boolean;
  managed: boolean;
  excluded: boolean;
  /** Whether every variant parses as KEY=VALUE. */
  format: "env" | "lines";
  variants: SecretFileVariant[];
  /** Pre-selected source: the newest variant. */
  defaultVariantId: string | null;
  /**
   * `format: "env"` only — every variable name across variants and, per variant,
   * whether it has the key and which value class it holds (variants with equal
   * values for a key share a class number; values themselves are never sent).
   */
  keys?: Array<{ key: string; byVariant: Record<string, number | null> }>;
  /** Clones where this path is refused, and why. */
  refused: Array<{ projectPath: string; refusal: SecretFileRefusal }>;
}

export interface SecretFileCandidatesResponse {
  workspace: string;
  repoKey: string;
  /** The repo's clones in this workspace. */
  clones: Array<{ projectPath: string; projectName: string }>;
  candidates: SecretFileCandidate[];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const secretFilesRoutes = {
  /** GET → {@link SecretVaultsResponse}. */
  list: "/api/secret-files",
  /** `?workspace=&repoKey=` GET → {@link SecretVaultResponse} (404 VAULT_NOT_FOUND); DELETE → 204. */
  vault: "/api/secret-files/vault",
  /** `?workspace=&repoKey=` GET → {@link SecretFileCandidatesResponse}. Also `&path=` to scan one hand-typed path. */
  candidates: "/api/secret-files/candidates",
  /** POST {@link SetupSecretVaultRequest} → {@link SecretVaultResponse}. */
  setup: "/api/secret-files/setup",
  /** PUT {@link UpdateSecretFilesRequest} → {@link SecretVaultResponse}. */
  files: "/api/secret-files/files",
  /** POST {@link SecretFilesCloneRequest} → {@link SecretVaultResponse}. */
  push: "/api/secret-files/push",
  /** POST {@link SecretFilesCloneRequest} → {@link SecretVaultResponse}. */
  reset: "/api/secret-files/reset",
  /** `?workspace=&repoKey=&projectPath=&path=` GET → {@link SecretFileCompareResponse} (clone = left, vault = right). */
  compare: "/api/secret-files/compare"
} as const;

export interface SecretVaultsResponse {
  vaults: SecretVaultSummary[];
}

export interface SecretVaultResponse {
  vault: SecretVaultDetail;
}

export interface SecretFileCompareResponse {
  path: string;
  compare: SecretFileCompare;
}

export type SecretFileSource =
  /** Take this clone's copy as the vault's first version. */
  | { projectPath: string }
  /** Union of every clone's variables; `primary`'s value wins where they differ (env files only). */
  | { merge: true; primary: string };

export interface SetupSecretVaultRequest {
  workspace: string;
  repoKey: string;
  /** The files to manage and where each one's first version comes from. Re-running setup adds files. */
  files: Array<{ path: string; source: SecretFileSource }>;
  /** Candidates to turn off. */
  excluded: string[];
}

export interface UpdateSecretFilesRequest {
  workspace: string;
  repoKey: string;
  /** Start managing these paths; each one's first version comes from its source. */
  add?: Array<{ path: string; source: SecretFileSource }>;
  /** Turn these candidates off (also stops managing them if they were managed). */
  exclude?: string[];
  /** Un-exclude these candidates (they show as new candidates again). */
  include?: string[];
  /** Stop managing these paths; the vault keeps their history, clones keep their files. */
  unmanage?: string[];
}

export interface SecretFilesCloneRequest {
  workspace: string;
  repoKey: string;
  projectPath: string;
  /** Default: every file of that clone in a state the action applies to. */
  files?: string[];
}

/** Refusal codes (`{ code, message }` bodies). A message never quotes file content. */
export type SecretFilesErrorCode =
  | "SECRET_FILES_DISABLED" // 409 — the plugin is off
  | "INVALID_REQUEST" // 400 — a malformed body/query (bad workspace, repoKey, path list…)
  | "INVALID_PATH" // 400 — see secretFilePathProblem
  | "INVALID_CLONE" // 400 — projectPath isn't a non-archived clone of that repo in that workspace
  | "VAULT_NOT_FOUND" // 404
  | "FILE_NOT_MANAGED" // 400 — a path that isn't one of the vault's files
  | "FILE_REFUSED" // 409 — the source copy is refused (tracked, symlink, too large…)
  | "SOURCE_MISSING" // 409 — the chosen source clone has no such file
  | "NOT_ENV_FORMAT" // 400 — merge asked for a file that isn't KEY=VALUE
  | "TOO_MANY_FILES" // 400 — over SECRET_FILES_MAX_PER_VAULT
  | "NOTHING_TO_PUSH" // 409 — no selected file is modified in that clone
  | "SECRET_FILES_UNAVAILABLE" // 503 — the vault store could not be read; changes are refused
  | "SECRET_FILES_ERROR"; // 500

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The `/events` channel every vault change and clone-state change goes out on. */
export const SECRET_FILES_CHANNEL = "secret-files";
/** Payload: {@link SecretFilesChangedPayload}. */
export const SECRET_FILES_CHANGED = "secretFiles.changed";

export type SecretFilesChangedPayload =
  | { vault: SecretVaultDetail }
  | { workspace: string; repoKey: string; deleted: true };

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/**
 * Why `path` is not a managed-file path, or null when it is one: relative to
 * the clone root, `/`-separated, no empty / `.` / `..` segments, no backslash,
 * no control characters, not under `.git/`, at most {@link SECRET_FILE_PATH_MAX}.
 * (Symlinks and containment are checked on disk by the daemon.)
 */
export function secretFilePathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "The path is empty.";
  if (path.length > SECRET_FILE_PATH_MAX) return "The path is too long.";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "The path may not contain control characters.";
  if (path.includes("\\")) return "Use / to separate folders.";
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) return "The path must be relative to the project folder.";
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return "The path may not contain empty, '.' or '..' parts.";
  }
  if (segments[0] === ".git") return "Files inside .git can't be managed.";
  return null;
}

/** Whether a file NAME (last path segment) is a conventional secret file: `.env` or `.env.*`, not a template. */
export function isConventionalSecretFileName(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  if (name === ".env.") return false;
  return !SECRET_FILE_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
