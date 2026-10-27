/**
 * Catalog family `knowledge` (Knowledge Graph plugin spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md, "Agent tools", "Citations"):
 * the shared knowledge base for in-chat agents — `knowledge_search`, `knowledge_get`,
 * `knowledge_save`, `knowledge_update`, `knowledge_delete`, `knowledge_collections` — and the two
 * tools of the plugin's own indexing sessions, `knowledge_worker_next_task` and
 * `knowledge_worker_submit`. Chat-only.
 *
 * - **Gating** is the manifest's (`session-tools/manifest.ts`): the family only while the plugin is
 *   on; search, get, update and delete only to a chat that sees a collection; the worker tools
 *   only — and alone — to a worker session. The routes enforce the same on the server (visibility,
 *   `KNOWLEDGE_NOT_A_WORKER`), and every refusal they answer comes back here as a clean tool error.
 * - **Visibility** is resolved by the daemon from the calling session: every request names it
 *   (`sessionId` in the body or the query) besides carrying the call's agent principal.
 * - **Results are compact text** (spec "Light on tokens"): one line per hit, collections by name,
 *   a one-line snippet and the entry's ready-made citation; full text only through `knowledge_get`.
 * - **No card**: saving, editing and deleting are Act; they change only the knowledge base, and
 *   saving must stay fast. Editing and deleting reach the same routes as the Knowledge tab.
 *
 * Everything goes through `DaemonApi` (D-1): this module imports types and pure contracts only.
 */

import { z } from "zod";
import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX,
  KNOWLEDGE_COLLECTION_NAME_MAX,
  KNOWLEDGE_COLLECTIONS_MAX,
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_SAVE_MAX_ENTRIES,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_TITLE_MAX,
  knowledgeRoutes,
  type KnowledgeCollectionsResponse,
  type KnowledgeConceptDetail,
  type KnowledgeEntryDetail,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySummary,
  type KnowledgeItemResponse,
  type KnowledgeSaveItem,
  type KnowledgeSaveRequest,
  type KnowledgeSaveResponse,
  type KnowledgeSearchHit,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResponse,
  type KnowledgeWorkerNextResponse,
  type KnowledgeWorkerSubmitRequest,
  type KnowledgeWorkerSubmitResponse,
  type UpdateKnowledgeEntryRequest
} from "@orquester/api";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { closedWorld, defineTool, DESTRUCTIVE, MUTATING, READ_ONLY, type AnyOrquesterTool, type CallContext, type ScopeClaim, type ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi, DaemonMethod } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { capText, clipText } from "../result.ts";

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
/** `knowledge_get` shows an entry body up to this many UTF-8 bytes (results stay under the 60 000-byte cap). */
const KNOWLEDGE_GET_BODY_MAX_BYTES = 48_000;
/** Lists inside one `knowledge_get` answer. */
const GET_LIST_MAX = 12;
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

function hitLines(hit: KnowledgeSearchHit, index: number, names: ReadonlyMap<string, string>): string[] {
  const n = `${index + 1}. `;
  if (hit.kind === "entry") {
    const [head, ...rest] = entryBlock(hit.entry, names);
    return [`${n}${head}`, ...rest];
  }
  const concept = hit.concept;
  const description = concept.description ? `: ${clipText(oneLine(concept.description), DESCRIPTION_CHARS)}` : "";
  const entries = hit.entryIds.length > 0 ? ` · entries ${hit.entryIds.join(", ")}` : "";
  return [`${n}concept ${concept.id} "${label(concept.name)}" (${label(concept.type)})${description}${entries}`];
}

/** The search answer as the agent reads it. */
function renderSearch(response: KnowledgeSearchResponse, names: ReadonlyMap<string, string>): string {
  const searched = response.searched.map((id) => names.get(id) ?? id);
  const over = searched.length > 0 ? `over ${searched.join(", ")}` : "over no collection";
  if (response.hits.length === 0) return `No knowledge found (${over}). Don't answer as if it came from the knowledge base.`;
  const lines = [`${response.hits.length} hit${response.hits.length === 1 ? "" : "s"} (${over}). Read one whole with knowledge_get; cite each entry you use with its cite link, verbatim.`];
  response.hits.forEach((hit, index) => lines.push(...hitLines(hit, index, names)));
  return lines.join("\n");
}

