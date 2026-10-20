/**
 * The "Secret files…" dialog's pure rules (spec §6): which candidates start
 * ticked, which copy each file's first version comes from, the request a setup
 * or an add sends, the variable comparison table (value classes as letters,
 * never values), state labels, and when Push / Reset / Compare apply.
 * No React, no client — tested on its own.
 */

import {
  SECRET_FILES_MAX_PER_VAULT,
  secretFileNeedsAttention,
  type SecretFileCandidate,
  type SecretFileRefusal,
  type SecretFileSource,
  type SecretFileState,
  type SecretFileVariant,
  type SecretFilesClone,
  type SecretVaultDetail,
  type SetupSecretVaultRequest,
  type UpdateSecretFilesRequest
} from "@orquester/api";

import { CONTENT_CHANGED_TEXT, pushReach } from "./drift.logic";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Where a selected file's first vault version comes from. */
export type SourceChoice =
  | { kind: "variant"; variantId: string }
  /** Union of every copy's variables; `primary`'s value wins where they differ. */
  | { kind: "merge"; primary: string };

function timeOf(iso: string): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** The newest copy: the daemon's pick when it names one of the variants, else the latest `modifiedAt`. */
export function newestVariant(candidate: SecretFileCandidate): SecretFileVariant | null {
  const named = candidate.variants.find((variant) => variant.variantId === candidate.defaultVariantId);
  if (named) return named;
  let best: SecretFileVariant | null = null;
  for (const variant of candidate.variants) {
    if (best === null || timeOf(variant.modifiedAt) > timeOf(best.modifiedAt)) best = variant;
  }
  return best;
}

/** Copies differ across clones, so the user picks one (or merges). */
export function needsSourceChoice(candidate: SecretFileCandidate): boolean {
  return candidate.variants.length > 1;
}

/** "Merge all" is offered for KEY=VALUE files with more than one copy. */
export function canMerge(candidate: SecretFileCandidate): boolean {
  return candidate.format === "env" && candidate.variants.length > 1;
}

/** The clones a merge's primary may be: any clone holding a copy. */
export function mergePrimaryOptions(candidate: SecretFileCandidate): string[] {
  return [...new Set(candidate.variants.flatMap((variant) => variant.projectPaths))];
}

/** Merge's primary by default: the newest copy's first clone. */
export function defaultMergePrimary(candidate: SecretFileCandidate): string | null {
  return newestVariant(candidate)?.projectPaths[0] ?? null;
}

/** The pre-selected source: the newest copy. Null when no clone has a usable copy. */
export function defaultSourceChoice(candidate: SecretFileCandidate): SourceChoice | null {
  const newest = newestVariant(candidate);
  return newest ? { kind: "variant", variantId: newest.variantId } : null;
}

/** A candidate can be managed only when some clone holds a usable copy. */
export function isSelectable(candidate: SecretFileCandidate): boolean {
  return candidate.variants.length > 0;
}

/**
 * The wire source for a candidate under a choice, or null when the choice is
 * not valid for it (a variant it doesn't have, a merge of a non-env file, a
 * primary that holds no copy). A single-copy file always takes that copy.
 */
export function sourceFor(candidate: SecretFileCandidate, choice: SourceChoice | null | undefined): SecretFileSource | null {
  if (candidate.variants.length === 0) return null;
  if (candidate.variants.length === 1) return { projectPath: candidate.variants[0].projectPaths[0] };
  const effective = choice ?? defaultSourceChoice(candidate);
  if (effective === null) return null;
  if (effective.kind === "merge") {
    if (!canMerge(candidate) || !mergePrimaryOptions(candidate).includes(effective.primary)) return null;
    return { merge: true, primary: effective.primary };
  }
  const variant = candidate.variants.find((entry) => entry.variantId === effective.variantId);
  return variant ? { projectPath: variant.projectPaths[0] } : null;
}

// ---------------------------------------------------------------------------
// Setup selection
// ---------------------------------------------------------------------------

/** Ticked by default: a selectable conventional candidate the user hasn't excluded. */
export function defaultTicked(candidate: SecretFileCandidate): boolean {
  return candidate.conventional && !candidate.excluded && isSelectable(candidate);
}

export interface SetupSelection {
  /** path → ticked. A path not listed takes {@link defaultTicked}. */
  ticked: Readonly<Record<string, boolean>>;
  /** path → source choice. A path not listed takes {@link defaultSourceChoice}. */
  sources: Readonly<Record<string, SourceChoice>>;
}

export function isTicked(candidate: SecretFileCandidate, selection: SetupSelection): boolean {
  if (!isSelectable(candidate)) return false;
  return selection.ticked[candidate.path] ?? defaultTicked(candidate);
}

export type SetupPlan = { ok: true; request: SetupSecretVaultRequest } | { ok: false; problem: string };

