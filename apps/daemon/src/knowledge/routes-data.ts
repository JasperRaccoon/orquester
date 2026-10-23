import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  KNOWLEDGE_COLORS,
  KNOWLEDGE_GRAPH_MAX_NODES,
  knowledgeRoutes,
  type KnowledgeChangedEvent,
  type KnowledgeCollection,
  type KnowledgeCollectionView,
  type KnowledgeCollectionsResponse,
  type KnowledgeEntriesResponse,
  type KnowledgeEntryDetail,
  type KnowledgeErrorCode,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeSaveResponse,
  type KnowledgeSearchResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import type { KnowledgeLinkingPort, KnowledgeSettingsPort, KnowledgeVisibilityPort } from "./ports.ts";
import type { KnowledgeSearch } from "./search/search.ts";
import { entryInScope } from "./search/visibility.ts";
import { KnowledgeError, type KnowledgeLogger } from "./store/errors.ts";
import type { KnowledgeStore } from "./store/store.ts";

/** What the data routes need. Every field is a seam the service composes (`ports.ts`). */
export interface KnowledgeDataRoutesDeps {
  store: KnowledgeStore;
  search: KnowledgeSearch;
  /** Every route answers 409 `KNOWLEDGE_DISABLED` while `enabled()` is false. */
  settings: Pick<KnowledgeSettingsPort, "enabled">;
  visibility: KnowledgeVisibilityPort;
  /** Read after a save's store change was emitted (the service forwards changes to linking). */
  linking: Pick<KnowledgeLinkingPort, "status">;
  /** The `/events` broadcaster (`Broadcaster` satisfies it). */
  publisher: { publish(channel: string, type: string, payload: unknown): void };
  /** Agent Profiles that include each collection id (`knowledgeCollections`), by collection id. */
  profilesForCollection(): Promise<Map<string, { id: string; name: string }[]>>;
  logger?: KnowledgeLogger;
}

/** A save can carry KNOWLEDGE_SAVE_MAX_ENTRIES bodies of KNOWLEDGE_ENTRY_MAX_BYTES, JSON-escaped. */
const SAVE_BODY_LIMIT = 32 * 1024 * 1024;
const ENTRY_BODY_LIMIT = 2 * 1024 * 1024;

