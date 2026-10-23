/**
 * The Knowledge Graph plugin's daemon service (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md): it composes the modules
 * behind `ports.ts` and owns their lifetimes.
 *
 * - **Always** (cheap, from construction or `start()`): the settings over the plugin record, the
 *   runtime tracker, chat visibility, the session-tools manifest read, the status, and the
 *   Agent Profile cache the collection views read.
 * - **While the plugin is on** (an "opening"): the store, the in-memory graph, search (BM25, the
 *   embedder, the vector cache) and the linking module. Switching the plugin off stops all of it
 *   (the embedder is released); switching it on opens it anew. With the plugin off nothing is
 *   read, indexed or loaded; the routes answer 409 `KNOWLEDGE_DISABLED`. An opening is also started
 *   by the first request or manifest that needs it, so nothing waits for `start()`.
 * - **Linking** plugs in through {@link KnowledgeService.attachLinking} (or the `linking` option):
 *   a {@link KnowledgeLinkingFactory} is called once per opening with that opening's ports, and its
 *   module is started after it and stopped before it closes. Until one is attached a placeholder
 *   answers the status (idle, or paused: plugin off / not installed) and ignores changes.
 * - **Failures never crash the daemon**: a store that cannot be opened leaves the routes answering
 *   500 `KNOWLEDGE_ERROR` (retried on the next request) and the status naming the error.
 *
 * Routes ({@link KnowledgeService.registerRoutes}): settings and status always, the data routes
 * (gated on the plugin), rebuild, and — on the unix socket only — the two worker routes the
 * indexing sessions' tools reach through the daemon's in-process API.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  KNOWLEDGE_STATUS_EVENT,
  knowledgeRoutes,
  type KnowledgeChangedEvent,
  type KnowledgeLinkingState,
  type KnowledgeRebuildEstimate,
  type KnowledgeStatus,
  type KnowledgeWorkerNextResponse,
  type KnowledgeWorkerSubmitResponse
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { knowledgeIndexDir } from "@orquester/config";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { profileKnowledgeCollections, profilesForCollection } from "../session-profiles/knowledge.ts";
import type { SessionProfileStore } from "../session-profiles/store.ts";
import type { ManifestKnowledge } from "../session-tools/manifest.ts";
import { KnowledgeRuntimeTracker, type KnowledgeRuntimeTrackerOptions } from "./install/runtime.ts";
import type {
  KnowledgeEntryChange,
  KnowledgeLinkingContext,
  KnowledgeLinkingFactory,
  KnowledgeLinkingModule,
  KnowledgePublisher,
  KnowledgeRuntimePort
} from "./ports.ts";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import { runtimeEmbedderSource, type KnowledgeEmbedderSource } from "./search/embedder.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { registerKnowledgeSettingsRoutes } from "./settings-routes.ts";
import { KnowledgeSettingsService, type KnowledgeSettingsAccounts, type KnowledgeSettingsPlugins } from "./settings.ts";
import { KnowledgeError } from "./store/errors.ts";
import { KnowledgeStore } from "./store/store.ts";
import { createKnowledgeForSession, KnowledgeSessionVisibility, type KnowledgeSessionRecord } from "./visibility.ts";

/** How long the Agent Profile read behind the collection views is reused (profile events clear it at once). */
export const KNOWLEDGE_PROFILES_CACHE_MS = 60_000;

/** A worker answer, as the route takes it (the tool's own cap, JSON-escaped). */
const WORKER_BODY_LIMIT = 16 * 1024 * 1024;

type Logger = Pick<Console, "warn" | "error">;

/** An embedder source for one opening; released when it closes. */
export type KnowledgeEmbedderSourceFactory = (runtime: KnowledgeRuntimePort) => KnowledgeEmbedderSource & { dispose?(): Promise<void> };

