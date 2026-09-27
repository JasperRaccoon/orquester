/**
 * Saved prompts — the panel's list rules: which prompts a scope shows, how a
 * search matches, the Pinned / Prompts sections and their order, the
 * "Context:" line a card shows, and which empty state applies.
 *
 * Pure (no React, no store), so every rule is testable on its own.
 */

import { promptVariablesUsed, type PromptVariableName, type SavedPrompt } from "@orquester/api";

/** The panel's switch: everything the project can use (global + its own), or only its own. */
export type SavedPromptScopeFilter = "all" | "project";

/**
 * A project directory as the panel compares it: trailing separators stripped,
 * so `/w/ws/app/` and `/w/ws/app` are one project. The root stays the root.
 */
export function normalizeProjectPath(path: string): string {
  const stripped = path.replace(/[\\/]+$/, "");
  return stripped.length > 0 || path.length === 0 ? stripped : path.charAt(0);
}

/** True when `prompt` is the project's own — never a global prompt, never with no project open. */
export function belongsToProject(
  prompt: Pick<SavedPrompt, "projectPath">,
  projectPath: string
): boolean {
  if (prompt.projectPath === null) return false;
  const wanted = normalizeProjectPath(projectPath);
  return wanted.length > 0 && normalizeProjectPath(prompt.projectPath) === wanted;
}

/** Everything the open project can use: every global prompt and the project's own. */
export function promptsForProject(
  prompts: Iterable<SavedPrompt>,
  projectPath: string
): SavedPrompt[] {
  const out: SavedPrompt[] = [];
  for (const prompt of prompts) {
    if (prompt.projectPath === null || belongsToProject(prompt, projectPath)) out.push(prompt);
  }
  return out;
}

/** `all` = global + this project's; `project` = this project's only. */
export function promptsInScope(
  prompts: readonly SavedPrompt[],
  scope: SavedPromptScopeFilter,
  projectPath: string
): SavedPrompt[] {
  return prompts.filter((prompt) =>
    scope === "project"
      ? belongsToProject(prompt, projectPath)
      : prompt.projectPath === null || belongsToProject(prompt, projectPath)
  );
}

/** What a scope chip says. */
export function promptScopeLabel(prompt: Pick<SavedPrompt, "projectPath">): "Global" | "Project" {
  return prompt.projectPath === null ? "Global" : "Project";
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Letters no Unicode decomposition takes apart, spelled the way a keyboard
 * without them would (after lower-casing, so `Ł`, `Ø` and `ẞ` land here too).
 */
const FOLDED_LETTERS: Readonly<Record<string, string>> = { ł: "l", ø: "o", ß: "ss" };

/** Case- and accent-insensitive form of `text`: "Révision" and "revision" match, and so do "Łódź" and "lodz". */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[łøß]/g, (letter) => FOLDED_LETTERS[letter] ?? letter);
}

