/**
 * The Knowledge tab's pure rules: colours, error and status text, and the
 * collection and entry forms. No React, no store.
 */

import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX,
  KNOWLEDGE_COLLECTION_NAME_MAX,
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_TITLE_MAX,
  type KnowledgeCollection,
  type KnowledgeCollectionView,
  type KnowledgeColor,
  type KnowledgeEntry,
  type KnowledgeEntryMeta,
  type KnowledgeErrorCode,
  type KnowledgeLinkingState,
  type KnowledgePauseReason,
  type KnowledgeRunSummary,
  type KnowledgeStatus,
  type UpdateKnowledgeEntryRequest
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** The theme custom property behind a palette key (`chart-N` is the app's `--lane-N`). */
export function knowledgeColorProperty(color: KnowledgeColor): string {
  return `--lane-${color.slice("chart-".length)}`;
}

/** CSS colour of a palette key, following the theme (light/dark, scheme). */
export function knowledgeColorCss(color: KnowledgeColor): string {
  return `rgb(var(${knowledgeColorProperty(color)}))`;
}

/** The palette key a new collection gets: the first one no collection uses yet, else round-robin. */
export function nextKnowledgeColor(collections: readonly Pick<KnowledgeCollection, "color">[], palette: readonly KnowledgeColor[]): KnowledgeColor {
  const used = new Set(collections.map((c) => c.color));
  return palette.find((c) => !used.has(c)) ?? palette[collections.length % palette.length]!;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_CODES: ReadonlySet<string> = new Set<KnowledgeErrorCode>([
  "KNOWLEDGE_DISABLED",
  "KNOWLEDGE_NOT_INSTALLED",
  "KNOWLEDGE_NOT_FOUND",
  "KNOWLEDGE_INVALID",
  "KNOWLEDGE_COLLECTION_EXISTS",
  "KNOWLEDGE_UNKNOWN_COLLECTION",
  "KNOWLEDGE_TOO_LARGE",
  "KNOWLEDGE_NOT_A_WORKER",
  "KNOWLEDGE_BUSY"
]);

const FALLBACK_TEXT: Partial<Record<KnowledgeErrorCode, string>> = {
  KNOWLEDGE_DISABLED: "The Knowledge Graph plugin is off.",
  KNOWLEDGE_NOT_INSTALLED: "The Knowledge Graph plugin is not installed yet.",
  KNOWLEDGE_NOT_FOUND: "It no longer exists.",
  KNOWLEDGE_COLLECTION_EXISTS: "A collection with that name already exists.",
  KNOWLEDGE_UNKNOWN_COLLECTION: "One of the collections no longer exists.",
  KNOWLEDGE_TOO_LARGE: "The text is too long.",
  KNOWLEDGE_BUSY: "The knowledge base is busy; try again in a moment."
};

/** The `{ code, message }` (or `{ error: { code, message } }`) a refused route sent, when any. */
function errorBody(error: unknown): { code?: unknown; message?: unknown } | null {
  const body = (error as { body?: unknown } | null)?.body;
  if (!body || typeof body !== "object") return null;
  const inner = (body as { error?: unknown }).error;
  if (inner && typeof inner === "object") return inner as { code?: unknown; message?: unknown };
  return body as { code?: unknown; message?: unknown };
}

/** The knowledge error code of a refused request, or null. */
export function knowledgeErrorCode(error: unknown): KnowledgeErrorCode | null {
  const code = errorBody(error)?.code;
  return typeof code === "string" && ERROR_CODES.has(code) ? (code as KnowledgeErrorCode) : null;
}

/** What to show for a failed knowledge request: the daemon's message, else a text for its code, else the error's own. */
export function knowledgeErrorText(error: unknown): string {
  const body = errorBody(error);
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  const code = knowledgeErrorCode(error);
  if (code && FALLBACK_TEXT[code]) return FALLBACK_TEXT[code]!;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "12 entries · 340 concepts · 5 collections". */
export function knowledgeCountsText(status: Pick<KnowledgeStatus, "entries" | "concepts" | "collections">): string {
  return [
    plural(status.entries, "entry", "entries"),
    plural(status.concepts, "concept", "concepts"),
    plural(status.collections, "collection", "collections")
  ].join(" · ");
}

const PAUSE_TEXT: Record<KnowledgePauseReason, string> = {
  "usage-limit": "every Claude account is at its usage limit",
  "no-account": "no Claude account can run it",
  "not-installed": "the plugin is not installed",
  "plugin-off": "the plugin is off",
  error: "the last run failed"
};

export interface LinkingView {
  /** `failed`: idle, but some entries' last run could not link them. */
  tone: "idle" | "queued" | "running" | "paused" | "failed";
  /** The short line the status bar shows. */
  label: string;
  /** More context (a tooltip / second line), or null. */
  detail: string | null;
  /** 0..1 while running with known progress, else null. */
  progress: number | null;
}

function clock(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/**
 * How the status bar describes linking; `runs` gives the running run's entry count, and
 * `failedEntries` the entries a run could not link (an idle state then says so, never "Every entry
 * is linked.").
 */
export function linkingView(
  linking: KnowledgeLinkingState,
  runs: readonly KnowledgeRunSummary[] = [],
  now = Date.now(),
  failedEntries = 0
): LinkingView {
  switch (linking.state) {
    case "idle":
      if (failedEntries > 0) {
        return {
          tone: "failed",
          label: `${plural(failedEntries, "entry", "entries")} could not be linked`,
          detail: "See Settings → Plugins → Knowledge Graph for the last error.",
          progress: null
        };
      }
      return { tone: "idle", label: "Linking idle", detail: "Every entry is linked.", progress: null };
    case "queued": {
      const startsIn = Math.round((new Date(linking.startsAt).getTime() - now) / 1000);
      const when = Number.isFinite(startsIn) && startsIn > 0 ? `starts in ${startsIn < 60 ? `${startsIn}s` : `${Math.ceil(startsIn / 60)} min`}` : "starts shortly";
      return {
        tone: "queued",
        label: `Linking queued · ${plural(linking.pendingEntries, "entry", "entries")}`,
        detail: `Linking ${when}.`,
        progress: null
      };
    }
    case "running": {
      const run = runs.find((r) => r.id === linking.runId);
      const what = run && run.entries > 0 ? `Linking ${plural(run.entries, "entry", "entries")}…` : "Linking…";
      const progress = linking.progress && linking.progress.total > 0 ? linking.progress.done / linking.progress.total : null;
      const parts: string[] = [];
      if (linking.progress && linking.progress.total > 0) parts.push(`${linking.progress.done} of ${linking.progress.total} steps`);
      if (linking.step) parts.push(`step ${linking.step}`);
      if (linking.mode === "rebuild" || linking.mode === "full") parts.push("full extraction");
      if (linking.pendingEntries > 0) parts.push(`${plural(linking.pendingEntries, "entry", "entries")} waiting for the next run`);
      return { tone: "running", label: what, detail: parts.length ? parts.join(" · ") : null, progress };
    }
    case "paused": {
      const resumes = linking.resumesAt ? clock(linking.resumesAt) : null;
      const parts = [linking.message || null, resumes ? `Resumes at ${resumes}.` : null].filter((p): p is string => p !== null);
      return {
        tone: "paused",
        label: `Linking paused: ${PAUSE_TEXT[linking.reason]}`,
        detail: parts.length ? parts.join(" ") : null,
        progress: null
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface CollectionForm {
  name: string;
  description: string;
  color: KnowledgeColor;
}

/** Why a collection form cannot be saved, or null. `editingId` is the collection being edited. */
export function collectionFormError(
  form: Pick<CollectionForm, "name" | "description">,
  collections: readonly Pick<KnowledgeCollection, "id" | "name">[],
  editingId: string | null
): string | null {
  const name = form.name.trim();
  if (!name) return "Give the collection a name.";
  if (name.length > KNOWLEDGE_COLLECTION_NAME_MAX) return `Names are at most ${KNOWLEDGE_COLLECTION_NAME_MAX} characters.`;
  if (/[\r\n]/.test(form.description)) return "The description is one line.";
  if (form.description.trim().length > KNOWLEDGE_COLLECTION_DESCRIPTION_MAX) {
    return `Descriptions are at most ${KNOWLEDGE_COLLECTION_DESCRIPTION_MAX} characters.`;
  }
  const lower = name.toLowerCase();
  if (collections.some((c) => c.id !== editingId && c.name.trim().toLowerCase() === lower)) return `There is already a collection named “${name}”.`;
  return null;
}

/** "SEO · SaaS expert, Mobile expert" — the profiles that see a collection, or null when none does. */
export function collectionProfilesText(collection: Pick<KnowledgeCollectionView, "profiles">): string | null {
  return collection.profiles.length > 0 ? collection.profiles.map((p) => p.name).join(", ") : null;
}

/** The delete confirmation's explanation. */
export function deleteCollectionMessage(collection: Pick<KnowledgeCollectionView, "name" | "entryCount">): string {
  const entries =
    collection.entryCount === 0
      ? "It has no entries."
      : `Its ${plural(collection.entryCount, "entry", "entries")} lose the label; an entry with no other collection becomes Unfiled, which only Global chats see.`;
  return `Delete the collection “${collection.name}”? ${entries} No entry is deleted.`;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** "Om Patel · @om_patel5", "@om_patel5", "Om Patel", or null. */
export function entryByline(entry: Pick<KnowledgeEntryMeta, "author" | "handle">): string | null {
  const parts = [entry.author, entry.handle ? `@${entry.handle}` : null].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** A short date ("Oct 11, 2026") for an ISO date or date-time; the raw text when it does not parse. */
export function formatKnowledgeDate(iso: string | null): string | null {
  if (!iso) return null;
  // A bare date is the author's calendar day: never shift it by the viewer's zone.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const at = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (!Number.isFinite(at.getTime())) return iso;
  return at.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
}

/** The date an entry card shows: when it was posted, else when it was saved. */
export function entryDate(entry: Pick<KnowledgeEntryMeta, "postedAt" | "savedAt">): string | null {
  return formatKnowledgeDate(entry.postedAt ?? entry.savedAt);
}

/** Only an http(s) URL is offered as "Open post". */
export function entryPostUrl(entry: Pick<KnowledgeEntryMeta, "url">): string | null {
  return entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null;
}

export interface EntryForm {
  title: string;
  body: string;
  kind: string;
  author: string;
  handle: string;
  url: string;
  postedAt: string;
  collections: string[];
}

export function entryFormOf(entry: KnowledgeEntry): EntryForm {
  return {
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    author: entry.author ?? "",
    handle: entry.handle ?? "",
    url: entry.url ?? "",
    postedAt: entry.postedAt ?? "",
    collections: [...entry.collections]
  };
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** An ISO date (`2026-10-11`) or date-time, as the daemon accepts for `postedAt`. */
function isIsoDate(text: string): boolean {
  const dateOnly = ISO_DATE.test(text);
  if (!dateOnly && !ISO_DATE_TIME.test(text)) return false;
  return Number.isFinite(Date.parse(dateOnly ? `${text}T00:00:00Z` : text));
}
const optional = (value: string): string | null => (value.trim() ? value.trim() : null);

/**
 * The PATCH an edited form makes — only the fields that changed — or the reason
 * it cannot be saved. An empty optional field clears it; a handle loses its "@".
 */
export function entryFormPatch(entry: KnowledgeEntry, form: EntryForm): { patch: UpdateKnowledgeEntryRequest } | { error: string } {
  const title = form.title.trim();
  if (!title) return { error: "Give the entry a title." };
  if (title.length > KNOWLEDGE_TITLE_MAX) return { error: `Titles are at most ${KNOWLEDGE_TITLE_MAX} characters.` };
  if (!form.body.trim()) return { error: "The text cannot be empty." };
  if (utf8Bytes(form.body) > KNOWLEDGE_ENTRY_MAX_BYTES) return { error: "The text is too long." };
  const url = optional(form.url);
  if (url && !/^https?:\/\/\S+$/i.test(url)) return { error: "The URL must start with http:// or https://." };
  const postedAt = optional(form.postedAt);
  if (postedAt && !isIsoDate(postedAt)) return { error: "The date is not a date (use YYYY-MM-DD)." };

  const patch: UpdateKnowledgeEntryRequest = {};
  if (title !== entry.title) patch.title = title;
  if (form.body !== entry.body) patch.body = form.body;
  const kind = form.kind.trim() || "note";
  if (kind !== entry.kind) patch.kind = kind;
  const author = optional(form.author);
  if (author !== entry.author) patch.author = author;
  const handle = optional(form.handle.trim().replace(/^@+/, ""));
  if (handle !== entry.handle) patch.handle = handle;
  if (url !== entry.url) patch.url = url;
  if (postedAt !== entry.postedAt) patch.postedAt = postedAt;
  const before = [...entry.collections].sort().join("\n");
  const after = [...new Set(form.collections)].sort();
  if (after.join("\n") !== before) patch.collections = after;
  return { patch };
}

/**
 * Whether a PATCH changes what the graph reads (anything but collections and the URL, which the
 * myKG input never carries — the daemon files those as a relabel): saving it queues linking.
 */
export function patchNeedsLinking(patch: UpdateKnowledgeEntryRequest): boolean {
  return Object.keys(patch).some((key) => key !== "collections" && key !== "url");
}

/** Kinds offered while editing (free-form: any other text is kept). */
export const KNOWLEDGE_KIND_SUGGESTIONS = ["post", "thread", "article", "case study", "note"] as const;