export interface KnowledgeServiceOptions {
  /** The appdir base (`paths.baseDir`); every path comes from the `packages/config` helpers. */
  appdir: string;
  /** `PluginsService`: the plugin record (switch, settings, runtime version) and its `"changed"` events. */
  plugins: KnowledgeSettingsPlugins & KnowledgeRuntimeTrackerOptions["plugins"];
  /** `AgentAccountsService`: the indexing account is checked to be a Claude account. */
  accounts: KnowledgeSettingsAccounts;
  /**
   * What the daemon records about a session now: its Agent Profile (null = Global, which is what a
   * chat whose profile was deleted becomes at its next start) and its owner's kind. Null for a
   * session the daemon does not know (it then sees nothing).
   */
  session(sessionId: string): KnowledgeSessionRecord | null;
  /** The Agent Profiles' store: each chat's ticked collections, and the profiles per collection. */
  profiles: Pick<SessionProfileStore, "list" | "read">;
  /** Subscribe to Agent Profile changes and deletions (by profile id); answers the unsubscribe. */
  onProfileChange?(listener: (profileId: string) => void): () => void;
  /** The `/events` broadcaster. */
  publisher: KnowledgePublisher;
  /** The daemon's in-process API (linking starts its worker sessions through it). */
  api?(): DaemonApi | null;
  /**
   * The knowledge tools a chat is advertised may have changed (the plugin was switched, a collection
   * was created, renamed or deleted, a profile's collections changed): push every open chat's manifest.
   */
  toolsChanged?(): void;
  /** The linking module; also attachable later with {@link KnowledgeService.attachLinking}. */
  linking?: KnowledgeLinkingFactory;
  /** Overrides the runtime tracker (tests). */
  runtime?: KnowledgeRuntimePort;
  /** Overrides the ONNX embedder over the runtime (tests pass a fake). */
  embedders?: KnowledgeEmbedderSourceFactory;
  logger?: Logger;
  now?: () => Date;
}

/** One opening of the knowledge base: what runs while the plugin is on. */
interface Opening {
  store: KnowledgeStore;
  graph: KnowledgeGraph;
  search: KnowledgeSearch;
  embedders: KnowledgeEmbedderSource & { dispose?(): Promise<void> };
  linking: KnowledgeLinkingModule;
  unsubscribe: (() => void)[];
}

type ProfilesByCollection = Map<string, { id: string; name: string }[]>;

const NO_TOKENS: KnowledgeStatus["tokens"] = { week: { in: 0, out: 0 }, total: { in: 0, out: 0 } };

/**
 * The linking slot before a linking module is attached, or when building one failed: it reports
 * why nothing links (plugin off, runtime not installed, the failure) or idle, and ignores changes.
 */
class LinkingPlaceholder implements KnowledgeLinkingModule {
  constructor(
    private readonly deps: { enabled(): boolean; installed(): boolean; pending(): number },
    private readonly failure: string | null = null
  ) {}

  status(): KnowledgeLinkingState {
    const paused = (reason: "plugin-off" | "not-installed" | "error", message: string): KnowledgeLinkingState => ({
      state: "paused",
      reason,
      message,
      resumesAt: null,
      pendingEntries: this.deps.pending()
    });
    if (!this.deps.enabled()) return paused("plugin-off", "The Knowledge Graph plugin is off.");
    if (this.failure !== null) return paused("error", this.failure);
    if (!this.deps.installed()) return paused("not-installed", "The Knowledge Graph runtime is not installed yet; entries are linked once it is.");
    return { state: "idle" };
  }

  entriesChanged(_change: KnowledgeEntryChange): void {}
}

export class KnowledgeService {
  readonly settings: KnowledgeSettingsService;
  readonly runtime: KnowledgeRuntimePort;
  readonly visibility: KnowledgeSessionVisibility;
  /** `SessionToolsRefreshDeps.knowledgeForSession`. */
  readonly knowledgeForSession: (sessionId: string) => Promise<ManifestKnowledge>;

