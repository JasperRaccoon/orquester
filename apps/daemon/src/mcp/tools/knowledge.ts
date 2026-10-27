/**
 * Catalog family `knowledge` (Knowledge Graph plugin spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md, "Agent tools", "Citations";
 * retrieval spec docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md, "Agent tools (A1)"):
 * the shared knowledge base for in-chat agents — `knowledge_search`, `knowledge_get`,
 * `knowledge_save`, `knowledge_update`, `knowledge_delete`, `knowledge_merge`, `knowledge_collections`
 * — and the two tools of the plugin's own indexing sessions, `knowledge_worker_next_task` and
 * `knowledge_worker_submit`. Chat-only.
 *
 * - **Gating** is the manifest's (`session-tools/manifest.ts`): the family only while the plugin is
 *   on; search, get, update, delete and merge only to a chat that sees a collection; the worker tools
 *   only — and alone — to a worker session. The routes enforce the same on the server (visibility,
 *   `KNOWLEDGE_NOT_A_WORKER`), and every refusal they answer comes back here as a clean tool error.
 * - **Visibility** is resolved by the daemon from the calling session: every request names it
 *   (`sessionId` in the body or the query) besides carrying the call's agent principal.
 * - **Results are compact text** (spec "Light on tokens"): a few short lines per hit — collections by
 *   name, how strongly and by which signals it matched, a one-line snippet, the entry's ready-made
 *   citation — and a paging footer; full text only through `knowledge_get`, in windows of a body.
 * - **Older daemons** answer without the retrieval fields (match, total, cursor, similar entries):
 *   whatever is absent is left out of the text, never guessed.
 * - **No card**: saving, editing, deleting and merging are Act; they change only the knowledge base,
 *   and saving must stay fast. Editing, deleting and merging reach the same routes as the Knowledge tab.
 *
 * Everything goes through `DaemonApi` (D-1): this module imports types and pure contracts only.
 */

import { z } from "zod";
import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX,
  KNOWLEDGE_COLLECTION_NAME_MAX,
  KNOWLEDGE_COLLECTIONS_MAX,
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_FILTER_MAX_VALUES,
  KNOWLEDGE_MERGE_MAX_ENTRIES,
  KNOWLEDGE_SAVE_MAX_ENTRIES,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SIMILAR_MAX_EXAMPLES,
  KNOWLEDGE_TITLE_MAX,
  knowledgeRoutes,
  type KnowledgeCollectionsResponse,
  type KnowledgeConceptDetail,
  type KnowledgeEntryDetail,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeItemResponse,
  type KnowledgeMergeRequest,
  type KnowledgeMergeResponse,
  type KnowledgeRelatedReason,
  type KnowledgeSaveItem,
  type KnowledgeSaveRequest,
  type KnowledgeSaveResponse,
  type KnowledgeSearchHit,
  type KnowledgeSearchRequest,
  type KnowledgeSearchFilters,
  type KnowledgeSearchResponse,
  type KnowledgeSimilarEntry,
  type KnowledgeWorkerNextResponse,
  type KnowledgeWorkerSubmitRequest,
  type KnowledgeWorkerSubmitResponse,
  type UpdateKnowledgeEntryRequest
} from "@orquester/api";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { closedWorld, defineTool, DESTRUCTIVE, MUTATING, READ_ONLY, type AnyOrquesterTool, type CallContext, type ScopeClaim, type ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi, DaemonMethod } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText } from "../result.ts";

// ---------------------------------------------------------------------------
// Limits of what the tools render
// ---------------------------------------------------------------------------

/** A snippet is shown on one line, at most this many characters. */
const KNOWLEDGE_SNIPPET_CHARS = 280;
/** A concept description in a search hit or a list. */
const DESCRIPTION_CHARS = 200;
/** A concept's own description in `knowledge_get` (myKG merges descriptions: they can grow). */
const CONCEPT_DESCRIPTION_CHARS = 2_000;
/** A concept, type, edge or attribute name, or an alias, wherever it is shown (myKG's, unbounded). */
const NAME_CHARS = 120;
/** `knowledge_get` shows at most this many UTF-8 bytes of body text, split across the entries it reads. */
const KNOWLEDGE_GET_BODY_MAX_BYTES = 48_000;
/**
 * A whole `knowledge_get` answer stays under this many bytes (text results are not capped by the
 * executor; MAX_RESULT_BYTES is 60 000): with several ids, the body window shrinks to leave room
 * for what is around the bodies.
 */