/**
 * The setup request: each ticked candidate with its source; every unticked
 * conventional candidate the user could have ticked goes to `excluded` (never
 * suggested again). Hand-added files left unticked, and candidates no clone
 * holds a usable copy of (nobody could tick them), are simply not sent.
 */
export function buildSetupRequest(
  workspace: string,
  repoKey: string,
  candidates: readonly SecretFileCandidate[],
  selection: SetupSelection
): SetupPlan {
  const files: SetupSecretVaultRequest["files"] = [];
  const excluded: string[] = [];
  for (const candidate of candidates) {
    if (!isTicked(candidate, selection)) {
      if (isSelectable(candidate) && candidate.conventional && !candidate.managed) excluded.push(candidate.path);
      continue;
    }
    const source = sourceFor(candidate, selection.sources[candidate.path]);
    if (source === null) return { ok: false, problem: `Pick where ${candidate.path} comes from.` };
    files.push({ path: candidate.path, source });
  }
  if (files.length === 0) return { ok: false, problem: "Select at least one file to keep in the vault." };
  if (files.length > SECRET_FILES_MAX_PER_VAULT) {
    return { ok: false, problem: `A vault holds at most ${SECRET_FILES_MAX_PER_VAULT} files.` };
  }
  return { ok: true, request: { workspace, repoKey, files, excluded } };
}

/** Start managing one more file (the manage view's Add). */
export function buildAddRequest(
  workspace: string,
  repoKey: string,
  candidate: SecretFileCandidate,
  choice: SourceChoice | null | undefined
): { ok: true; request: UpdateSecretFilesRequest } | { ok: false; problem: string } {
  const source = sourceFor(candidate, choice);
  if (source === null) {
    return {
      ok: false,
      problem: isSelectable(candidate) ? `Pick where ${candidate.path} comes from.` : `No clone has a usable ${candidate.path}.`
    };
  }
  return { ok: true, request: { workspace, repoKey, add: [{ path: candidate.path, source }] } };
}

/** A hand-typed path's scan answer merged into the list: replaces the same path, else appended. */
export function mergeCandidate(
  candidates: readonly SecretFileCandidate[],
  added: SecretFileCandidate
): SecretFileCandidate[] {
  const at = candidates.findIndex((candidate) => candidate.path === added.path);
  if (at === -1) return [...candidates, added];
  const next = candidates.slice();
  next[at] = added;
  return next;
}

/** The candidate a one-path scan answered for `path`, if any. */
export function scannedCandidate(candidates: readonly SecretFileCandidate[], path: string): SecretFileCandidate | null {
  return candidates.find((candidate) => candidate.path === path) ?? null;
}

// ---------------------------------------------------------------------------
// Variable comparison (value classes, never values)
// ---------------------------------------------------------------------------

export interface KeyRowCell {
  variantId: string;
  present: boolean;
  /** `A`, `B`, … per key, in variant order: equal letters = equal values. Null when absent. */
  letter: string | null;
}

export interface KeyRow {
  key: string;
  cells: KeyRowCell[];
  /** Every copy has the key with the same value. */
  agree: boolean;
}