  private readonly options: KnowledgeServiceOptions;
  private readonly logger: Logger;
  private readonly tracker: KnowledgeRuntimeTracker | null;
  private linkingFactory: KnowledgeLinkingFactory | null;
  private opening: Opening | null = null;
  /** The last opening, kept for a request already past `ready()` when the plugin is switched off. */
  private lastOpening: Opening | null = null;
  private openError: { message: string; at: string } | null = null;
  /** Openings and closings, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  private readonly unsubscribers: (() => void)[] = [];
  private started = false;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private statusQueued = false;
  /** The plugin switch the chats' manifests were last pushed for. */
  private toolsEnabled: boolean;
  /** The collections (id and name, in order) the chats' manifests were last pushed for. */
  private collectionsKey: string | null = null;
  private profiles: { at: number; map: ProfilesByCollection } | null = null;
  private profilesRead: { generation: number; promise: Promise<ProfilesByCollection> } | null = null;
  /** Bumped by every profile event: a read started before it is not cached. */
  private profileGeneration = 0;
  private profileChain: Promise<void> = Promise.resolve();

  constructor(options: KnowledgeServiceOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
    this.linkingFactory = options.linking ?? null;
    this.settings = new KnowledgeSettingsService({ plugins: options.plugins, accounts: options.accounts, logger: this.logger });
    this.tracker = options.runtime ? null : new KnowledgeRuntimeTracker({ baseDir: options.appdir, plugins: options.plugins, logger: this.logger });
    this.runtime = options.runtime ?? this.tracker!;
    this.visibility = new KnowledgeSessionVisibility({
      session: (sessionId) => options.session(sessionId),
      profileCollections: (profileId) => profileKnowledgeCollections(options.profiles, profileId),
      logger: this.logger
    });
    this.knowledgeForSession = createKnowledgeForSession({
      enabled: () => this.settings.enabled(),
      visibility: this.visibility,
      // In the store's order, as the collections route lists them; none while it cannot open.
      collections: async () => (await this.ready().catch(() => null))?.store.listCollections() ?? []
    });
    this.toolsEnabled = this.settings.enabled();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Follow the plugin record, the runtime and the Agent Profiles (call after `PluginsService.start`).
   * Resolves once the runtime state is settled; the knowledge base opens in the background when the
   * plugin is on (requests wait for it). Never rejects.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribers.push(this.settings.onChange(() => this.settingsChanged()));
    this.unsubscribers.push(this.runtime.onChange(() => this.publishStatus()));
    const unsubscribeProfiles = this.options.onProfileChange?.((profileId) => this.profileChanged(profileId));
    if (unsubscribeProfiles) this.unsubscribers.push(unsubscribeProfiles);
    await this.tracker?.start().catch((error) => this.logger.warn("knowledge: the runtime state could not be read", error));
    void this.sync();
  }

  /** Stop following everything and close the knowledge base (linking first). Idempotent; never rejects. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      this.tracker?.stop();
      this.settings.dispose();
      await this.sync();
      await this.profileChain;
    })();
    return this.stopping;
  }

  /** Every opening, closing and profile event queued so far has been handled (tests). */
  async settled(): Promise<void> {
    await this.chain;
    await this.profileChain;
    await this.opening?.search.idle();
  }

  /**
   * Plug in the linking module. An open knowledge base swaps its placeholder for it at once; every
   * later opening builds its own. Only one linking module can be attached.
   */
  attachLinking(factory: KnowledgeLinkingFactory): Promise<void> {
    if (this.linkingFactory) throw new Error("knowledge: a linking module is already attached");
    this.linkingFactory = factory;
    return this.enqueue(async () => {
      const opening = this.opening;
      if (!opening) return;
      opening.linking = this.buildLinking(opening);
      await this.startLinking(opening);
      this.publishStatus();
    });
  }

