import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  KNOWLEDGE_COLORS,
  KNOWLEDGE_FILTER_MAX_VALUES,
  KNOWLEDGE_GRAPH_MAX_NODES,
  KNOWLEDGE_MERGE_MAX_ENTRIES,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SIMILAR_MAX_EXAMPLES,
  KNOWLEDGE_SIMILARITY_GRAPH_MAX_K,
  KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES,
  knowledgeRoutes,
  type KnowledgeChangedEvent,
  type KnowledgeCollection,
  type KnowledgeCollectionView,
  type KnowledgeCollectionsResponse,
  type KnowledgeConceptMerge,
  type KnowledgeConceptMergesResponse,
  type KnowledgeEntriesResponse,
  type KnowledgeEntryDetail,
  type KnowledgeFacetsResponse,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeMergeResponse,
  type KnowledgeSaveResponse,
  type KnowledgeSearchResponse,
  type KnowledgeSimilarityGraphResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import type { KnowledgeLinkingPort, KnowledgeSettingsPort, KnowledgeVisibilityPort } from "./ports.ts";
import { computeKnowledgeFacets } from "./search/facets.ts";
import { entryMatchesFilter, parseKnowledgeFilters } from "./search/filters.ts";
import type { KnowledgeSearch } from "./search/search.ts";
import { entryInScope, type KnowledgeScope } from "./search/visibility.ts";
import { KnowledgeError, type KnowledgeLogger, knowledgeFrameworkError } from "./store/errors.ts";
import type { KnowledgeStore } from "./store/store.ts";

/**
 * What the data routes need. Every field is a seam the service composes (`ports.ts`). `store` and
 * `search` are read per request, after `ready()`: the service opens them when the plugin is
 * switched on (and anew after it was switched off), so it passes them as getters.
 */
export interface KnowledgeDataRoutesDeps {
  store: KnowledgeStore;
  search: KnowledgeSearch;
  /** Every route answers 409 `KNOWLEDGE_DISABLED` while `enabled()` is false. */
  settings: Pick<KnowledgeSettingsPort, "enabled">;
  /**
   * Awaited after the plugin gate, before the handler: resolves once `store` and `search` are open,
   * or throws a `KnowledgeError` (the refusal answered). Absent: they are always open.
   */
  ready?(): Promise<void>;
  visibility: KnowledgeVisibilityPort;
  /** Read after a save's store change was emitted (the service forwards changes to linking). */
  linking: Pick<KnowledgeLinkingPort, "status">;
  /** The `/events` broadcaster (`Broadcaster` satisfies it). */
  publisher: { publish(channel: string, type: string, payload: unknown): void };
  /** Agent Profiles that include each collection id (`knowledgeCollections`), by collection id. */
  profilesForCollection(): Promise<Map<string, { id: string; name: string }[]>>;
  logger?: KnowledgeLogger;
  /** Automatic concept merges (`search/concept-merges.ts`), read per request; absent: none to list or undo. */
  conceptMerges?: KnowledgeConceptMergesRoutePort | null;
}

/** What the concept merge routes need (`KnowledgeConceptMerges` satisfies it). */
export interface KnowledgeConceptMergesRoutePort {
  list(scope: KnowledgeScope): KnowledgeConceptMerge[];
  /** False when the scope sees no such merge. */
  undo(id: string, scope: KnowledgeScope): Promise<boolean>;
}

/** A save can carry KNOWLEDGE_SAVE_MAX_ENTRIES bodies of KNOWLEDGE_ENTRY_MAX_BYTES, JSON-escaped. */
const SAVE_BODY_LIMIT = 32 * 1024 * 1024;
const ENTRY_BODY_LIMIT = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Request shapes (the store and search check limits and meaning)
// ---------------------------------------------------------------------------

/** An optional text field an agent may also send as `null` (read as absent). */
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableText = z.string().nullable().optional();
const sessionId = z.string().min(1).max(200).optional();
const color = z.enum(KNOWLEDGE_COLORS as unknown as [string, ...string[]]);
const intFromQuery = (min: number, max: number) =>
  z
    .union([z.number(), z.string().regex(/^\d+$/, "must be a whole number")])
    .transform((value) => Number(value))
    .pipe(z.number().int().min(min).max(max))
    .optional();

const createCollectionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  color: color.optional()
});
const updateCollectionSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  color: color.optional()
});
const updateEntrySchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  kind: z.string().optional(),
  author: nullableText,
  handle: nullableText,
  url: nullableText,
  postedAt: nullableText,
  collections: z.array(z.string()).optional()
});
/** The store checks the rest (distinct ids, keep among them, title and text limits). */
const mergeEntriesSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(2).max(KNOWLEDGE_MERGE_MAX_ENTRIES),
  keep: z.string().min(1).max(200).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  sessionId
});
const saveSchema = z.object({
  entries: z.array(
    z.object({
      body: z.string(),
      title: optionalText,
      kind: optionalText,
      author: optionalText,
      handle: optionalText,
      url: optionalText,
      postedAt: optionalText,
      collections: z.array(z.string())
    })
  ),
  newCollections: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .nullish()
    .transform((value) => value ?? undefined),
  sessionId
});
/** A field an agent may also send as `null` (read as absent). */
const nullish = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((value) => value ?? undefined);
const filterValue = z.string().max(200);
/** ISO dates are checked by the search's filter parser (`search/filters.ts`), which says what is wrong. */
const isoBound = nullish(z.string().max(40));
const exampleList = nullish(z.array(z.string().max(100)).max(KNOWLEDGE_SIMILAR_MAX_EXAMPLES));
const searchSchema = z.object({
  query: nullish(z.string()),
  collections: nullish(z.array(z.string())),
  limit: nullish(z.number().int().min(1).max(KNOWLEDGE_SEARCH_MAX_LIMIT)),
  filters: nullish(
    z.object({
      kinds: nullish(z.array(filterValue).max(KNOWLEDGE_FILTER_MAX_VALUES)),
      authors: nullish(z.array(filterValue).max(KNOWLEDGE_FILTER_MAX_VALUES)),
      years: nullish(z.array(filterValue).max(KNOWLEDGE_FILTER_MAX_VALUES)),
      postedAfter: isoBound,
      postedBefore: isoBound,
      savedAfter: isoBound,
      savedBefore: isoBound
    })
  ),
  similarTo: exampleList,
  unlike: exampleList,
  sort: nullish(z.enum(["relevance", "recent", "newest"])),
  diverse: nullish(z.boolean()),
  cursor: nullish(z.string().min(1).max(500)),
  facets: nullish(z.boolean()),
  sessionId
});
/**
 * A filter list on the query string, comma-separated or a JSON array (`search/filters.ts` splits and
 * checks it). Room for the most values at ~200 characters each in the JSON form: every character
 * escaped to two (quotes, backslashes), plus each value's quotes and comma, plus the brackets.
 */
const filterListParam = z
  .string()
  .max(KNOWLEDGE_FILTER_MAX_VALUES * (2 * 200 + 3) + 2)
  .optional();
