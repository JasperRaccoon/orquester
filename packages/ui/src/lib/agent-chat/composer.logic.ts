/** Agent chat draft persistence and field-wise attachment/context validation (§7.4). */

import type { AttachmentRef, ComposerContextRecord } from "@orquester/api/agent-chat";

// Drafts (§7.4)
// ---------------------------------------------------------------------------

/**
 * A composer draft: what the user has typed, attached and not sent.
 *
 * Unlike a queued message — a live intent held in memory (§7.4) — this is
 * persisted per thread, and the mounted composer writes it on every change
 * (debounced) so it genuinely survives what the component does not: a tab
 * switch, a switch to a project whose tabs unmount it, and a reload.
 *
 * `attachments` are references whose bytes are already on the daemon; an
 * upload still in flight is identified by a `File` no storage can carry, so it
 * is dropped rather than half-persisted.
 */
export interface ComposerDraft {
  text: string;
  attachments: AttachmentRef[];
  context: ComposerContextRecord[];
  /**
   * Passages quoted from the agent's replies, in the order they were added.
   * Absent when there are none, so a draft without quotes keeps the shape an
   * older bundle wrote and reads. Sent as blockquotes ahead of `text`
   * (`composeQuotedPrompt`).
   */
  quotes?: ComposerQuote[];
}

/**
 * One passage of an agent's reply quoted into the composer: its markdown,
 * rebuilt from what the user selected (`selectionMarkdown`), and the id its
 * chip is keyed by. The id is the draft's own, never the message's: the same
 * passage may be quoted twice.
 */
export interface ComposerQuote {
  id: string;
  text: string;
}

/** How many quotes one draft holds. */
export const MAX_COMPOSER_QUOTES = 20;

/**
 * The longest passage one quote holds. The whole prompt is still measured
 * against the turn input bound on send; this keeps a selection of a whole
 * long thread from landing in `localStorage` as one quote.
 */
export const MAX_COMPOSER_QUOTE_CHARS = 50_000;

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [], context: [] };

function draftIsEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length === 0 &&
    draft.attachments.length === 0 &&
    draft.context.length === 0 &&
    (draft.quotes?.length ?? 0) === 0
  );
}

/**
 * The absolute host path an upload answered for a ref (§7.4), or undefined —
 * the `unknown` arm never has one, an older bundle never wrote one.
 */
export function attachmentPathOf(ref: AttachmentRef | undefined): string | undefined {
  if (ref === undefined || !("path" in ref)) return undefined;
  return typeof ref.path === "string" && ref.path.length > 0 ? ref.path : undefined;
}

/**
 * A persisted ref's `path` must be a non-empty string or absent: a malformed
 * one from a stale blob must never reach `removeFilePath` (AGENTS.md: raw
 * `JSON.parse` output never reaches typed code).
 */
function normalisePersistedAttachment(ref: AttachmentRef): AttachmentRef {
  if (!("path" in ref) || attachmentPathOf(ref) !== undefined) return ref;
  const { path: _dropped, ...rest } = ref;
  return rest;
}

const DRAFTS_KEY = "orquester:agent-chat-drafts";
const MAX_PERSISTED_DRAFTS = 50;

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.type === "image" || record.type === "file" || record.type === "unknown") &&
    typeof record.id === "string" &&
    typeof record.name === "string"
  );
}

function isContextRecord(value: unknown): value is ComposerContextRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string" && typeof record.label === "string";
}

/**
 * A persisted list of attachment refs, field-wise: every entry that is a ref
 * (its `path` normalised), anything else dropped — never the whole list. The
 * one reading of a stored ref, for the drafts and the tab's outbox
 * (`composer-outbox.ts`) alike.
 */
export function parsePersistedAttachmentRefs(value: unknown): AttachmentRef[] {
  return Array.isArray(value) ? value.filter(isAttachmentRef).map(normalisePersistedAttachment) : [];
}

/** A persisted list of composer context records, field-wise, as {@link parsePersistedAttachmentRefs}. */
export function parsePersistedContextRecords(value: unknown): ComposerContextRecord[] {
  return Array.isArray(value) ? value.filter(isContextRecord) : [];
}

function isQuote(value: unknown): value is ComposerQuote {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.text === "string" &&
    record.text.trim().length > 0 &&
    record.text.length <= MAX_COMPOSER_QUOTE_CHARS
  );
}

/**
 * A persisted list of quotes, field-wise: every well-formed entry narrowed to
 * its own fields, the first of a repeated id, at most
 * {@link MAX_COMPOSER_QUOTES}. Anything else is dropped, never the whole list.
 */
export function parsePersistedQuotes(value: unknown): ComposerQuote[] {
  if (!Array.isArray(value)) return [];
  const quotes: ComposerQuote[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isQuote(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    quotes.push({ id: entry.id, text: entry.text });
    if (quotes.length === MAX_COMPOSER_QUOTES) break;
  }
  return quotes;
}

/**
 * Field-wise validation with a fallback, per AGENTS.md: **raw `JSON.parse`
 * output must never reach typed code** — an old bundle's payload outlives a
 * deploy, and one malformed blob must degrade to "no draft", never crash the
 * client on load.
 */
export function parsePersistedDrafts(raw: string | null): Record<string, ComposerDraft> {
  if (!raw) {
    return {};
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return {};
  }
  const result: Record<string, ComposerDraft> = {};
  for (const [sessionId, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.text !== "string") {
      continue;
    }
    const quotes = parsePersistedQuotes(record.quotes);
    result[sessionId] = {
      text: record.text,
      attachments: parsePersistedAttachmentRefs(record.attachments),
      context: parsePersistedContextRecords(record.context),
      ...(quotes.length > 0 ? { quotes } : {})
    };
  }
  return result;
}

export function readPersistedDrafts(): Record<string, ComposerDraft> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    return parsePersistedDrafts(localStorage.getItem(DRAFTS_KEY));
  } catch {
    return {};
  }
}

export function writePersistedDrafts(drafts: Record<string, ComposerDraft>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    const entries = Object.entries(drafts).filter(([, draft]) => !draftIsEmpty(draft));
    const bounded = entries.slice(Math.max(0, entries.length - MAX_PERSISTED_DRAFTS));
    if (bounded.length === 0) {
      localStorage.removeItem(DRAFTS_KEY);
      return;
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(bounded)));
  } catch {
    /* private window, blocked storage, quota — a draft is a convenience */
  }
}