  /** The open knowledge base, opening it first if the plugin is on. Throws the refusal the routes answer. */
  private async ready(): Promise<Opening> {
    if (this.opening === null && !this.stopped) await this.sync();
    const opening = this.opening;
    if (opening) return opening;
    if (!this.settings.enabled() || this.stopped) {
      throw new KnowledgeError("KNOWLEDGE_DISABLED", "The Knowledge Graph plugin is off. Turn it on in Settings → Plugins.");
    }
    throw new KnowledgeError(
      "KNOWLEDGE_ERROR",
      `The knowledge base could not be opened (${this.openError?.message ?? "unknown error"}). See the daemon log.`
    );
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    this.chain = run.catch((error) => this.logger.error("knowledge: opening or closing the knowledge base failed", error));
    return this.chain;
  }

  /** Open or close to match the plugin switch. */
  private sync(): Promise<void> {
    return this.enqueue(async () => {
      const wanted = !this.stopped && this.settings.enabled();
      if (wanted && this.opening === null) await this.open();
      else if (!wanted && this.opening !== null) await this.close();
    });
  }

  private async open(): Promise<void> {
    const { appdir } = this.options;
    let store: KnowledgeStore;
    try {
      store = await KnowledgeStore.open({ appdir, logger: this.logger, ...(this.options.now ? { now: this.options.now } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.openError?.message !== message) this.logger.error(`knowledge: the knowledge base could not be opened (${message})`);
      this.openError = { message, at: new Date().toISOString() };
      this.publishStatus();
      return;
    }
    const graph = new KnowledgeGraph({ entries: store, logger: this.logger });
    const embedders = (this.options.embedders ?? ((runtime) => runtimeEmbedderSource(runtime)))(this.runtime);
    const search = new KnowledgeSearch({ store, graph, embedders, indexDir: knowledgeIndexDir(appdir), logger: this.logger });
    const opening: Opening = { store, graph, search, embedders, linking: this.placeholder(store), unsubscribe: [] };
    // Text indexing runs in the background; queries wait for it.
    void search.start().catch((error) => this.logger.warn("knowledge: indexing the entries failed", error));
    opening.linking = this.buildLinking(opening);
    opening.unsubscribe.push(
      store.onChange((change) => {
        try {
          opening.linking.entriesChanged(change);
        } catch (error) {
          this.logger.warn("knowledge: linking could not take a change", error);
        }
        this.publishStatus();
      })
    );
    this.opening = opening;
    this.lastOpening = opening;
    this.openError = null;
    this.collectionsKey = collectionsKeyOf(store);
    await this.startLinking(opening);
    // The collection views read it; profile events then keep it current.
    void this.readProfiles().catch(() => undefined);
    this.publishStatus();
  }

  private async close(): Promise<void> {
    const opening = this.opening;
    if (!opening) return;
    this.opening = null;
    for (const unsubscribe of opening.unsubscribe.splice(0)) unsubscribe();
    await opening.linking.stop?.().catch((error: unknown) => this.logger.warn("knowledge: stopping linking failed", error));
    await opening.search.stop().catch((error: unknown) => this.logger.warn("knowledge: stopping search failed", error));
    await opening.store.idle();
    await opening.embedders.dispose?.().catch((error: unknown) => this.logger.warn("knowledge: releasing the embedder failed", error));
    this.publishStatus();
  }

  private placeholder(store: KnowledgeStore, failure: string | null = null): LinkingPlaceholder {
    return new LinkingPlaceholder(
      {
        enabled: () => this.settings.enabled(),
        installed: () => this.runtime.current() !== null,
        pending: () => store.listMeta().filter((meta) => meta.linkState === "pending").length
      },
      failure
    );
  }

  private buildLinking(opening: Opening): KnowledgeLinkingModule {
    const factory = this.linkingFactory;
    if (!factory) return this.placeholder(opening.store);
    const context: KnowledgeLinkingContext = {
      appdir: this.options.appdir,
      store: opening.store,
      graph: opening.graph,
      runtime: this.runtime,
      settings: this.settings,
      api: () => this.options.api?.() ?? null,
      isWorker: (sessionId) => this.visibility.isWorker(sessionId),
      statusChanged: () => this.publishStatus(),
      graphChanged: () => {
        this.publishChanged({ graph: true });
        this.publishStatus();
      },
      publisher: this.options.publisher,
      logger: this.logger
    };
    try {
      return factory(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`knowledge: the linking module could not be built (${message})`);
      return this.placeholder(opening.store, `Linking could not start: ${message}`);
    }
  }

  private async startLinking(opening: Opening): Promise<void> {
    try {
      await opening.linking.start?.();
    } catch (error) {
      this.logger.error("knowledge: starting linking failed", error);
    }
  }

  // -------------------------------------------------------------------------
  // Status and events
  // -------------------------------------------------------------------------

  /** The linking state, from the linking module (or why nothing links). Never throws. */
  linkingStatus(): KnowledgeLinkingState {
    const opening = this.opening;
    if (opening) {
      try {
        return opening.linking.status();
      } catch (error) {
        this.logger.warn("knowledge: linking could not report its status", error);
        return { state: "paused", reason: "error", message: "Linking could not report its status.", resumesAt: null, pendingEntries: 0 };
      }
    }
    if (!this.settings.enabled()) return { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries: 0 };
    if (this.openError) return { state: "paused", reason: "error", message: `The knowledge base could not be opened: ${this.openError.message}`, resumesAt: null, pendingEntries: 0 };
    return { state: "idle" };
  }

  /** `GET knowledgeRoutes.status`. Counts are those of the open knowledge base (zero while the plugin is off). */
  status(): KnowledgeStatus {
    const opening = this.opening;
    let report: ReturnType<NonNullable<KnowledgeLinkingModule["report"]>> | undefined;
    try {
      report = opening?.linking.report?.();
    } catch (error) {
      this.logger.warn("knowledge: linking could not report its runs", error);
    }
    const counts = opening?.graph.counts() ?? { nodes: 0, edges: 0 };
    return {
      enabled: this.settings.enabled(),
      installed: this.runtime.current() !== null,
      entries: opening?.store.listMeta().length ?? 0,
      concepts: counts.nodes,
      edges: counts.edges,
      collections: opening?.store.listCollections().length ?? 0,
      linking: this.linkingStatus(),
      lastRun: report?.lastRun ?? null,
      recentRuns: report?.recentRuns ?? [],
      workers: report?.workers ?? [],
      tokens: report?.tokens ?? NO_TOKENS,
      lastError: report?.lastError ?? this.openError
    };
  }

  /** Publish `knowledge.status` once for every burst of changes in one tick. */
  private publishStatus(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      try {
        this.options.publisher.publish(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, this.status());
      } catch (error) {
        this.logger.warn("knowledge: publishing the status failed", error);
      }
    });
  }