const KNOWLEDGE_GET_OUTPUT_MAX_BYTES = 57_000;
/** Ids one `knowledge_get` call reads. */
const KNOWLEDGE_GET_MAX_IDS = 5;
/** Lists inside one `knowledge_get` answer: reading one item, and each of several. */
const GET_LIST_MAX = 12;
const GET_LIST_MAX_SEVERAL = 4;
/** Similar entries shown with an entry (the daemon sends up to 8): reading one, and each of several. */
const GET_SIMILAR_MAX = 8;
const GET_SIMILAR_MAX_SEVERAL = 4;
/** A title quoted in a list line (a search hit's own title line uses KNOWLEDGE_TITLE_MAX). */
const LIST_TITLE_CHARS = 100;
/** A paging cursor, in characters (the daemon's is a short base64url token). */
const KNOWLEDGE_CURSOR_MAX_CHARS = 1_000;
/** A date bound: an ISO date or date-time (the daemon's filter rule, `knowledge/search/filters.ts`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const YEAR = /^\d{4}$/;
/** A query, in characters (the search's own `KNOWLEDGE_QUERY_MAX`). */
const KNOWLEDGE_QUERY_MAX_CHARS = 1_000;
/** A save item's metadata, in characters: the store's limits (`knowledge/store/validate.ts`), which refuse the whole batch. */
const KIND_MAX_CHARS = 40;
const AUTHOR_MAX_CHARS = 120;
const HANDLE_MAX_CHARS = 64;
const URL_MAX_CHARS = 2_048;
/** Collections an agent may create in one save. */
const KNOWLEDGE_NEW_COLLECTIONS_MAX = 10;
/** A worker answer, in characters. */
const KNOWLEDGE_WORKER_ANSWER_MAX_CHARS = 2_000_000;
/** A collection reference: a name (≤ 60) or an id. */
const COLLECTION_REF_MAX = 64;
/** Entries one `knowledge_delete` call removes. */
const KNOWLEDGE_DELETE_MAX_IDS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The calling chat: every knowledge route resolves visibility (and workers) from it. */
function sessionIdOf(caller: ToolCaller, tool: string): string {
  if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${tool} is a chat tool.`);
  return caller.threadId;
}

/** The knowledge base is the daemon's own state and belongs to no project: nothing for the gate to classify. */
const knowledgeScope = (reads: ScopeClaim["reads"], writes: boolean): ScopeClaim => ({ projects: [], sessions: [], reads, writes, causesTurnIn: [] });

const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });

async function call<T>(api: DaemonApi, method: DaemonMethod, path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const res = await api.request(method, path, opts);
  if (res.status >= 400) throw daemonError(res);
  return res.body as T;
}

/** id → name of every collection; on a failed read the ids stand for themselves (the answer still goes out). */
async function collectionNames(api: DaemonApi): Promise<Map<string, string>> {
  try {
    const res = await api.request("GET", knowledgeRoutes.collections);
    if (res.status >= 400) return new Map();
    const collections = (res.body as Partial<KnowledgeCollectionsResponse> | null)?.collections;
    return new Map(Array.isArray(collections) ? collections.map((collection) => [collection.id, collection.name] as const) : []);
  } catch {
    return new Map();
  }
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();
/** A graph name on one line, clipped: concept, type, edge and attribute names come from myKG unbounded. */
const label = (value: string): string => clipText(oneLine(value), NAME_CHARS);

/** "Om Patel (@om_patel5)", "@om_patel5", "Om Patel" or "". */
function authorLabel(meta: Pick<KnowledgeEntryMeta, "author" | "handle">): string {
  const author = meta.author ? oneLine(meta.author) : "";
  const handle = meta.handle ? `@${oneLine(meta.handle).replace(/^@+/, "")}` : "";
  if (author && handle) return `${author} (${handle})`;
  return author || handle;
}

function inCollections(ids: readonly string[], names: ReadonlyMap<string, string>): string {
  if (ids.length === 0) return "Unfiled";
  return `in ${ids.map((id) => names.get(id) ?? id).join(", ")}`;
}

/** An entry's head line: id · kind · author · date · collections (· linking state when not linked). */
function entryHead(meta: KnowledgeEntryMeta, names: ReadonlyMap<string, string>): string {
  const parts = [meta.id, oneLine(meta.kind) || "note"];
  const who = authorLabel(meta);
  if (who) parts.push(who);
  if (meta.postedAt) parts.push(meta.postedAt.slice(0, 10));
  parts.push(inCollections(meta.collections, names));
  if (meta.linkState !== "linked") parts.push(`linking ${meta.linkState}`);
  return parts.join(" · ");
}

/** An entry summary in three short lines: head, snippet, citation. */
function entryBlock(entry: KnowledgeEntrySummary, names: ReadonlyMap<string, string>, indent = "   "): string[] {
  const lines = [entryHead(entry, names)];
  const snippet = clipText(oneLine(entry.snippet ?? ""), KNOWLEDGE_SNIPPET_CHARS);
  if (snippet) lines.push(`${indent}${snippet}`);
  lines.push(`${indent}cite: ${entry.citation}`);
  return lines;
}

/** A title quoted on one line, clipped. */
const quotedTitle = (title: string, max = LIST_TITLE_CHARS): string => `"${clipText(oneLine(title), max)}"`;

function hitLines(hit: KnowledgeSearchHit, index: number, names: ReadonlyMap<string, string>): string[] {
  const n = `${index + 1}. `;
  if (hit.kind === "entry") {
    const entry = hit.entry;
    const head = [entryHead(entry, names)];
    // An older daemon sends no match: the head stays as it was.
    if (hit.match) {
      head.push(hit.match.band);
      if (hit.match.via.length > 0) head.push(`via ${hit.match.via.join("+")}`);
    }
    const lines = [`${n}${head.join(" · ")}`, `   ${quotedTitle(entry.title, KNOWLEDGE_TITLE_MAX)}`];
    const snippet = clipText(oneLine(entry.snippet ?? ""), KNOWLEDGE_SNIPPET_CHARS);
    if (snippet) lines.push(`   ${snippet}`);
    const passage = hit.match?.passage;
    if (passage) lines.push(`   passage: chars ${passage.start}–${passage.end} (chunk ${passage.chunk + 1}/${passage.chunks})`);
    lines.push(`   cite: ${entry.citation}`);
    return lines;
  }
  const concept = hit.concept;
  const description = concept.description ? `: ${clipText(oneLine(concept.description), DESCRIPTION_CHARS)}` : "";
  // An older daemon sends the ids only.
  const listed = hit.entries && hit.entries.length > 0 ? hit.entries.map((entry) => `${entry.id} ${quotedTitle(entry.title)}`) : hit.entryIds;
  const entries = listed.length > 0 ? ` · entries ${listed.join(", ")}` : "";
  return [`${n}concept ${concept.id} "${label(concept.name)}" (${label(concept.type)})${description}${entries}`];
}

/** The offset of the page a cursor asks for (the daemon's base64url `{v, o, h}`), or null when it cannot be read. */
function cursorOffset(cursor: string): number | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown } | null;
    const offset = value?.o;
    return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

/** Where this page sits among every match, the next page's cursor, and a hint to narrow a long list. */
function pagingFooter(total: number, shown: number, nextCursor: string | null | undefined, cursor: string | undefined): string[] {
  const lines: string[] = [];
  if (shown > 0) {
    // The last page ends at the total even when its cursor cannot be read.
    const start = cursor === undefined ? 0 : (cursorOffset(cursor) ?? (nextCursor ? null : Math.max(0, total - shown)));
    lines.push(start === null ? `Showing ${shown} of ${total}.` : `Showing ${start + 1}–${start + shown} of ${total}.`);
  }
  if (nextCursor) lines.push(`Next page: cursor "${nextCursor}".`);
  if (total > shown) lines.push("Too many to read? Narrow it: a more specific query, collections, kinds, authors, years or dates.");
  return lines;
}

/** What the call asked beyond its words: the cursor it paged with, and whether filters narrowed it. */
interface KnowledgeSearchAsked {
  cursor?: string;
  filtered: boolean;
}

/** The search answer as the agent reads it. */
function renderSearch(response: KnowledgeSearchResponse, names: ReadonlyMap<string, string>, asked: KnowledgeSearchAsked = { filtered: false }): string {
  const searched = response.searched.map((id) => names.get(id) ?? id);
  const over = searched.length > 0 ? `over ${searched.join(", ")}` : "over no collection";
  if (response.hits.length === 0) {
    return `No knowledge found (${over}${asked.filtered ? ", with these filters" : ""}). Don't answer as if it came from the knowledge base.`;
  }
  const lines = [`${response.hits.length} hit${response.hits.length === 1 ? "" : "s"} (${over}). Read one whole with knowledge_get; cite each entry you use with its cite link, verbatim.`];
  if (response.hits.some((hit) => hit.kind === "entry" && hit.match?.band === "weak")) lines.push("Weak hits may be unrelated: never cite one as evidence.");
  response.hits.forEach((hit, index) => lines.push(...hitLines(hit, index, names)));
  // An older daemon sends no total: no footer.
  if (typeof response.total === "number") {
    const shown = response.hits.filter((hit) => hit.kind === "entry").length;
    lines.push(...pagingFooter(response.total, shown, response.nextCursor, asked.cursor));
  }
  return lines.join("\n");
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Where a window asked to start at `from` starts: within the body, and never between the halves of a surrogate pair. */
function windowStart(body: string, from: number): number {
  const start = Math.min(Math.max(0, from), body.length);
  return start > 0 && start < body.length && isLowSurrogate(body.charCodeAt(start)) && isHighSurrogate(body.charCodeAt(start - 1)) ? start - 1 : start;
}