/** The query's words, folded; none for a blank query. */
export function searchWords(query: string): string[] {
  return foldSearchText(query)
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Folded title + description + tags + body, per record. A record is never
 * mutated — an edit arrives as a new object — so the cache keys on identity
 * and a 32 KB body is folded once, not on every keystroke.
 */
const haystacks = new WeakMap<SavedPrompt, string>();

function haystackOf(prompt: SavedPrompt): string {
  let text = haystacks.get(prompt);
  if (text === undefined) {
    text = foldSearchText([prompt.title, prompt.description, ...prompt.tags, prompt.body].join("\n"));
    haystacks.set(prompt, text);
  }
  return text;
}

/** Every word appears somewhere in the title, the description, a tag or the body. */
export function matchesSearch(prompt: SavedPrompt, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = haystackOf(prompt);
  return words.every((word) => haystack.includes(word));
}

// ---------------------------------------------------------------------------
// Order and sections
// ---------------------------------------------------------------------------

function timeOf(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function descending(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

const titleCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function byId(a: SavedPrompt, b: SavedPrompt): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pinned prompts: alphabetical, so a favourite stays where the user last saw it. */
export function compareByTitle(a: SavedPrompt, b: SavedPrompt): number {
  return titleCollator.compare(a.title, b.title) || byId(a, b);
}

/** The rest: last used first (never used last), then last edited, then by title. */
export function compareByRecency(a: SavedPrompt, b: SavedPrompt): number {
  return (
    descending(timeOf(a.lastUsedAt), timeOf(b.lastUsedAt)) ||
    descending(timeOf(a.updatedAt), timeOf(b.updatedAt)) ||
    compareByTitle(a, b)
  );
}

export interface SavedPromptSections {
  pinned: SavedPrompt[];
  others: SavedPrompt[];
  /** How many the scope holds before the search — 0 is the scope's own empty state. */
  inScope: number;
}

/** Scope, then search, then Pinned first and the rest after, each in its order. */
export function savedPromptSections(
  prompts: readonly SavedPrompt[],
  input: { scope: SavedPromptScopeFilter; projectPath: string; query: string }
): SavedPromptSections {
  const scoped = promptsInScope(prompts, input.scope, input.projectPath);
  const words = searchWords(input.query);
  const pinned: SavedPrompt[] = [];
  const others: SavedPrompt[] = [];
  for (const prompt of scoped) {
    if (!matchesSearch(prompt, words)) continue;
    (prompt.pinned ? pinned : others).push(prompt);
  }
  pinned.sort(compareByTitle);
  others.sort(compareByRecency);
  return { pinned, others, inScope: scoped.length };
}

// ---------------------------------------------------------------------------
// The "Context:" line
// ---------------------------------------------------------------------------

/** The git variables that pull context in at use time, as a card names them. */
const CONTEXT_LABELS: Partial<Record<PromptVariableName, string>> = {
  diff: "current diff",
  changedFiles: "changed files",
  branch: "branch"
};

/** "Context: current diff, branch" — in the body's first-use order — or `null` when it reads no git context. */
export function promptContextLine(body: string): string | null {
  const labels: string[] = [];
  for (const name of promptVariablesUsed(body)) {
    const label = CONTEXT_LABELS[name];
    if (label !== undefined) labels.push(label);
  }
  return labels.length > 0 ? `Context: ${labels.join(", ")}` : null;
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export type SavedPromptsEmptyState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** Nothing saved that this project can use. */
  | { kind: "none" }
  /** The Project scope, and the project has none of its own. */
  | { kind: "no-project-prompts" }
  | { kind: "no-matches"; query: string };

/**
 * The line over the rows when a load failed but rows are shown anyway: a
 * refresh that failed over loaded rows, or a first load that failed under
 * rows that arrived another way (an event, the global list) — never
 * "refresh" for something that was never loaded. `null` without an error.
 */
export function savedPromptsLoadErrorLine(
  status: "loading" | "loaded" | "error",
  error: string | null
): string | null {
  if (error === null) return null;
  return status === "loaded"
    ? `Couldn't refresh saved prompts: ${error}`
    : `Couldn't load saved prompts: ${error}`;
}

/** What the list shows instead of rows, or `null` when it has rows to show. */
export function savedPromptsEmptyState(input: {
  status: "loading" | "loaded" | "error";
  error: string | null;
  scope: SavedPromptScopeFilter;
  sections: SavedPromptSections;
  query: string;
}): SavedPromptsEmptyState | null {
  const { sections } = input;
  if (sections.pinned.length + sections.others.length > 0) return null;
  if (input.status === "loading") return { kind: "loading" };
  if (input.status === "error") {
    return { kind: "error", message: input.error ?? "The daemon did not answer." };
  }
  if (sections.inScope === 0) {
    return input.scope === "project" ? { kind: "no-project-prompts" } : { kind: "none" };
  }
  return { kind: "no-matches", query: input.query.trim() };
}