function letterOf(index: number): string {
  let out = "";
  let n = index;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * The table rows for an env candidate: per variable, per copy (in variant
 * order) whether it has it and which value class — the daemon's class numbers
 * relabelled A, B, … in order of first appearance, so the first copy that has
 * a key always reads `A`.
 */
export function keyTable(candidate: SecretFileCandidate): KeyRow[] {
  if (!candidate.keys) return [];
  return candidate.keys.map(({ key, byVariant }) => {
    const letters = new Map<number, string>();
    const cells = candidate.variants.map((variant) => {
      const cls = byVariant[variant.variantId];
      if (cls === null || cls === undefined) return { variantId: variant.variantId, present: false, letter: null };
      let letter = letters.get(cls);
      if (letter === undefined) {
        letter = letterOf(letters.size);
        letters.set(cls, letter);
      }
      return { variantId: variant.variantId, present: true, letter };
    });
    return { key, cells, agree: cells.every((cell) => cell.present) && letters.size === 1 };
  });
}

/** One copy's size line: `12 variables` / `40 lines`. */
export function variantSizeText(candidate: SecretFileCandidate, variant: SecretFileVariant): string {
  if (candidate.format === "env" && variant.keyCount !== undefined) {
    return `${variant.keyCount} ${variant.keyCount === 1 ? "variable" : "variables"}`;
  }
  if (variant.lineCount !== undefined) return `${variant.lineCount} ${variant.lineCount === 1 ? "line" : "lines"}`;
  return "";
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const REFUSAL_TEXT: Record<SecretFileRefusal, string> = {
  tracked: "tracked by git",
  symlink: "symlink",
  outside: "outside the project",
  "not-a-file": "not a file",
  "too-large": "too large",
  unreadable: "unreadable"
};

export function refusalText(refusal: SecretFileRefusal | undefined): string {
  return refusal ? REFUSAL_TEXT[refusal] : "can't be synced";
}

/** A clone file's state in words. */
export function stateLabel(state: SecretFileState, refusal?: SecretFileRefusal): string {
  switch (state) {
    case "synced":
      return "Synced";
    case "missing":
      return "Missing, copying";
    case "missing-dir":
      return "Missing folder";
    case "outdated":
      return "Out of date";
    case "modified":
      return "Changed";
    case "deleted":
      return "Deleted";
    case "refused":
      return `Not synced: ${refusalText(refusal)}`;
  }
}

export type StateTone = "ok" | "pending" | "attention";

export function stateTone(state: SecretFileState): StateTone {
  if (state === "synced") return "ok";
  return secretFileNeedsAttention(state) ? "attention" : "pending";
}

// ---------------------------------------------------------------------------
// Clone actions
// ---------------------------------------------------------------------------

/** The files Push sends: the clone's changed copies. */
export function pushableFiles(clone: SecretFilesClone): string[] {
  return clone.files.filter((file) => file.state === "modified").map((file) => file.path);
}

/** The files Reset rewrites from the vault: changed and deleted copies. */
export function resettableFiles(clone: SecretFilesClone): string[] {
  return clone.files.filter((file) => file.state === "modified" || file.state === "deleted").map((file) => file.path);
}

export function canPush(clone: SecretFilesClone): boolean {
  return pushableFiles(clone).length > 0;
}

export function canReset(clone: SecretFilesClone): boolean {
  return resettableFiles(clone).length > 0;
}

/** Compare shows the clone's files that differ from the vault (changed or deleted). */
export function canCompare(clone: SecretFilesClone): boolean {
  return canReset(clone);
}

/**
 * What a push of `files` (default: every changed copy) from `source` does to
 * the other clones, per file: a clone whose copy of a pushed file is in sync,
 * merely behind or missing gets the new version; one with its own changes to a
 * pushed file keeps them, still flagged — a clone can be in both lists.
 */
export function pushImpact(
  vault: SecretVaultDetail,
  source: SecretFilesClone,
  files: readonly string[] = pushableFiles(source)
): { overwritten: SecretFilesClone[]; keptFlagged: SecretFilesClone[] } {
  const reach = pushReach(vault.clones, source.projectPath, files);
  return { overwritten: reach.receives, keptFlagged: reach.keepsChanges };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function codeText(code: string): string | null {
  switch (code) {
    case "SECRET_FILES_DISABLED":
      return "The Secret files plugin is off. Turn it on in Settings → Plugins.";
    case "VAULT_NOT_FOUND":
      return "This repo has no vault any more.";
    case "INVALID_PATH":
      return "That path can't be used.";
    case "INVALID_CLONE":
      return "That project isn't a clone of this repo here any more.";
    case "FILE_NOT_MANAGED":
      return "That file isn't in the vault.";
    case "FILE_REFUSED":
      return "That copy can't be used (tracked by git, a symlink or too large).";
    case "SOURCE_MISSING":
      return "The chosen clone no longer has that file.";
    case "NOT_ENV_FORMAT":
      return "Only KEY=VALUE files can be merged.";
    case "TOO_MANY_FILES":
      return `A vault holds at most ${SECRET_FILES_MAX_PER_VAULT} files.`;
    case "NOTHING_TO_PUSH":
      return "Nothing in that clone differs from the vault any more.";
    case "SECRET_FILES_UNAVAILABLE":
      return "The vault store can't be read right now, so changes are refused.";
    default:
      return null;
  }
}

/**
 * The words a failure is shown with: the daemon's own message when it sent
 * one (except CONTENT_CHANGED, always "review it again"), else a friendly text
 * for its refusal code, else its status or message.
 * Duck-typed on `ApiError`.
 */
export function secretFilesErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const body = (error as { body?: unknown }).body;
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    // What to do next matters more than the daemon's wording here.
    if (code === "CONTENT_CHANGED") return CONTENT_CHANGED_TEXT;
    const server = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof server === "string" && server.trim().length > 0) return server.trim();
    const text = typeof code === "string" ? codeText(code) : null;
    if (text !== null) return text;
    const status = (error as { status?: unknown }).status;
    if (status === 404) return "This daemon doesn't support secret files yet — update it.";
    if (typeof status === "number") return `The daemon refused the request (${status}).`;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return "Something went wrong.";
}

/** The project name a clone path is shown with. */
export function cloneName(clones: ReadonlyArray<{ projectPath: string; projectName: string }>, projectPath: string): string {
  const known = clones.find((clone) => clone.projectPath === projectPath)?.projectName;
  if (known) return known;
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

/** `A, B and C`. */
export function listText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
