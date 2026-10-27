// The entry panel's pure parts (retrieval spec, "Entry panel and citations (U2)"): the similar
// entries and their reason chips, the possible-duplicate merge, the long-body cut for the Markdown
// view, and what the panel remembers for the session ("Plain text", "Keep both"). No React.

import {
  knowledgeMergeKeep,
  type KnowledgeEntryDetail,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeRelatedReason,
  type KnowledgeSimilarEntry
} from "@orquester/api";

import { formatKnowledgeDate, knowledgeErrorText } from "./knowledge.logic";

// ---------------------------------------------------------------------------
// Similar entries
// ---------------------------------------------------------------------------

/** Entries the "Similar" section lists at most (the daemon's own cap). */
const SIMILAR_MAX = 8;

const REASON_ORDER: Record<KnowledgeRelatedReason["kind"], number> = { meaning: 0, concepts: 1, author: 2 };

/** A 0..1 similarity as a whole percentage ("91"). */
export function similarityPercent(similarity: number): number {
  return Math.round(Math.min(1, Math.max(0, similarity)) * 100);
}

/** A reason chip's text: "Meaning 91%", "Concepts: A, B +1", "Same author". */
export function reasonLabel(reason: KnowledgeRelatedReason): string {
  switch (reason.kind) {
    case "meaning":
      return `Meaning ${similarityPercent(reason.similarity)}%`;
    case "concepts": {
      const names = reason.concepts.map((c) => c.name);
      if (names.length > 0) {
        const more = reason.shared - names.length;
        return `Concepts: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}`;
      }
      if (reason.shared > 0) return `${reason.shared} shared ${reason.shared === 1 ? "concept" : "concepts"}`;
      return "Shared concepts";
    }
    case "author":
      return "Same author";
  }
}

/** A reason chip's tooltip (who the author is), or undefined. */
export function reasonTitle(reason: KnowledgeRelatedReason): string | undefined {
  if (reason.kind === "author") return `Also by ${reason.value}`;
  if (reason.kind === "concepts" && reason.shared > reason.concepts.length) return `${reason.shared} shared concepts`;
  return undefined;
}

function sharedConcepts(item: KnowledgeSimilarEntry): number {
  const reason = item.reasons.find((r) => r.kind === "concepts");
  return reason?.kind === "concepts" ? reason.shared : 0;
}