/**
 * The window of `body` from `start` (character offsets: UTF-16 code units, as the daemon's passage
 * offsets are) holding at most `maxBytes` UTF-8 bytes, never splitting a surrogate pair. A lone
 * surrogate counts as the 3 bytes its replacement character takes.
 */
function bodyWindow(body: string, start: number, maxBytes: number): { text: string; end: number } {
  let end = start;
  let bytes = 0;
  while (end < body.length) {
    const code = body.codePointAt(end)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += code > 0xffff ? 2 : 1;
  }
  return { text: body.slice(start, end), end };
}

/** Split `budget` bytes across bodies that need `needs` bytes: none gets more than it needs; what is left is shared evenly. */
function splitBudget(needs: readonly number[], budget: number): number[] {
  const shares = needs.map(() => 0);
  const order = needs.map((need, index) => ({ need, index })).sort((a, b) => a.need - b.need || a.index - b.index);
  let left = Math.max(0, budget);
  order.forEach(({ need, index }, position) => {
    const share = Math.min(need, Math.floor(left / (order.length - position)));
    shares[index] = share;
    left -= share;
  });
  return shares;
}

/** A body window's footer: where it sits, and the offset to continue from when it is cut. */
function windowFooter(start: number, end: number, length: number, from: number): string | null {
  if (from > length) return `[from=${from} is past the end: the body has ${length} chars]`;
  if (end < length) return `[chars ${start}–${end} of ${length} — continue with from=${end}]`;
  return start > 0 ? `[chars ${start}–${end} of ${length}, the end]` : null;
}

