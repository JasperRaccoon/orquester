/**
 * Secret files — where drift shows (spec §7), as pure rules: the project-row
 * badge, the repo-header count, the project bar's message and dismissals,
 * and the compare modal's summaries. Names, states and counts only; nothing
 * here ever sees a secret value.
 */

import {
  secretFileNeedsAttention,
  type SecretFileCloneState,
  type SecretFileCompare,
  type SecretFileRefusal,
  type SecretFilesClone,
  type SecretFileState,
  type SecretKeyChange,
  type SecretVaultDetail,
  type SecretVaultSummary
} from "@orquester/api";

// ---------------------------------------------------------------------------
// State labels
// ---------------------------------------------------------------------------

/** One clone file's state, as the user reads it. */
export const SECRET_FILE_STATE_LABEL: Record<SecretFileState, string> = {
  synced: "in sync",
  missing: "being copied in",
  "missing-dir": "its folder is missing here",
  outdated: "being updated",
  modified: "changed here",
  deleted: "deleted here",
  refused: "can't be synced here"
};

export const SECRET_FILE_REFUSAL_LABEL: Record<SecretFileRefusal, string> = {
  tracked: "git tracks it here",
  symlink: "it or a folder above it is a symlink",
  outside: "it resolves outside the project",
  "not-a-file": "it isn't a regular file",
  "too-large": "it is too large",
  unreadable: "it can't be read"
};

/** `changed here`, or for a refused file its reason (`can't be synced here: git tracks it here`). */
export function secretFileStateText(file: Pick<SecretFileCloneState, "state" | "refusal">): string {
  const label = SECRET_FILE_STATE_LABEL[file.state] ?? file.state;
  if (file.state === "refused" && file.refusal) {
    return `${label}: ${SECRET_FILE_REFUSAL_LABEL[file.refusal] ?? file.refusal}`;
  }
  return label;
}

/** A clone's files in a state the user has to act on, in the clone's order. */
export function attentionFiles(clone: Pick<SecretFilesClone, "files">): SecretFileCloneState[] {
  return clone.files.filter((file) => secretFileNeedsAttention(file.state));
}

// ---------------------------------------------------------------------------
// Project row badge
// ---------------------------------------------------------------------------

export interface ProjectSecretBadge {
  /** The tooltip / accessible name: which files need attention and why. */
  title: string;
}

/**
 * The project row's key badge: shown only when the plugin is on, the project
 * is a clone in a vault and one of its files needs attention — a synced clone
 * keeps its row clean. Null: no badge.
 */
export function projectSecretBadge(
  enabled: boolean,
  clone: Pick<SecretFilesClone, "files"> | undefined
): ProjectSecretBadge | null {
  if (!enabled || !clone) return null;
  const files = attentionFiles(clone);
  if (files.length === 0) return null;
  const lines = files.map((file) => `${file.path} — ${secretFileStateText(file)}`);
  return {
    title: [files.length === 1 ? "A secret file needs attention:" : "Secret files need attention:", ...lines].join("\n")
  };
}

// ---------------------------------------------------------------------------
// Repo group header count
// ---------------------------------------------------------------------------

export interface RepoSecretCount {
  /** What the pill shows: clones needing attention plus new candidate files. */
  count: number;
  title: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The repo header's amber "🔑 N": clones of the repo needing attention plus
 * new conventional files found in some clone. Null when the plugin is off,
 * the repo has no vault, or there is nothing to look at.
 */
export function repoSecretCount(
  enabled: boolean,
  vault: Pick<SecretVaultSummary, "clonesNeedingAttention" | "newCandidates"> | undefined
): RepoSecretCount | null {
  if (!enabled || !vault) return null;
  const clones = Math.max(0, vault.clonesNeedingAttention | 0);
  const candidates = Math.max(0, vault.newCandidates | 0);
  if (clones === 0 && candidates === 0) return null;
  const parts: string[] = [];
  if (clones > 0) parts.push(`${plural(clones, "clone has", "clones have")} secret files that need attention`);
  if (candidates > 0) parts.push(`${plural(candidates, "new secret file was", "new secret files were")} found and can be added`);
  return { count: clones + candidates, title: `${parts.join("; ")}. Open "Secret files…" to review.` };
}

// ---------------------------------------------------------------------------
// Compare summaries
// ---------------------------------------------------------------------------

export interface EnvCompareSummary {
  added: number;
  removed: number;
  changed: number;
  same: number;
}

export function countKeyChanges(keys: ReadonlyArray<{ change: SecretKeyChange }>): EnvCompareSummary {
  const counts: EnvCompareSummary = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const { change } of keys) {
    if (change in counts) counts[change] += 1;
  }
  return counts;
}