  private publishChanged(event: KnowledgeChangedEvent): void {
    try {
      this.options.publisher.publish(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, event);
    } catch (error) {
      this.logger.warn("knowledge: publishing a change failed", error);
    }
  }

  private toolsChanged(): void {
    try {
      this.options.toolsChanged?.();
    } catch (error) {
      this.logger.warn("knowledge: refreshing the chats' tools failed", error);
    }
  }

  private settingsChanged(): void {
    this.publishStatus();
    void this.sync().then(() => {
      const enabled = this.settings.enabled();
      if (enabled === this.toolsEnabled) return;
      this.toolsEnabled = enabled;
      this.toolsChanged();
    });
  }

  /** A data route changed the collections (or their counts): push manifests when a name or the set changed. */
  private collectionsMaybeChanged(): void {
    const opening = this.opening;
    if (!opening) return;
    const key = collectionsKeyOf(opening.store);
    if (key === this.collectionsKey) return;
    this.collectionsKey = key;
    if (this.settings.enabled()) this.toolsChanged();
  }

  // -------------------------------------------------------------------------
  // Agent Profiles
  // -------------------------------------------------------------------------

  /** Per collection id, the profiles that tick it: one profile-store listing, reused until a profile event or the TTL. */
  profilesForCollection(): Promise<ProfilesByCollection> {
    const cached = this.profiles;
    if (cached && Date.now() - cached.at < KNOWLEDGE_PROFILES_CACHE_MS) return Promise.resolve(cached.map);
    return this.readProfiles();
  }