/** "meaning 0.91", "shares concepts A, B +2 more", "same author". */
function reasonText(reason: KnowledgeRelatedReason): string {
  if (reason.kind === "meaning") return `meaning ${reason.similarity.toFixed(2)}`;
  if (reason.kind === "author") return "same author";
  const named = reason.concepts.slice(0, 3).map((concept) => label(concept.name));
  if (named.length === 0) return `shares ${reason.shared} concept${reason.shared === 1 ? "" : "s"}`;
  const more = reason.shared - named.length;
  return `shares concept${reason.shared === 1 ? "" : "s"} ${named.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
}

/** One similar entry: id, title and every reason on one line, its citation on the next. */
function similarLines(item: KnowledgeSimilarEntry): string[] {
  return [[`- ${item.entry.id} ${quotedTitle(item.entry.title)}`, ...item.reasons.map(reasonText)].join(" · "), `  cite: ${item.entry.citation}`];
}

/**
 * An entry's lines down to its body's separator. Reading on (`from` > 0) shows only the head: the
 * concepts and neighbours came with the first window.
 */
function entryLines(detail: KnowledgeEntryDetail, names: ReadonlyMap<string, string>, from: number, several: boolean): string[] {
  const entry = detail.entry;
  const lines = [`cite: ${detail.citation}`, `entry ${entryHead(entry, names)}`, `Title: ${oneLine(entry.title)}`];
  if (entry.url) lines.push(`URL: ${entry.url}`);
  if (from === 0) {
    const listMax = several ? GET_LIST_MAX_SEVERAL : GET_LIST_MAX;
    if (detail.concepts.length > 0) {
      const shown = detail.concepts.slice(0, listMax).map((concept) => `${label(concept.name)} (${label(concept.type)}) [${concept.id}]`);
      const more = detail.concepts.length - shown.length;
      lines.push(`Concepts: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`);
    }
    const duplicates = detail.possibleDuplicates ?? [];
    if (detail.similar !== undefined) {
      // A possible duplicate is listed once, below.
      const duplicateIds = new Set(duplicates.map((duplicate) => duplicate.entry.id));
      const similar = detail.similar.filter((item) => !duplicateIds.has(item.entry.id)).slice(0, several ? GET_SIMILAR_MAX_SEVERAL : GET_SIMILAR_MAX);
      if (similar.length > 0) lines.push("Similar:", ...similar.flatMap(similarLines));
    } else if (detail.related.length > 0) {
      // An older daemon: the concept-related entries only.
      lines.push("Related:");
      for (const related of detail.related.slice(0, listMax)) lines.push(`- ${entryHead(related, names)}`, `  cite: ${related.citation}`);
    }
    if (duplicates.length > 0) {
      lines.push("Possible duplicates (if one is the same content, knowledge_merge them):");
      for (const duplicate of duplicates.slice(0, 3)) {
        const similarity = duplicate.similarity === null ? "" : ` (${duplicate.similarity.toFixed(2)})`;
        lines.push(`- ${duplicate.entry.id} ${quotedTitle(duplicate.entry.title)}${similarity}`, `  cite: ${duplicate.entry.citation}`);
      }
    }
  }
  lines.push("---");
  return lines;
}

function renderConceptDetail(detail: KnowledgeConceptDetail, names: ReadonlyMap<string, string>, listMax = GET_LIST_MAX): string {
  const concept = detail.concept;
  const lines = [`concept ${concept.id} "${label(concept.name)}" (${label(concept.type)}) · confidence ${concept.confidence.toFixed(2)} · ${inCollections(detail.collections, names)}`];
  if (concept.aliases.length > 0) {
    const more = concept.aliases.length - listMax;
    lines.push(`Aliases: ${concept.aliases.slice(0, listMax).map(label).join(", ")}${more > 0 ? `, +${more} more` : ""}`);
  }
  if (concept.description) lines.push(clipText(concept.description.trim(), CONCEPT_DESCRIPTION_CHARS));
  const attributes = Object.entries(concept.attributes).slice(0, listMax);
  if (attributes.length > 0) lines.push(`Attributes: ${attributes.map(([key, attribute]) => `${label(key)}: ${clipText(oneLine(attribute.value), DESCRIPTION_CHARS)}`).join("; ")}`);
  if (detail.entries.length > 0) {
    lines.push("Entries:");
    for (const entry of detail.entries.slice(0, listMax)) {
      const [head, ...rest] = entryBlock(entry, names, "  ");
      lines.push(`- ${head}`, ...rest);
    }
  }
  if (detail.neighbors.length > 0) {
    lines.push("Links:");
    for (const { edge, concept: other } of detail.neighbors.slice(0, listMax * 2)) {
      const arrow = edge.from === concept.id ? `${label(edge.type)} →` : `← ${label(edge.type)}`;
      lines.push(`- ${arrow} ${label(other.name)} (${label(other.type)}) [${other.id}]`);
    }
  }
  return lines.join("\n");
}

/** One id of a get call: what the daemon answered, or its refusal. */
type KnowledgeGetOutcome = { id: string; response: KnowledgeItemResponse } | { id: string; error: ToolError };

/** Room kept for a body window's footer line (its numbers are at most six digits each). */
const WINDOW_FOOTER_BYTES = 100;

/**
 * The get answer as the agent reads it: each item (with several, under a numbered separator), an
 * entry's body in a window from `from`. The windows share KNOWLEDGE_GET_BODY_MAX_BYTES — less when
 * the text around them needs the room to stay under KNOWLEDGE_GET_OUTPUT_MAX_BYTES.
 */
function renderItems(outcomes: readonly KnowledgeGetOutcome[], names: ReadonlyMap<string, string>, from = 0): string {
  const several = outcomes.length > 1;
  const pieces = outcomes.map((outcome, index) => {
    const separator = several ? [`=== ${index + 1}/${outcomes.length} ${outcome.id} ===`] : [];
    if ("error" in outcome) {
      return { head: [...separator, `Not read: ${clipText(oneLine(outcome.error.message), DESCRIPTION_CHARS)} (${outcome.error.code})`].join("\n"), body: null };
    }
    if (outcome.response.kind === "concept") {
      return { head: [...separator, renderConceptDetail(outcome.response.concept, names, several ? GET_LIST_MAX_SEVERAL : GET_LIST_MAX)].join("\n"), body: null };
    }
    const body = outcome.response.entry.entry.body;
    return { head: [...separator, ...entryLines(outcome.response.entry, names, from, several)].join("\n"), body: { text: body, start: windowStart(body, from) } };
  });
  const around = pieces.reduce((sum, piece) => sum + Buffer.byteLength(piece.head, "utf8") + 2 + (piece.body ? WINDOW_FOOTER_BYTES : 0), 0);
  const budget = Math.min(KNOWLEDGE_GET_BODY_MAX_BYTES, KNOWLEDGE_GET_OUTPUT_MAX_BYTES - around);
  const bodies = pieces.flatMap((piece) => (piece.body ? [piece.body] : []));
  const shares = splitBudget(
    bodies.map((body) => Buffer.byteLength(body.text.slice(body.start), "utf8")),
    budget
  );
  let next = 0;
  const out = pieces
    .map((piece) => {
      if (!piece.body) return piece.head;
      const { text: shown, end } = bodyWindow(piece.body.text, piece.body.start, shares[next++]!);
      const footer = windowFooter(piece.body.start, end, piece.body.text.length, from);
      return [piece.head, shown, ...(footer ? [footer] : [])].join("\n");
    })
    .join(several ? "\n\n" : "\n");
  // Only the text around the bodies can still be too long (several large concepts): cut it, and say so.
  if (Buffer.byteLength(out, "utf8") <= KNOWLEDGE_GET_OUTPUT_MAX_BYTES) return out;
  return `${bodyWindow(out, 0, KNOWLEDGE_GET_OUTPUT_MAX_BYTES - 100).text}\n[… the rest is cut at the result limit: read fewer ids at once]`;
}

/** The save answer: what was saved, what was already there (or may be: close in meaning), what was created. */
function renderSave(response: KnowledgeSaveResponse, names: ReadonlyMap<string, string>): string {
  const all = new Map(names);
  for (const created of response.createdCollections) all.set(created.id, created.name);
  const saved = response.results.filter((result) => result.status === "saved").length;
  const duplicates = response.results.length - saved;
  const linking = response.linking === "not-needed" ? "nothing to link" : `linking ${response.linking}`;
  const lines = [`Saved ${saved} entr${saved === 1 ? "y" : "ies"}${duplicates > 0 ? `, ${duplicates} already saved` : ""}; ${linking}.`];
  if (response.createdCollections.length > 0) {
    lines.push(`Created collection${response.createdCollections.length === 1 ? "" : "s"} ${response.createdCollections.map((collection) => `"${collection.name}"`).join(", ")}: tell the user.`);
  }
  for (const result of response.results) {
    const where = inCollections(result.collections, all);
    lines.push(result.status === "saved" ? `- saved ${result.entryId} · ${where} · cite: ${result.citation}` : `- already saved as ${result.entryId} (not saved again; the collections it is in now) · ${where} · cite: ${result.citation}`);
    // Close in meaning to an entry already there (absent from an older daemon).
    if (result.status === "saved") {
      for (const similar of result.similar ?? []) {
        lines.push(`  possible duplicate of ${similar.entryId} ${quotedTitle(similar.title)} (${similar.similarity.toFixed(2)}) — if it is the same content, knowledge_merge the two`);
      }
    }
  }
  return lines.join("\n");
}

/** The edit answer: what changed, the entry as it is now, its citation (relinking shows in the head). */
function renderUpdate(detail: KnowledgeEntryDetail, changed: readonly string[], names: ReadonlyMap<string, string>): string {
  const entry = detail.entry;
  return [`Updated ${changed.join(", ")}.`, `entry ${entryHead(entry, names)}`, `Title: ${oneLine(entry.title)}`, `cite: ${detail.citation}`].join("\n");
}

/** One id of a delete call: deleted (with what it was), or refused (with the daemon's words). */
type KnowledgeDeleteOutcome = { id: string; deleted: true; title: string } | { id: string; deleted: false; message: string };

/** The delete answer: what was deleted, what was not and why. */
function renderDelete(outcomes: readonly KnowledgeDeleteOutcome[]): string {
  const deleted = outcomes.filter((outcome) => outcome.deleted).length;
  const failed = outcomes.length - deleted;
  const lines = [`Deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}${failed > 0 ? `; ${failed} not deleted` : ""}. Their cite links no longer resolve.`];
  for (const outcome of outcomes) {
    lines.push(outcome.deleted ? `- deleted ${outcome.id} "${clipText(oneLine(outcome.title), NAME_CHARS)}"` : `- not deleted ${outcome.id}: ${clipText(oneLine(outcome.message), DESCRIPTION_CHARS)}`);
  }
  return lines.join("\n");
}

/** The merge answer: the entry kept as it is now, its citation, and what was deleted. */
function renderMerge(response: KnowledgeMergeResponse, names: ReadonlyMap<string, string>): string {
  const entry = response.kept.entry;
  const count = response.deleted.length;
  return [
    `Merged ${count + 1} entries into ${entry.id}; deleted ${response.deleted.join(", ")}. Their cite links no longer resolve: cite the kept one.`,
    `entry ${entryHead(entry, names)}`,
    `Title: ${oneLine(entry.title)}`,
    `cite: ${response.kept.citation}`
  ].join("\n");
}

/** Every collection, one line each. */
function renderCollections(response: KnowledgeCollectionsResponse): string {
  const lines = [`${response.collections.length} collection${response.collections.length === 1 ? "" : "s"}, ${response.totalEntries} entries (${response.unfiledCount} unfiled).`];
  for (const collection of response.collections) {
    const description = collection.description ? `: ${clipText(oneLine(collection.description), DESCRIPTION_CHARS)}` : "";
    lines.push(`- ${oneLine(collection.name)} (${collection.entryCount})${description}`);
  }
  if (response.collections.length === 0) lines.push("None yet: knowledge_save can create one (newCollections).");
  return lines.join("\n");
}

/** A worker's next task (or the word to stop). */
export function renderWorkerNext(next: KnowledgeWorkerNextResponse): string {
  if (next.kind === "done") return `No task (${next.reason}). End your turn now.`;
  const task = next.task;
  const lines = [`Task ${task.taskId} · step ${task.step} · answer ≤ ${task.maxTokens} tokens · ${task.remaining} more waiting`];
  if (task.instructions === null) lines.push(`Instructions: the same as task ${task.sameInstructionsAs ?? "before"}.`);
  else lines.push("Instructions:", task.instructions);
  lines.push("", "Input:", task.input, "", `Reply with knowledge_worker_submit: taskId "${task.taskId}" and the answer — only the JSON text the instructions ask for.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const collectionRef = z.string().trim().min(1).max(COLLECTION_REF_MAX);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