/** At most `max` UTF-8 bytes of `body`, never splitting a character. */
function clipBytes(body: string, max: number): { text: string; omitted: number } {
  const total = Buffer.byteLength(body, "utf8");
  if (total <= max) return { text: body, omitted: 0 };
  // Every character is at most 4 bytes: start from a safe length and grow.
  let lo = 0;
  let hi = Math.min(body.length, max);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(capText(body, mid).text, "utf8") <= max) lo = mid;
    else hi = mid - 1;
  }
  const kept = capText(body, lo).text;
  return { text: kept, omitted: total - Buffer.byteLength(kept, "utf8") };
}

function renderEntryDetail(detail: KnowledgeEntryDetail, names: ReadonlyMap<string, string>): string {
  const entry = detail.entry;
  const lines = [`cite: ${detail.citation}`, `entry ${entryHead(entry, names)}`, `Title: ${oneLine(entry.title)}`];
  if (entry.url) lines.push(`URL: ${entry.url}`);
  if (detail.concepts.length > 0) {
    const shown = detail.concepts.slice(0, GET_LIST_MAX).map((concept) => `${label(concept.name)} (${label(concept.type)}) [${concept.id}]`);
    const more = detail.concepts.length - shown.length;
    lines.push(`Concepts: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`);
  }
  if (detail.related.length > 0) {
    lines.push("Related:");
    for (const related of detail.related.slice(0, GET_LIST_MAX)) lines.push(`- ${entryHead(related, names)}`, `  cite: ${related.citation}`);
  }
  const body = clipBytes(entry.body, KNOWLEDGE_GET_BODY_MAX_BYTES);
  lines.push("---", body.text);
  if (body.omitted > 0) lines.push(`[… ${body.omitted} more bytes not shown]`);
  return lines.join("\n");
}

function renderConceptDetail(detail: KnowledgeConceptDetail, names: ReadonlyMap<string, string>): string {
  const concept = detail.concept;
  const lines = [`concept ${concept.id} "${label(concept.name)}" (${label(concept.type)}) · confidence ${concept.confidence.toFixed(2)} · ${inCollections(detail.collections, names)}`];
  if (concept.aliases.length > 0) {
    const more = concept.aliases.length - GET_LIST_MAX;
    lines.push(`Aliases: ${concept.aliases.slice(0, GET_LIST_MAX).map(label).join(", ")}${more > 0 ? `, +${more} more` : ""}`);
  }
  if (concept.description) lines.push(clipText(concept.description.trim(), CONCEPT_DESCRIPTION_CHARS));
  const attributes = Object.entries(concept.attributes).slice(0, GET_LIST_MAX);
  if (attributes.length > 0) lines.push(`Attributes: ${attributes.map(([key, attribute]) => `${label(key)}: ${clipText(oneLine(attribute.value), DESCRIPTION_CHARS)}`).join("; ")}`);
  if (detail.entries.length > 0) {
    lines.push("Entries:");
    for (const entry of detail.entries.slice(0, GET_LIST_MAX)) {
      const [head, ...rest] = entryBlock(entry, names, "  ");
      lines.push(`- ${head}`, ...rest);
    }
  }
  if (detail.neighbors.length > 0) {
    lines.push("Links:");
    for (const { edge, concept: other } of detail.neighbors.slice(0, GET_LIST_MAX * 2)) {
      const arrow = edge.from === concept.id ? `${label(edge.type)} →` : `← ${label(edge.type)}`;
      lines.push(`- ${arrow} ${label(other.name)} (${label(other.type)}) [${other.id}]`);
    }
  }
  return lines.join("\n");
}

/** The get answer as the agent reads it. */
export function renderItem(response: KnowledgeItemResponse, names: ReadonlyMap<string, string>): string {
  return response.kind === "entry" ? renderEntryDetail(response.entry, names) : renderConceptDetail(response.concept, names);
}

/** The save answer: what was saved, what was already there, what was created. */
export function renderSave(response: KnowledgeSaveResponse, names: ReadonlyMap<string, string>): string {
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
  }
  return lines.join("\n");
}