function time(iso: string): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** The spec's order: similarity desc (none last), shared concepts desc, saved desc, then id. */
function compareSimilar(a: KnowledgeSimilarEntry, b: KnowledgeSimilarEntry): number {
  if (a.similarity !== b.similarity) {
    if (a.similarity === null) return 1;
    if (b.similarity === null) return -1;
    return b.similarity - a.similarity;
  }
  const shared = sharedConcepts(b) - sharedConcepts(a);
  if (shared !== 0) return shared;
  const saved = time(b.entry.savedAt) - time(a.entry.savedAt);
  if (saved !== 0 && !Number.isNaN(saved)) return saved;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

interface SimilarSection {
  items: KnowledgeSimilarEntry[];
}

/**
 * What the "Similar" section lists: the daemon's `similar` (each entry once, never the entry
 * itself, reasons meaning first, in the spec's order, at most {@link SIMILAR_MAX}); from a daemon
 * without it, the concept-related entries, as they came.
 */
export function similarSection(detail: Pick<KnowledgeEntryDetail, "entry" | "related" | "similar">): SimilarSection {
  const self = detail.entry.id;
  const seen = new Set<string>([self]);
  const once = (id: string) => !seen.has(id) && (seen.add(id), true);
  if (detail.similar === undefined) {
    const items = detail.related
      .filter((entry) => once(entry.id))
      .slice(0, SIMILAR_MAX)
      .map((entry): KnowledgeSimilarEntry => ({ entry, similarity: null, reasons: [{ kind: "concepts", concepts: [], shared: 0 }] }));
    return { items };
  }
  const items = detail.similar
    .filter((item) => once(item.entry.id))
    .map((item) => ({ ...item, reasons: [...item.reasons].sort((a, b) => REASON_ORDER[a.kind] - REASON_ORDER[b.kind]) }))
    .sort(compareSimilar)
    .slice(0, SIMILAR_MAX);
  return { items };
}

// ---------------------------------------------------------------------------
// Possible duplicates and merging
// ---------------------------------------------------------------------------

/** "Looks like the same content as <Title> (95%)": the title and the percentage, or null without a similarity. */
export function duplicateText(item: KnowledgeSimilarEntry): { title: string; percent: number | null } {
  return { title: item.entry.title || "Untitled", percent: item.similarity === null ? null : similarityPercent(item.similarity) };
}

/** The possible duplicates the banner shows: the daemon's, minus pairs kept for this session. */
export function visibleDuplicates(detail: Pick<KnowledgeEntryDetail, "entry" | "possibleDuplicates">): KnowledgeSimilarEntry[] {
  const self = detail.entry.id;
  return (detail.possibleDuplicates ?? []).filter((item) => item.entry.id !== self && !isDuplicatePairKept(self, item.entry.id));
}

type MergeSide = Pick<KnowledgeEntryMeta, "id" | "title" | "savedAt" | "collections">;

export interface KnowledgeMergePlan {
  /** The older entry (by `savedAt`; the same instant keeps the smaller id): the daemon's own rule, `knowledgeMergeKeep`. */
  keep: MergeSide;
  /** The newer one, deleted. */
  remove: MergeSide;
  /** True when the entry open in the panel is the one deleted. */
  removesOpen: boolean;
  /**
   * The kept entry's collections after the merge (its own, then the deleted one's it lacks), or
   * null when it already has every one (nothing to update).
   */
  collections: string[] | null;
}

/** Which of `open` and `other` is kept and which deleted, and the kept one's collections. */
export function knowledgeMergePlan(open: MergeSide, other: MergeSide): KnowledgeMergePlan {
  const openIsOlder = knowledgeMergeKeep([open, other]) === open;
  const keep = openIsOlder ? open : other;
  const remove = openIsOlder ? other : open;
  const added = remove.collections.filter((id, i, all) => !keep.collections.includes(id) && all.indexOf(id) === i);
  return { keep, remove, removesOpen: !openIsOlder, collections: added.length > 0 ? [...keep.collections, ...added] : null };
}

/** The confirmation's text: which entry stays, which collections move, which is deleted. */
export function mergeConfirmMessage(plan: KnowledgeMergePlan): string {
  const kept = `“${plan.keep.title || "Untitled"}”`;
  const removed = `“${plan.remove.title || "Untitled"}”`;
  const keptSaved = formatKnowledgeDate(plan.keep.savedAt);
  const removedSaved = formatKnowledgeDate(plan.remove.savedAt);
  const older = keptSaved ? ` (saved ${keptSaved})` : "";
  const newer = removedSaved ? ` (saved ${removedSaved})` : "";
  const moves = plan.collections ? "adds its collections to the one kept" : "the one kept already has all its collections";
  return plan.removesOpen
    ? `Keeps the older entry, ${kept}${older}, and deletes this one${newer}: ${moves}.`
    : `Keeps this entry, the older one${older}, and deletes ${removed}${newer}: ${moves}.`;
}

/**
 * What the banner says when a merge fails: a refusal (4xx) was checked before anything changed;
 * anything else may have stopped part-way (the daemon's message then says what was done).
 */
export function mergeErrorText(error: unknown): string {
  const reason = knowledgeErrorText(error);
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 ? `Nothing was merged: ${reason}` : `The merge may not have finished: ${reason}`;
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** Characters of a body rendered as Markdown before "Show the rest" (a 200 KB body would stall the panel). */
const MARKDOWN_BODY_PREVIEW_CHARS = 20_000;

/**
 * The start of a long body for the Markdown view: cut at a paragraph (else line) break in the last
 * half of `limit`, never inside a surrogate pair, and with an open code fence closed. `rest` counts
 * the characters left out (0: the whole body).
 */
export function markdownBodyPreview(body: string, limit = MARKDOWN_BODY_PREVIEW_CHARS): { text: string; rest: number } {
  if (body.length <= limit) return { text: body, rest: 0 };
  const floor = Math.floor(limit / 2);
  let cut = body.lastIndexOf("\n\n", limit);
  if (cut < floor) cut = body.lastIndexOf("\n", limit);
  if (cut < floor) {
    cut = limit;
    const code = body.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  let text = body.slice(0, cut).replace(/\s+$/, "");
  const fence = openCodeFence(text);
  if (fence) text += `\n${fence}`;
  return { text, rest: body.length - cut };
}

/**
 * The fence that closes the code block still open at the end of `text`, or null when none is
 * (CommonMark: an opening fence is 3+ backticks or tildes indented at most 3 spaces — a backtick
 * one with no backtick in its info string; only a run of the same character, at least as long,
 * with nothing but spaces after it closes it).
 */
function openCodeFence(text: string): string | null {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    const after = match[2]!;
    if (!open) {
      if (run[0] === "`" && after.includes("`")) continue;
      open = { char: run[0]!, length: run.length };
    } else if (run[0] === open.char && run.length >= open.length && after.trim() === "") open = null;
  }
  return open ? open.char.repeat(open.length) : null;
}

// ---------------------------------------------------------------------------
// Session memory ("Plain text", "Keep both")
// ---------------------------------------------------------------------------

let plainText = false;
const keptPairs = new Set<string>();
const listeners = new Set<() => void>();

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Moves with every session change (the hooks' `useSyncExternalStore` snapshot). */
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribePanelSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether entry bodies show as plain text instead of Markdown (every panel, this session). */
export function isPlainTextBody(): boolean {
  return plainText;
}

export function setPlainTextBody(value: boolean): void {
  if (plainText === value) return;
  plainText = value;
  emit();
}

/** "Keep both": the two entries are not offered as duplicates of each other again this session. */
export function keepDuplicatePair(a: string, b: string): void {
  const key = pairKey(a, b);
  if (keptPairs.has(key)) return;
  keptPairs.add(key);
  emit();
}

function isDuplicatePairKept(a: string, b: string): boolean {
  return keptPairs.has(pairKey(a, b));
}

export function panelSessionVersion(): number {
  return version;
}

/** The `ids` an entry panel shows besides its own: a change to any of them makes it stale. */
export function entryPanelIds(detail: Pick<KnowledgeEntryDetail, "entry" | "related" | "similar" | "possibleDuplicates">): string[] {
  const ids = new Set<string>([detail.entry.id]);
  const add = (entries: readonly Pick<KnowledgeEntrySummary, "id">[]) => entries.forEach((e) => ids.add(e.id));
  add(detail.related);
  add((detail.similar ?? []).map((item) => item.entry));
  add((detail.possibleDuplicates ?? []).map((item) => item.entry));
  return [...ids];
}