/** An edit's metadata field: a new value, or null to clear it. */
const clearableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
/** An entry id, as citations carry it. */
const entryId = z.string().trim().regex(/^ke_[a-z0-9]{12}$/, "an entry id looks like ke_ and 12 letters or digits");

/** A search's example entries (`similarTo`, `unlike`). */
const exampleIds = z.array(entryId).max(KNOWLEDGE_SIMILAR_MAX_EXAMPLES);
/**
 * A filter list (`kinds`, `authors`): values of at most `max` characters. Refinements here and below,
 * not lengths or patterns: they cost the advertised schema nothing (the family's byte budget), and
 * the daemon checks the same.
 */
const filterValues = (max: number) =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .refine((value) => value.length <= max, `at most ${max} characters`)
    )
    .max(KNOWLEDGE_FILTER_MAX_VALUES);
const filterYear = z.string().trim().refine((value) => YEAR.test(value), "a year looks like 2025");
const dateBound = z
  .string()
  .trim()
  .refine((value) => ISO_DATE.test(value) && !Number.isNaN(Date.parse(value.slice(0, 10))), "a date bound is an ISO date (YYYY-MM-DD) or date-time");

/** The typed filters of a search call (top level, so an agent fills them from the question). */
interface SearchFilterArgs {
  kinds?: string[];
  authors?: string[];
  years?: string[];
  postedAfter?: string;
  postedBefore?: string;
  savedAfter?: string;
  savedBefore?: string;
}