const entriesQuerySchema = z.object({
  collection: z.string().min(1).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: intFromQuery(1, 1_000),
  kinds: filterListParam,
  authors: filterListParam,
  years: filterListParam,
  postedAfter: z.string().max(40).optional(),
  postedBefore: z.string().max(40).optional(),
  savedAfter: z.string().max(40).optional(),
  savedBefore: z.string().max(40).optional(),
  sessionId
});
const graphQuerySchema = z.object({
  collections: z.string().optional(),
  focus: z.string().min(1).max(300).optional(),
  depth: intFromQuery(1, 3),
  limit: intFromQuery(1, KNOWLEDGE_GRAPH_MAX_NODES),
  sessionId
});
const facetsSchema = z.object({
  collections: nullish(z.array(z.string())),
  filters: nullish(
    z.object({
      kinds: z.array(z.string()).optional(),
      authors: z.array(z.string()).optional(),
      years: z.array(z.string()).optional(),
      postedAfter: z.string().optional(),
      postedBefore: z.string().optional(),
      savedAfter: z.string().optional(),
      savedBefore: z.string().optional()
    })
  ),
  sessionId
});
const similarityGraphQuerySchema = z.object({
  collections: z.string().optional(),
  k: intFromQuery(1, KNOWLEDGE_SIMILARITY_GRAPH_MAX_K),
  limit: intFromQuery(1, KNOWLEDGE_SIMILARITY_GRAPH_MAX_NODES),
  sessionId
});
const sessionQuerySchema = z.object({ sessionId });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  throw new KnowledgeError("KNOWLEDGE_INVALID", `Invalid ${what} — ${where}${issue?.message ?? "invalid"}.`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * The knowledge base's data routes (paths from `knowledgeRoutes`): collections, entries, items,
 * graph, search and save, on both transports behind the usual bearer hook. Every refusal is
 * `{ code, message }`; every route refuses with 409 `KNOWLEDGE_DISABLED` while the plugin is off.
 *
 * Who is asking: an in-chat agent's server-stamped principal names its session; otherwise the
 * request's `sessionId` (body for POST, query for GET); none → the user, who sees everything.
 * Visibility is resolved per request and applied inside search and traversal. A hidden entry,
 * concept or collection answers like an unknown one — except in the collections LIST, which names
 * every collection (with the caller's own totals) so a profile chat can choose where to save.
 *
 * The one exception: an entry edit that moves the entry out of the caller's view answers the
 * edited entry (its collections and related entries still scoped), since the write landed.
 *
 * Mutations publish `knowledge.changed` on the `knowledge` channel. The routes register in their
 * own encapsulated scope, whose error handler answers Fastify's refusals (bad JSON, a body over
 * the limit, a media type with no parser) in the same shape without changing the rest of the app.
 */
export function registerKnowledgeDataRoutes(app: FastifyInstance, deps: KnowledgeDataRoutesDeps): void {
  app.register(async (scope) => registerDataRoutes(scope, deps));
}

function registerDataRoutes(app: FastifyInstance, deps: KnowledgeDataRoutesDeps): void {
  const logger = deps.logger ?? console;

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof KnowledgeError) return reply.code(error.status).send({ code: error.code, message: error.message });
    logger.error(`knowledge: a request failed (${error instanceof Error ? error.message : String(error)})`);
    return reply.code(500).send({ code: "KNOWLEDGE_ERROR", message: "The knowledge request failed." });
  };

  app.setErrorHandler((error, _request, reply) => fail(reply, knowledgeFrameworkError(error) ?? error));

  const changed = (event: KnowledgeChangedEvent): void => {
    try {
      deps.publisher.publish(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, event);
    } catch (error) {
      logger.warn(`knowledge: publishing a change failed (${(error as Error).message})`);
    }
  };

  const visibilityOf = (request: FastifyRequest, requested: string | undefined): Promise<KnowledgeVisibility> => {
    const principal = (request as unknown as { principal?: CallerPrincipal }).principal;
    return deps.visibility.forSession(principal?.kind === "agent" ? principal.threadId : requested);
  };

  /** The plugin gate, then the handler; every error answers `{ code, message }`. */
  const handle =
    <T>(run: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<T | FastifyReply> => {
      try {
        if (!deps.settings.enabled()) {
          throw new KnowledgeError("KNOWLEDGE_DISABLED", "The Knowledge Graph plugin is off. Turn it on in Settings → Plugins.");
        }
        await deps.ready?.();
        return await run(request, reply);
      } catch (error) {
        return fail(reply, error);
      }
    };

  const profiles = async (): Promise<Map<string, { id: string; name: string }[]>> => {
    try {
      return await deps.profilesForCollection();
    } catch (error) {
      logger.warn(`knowledge: could not read which profiles see each collection (${(error as Error).message})`);
      return new Map();
    }
  };

  const collectionView = (
    collection: KnowledgeCollection,
    counts: ReadonlyMap<string, number>,
    byCollection: ReadonlyMap<string, { id: string; name: string }[]>
  ): KnowledgeCollectionView => ({
    ...collection,
    entryCount: counts.get(collection.id) ?? 0,
    profiles: [...(byCollection.get(collection.id) ?? [])]
  });

  const entryCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const meta of deps.store.listMeta()) for (const id of meta.collections) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  };

  /** A collection the caller can see, or NOT_FOUND. */
  const visibleCollection = (id: string, visibility: KnowledgeVisibility): KnowledgeCollection => {
    const collection = deps.store.getCollection(id);
    if (!collection || (visibility.kind === "collections" && !visibility.ids.includes(id))) {
      throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such collection.");
    }
    return collection;
  };

  /** An entry the caller can see, or NOT_FOUND. */
  const visibleEntry = (id: string, visibility: KnowledgeVisibility): void => {
    const meta = deps.store.getMeta(id);
    if (!meta || !entryInScope(meta, deps.search.scope(visibility))) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
  };

  const entryDetail = async (id: string, visibility: KnowledgeVisibility, options?: { evenIfHidden?: boolean }): Promise<KnowledgeEntryDetail> => {
    const detail = await deps.search.entryDetail(id, visibility, options);
    if (!detail) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
    return detail;
  };

  // --- collections ---------------------------------------------------------

  app.get(
    knowledgeRoutes.collections,
    handle(async (request): Promise<KnowledgeCollectionsResponse> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      const scope = deps.search.scope(visibility);
      const byCollection = await profiles();
      const counts = entryCounts();
      const metas = deps.store.listMeta();
      const known = scope.known;
      // Every collection, whoever asks: a profile chat chooses where to save from this list and may
      // save into collections it cannot see (spec goal 3, "Agent tools"). Names and counts are not
      // the entries; the totals below are the caller's.
      return {
        collections: deps.store.listCollections().map((c) => collectionView(c, counts, byCollection)),
        unfiledCount: visibility.kind === "all" ? metas.filter((m) => !m.collections.some((id) => known.has(id))).length : 0,
        totalEntries: metas.filter((m) => entryInScope(m, scope)).length
      };
    })
  );

  app.post(
    knowledgeRoutes.collections,
    handle(async (request, reply) => {
      const body = parse(createCollectionSchema, request.body, "collection");
      const created = await deps.store.createCollection({
        name: body.name,
        description: body.description,
        color: body.color as KnowledgeCollection["color"] | undefined
      });
      changed({ collections: true });
      return reply.code(201).send(collectionView(created, entryCounts(), await profiles()));
    })
  );

  const collectionPath = `${knowledgeRoutes.collections}/:id`;

  app.get<{ Params: { id: string } }>(
    collectionPath,
    handle(async (request): Promise<KnowledgeCollectionView> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const id = (request.params as { id: string }).id;
      const collection = visibleCollection(id, await visibilityOf(request, query.sessionId));
      return collectionView(collection, entryCounts(), await profiles());
    })
  );

  app.patch<{ Params: { id: string } }>(
    collectionPath,
    handle(async (request): Promise<KnowledgeCollectionView> => {
      const id = (request.params as { id: string }).id;
      const query = parse(sessionQuerySchema, request.query, "query");
      visibleCollection(id, await visibilityOf(request, query.sessionId));
      const body = parse(updateCollectionSchema, request.body, "collection");
      const updated = await deps.store.updateCollection(id, {
        name: body.name,
        description: body.description,
        color: body.color as KnowledgeCollection["color"] | undefined
      });
      changed({ collections: true });
      return collectionView(updated, entryCounts(), await profiles());
    })
  );

  app.delete<{ Params: { id: string } }>(
    collectionPath,
    handle(async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const query = parse(sessionQuerySchema, request.query, "query");
      visibleCollection(id, await visibilityOf(request, query.sessionId));
      const relabelled = deps.store.listMeta().filter((m) => m.collections.includes(id)).map((m) => m.id);
      await deps.store.deleteCollection(id);
      changed(relabelled.length > 0 ? { collections: true, entryIds: relabelled } : { collections: true });
      return reply.code(204).send();
    })
  );

  // --- entries -------------------------------------------------------------

  app.get(
    knowledgeRoutes.entries,
    handle(async (request): Promise<KnowledgeEntriesResponse> => {
      const query = parse(entriesQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      const { sessionId: _session, ...entriesQuery } = query;
      return deps.search.listEntries(entriesQuery, visibility);
    })
  );

  const entryPath = `${knowledgeRoutes.entries}/:id`;

  app.get<{ Params: { id: string } }>(
    entryPath,
    handle(async (request): Promise<KnowledgeEntryDetail> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      return entryDetail((request.params as { id: string }).id, await visibilityOf(request, query.sessionId));
    })
  );

  app.patch<{ Params: { id: string } }>(
    entryPath,
    { bodyLimit: ENTRY_BODY_LIMIT },
    handle(async (request): Promise<KnowledgeEntryDetail> => {
      const id = (request.params as { id: string }).id;
      const query = parse(sessionQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      visibleEntry(id, visibility);
      const body = parse(updateEntrySchema, request.body, "entry update");
      const before = deps.store.getMeta(id)!;
      const after = await deps.store.updateEntry(id, body);
      if (after.updatedAt !== before.updatedAt) {
        await deps.search.indexEntries([id]);
        changed(after.collections.join() === before.collections.join() ? { entryIds: [id] } : { entryIds: [id], collections: true });
      }
      // The edit landed even when it moved the entry out of the caller's view: answer it (only
      // this entry; its collections and related entries stay scoped), not a 404.
      return entryDetail(id, visibility, { evenIfHidden: true });
    })
  );

  app.delete<{ Params: { id: string } }>(
    entryPath,
    handle(async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const query = parse(sessionQuerySchema, request.query, "query");
      visibleEntry(id, await visibilityOf(request, query.sessionId));
      await deps.store.deleteEntry(id);
      changed({ entryIds: [id], collections: true });
      return reply.code(204).send();
    })
  );

  // Merge: the kept entry edited as a PATCH edits it, the others deleted as DELETE deletes them,
  // in one step. Every id must be visible (a hidden one answers like an unknown one, naming it);
  // the store checks the rest before it changes anything.
  app.post(
    knowledgeRoutes.entriesMerge,
    { bodyLimit: ENTRY_BODY_LIMIT },
    handle(async (request): Promise<KnowledgeMergeResponse> => {
      const body = parse(mergeEntriesSchema, request.body, "merge");
      const visibility = await visibilityOf(request, body.sessionId);
      const scope = deps.search.scope(visibility);
      for (const id of body.ids) {
        const meta = deps.store.getMeta(id);
        if (!meta || !entryInScope(meta, scope)) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", `No such entry: ${id.slice(0, 80)}.`);
      }
      const outcome = await deps.store.mergeEntries({ ids: body.ids, keep: body.keep, title: body.title, body: body.body });
      const keptId = outcome.kept.id;
      if (outcome.keptChanged) await deps.search.indexEntries([keptId]);
      const touched = [...(outcome.keptChanged ? [keptId] : []), ...outcome.deleted];
      if (touched.length > 0) changed({ entryIds: touched, ...(outcome.deleted.length > 0 || outcome.collectionsChanged ? { collections: true } : {}) });
      if (outcome.notDeleted.length > 0) {
        const kept = outcome.keptChanged ? `${keptId} was updated` : `${keptId} was kept unchanged`;
        const deleted = outcome.deleted.length > 0 ? `deleted ${outcome.deleted.join(", ")}` : "deleted none";
        const left = outcome.notDeleted.map((item) => `${item.id} (${item.message})`).join(", ");
        throw new KnowledgeError("KNOWLEDGE_ERROR", `The merge stopped part-way: ${kept}; ${deleted}; still there: ${left}. Delete those to finish.`);
      }
      // The merge only adds collections to the kept entry, so it stays visible; answer it as an edit does.
      return { kept: await entryDetail(keptId, visibility, { evenIfHidden: true }), deleted: outcome.deleted };
    })
  );

  // --- items and the graph -------------------------------------------------

  app.get<{ Params: { id: string } }>(
    `${knowledgeRoutes.item("")}:id`,
    handle(async (request): Promise<KnowledgeItemResponse> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const item = await deps.search.item((request.params as { id: string }).id, await visibilityOf(request, query.sessionId));
      if (!item) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "Nothing visible has that id.");
      return item;
    })
  );

  app.get(
    knowledgeRoutes.graph,
    handle(async (request): Promise<KnowledgeGraphResponse> => {
      const query = parse(graphQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      return deps.search.graphView({ collections: query.collections, focus: query.focus, depth: query.depth, limit: query.limit }, visibility);
    })
  );

  app.get(
    knowledgeRoutes.similarityGraph,
    handle(async (request): Promise<KnowledgeSimilarityGraphResponse> => {
      const query = parse(similarityGraphQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      const refs = (query.collections ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const narrow = refs.length > 0 ? deps.search.resolveVisible(refs, visibility, true) : null;
      return deps.search.similarity.graph({ k: query.k, limit: query.limit }, deps.search.scope(visibility, narrow));
    })
  );

  // --- search, facets and save ---------------------------------------------

  app.post(
    knowledgeRoutes.search,
    handle(async (request): Promise<KnowledgeSearchResponse> => {
      const body = parse(searchSchema, request.body, "search");
      const visibility = await visibilityOf(request, body.sessionId);
      const { sessionId: _session, ...searchRequest } = body;
      return deps.search.search(searchRequest, visibility);
    })
  );

  app.post(
    knowledgeRoutes.facets,
    handle(async (request): Promise<KnowledgeFacetsResponse> => {
      const body = parse(facetsSchema, request.body, "facets request");
      const visibility = await visibilityOf(request, body.sessionId);
      const narrow = body.collections && body.collections.length > 0 ? deps.search.resolveVisible(body.collections, visibility, true) : null;
      const filter = parseKnowledgeFilters(body.filters);
      const scope = deps.search.scope(visibility, narrow);
      const kept = deps.store.listMeta().filter((meta) => entryInScope(meta, scope) && entryMatchesFilter(meta, filter));
      return { facets: computeKnowledgeFacets(kept, scope, deps.store.listCollections()), total: kept.length };
    })
  );

  app.post(
    knowledgeRoutes.save,
    { bodyLimit: SAVE_BODY_LIMIT },
    handle(async (request): Promise<KnowledgeSaveResponse> => {
      const body = parse(saveSchema, request.body, "save");
      const principal = (request as unknown as { principal?: CallerPrincipal }).principal;
      const caller = principal?.kind === "agent" ? principal.threadId : body.sessionId;
      const outcome = await deps.store.save({ entries: body.entries, newCollections: body.newCollections, sessionId: caller });
      const added = outcome.changes.filter((c) => c.kind === "added").flatMap((c) => c.entryIds);
      const touched = outcome.changes.flatMap((c) => c.entryIds);
      // Searchable (text and, for short entries, meaning) before the chat hears back.
      if (added.length > 0) await deps.search.indexEntries(added);
      if (touched.length > 0 || outcome.createdCollections.length > 0) {
        changed({ ...(touched.length > 0 ? { entryIds: touched } : {}), collections: true });
      }
      // Possible duplicates already in the knowledge base, among what the caller can see (no extra
      // wait: entries not embedded within the indexing wait above get none).
      const saved = outcome.results.filter((r) => r.status === "saved").map((r) => r.entryId);
      const similar = saved.length > 0 ? deps.search.similarity.similarForSaved(saved, deps.search.scope(await visibilityOf(request, body.sessionId))) : null;
      const linking = deps.linking.status();
      return {
        results: similar ? outcome.results.map((r) => (r.status === "saved" ? { ...r, similar: similar.get(r.entryId) ?? [] } : r)) : outcome.results,
        createdCollections: outcome.createdCollections,
        linking: linking.state === "running" ? "running" : linking.state === "queued" || linking.state === "paused" ? "queued" : "not-needed"
      };
    })
  );

  // --- concept merges (phase 2 spec, "Concept merges") ---------------------

  app.get(
    knowledgeRoutes.conceptMerges,
    handle(async (request): Promise<KnowledgeConceptMergesResponse> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const scope = deps.search.scope(await visibilityOf(request, query.sessionId));
      return { merges: deps.conceptMerges?.list(scope) ?? [] };
    })
  );

  app.delete<{ Params: { id: string } }>(
    `${knowledgeRoutes.conceptMerge("")}:id`,
    handle(async (request, reply) => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const scope = deps.search.scope(await visibilityOf(request, query.sessionId));
      const id = (request.params as { id: string }).id;
      // Undone: the concepts come apart in the graph and are never merged again.
      if (!(await deps.conceptMerges?.undo(id, scope))) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such concept merge.");
      changed({ graph: true });
      return reply.code(204).send();
    })
  );
}