/** The edit answer: what changed, the entry as it is now, its citation (relinking shows in the head). */
export function renderUpdate(detail: KnowledgeEntryDetail, changed: readonly string[], names: ReadonlyMap<string, string>): string {
  const entry = detail.entry;
  return [`Updated ${changed.join(", ")}.`, `entry ${entryHead(entry, names)}`, `Title: ${oneLine(entry.title)}`, `cite: ${detail.citation}`].join("\n");
}

/** One id of a delete call: deleted (with what it was), or refused (with the daemon's words). */
export type KnowledgeDeleteOutcome = { id: string; deleted: true; title: string } | { id: string; deleted: false; message: string };

/** The delete answer: what was deleted, what was not and why. */
export function renderDelete(outcomes: readonly KnowledgeDeleteOutcome[]): string {
  const deleted = outcomes.filter((outcome) => outcome.deleted).length;
  const failed = outcomes.length - deleted;
  const lines = [`Deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}${failed > 0 ? `; ${failed} not deleted` : ""}. Their cite links no longer resolve.`];
  for (const outcome of outcomes) {
    lines.push(outcome.deleted ? `- deleted ${outcome.id} "${clipText(oneLine(outcome.title), NAME_CHARS)}"` : `- not deleted ${outcome.id}: ${clipText(oneLine(outcome.message), DESCRIPTION_CHARS)}`);
  }
  return lines.join("\n");
}

/** Every collection, one line each. */
export function renderCollections(response: KnowledgeCollectionsResponse): string {
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
export function toSaveItem(item: z.infer<typeof saveItem>): KnowledgeSaveItem {
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
export function toUpdateRequest(fields: UpdateFields): UpdateKnowledgeEntryRequest {
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
    "Search the shared knowledge base (saved posts, threads, articles, notes) by meaning and keywords, over the collections this chat can see. Use it before deciding on a topic those collections cover; when you use it on your own while working, don't announce it. When the user asks you a question directly, answer from the entries found (knowledge_get reads one whole), paste each used entry's `cite` link verbatim, and never pass off general knowledge as coming from it. Returns compact hits: entries (id, kind, author, collections, snippet, cite) and concepts (name, type, top entry ids).",
  input: {
    query: z.string().trim().min(1).max(KNOWLEDGE_QUERY_MAX_CHARS),
    collections: z.array(collectionRef).max(KNOWLEDGE_COLLECTIONS_MAX).optional().describe("Narrow to these (names or ids)."),
    limit: z.number().int().min(1).max(KNOWLEDGE_SEARCH_MAX_LIMIT).optional().describe("Default 8.")
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "read",
  scope: async () => knowledgeScope("content", false),
  annotations: READ_ONLY,
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_search");
    const body: KnowledgeSearchRequest = {
      query: args.query,
      sessionId,
      ...(args.collections !== undefined && args.collections.length > 0 ? { collections: [...new Set(args.collections)] } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {})
    };
    const response = await call<KnowledgeSearchResponse>(api, "POST", knowledgeRoutes.search, { body });
    return text(renderSearch(response, await collectionNames(api)));
  }
});

const knowledgeGet = defineTool({
  name: "knowledge_get",
  title: "Read a knowledge entry",
  description:
    "Read one knowledge entry whole — text, metadata, linked concepts, related entries — or, given a concept id, the concept's description, entries and links. Ids come from knowledge_search. When your answer uses an entry, paste its `cite` link verbatim.",
  input: {
    id: z.string().trim().min(1).max(200).describe("An entry id (ke_…) or a concept id.")
  },
  audiences: ["chat"],
  toolset: "knowledge",
  tier: "read",
  scope: async () => knowledgeScope("content", false),
  annotations: READ_ONLY,
  resultKind: "text",
  async run(args, { api, caller }: CallContext) {
    const sessionId = sessionIdOf(caller, "knowledge_get");
    const response = await call<KnowledgeItemResponse>(api, "GET", knowledgeRoutes.item(args.id), { query: { sessionId } });
    return text(renderItem(response, await collectionNames(api)));
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
export const knowledgeFamily: readonly AnyOrquesterTool[] = [knowledgeSearch, knowledgeGet, knowledgeSave, knowledgeUpdate, knowledgeDelete, knowledgeCollections, workerNextTask, workerSubmit];