/** A search call's filters as the route takes them: each list once and only when not empty, absent bounds left out; undefined when there are none. */
function toSearchFilters(args: SearchFilterArgs): KnowledgeSearchFilters | undefined {
  const filters: KnowledgeSearchFilters = {};
  for (const key of ["kinds", "authors", "years"] as const) {
    const values = args[key];
    if (values !== undefined && values.length > 0) filters[key] = [...new Set(values)];
  }
  for (const key of ["postedAfter", "postedBefore", "savedAfter", "savedBefore"] as const) {
    const value = args[key];
    if (value !== undefined) filters[key] = value;
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

const entryBody = z
  .string()
  .min(1)
  .refine((value) => value.trim() !== "", "body is empty")
  .refine((value) => Buffer.byteLength(value, "utf8") <= KNOWLEDGE_ENTRY_MAX_BYTES, `body is over ${KNOWLEDGE_ENTRY_MAX_BYTES} bytes: split it`);
const entryHandle = z
  .string()
  .trim()
  .min(1)
  // The "@" is dropped before the store counts it.
  .refine((value) => value.replace(/^@+/, "").length <= HANDLE_MAX_CHARS, `a handle is at most ${HANDLE_MAX_CHARS} characters`);

const saveItem = z
  .object({
    body: entryBody.describe("The text, verbatim, site chrome removed."),
    title: optionalText(KNOWLEDGE_TITLE_MAX).describe("Short and descriptive."),
    kind: optionalText(KIND_MAX_CHARS).describe('"post", "thread", "article", "note", "case study"…'),
    author: optionalText(AUTHOR_MAX_CHARS),
    handle: entryHandle.optional().describe("Without the @."),
    url: optionalText(URL_MAX_CHARS),
    postedAt: optionalText(40).describe("ISO date of the original, when shown."),
    collections: z.array(collectionRef).min(1).max(KNOWLEDGE_COLLECTIONS_MAX).describe("Names (or ids); at least one.")
  })
  .strict();

const newCollection = z
  .object({
    name: z.string().trim().min(1).max(KNOWLEDGE_COLLECTION_NAME_MAX),
    description: z.string().trim().min(1).max(KNOWLEDGE_COLLECTION_DESCRIPTION_MAX).describe("One line: what it covers.")
  })
  .strict();

/** A save item as the route takes it: a handle without its "@", absent fields left out. */
function toSaveItem(item: z.infer<typeof saveItem>): KnowledgeSaveItem {
  const handle = item.handle?.replace(/^@+/, "");
  return {
    body: item.body,
    collections: [...new Set(item.collections)],
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    ...(item.author !== undefined ? { author: item.author } : {}),
    ...(handle ? { handle } : {}),
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.postedAt !== undefined ? { postedAt: item.postedAt } : {})
  };
}

const updateFields = {
  title: optionalText(KNOWLEDGE_TITLE_MAX),
  body: entryBody.optional().describe("The whole new text (replaces it)."),
  kind: optionalText(KIND_MAX_CHARS),
  author: clearableText(AUTHOR_MAX_CHARS),
  handle: entryHandle.nullable().optional(),
  url: clearableText(URL_MAX_CHARS),
  postedAt: clearableText(40),
  collections: z.array(collectionRef).min(1).max(KNOWLEDGE_COLLECTIONS_MAX).optional().describe("The new set, replacing the old: names or ids.")
};
type UpdateFields = z.infer<z.ZodObject<typeof updateFields>>;

/** An edit as the route takes it: only the fields passed, a handle without its "@", collections once each. */
function toUpdateRequest(fields: UpdateFields): UpdateKnowledgeEntryRequest {
  const request: UpdateKnowledgeEntryRequest = {};
  if (fields.title !== undefined) request.title = fields.title;
  if (fields.body !== undefined) request.body = fields.body;
  if (fields.kind !== undefined) request.kind = fields.kind;
  if (fields.author !== undefined) request.author = fields.author;
  if (fields.handle !== undefined) request.handle = fields.handle === null ? null : fields.handle.replace(/^@+/, "");
  if (fields.url !== undefined) request.url = fields.url;
  if (fields.postedAt !== undefined) request.postedAt = fields.postedAt;
  if (fields.collections !== undefined) request.collections = [...new Set(fields.collections)];
  return request;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const knowledgeSearch = defineTool({
  name: "knowledge_search",
  title: "Search the knowledge base",
  description:
    "Search the shared knowledge base in the collections this chat can see, by meaning and keywords (query), by example (similarTo) or both; filters narrow it. Use it before deciding on a topic those collections cover; on your own while working, don't announce it. When the user asks you directly, answer from the entries found, paste each used entry's `cite` link verbatim, and never pass off general knowledge as from it. Never cite a weak hit as evidence.",
  input: {
    query: z.string().trim().min(1).max(KNOWLEDGE_QUERY_MAX_CHARS).optional().describe("Needed without similarTo."),
    similarTo: exampleIds.optional().describe("Entry ids: find more like these."),
    unlike: exampleIds.optional().describe("With similarTo: less like these."),
    collections: z.array(collectionRef).max(KNOWLEDGE_COLLECTIONS_MAX).optional().describe("Names or ids."),
    kinds: filterValues(KIND_MAX_CHARS).optional().describe('"thread", "article"…'),
    authors: filterValues(AUTHOR_MAX_CHARS).optional().describe("Names or @handles."),
    years: z.array(filterYear).max(KNOWLEDGE_FILTER_MAX_VALUES).optional().describe('"2025" (postedAt, else savedAt).'),
    postedAfter: dateBound.optional().describe("Inclusive ISO date (each bound); posted bounds skip undated entries."),
    postedBefore: dateBound.optional(),
    savedAfter: dateBound.optional(),
    savedBefore: dateBound.optional(),
    sort: z.enum(["relevance", "recent", "newest"]).optional().describe("Default relevance; recent boosts newer; newest: latest saved first."),
    limit: z.number().int().min(1).max(KNOWLEDGE_SEARCH_MAX_LIMIT).optional().describe("Default 8."),
    cursor: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.length <= KNOWLEDGE_CURSOR_MAX_CHARS, "not a cursor from a footer")
      .optional().describe("The footer's: next page (same other inputs).")
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "read",
  scope: async () => knowledgeScope("content", false),
  annotations: READ_ONLY,
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_search");
    const similarTo = [...new Set(args.similarTo ?? [])];
    const unlike = [...new Set(args.unlike ?? [])];
    if (args.query === undefined && similarTo.length === 0) {
      throw new ToolError("INVALID_ARGUMENT", "Nothing to search for: pass a query, or similarTo with entry ids (from an earlier search) to find entries like them.");
    }
    if (unlike.length > 0 && similarTo.length === 0) throw new ToolError("INVALID_ARGUMENT", "unlike steers a search by example: pass it with similarTo.");
    const filters = toSearchFilters(args);
    const body: KnowledgeSearchRequest = {
      ...(args.query !== undefined ? { query: args.query } : {}),
      sessionId,
      ...(args.collections !== undefined && args.collections.length > 0 ? { collections: [...new Set(args.collections)] } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(filters ? { filters } : {}),
      ...(similarTo.length > 0 ? { similarTo } : {}),
      ...(unlike.length > 0 ? { unlike } : {}),
      ...(args.sort !== undefined ? { sort: args.sort } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {})
    };
    const response = await call<KnowledgeSearchResponse>(api, "POST", knowledgeRoutes.search, { body });
    return text(renderSearch(response, await collectionNames(api), { filtered: filters !== undefined, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}) }));
  }
});