  private readProfiles(): Promise<ProfilesByCollection> {
    const generation = this.profileGeneration;
    if (this.profilesRead && this.profilesRead.generation === generation) return this.profilesRead.promise;
    const promise = profilesForCollection(this.options.profiles).then((map) => {
      if (this.profileGeneration === generation) this.profiles = { at: Date.now(), map };
      return map;
    });
    const read = { generation, promise };
    this.profilesRead = read;
    void promise
      .finally(() => {
        if (this.profilesRead === read) this.profilesRead = null;
      })
      .catch(() => undefined);
    return promise;
  }

  /** A profile changed or was deleted: re-read the profiles and push manifests when its collections changed. */
  private profileChanged(profileId: string): void {
    const run = this.profileChain.then(async () => {
      const before = this.profiles?.map ?? null;
      this.profileGeneration += 1;
      this.profiles = null;
      // With the plugin off no chat has knowledge tools; switching it on pushes every manifest.
      if (this.stopped || !this.settings.enabled()) return;
      const after = await this.readProfiles().catch((error: unknown) => {
        this.logger.warn("knowledge: the Agent Profiles could not be read", error);
        return null;
      });
      if (before === null || after === null || ticked(before, profileId) !== ticked(after, profileId)) this.toolsChanged();
    });
    this.profileChain = run.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /**
   * Every knowledge route on one transport: settings and status (answered with the plugin off), the
   * data routes and rebuild (409 `KNOWLEDGE_DISABLED` while off), and with `socket` the worker
   * routes, which only the in-process API reaches (the indexing sessions' tools). Remote HTTP gets
   * the same bearer hook as every other `/api` route.
   */
  registerRoutes(app: FastifyInstance, options: { socket: boolean }): void {
    const logger = this.logger;
    const service = this;
    registerKnowledgeSettingsRoutes(app, { settings: this.settings, logger });
    registerKnowledgeDataRoutes(app, {
      // Read per request, after `ready`: the opening of the moment.
      get store() {
        return (service.opening ?? service.lastOpening)!.store;
      },
      get search() {
        return (service.opening ?? service.lastOpening)!.search;
      },
      settings: { enabled: () => this.settings.enabled() },
      ready: async () => {
        await this.ready();
      },
      visibility: this.visibility,
      linking: { status: () => this.linkingStatus() },
      publisher: {
        publish: (channel, type, payload) => {
          this.options.publisher.publish(channel, type, payload);
          if (type === KNOWLEDGE_CHANGED_EVENT && (payload as KnowledgeChangedEvent | null)?.collections === true) this.collectionsMaybeChanged();
        }
      },
      profilesForCollection: () => this.profilesForCollection(),
      logger
    });

    const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
      if (error instanceof KnowledgeError) return reply.code(error.status).send({ code: error.code, message: error.message });
      logger.error(`knowledge: a request failed (${error instanceof Error ? error.message : String(error)})`);
      return reply.code(500).send({ code: "KNOWLEDGE_ERROR", message: "The knowledge request failed." });
    };
    const notBuilt = (): KnowledgeError => new KnowledgeError("KNOWLEDGE_NOT_INSTALLED", "Graph linking is not available in this build.");
    const gated = async (): Promise<Opening> => {
      if (!this.settings.enabled()) throw new KnowledgeError("KNOWLEDGE_DISABLED", "The Knowledge Graph plugin is off. Turn it on in Settings → Plugins.");
      return this.ready();
    };

    app.get(knowledgeRoutes.status, async (): Promise<KnowledgeStatus> => this.status());

    app.get(knowledgeRoutes.rebuildEstimate, async (_request, reply): Promise<KnowledgeRebuildEstimate | FastifyReply> => {
      try {
        const opening = await gated();
        if (!opening.linking.rebuildEstimate) throw notBuilt();
        return await opening.linking.rebuildEstimate();
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post(knowledgeRoutes.rebuild, async (_request, reply): Promise<KnowledgeStatus | FastifyReply> => {
      try {
        const opening = await gated();
        if (!opening.linking.rebuild) throw notBuilt();
        await opening.linking.rebuild();
        return reply.code(202).send(this.status());
      } catch (error) {
        return fail(reply, error);
      }
    });

    if (!options.socket) return;

    /** The calling worker session: the agent principal's thread, else the body's `sessionId`; 403 unless it is a worker. */
    const worker = async (request: FastifyRequest, bodySessionId: string | undefined): Promise<string> => {
      const principal = (request as unknown as { principal?: CallerPrincipal }).principal;
      const sessionId = principal?.kind === "agent" ? principal.threadId : bodySessionId;
      if (!sessionId || !(await this.visibility.isWorker(sessionId))) {
        throw new KnowledgeError("KNOWLEDGE_NOT_A_WORKER", "Only the Knowledge Graph plugin's indexing sessions take tasks.");
      }
      return sessionId;
    };
    /** No linking to work for (the plugin is off, or none is built): the worker ends its turn. */
    const cancelled: KnowledgeWorkerNextResponse = { kind: "done", reason: "run-cancelled" };
    const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.output<T> => {
      const parsed = schema.safeParse(body ?? {});
      if (parsed.success) return parsed.data;
      const issue = parsed.error.issues[0];
      throw new KnowledgeError("KNOWLEDGE_INVALID", `Invalid request — ${issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "invalid"}.`);
    };
    const sessionId = z.string().min(1).max(200).optional();
    const nextSchema = z.object({ sessionId });
    const submitSchema = z.object({ sessionId, taskId: z.string().min(1).max(200), answer: z.string().max(2_000_000) });

    app.post(knowledgeRoutes.workerNext, async (request, reply): Promise<KnowledgeWorkerNextResponse | FastifyReply> => {
      try {
        const body = parse(nextSchema, request.body);
        const caller = await worker(request, body.sessionId);
        const linking = this.opening?.linking;
        if (!this.settings.enabled() || !linking?.workerNext) return cancelled;
        return await linking.workerNext(caller);
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post(knowledgeRoutes.workerSubmit, { bodyLimit: WORKER_BODY_LIMIT }, async (request, reply): Promise<KnowledgeWorkerSubmitResponse | FastifyReply> => {
      try {
        const body = parse(submitSchema, request.body);
        const caller = await worker(request, body.sessionId);
        const linking = this.opening?.linking;
        if (!this.settings.enabled() || !linking?.workerSubmit) return { accepted: true, next: cancelled };
        return await linking.workerSubmit(caller, { taskId: body.taskId, answer: body.answer });
      } catch (error) {
        return fail(reply, error);
      }
    });
  }
}

/** The collections as the manifests name them: ids and names, in order. */
function collectionsKeyOf(store: KnowledgeStore): string {
  return JSON.stringify(store.listCollections().map((collection) => [collection.id, collection.name]));
}

/** The collection ids one profile ticks in a profiles-by-collection map, as a comparable key. */
function ticked(map: ProfilesByCollection, profileId: string): string {
  const ids: string[] = [];
  for (const [collectionId, profiles] of map) if (profiles.some((profile) => profile.id === profileId)) ids.push(collectionId);
  return ids.sort().join(",");
}