type Code = KnowledgeErrorCode | "KNOWLEDGE_ERROR";

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
const searchSchema = z.object({
  query: z.string(),
  collections: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? undefined),
  limit: z.number().int().optional(),
  sessionId
});
const entriesQuerySchema = z.object({
  collection: z.string().min(1).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: intFromQuery(1, 1_000),
  sessionId
});
const graphQuerySchema = z.object({
  collections: z.string().optional(),
  focus: z.string().min(1).max(300).optional(),
  depth: intFromQuery(1, 3),
  limit: intFromQuery(1, KNOWLEDGE_GRAPH_MAX_NODES),
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
 * Mutations publish `knowledge.changed` on the `knowledge` channel.
 */
export function registerKnowledgeDataRoutes(app: FastifyInstance, deps: KnowledgeDataRoutesDeps): void {
  const { store, search } = deps;
  const logger = deps.logger ?? console;

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof KnowledgeError) return reply.code(error.status).send({ code: error.code, message: error.message });
    logger.error(`knowledge: a request failed (${error instanceof Error ? error.message : String(error)})`);
    const code: Code = "KNOWLEDGE_ERROR";
    return reply.code(500).send({ code, message: "The knowledge request failed." });
  };

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
    for (const meta of store.listMeta()) for (const id of meta.collections) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  };

  /** A collection the caller can see, or NOT_FOUND. */
  const visibleCollection = (id: string, visibility: KnowledgeVisibility): KnowledgeCollection => {
    const collection = store.getCollection(id);
    if (!collection || (visibility.kind === "collections" && !visibility.ids.includes(id))) {
      throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such collection.");
    }
    return collection;
  };

  /** An entry the caller can see, or NOT_FOUND. */
  const visibleEntry = (id: string, visibility: KnowledgeVisibility): void => {
    const meta = store.getMeta(id);
    if (!meta || !entryInScope(meta, search.scope(visibility))) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
  };

  const entryDetail = async (id: string, visibility: KnowledgeVisibility): Promise<KnowledgeEntryDetail> => {
    const detail = await search.entryDetail(id, visibility);
    if (!detail) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
    return detail;
  };

  // --- collections ---------------------------------------------------------

  app.get(
    knowledgeRoutes.collections,
    handle(async (request): Promise<KnowledgeCollectionsResponse> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      const scope = search.scope(visibility);
      const byCollection = await profiles();
      const counts = entryCounts();
      const metas = store.listMeta();
      const known = scope.known;
      // Every collection, whoever asks: a profile chat chooses where to save from this list and may
      // save into collections it cannot see (spec goal 3, "Agent tools"). Names and counts are not
      // the entries; the totals below are the caller's.
      return {
        collections: store.listCollections().map((c) => collectionView(c, counts, byCollection)),
        unfiledCount: visibility.kind === "all" ? metas.filter((m) => !m.collections.some((id) => known.has(id))).length : 0,
        totalEntries: metas.filter((m) => entryInScope(m, scope)).length
      };
    })
  );

  app.post(
    knowledgeRoutes.collections,
    handle(async (request, reply) => {
      const body = parse(createCollectionSchema, request.body, "collection");
      const created = await store.createCollection({
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
      const updated = await store.updateCollection(id, {
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
      const relabelled = store.listMeta().filter((m) => m.collections.includes(id)).map((m) => m.id);
      await store.deleteCollection(id);
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
      return search.listEntries({ collection: query.collection, cursor: query.cursor, limit: query.limit }, visibility);
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
      const before = store.getMeta(id)!;
      const after = await store.updateEntry(id, body);
      if (after.updatedAt !== before.updatedAt) {
        await search.indexEntries([id]);
        changed(after.collections.join() === before.collections.join() ? { entryIds: [id] } : { entryIds: [id], collections: true });
      }
      return entryDetail(id, visibility);
    })
  );

  app.delete<{ Params: { id: string } }>(
    entryPath,
    handle(async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const query = parse(sessionQuerySchema, request.query, "query");
      visibleEntry(id, await visibilityOf(request, query.sessionId));
      await store.deleteEntry(id);
      changed({ entryIds: [id], collections: true });
      return reply.code(204).send();
    })
  );

  // --- items and the graph -------------------------------------------------

  app.get<{ Params: { id: string } }>(
    `${knowledgeRoutes.item("")}:id`,
    handle(async (request): Promise<KnowledgeItemResponse> => {
      const query = parse(sessionQuerySchema, request.query, "query");
      const item = await search.item((request.params as { id: string }).id, await visibilityOf(request, query.sessionId));
      if (!item) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "Nothing visible has that id.");
      return item;
    })
  );

  app.get(
    knowledgeRoutes.graph,
    handle(async (request): Promise<KnowledgeGraphResponse> => {
      const query = parse(graphQuerySchema, request.query, "query");
      const visibility = await visibilityOf(request, query.sessionId);
      return search.graphView({ collections: query.collections, focus: query.focus, depth: query.depth, limit: query.limit }, visibility);
    })
  );

  // --- search and save -----------------------------------------------------

  app.post(
    knowledgeRoutes.search,
    handle(async (request): Promise<KnowledgeSearchResponse> => {
      const body = parse(searchSchema, request.body, "search");
      const visibility = await visibilityOf(request, body.sessionId);
      return search.search({ query: body.query, collections: body.collections, limit: body.limit }, visibility);
    })
  );

  app.post(
    knowledgeRoutes.save,
    { bodyLimit: SAVE_BODY_LIMIT },
    handle(async (request): Promise<KnowledgeSaveResponse> => {
      const body = parse(saveSchema, request.body, "save");
      const principal = (request as unknown as { principal?: CallerPrincipal }).principal;
      const caller = principal?.kind === "agent" ? principal.threadId : body.sessionId;
      const outcome = await store.save({ entries: body.entries, newCollections: body.newCollections, sessionId: caller });
      const added = outcome.changes.filter((c) => c.kind === "added").flatMap((c) => c.entryIds);
      const touched = outcome.changes.flatMap((c) => c.entryIds);
      // Searchable (text and, for short entries, meaning) before the chat hears back.
      if (added.length > 0) await search.indexEntries(added);
      if (touched.length > 0 || outcome.createdCollections.length > 0) {
        changed({ ...(touched.length > 0 ? { entryIds: touched } : {}), collections: true });
      }
      const linking = deps.linking.status();
      return {
        results: outcome.results,
        createdCollections: outcome.createdCollections,
        linking: linking.state === "running" ? "running" : linking.state === "queued" || linking.state === "paused" ? "queued" : "not-needed"
      };
    })
  );
}