/** An entry or concept id, as `knowledge_get` takes it. */
const itemId = z.string().trim().min(1).max(200);

const knowledgeGet = defineTool({
  name: "knowledge_get",
  title: "Read a knowledge entry",
  description:
    "Read knowledge entries whole — text, metadata, concepts, similar entries, possible duplicates — or a concept (description, entries, links). A cut body's footer gives the from to read on with. Paste the `cite` link of each entry you use, verbatim.",
  input: {
    id: itemId.optional().describe("An entry id (ke_…) or a concept id."),
    ids: z.array(itemId).min(1).max(KNOWLEDGE_GET_MAX_IDS).optional().describe("Up to 5, instead of id."),
    from: z.number().int().min(0).optional().describe("Character offset into the body (from a footer or a passage).")
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "read",
  scope: async () => knowledgeScope("content", false),
  annotations: READ_ONLY,
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_get");
    if ((args.id === undefined) === (args.ids === undefined)) throw new ToolError("INVALID_ARGUMENT", `Pass id, or ids (up to ${KNOWLEDGE_GET_MAX_IDS}): exactly one of them.`);
    const ids = args.ids !== undefined ? [...new Set(args.ids)] : [args.id!];
    if (args.from !== undefined && args.from > 0 && ids.length > 1) throw new ToolError("INVALID_ARGUMENT", "from reads on in one entry: pass it with id.");
    const outcomes: KnowledgeGetOutcome[] = [];
    let firstError: ToolError | null = null;
    for (const id of ids) {
      try {
        outcomes.push({ id, response: await call<KnowledgeItemResponse>(api, "GET", knowledgeRoutes.item(id), { query: { sessionId } }) });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        firstError ??= error;
        outcomes.push({ id, error });
      }
    }
    // Nothing read: the daemon's own refusal (plugin off, no such item) as a clean error.
    if (firstError && outcomes.every((outcome) => "error" in outcome)) throw firstError;
    return text(renderItems(outcomes, await collectionNames(api), args.from ?? 0));
  }
});

const knowledgeSave = defineTool({
  name: "knowledge_save",
  title: "Save to the knowledge base",
  description:
    "Save posts, threads, articles or notes the user gives you to the shared knowledge base; it returns at once (linking runs later). Keep the author's words verbatim: strip only site chrome (\"Post\", \"Ver posts nuevos\", \"Conversación\", \"Copy\", view and like counts, repeated headers); never summarise or reword. One thread = one entry; unrelated posts = separate entries (a bulk import is one call with many). Give each a short descriptive title; fill author, handle, url, postedAt and kind when visible. Choose collections by content, not by this chat: one, several or all that fit (knowledge_collections lists them); you may save into collections this chat can't see. Only when none fits, create one in newCollections, with a description. A duplicate (same URL or text) is reported, not saved twice.",
  input: {
    entries: z.array(saveItem).min(1).max(KNOWLEDGE_SAVE_MAX_ENTRIES),
    newCollections: z.array(newCollection).max(KNOWLEDGE_NEW_COLLECTIONS_MAX).optional().describe("Collections to create first; entries may then name them.")
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "act",
  // Saving is what the user asked for, changes only the knowledge base, and must stay fast: no card, and allowed while planning.
  planSafe: true,
  scope: async () => knowledgeScope("none", true),
  annotations: closedWorld(MUTATING),
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_save");
    const body: KnowledgeSaveRequest = {
      entries: args.entries.map(toSaveItem),
      sessionId,
      ...(args.newCollections !== undefined && args.newCollections.length > 0 ? { newCollections: args.newCollections } : {})
    };
    const response = await call<KnowledgeSaveResponse>(api, "POST", knowledgeRoutes.save, { body });
    return text(renderSave(response, await collectionNames(api)));
  }
});

const knowledgeUpdate = defineTool({
  name: "knowledge_update",
  title: "Edit a knowledge entry",
  description:
    "Edit one entry in place (id from knowledge_search). Only the fields you pass change; collections replaces the set; null clears author, handle, url or postedAt. Correct an entry with this, not a second save. Keep saved posts verbatim unless the user asks. A changed text or title is linked again.",
  input: { id: entryId.describe("The entry's id (ke_…)."), ...updateFields },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "act",
  scope: async () => knowledgeScope("none", true),
  annotations: closedWorld(MUTATING),
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_update");
    const { id, ...fields } = args;
    const body = toUpdateRequest(fields);
    const changed = Object.keys(body);
    if (changed.length === 0) throw new ToolError("INVALID_ARGUMENT", "Nothing to change: pass at least one field besides id.");
    const detail = await call<KnowledgeEntryDetail>(api, "PATCH", knowledgeRoutes.entry(id), { body, query: { sessionId } });
    return text(renderUpdate(detail, changed, await collectionNames(api)));
  }
});