/** The variables that differ (added / removed / changed), in the daemon's order; "same" ones are only counted. */
export function differingKeys<K extends { change: SecretKeyChange }>(keys: readonly K[]): K[] {
  return keys.filter((key) => key.change !== "same");
}

/**
 * One line for a compare (clone = left, vault = right): `1 added, 2 changed`,
 * `3 lines added, 1 removed`, `missing in this clone`. Null when nothing
 * differs that can be shown by name (e.g. only spacing or comments changed).
 */
export function compareSummaryText(compare: SecretFileCompare): string | null {
  if (compare.format === "env") {
    const { added, removed, changed } = countKeyChanges(compare.keys);
    const parts: string[] = [];
    if (added > 0) parts.push(`${added} added`);
    if (removed > 0) parts.push(`${removed} removed`);
    if (changed > 0) parts.push(`${changed} changed`);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (compare.format === "lines") {
    const added = Math.max(0, compare.linesAdded | 0);
    const removed = Math.max(0, compare.linesRemoved | 0);
    if (added === 0 && removed === 0) return null;
    return `${plural(added, "line", "lines")} added, ${removed} removed`;
  }
  return compare.side === "left" ? "missing in this clone" : "missing in the vault";
}

/** What the compare modal lists: one path, or every managed file of the clone that isn't synced. */
export function compareTargets(clone: Pick<SecretFilesClone, "files"> | undefined, path: string | undefined): string[] {
  if (path !== undefined) return [path];
  return (clone?.files ?? []).filter((file) => file.state !== "synced").map((file) => file.path);
}

// ---------------------------------------------------------------------------
// Project bar
// ---------------------------------------------------------------------------

/** States the bar's Push / Reset act on. */
const DRIFT_STATES: readonly SecretFileState[] = ["modified", "deleted"];

export type ProjectBarModel =
  | {
      kind: "drift";
      /** The `modified` / `deleted` files, in the clone's order. */
      files: SecretFileCloneState[];
      /** Paths Push to vault sends (only `modified`: a deletion is never pushed). */
      pushPaths: string[];
      /** Paths Reset to vault restores (`modified` and `deleted`). */
      resetPaths: string[];
      /** The one file whose compare summary completes the message; null for several. */
      comparePath: string | null;
    }
  | {
      kind: "info";
      /** The `missing-dir` / `refused` files. */
      files: SecretFileCloneState[];
    };

/**
 * The bar for the open project: `drift` when it has `modified` / `deleted`
 * files, else `info` when it has `missing-dir` / `refused` ones, else null.
 */
export function projectBarModel(clone: Pick<SecretFilesClone, "files"> | undefined): ProjectBarModel | null {
  if (!clone) return null;
  const drift = clone.files.filter((file) => DRIFT_STATES.includes(file.state));
  if (drift.length > 0) {
    return {
      kind: "drift",
      files: drift,
      pushPaths: drift.filter((file) => file.state === "modified").map((file) => file.path),
      resetPaths: drift.map((file) => file.path),
      comparePath: drift.length === 1 && drift[0].state === "modified" ? drift[0].path : null
    };
  }
  const info = clone.files.filter((file) => file.state === "missing-dir" || file.state === "refused");
  return info.length > 0 ? { kind: "info", files: info } : null;
}

/**
 * The bar's message, as parts so the path can be set in code type:
 * `MatsSmileBack/.env` + ` differs from the vault: 1 added, 2 changed`.
 * `summary` is the one file's compare summary once it has loaded.
 */
export function projectBarMessage(
  model: ProjectBarModel,
  summary?: string | null
): { path: string | null; text: string } {
  const [first] = model.files;
  if (model.kind === "drift") {
    if (model.files.length > 1) return { path: null, text: `${model.files.length} secret files differ from the vault` };
    if (first.state === "deleted") return { path: first.path, text: " was deleted in this project; the vault still has it" };
    return { path: first.path, text: summary ? ` differs from the vault: ${summary}` : " differs from the vault" };
  }
  if (model.files.length > 1) return { path: null, text: `${model.files.length} secret files can't be synced to this project` };
  if (first.state === "missing-dir") return { path: first.path, text: " can't be copied here: its folder doesn't exist in this project" };
  const reason = first.refusal ? SECRET_FILE_REFUSAL_LABEL[first.refusal] : null;
  return { path: first.path, text: reason ? ` can't be synced here: ${reason}` : " can't be synced here" };
}

/** Another clone's states the daemon writes the pushed version into (spec §4); `missing` copies are created. */
export const RECEIVES_PUSH: readonly SecretFileState[] = ["synced", "outdated", "missing"];

/**
 * Which other clones a push of `paths` from `projectPath` reaches, judged per
 * file: a clone receives the new version of each pushed file it holds in sync,
 * behind or missing, and keeps its own changes to each one it modified — so a
 * clone can be in both lists, for different files.
 */
export function pushReach<C extends Pick<SecretFilesClone, "projectPath" | "files">>(
  clones: readonly C[],
  projectPath: string,
  paths: readonly string[]
): { receives: C[]; keepsChanges: C[] } {
  const receives: C[] = [];
  const keepsChanges: C[] = [];
  for (const clone of clones) {
    if (clone.projectPath === projectPath) continue;
    const states = clone.files.filter((file) => paths.includes(file.path)).map((file) => file.state);
    if (states.some((state) => RECEIVES_PUSH.includes(state))) receives.push(clone);
    if (states.includes("modified")) keepsChanges.push(clone);
  }
  return { receives, keepsChanges };
}

/**
 * The Push confirm: which clones the vault's new version reaches. Clones in
 * sync (or only behind, or missing the file) get it; ones with their own
 * changes stay flagged and are compared against the new version (per file —
 * see {@link pushReach}).
 */
export function pushConfirmText(
  vault: Pick<SecretVaultDetail, "clones">,
  projectPath: string,
  paths: readonly string[]
): string {
  const reach = pushReach(vault.clones, projectPath, paths);
  const overwritten = reach.receives.map((clone) => clone.projectName);
  const kept = reach.keepsChanges.map((clone) => clone.projectName);
  const what = paths.length === 1 ? `this project's ${paths[0]}` : `this project's ${paths.length} changed secret files`;
  let text = `This makes ${what} the vault's version.`;
  text +=
    overwritten.length > 0
      ? ` It overwrites the copy in ${overwritten.join(", ")}.`
      : " No other clone is overwritten.";
  if (kept.length > 0) {
    text +=
      kept.length === 1
        ? ` ${kept[0]} has its own changes and stays flagged.`
        : ` ${kept.join(", ")} have their own changes and stay flagged.`;
  }
  return text;
}

/** States in which the clone holds no copy of the file. */
const NO_COPY_STATES: readonly SecretFileState[] = ["deleted", "missing", "missing-dir"];

/**
 * The `expect` a Push / Reset of `paths` sends: each file's content token as
 * the UI showed it (null for a copy the clone doesn't have), so the daemon
 * refuses with 409 CONTENT_CHANGED if it changed since. A file the clone has
 * but without a token (a daemon predating tokens) is left out; undefined when
 * nothing is left.
 */
export function expectedContent(
  files: ReadonlyArray<Pick<SecretFileCloneState, "path" | "state" | "contentToken">>,
  paths: readonly string[]
): Record<string, string | null> | undefined {
  const expect: Record<string, string | null> = {};
  for (const path of paths) {
    const file = files.find((entry) => entry.path === path);
    if (!file) continue;
    if (file.contentToken) expect[path] = file.contentToken;
    else if (NO_COPY_STATES.includes(file.state)) expect[path] = null;
  }
  return Object.keys(expect).length > 0 ? expect : undefined;
}

/** What a 409 CONTENT_CHANGED is shown as. */
export const CONTENT_CHANGED_TEXT = "This file changed since you looked — review it again.";

/** The Reset confirm. */
export function resetConfirmText(paths: readonly string[]): string {
  const what = paths.length === 1 ? paths[0] : `${paths.length} secret files`;
  return `This replaces ${what} in this project with the vault's version. This project's changes to ${paths.length === 1 ? "it" : "them"} are discarded.`;
}

// ---------------------------------------------------------------------------
// Bar dismissal
// ---------------------------------------------------------------------------

/**
 * One dismissal of the bar. `key` is what it covers: the project and, per
 * flagged file, its path, state and the vault version it is compared with.
 * `tokens` are those files' content tokens (this clone's copies) and `boot`
 * the daemon boot they came from: the daemon keys its tokens per process, so
 * they only compare within one boot. Any of those changing (a push, a reset,
 * another file flagged, a further edit of a flagged file) brings the bar back;
 * a daemon restart alone does not.
 */
export interface BarDismissal {
  key: string;
  tokens: string;
  /** The vault revision's boot (null: the vault carried none). */
  boot: string | null;
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What a dismissal of the bar now would record for its flagged `files`. */
export function projectBarDismissal(
  projectPath: string,
  files: ReadonlyArray<Pick<SecretFileCloneState, "path" | "state" | "contentToken">>,
  vault: Pick<SecretVaultDetail, "files" | "revision">
): BarDismissal {
  const versions = new Map(vault.files.map((file) => [file.path, file.version]));
  const sorted = [...files].sort(byPath);
  return {
    key: [projectPath, ...sorted.map((file) => `${file.path}\u0001${file.state}\u0001${versions.get(file.path) ?? ""}`)].join(
      "\u0000"
    ),
    tokens: sorted.map((file) => `${file.path}\u0001${file.contentToken ?? ""}`).join("\u0000"),
    boot: vault.revision?.boot ?? null
  };
}

/**
 * The stored dismissal covering `current`, if any: the same key and — when it
 * was recorded under the same daemon boot — the same content tokens. Under
 * another boot (the daemon restarted: every token changed) the tokens are not
 * compared.
 */
export function findBarDismissal(
  dismissals: readonly BarDismissal[],
  current: BarDismissal
): BarDismissal | undefined {
  return dismissals.find(
    (dismissal) =>
      dismissal.key === current.key && (dismissal.boot !== current.boot || dismissal.tokens === current.tokens)
  );
}

/** Dismissals kept per tab session; the oldest go first past this. */
const MAX_BAR_DISMISSALS = 200;

const isBarDismissal = (value: unknown): value is BarDismissal => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.tokens === "string" &&
    (record.boot === null || typeof record.boot === "string")
  );
};

/** The stored dismissals (a JSON list); anything malformed (or of an older format) is left out. */
export function parseBarDismissals(raw: unknown): BarDismissal[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isBarDismissal)
      .map(({ key, tokens, boot }) => ({ key, tokens, boot }))
      .slice(-MAX_BAR_DISMISSALS);
  } catch {
    return [];
  }
}

/** `dismissal` recorded, replacing an earlier one with the same key. */
export function addBarDismissal(dismissals: readonly BarDismissal[], dismissal: BarDismissal): BarDismissal[] {
  return [...dismissals.filter((existing) => existing.key !== dismissal.key), dismissal].slice(-MAX_BAR_DISMISSALS);
}