const knowledgeDelete = defineTool({
  name: "knowledge_delete",
  title: "Delete knowledge entries",
  description:
    "Delete entries for good (ids from knowledge_search). There is no undo: delete only what the user asked to remove, or entries you saved by mistake. Each id is reported deleted or not, with the reason.",
  input: { ids: z.array(entryId).min(1).max(KNOWLEDGE_DELETE_MAX_IDS).describe("Entry ids (ke_…).") },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "act",
  scope: async () => knowledgeScope("none", true),
  annotations: closedWorld(DESTRUCTIVE),
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_delete");
    const outcomes: KnowledgeDeleteOutcome[] = [];
    let firstError: ToolError | null = null;
    for (const id of new Set(args.ids)) {
      try {
        // Read first: the answer names what was deleted, and a hidden entry is refused like an unknown one.
        const detail = await call<KnowledgeEntryDetail>(api, "GET", knowledgeRoutes.entry(id), { query: { sessionId } });
        await call<unknown>(api, "DELETE", knowledgeRoutes.entry(id), { query: { sessionId } });
        outcomes.push({ id, deleted: true, title: detail.entry.title });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        firstError ??= error;
        outcomes.push({ id, deleted: false, message: error.message });
      }
    }
    // Nothing deleted: the daemon's own refusal (plugin off, no such entry) as a clean error.
    if (firstError && outcomes.every((outcome) => !outcome.deleted)) throw firstError;
    return text(renderDelete(outcomes));
  }
});

const knowledgeMerge = defineTool({
  name: "knowledge_merge",
  title: "Merge knowledge entries",
  description:
    "Merge duplicate entries into one: the kept one gets all their collections (and title, body if given); the others are deleted. No undo.",
  input: {
    ids: z.array(entryId).min(2).max(KNOWLEDGE_MERGE_MAX_ENTRIES),
    keep: entryId.optional().describe("One of ids; default the oldest."),
    title: optionalText(KNOWLEDGE_TITLE_MAX),
    body: entryBody.optional().describe("The combined text; default the kept one's.")
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "act",
  scope: async () => knowledgeScope("none", true),
  annotations: closedWorld(DESTRUCTIVE),
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_merge");
    const ids = [...new Set(args.ids)];
    if (ids.length < 2) throw new ToolError("INVALID_ARGUMENT", "Pass at least two different entry ids to merge.");
    if (args.keep !== undefined && !ids.includes(args.keep)) throw new ToolError("INVALID_ARGUMENT", "keep must be one of ids.");
    const body: KnowledgeMergeRequest = {
      ids,
      sessionId,
      ...(args.keep !== undefined ? { keep: args.keep } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.body !== undefined ? { body: args.body } : {})
    };
    const response = await call<KnowledgeMergeResponse>(api, "POST", knowledgeRoutes.entriesMerge, { body });
    return text(renderMerge(response, await collectionNames(api)));
  }
});

const knowledgeCollections = defineTool({
  name: "knowledge_collections",
  title: "List knowledge collections",
  description:
    "Every knowledge collection — name, entry count, description — to choose where knowledge_save files an entry. It lists all of them, including ones this chat does not search.",
  input: {},
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "read",
  scope: async () => knowledgeScope("metadata", false),
  annotations: READ_ONLY,
  resultKind: "text",
  async run(_args, { api, caller }: CallContext) {
    sessionIdOf(caller, "knowledge_collections");
    return text(renderCollections(await call<KnowledgeCollectionsResponse>(api, "GET", knowledgeRoutes.collections)));
  }
});

const workerNextTask = defineTool({
  name: "knowledge_worker_next_task",
  title: "Next indexing task",
  description:
    "Knowledge Graph indexing sessions only: the next extraction task — its instructions (sent once per step; later \"the same as task N\") and its input — or none left, and then you end your turn.",
  input: {},
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "act",
  planSafe: true,
  scope: async () => knowledgeScope("none", true),
  annotations: closedWorld(MUTATING),
  resultKind: "text",
  async run(_args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_worker_next_task");
    return text(renderWorkerNext(await call<KnowledgeWorkerNextResponse>(api, "POST", knowledgeRoutes.workerNext, { body: { sessionId } })));
  }
});

const workerSubmit = defineTool({
  name: "knowledge_worker_submit",
  title: "Submit an indexing answer",
  description:
    "Knowledge Graph indexing sessions only: submit a task's answer — exactly the JSON text its instructions ask for, nothing around it. A valid answer returns the next task; an invalid one is refused with the parse error: fix it and submit the same task again.",
  input: {
    taskId: z.string().trim().min(1).max(200),
    answer: z.string().min(1).max(KNOWLEDGE_WORKER_ANSWER_MAX_CHARS)
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "act",
  planSafe: true,
  scope: async () => knowledgeScope("none", true),
  annotations: closedWorld(MUTATING),
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_worker_submit");
    const body: KnowledgeWorkerSubmitRequest = { sessionId, taskId: args.taskId, answer: args.answer };
    const response = await call<KnowledgeWorkerSubmitResponse>(api, "POST", knowledgeRoutes.workerSubmit, { body });
    if (!response.accepted) {
      // The daemon's own words say what to do next (redo it, call for the next task, or end the turn).
      throw new ToolError("KNOWLEDGE_INVALID", `The answer to task ${clipText(args.taskId, 100)} was refused: ${clipText(response.error, 2_000)}`);
    }
    return text(`Accepted.\n${renderWorkerNext(response.next)}`);
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const knowledgeFamily: readonly AnyOrquesterTool[] = [knowledgeSearch, knowledgeGet, knowledgeSave, knowledgeUpdate, knowledgeDelete, knowledgeMerge, knowledgeCollections, workerNextTask, workerSubmit];
