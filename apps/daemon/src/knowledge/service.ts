/**
 * The Knowledge Graph plugin's daemon service (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md): it composes the modules
 * behind `ports.ts` and owns their lifetimes.
 *
 * - **Always** (cheap): the settings over the plugin record, the runtime tracker, chat visibility,
 *   the session-tools manifest read, the status, and the Agent Profile cache the collection views
 *   read.
 * - **From the first time the plugin is on** (the "opening", kept until the daemon stops): the
 *   store, the in-memory graph, search (BM25, the embedder, the vector cache) and linking
 *   (`linking/service.ts`, built by the `linking` factory with the opening's store and graph; its
 *   store changes are forwarded to it). With the plugin off since boot nothing of it is read. When
 *   the plugin is switched off later the data routes answer 409 `KNOWLEDGE_DISABLED`, linking
 *   pauses itself (a run in flight is cancelled), and the embedder is released: nothing indexes,
 *   embeds or links; the entries stay in memory for the next switch-on.
 * - **Failures never crash the daemon**: a store that cannot be opened leaves the data routes
 *   answering 500 `KNOWLEDGE_ERROR` (retried on the next request) and the status naming the error;
 *   a linking module that cannot be built or started leaves linking paused with the error.
 *
 * Routes ({@link KnowledgeService.registerRoutes}): settings, the data routes, and linking's status,
 * rebuild and worker routes (`routes-linking.ts`; the worker is only ever the stamped agent principal).
 */

import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  KNOWLEDGE_STATUS_EVENT,
  type KnowledgeChangedEvent,
  type KnowledgeLinkingState,
  type KnowledgeStatus,
  type SessionOwner
} from "@orquester/api";
import { knowledgeIndexDir } from "@orquester/config";

import { profileKnowledgeCollections, profilesForCollection } from "../session-profiles/knowledge.ts";
import type { SessionProfileStore } from "../session-profiles/store.ts";
import type { ManifestKnowledge } from "../session-tools/manifest.ts";
import { KnowledgeRuntimeTracker, type KnowledgeRuntimeTrackerOptions } from "./install/runtime.ts";
import type { KnowledgeLinkingService, KnowledgeLinkingSnapshot } from "./linking/service.ts";
import type { KnowledgeRuntimePort, KnowledgeSettingsPort } from "./ports.ts";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import { buildKnowledgeStatus, registerKnowledgeLinkingRoutes, type KnowledgeLinkingRouteService, type KnowledgeStatusCounts } from "./routes-linking.ts";
import { runtimeEmbedderSource, type KnowledgeEmbedderSource } from "./search/embedder.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { registerKnowledgeSettingsRoutes } from "./settings-routes.ts";
import { KnowledgeSettingsService, type KnowledgeSettingsAccounts, type KnowledgeSettingsPlugins } from "./settings.ts";
import { KnowledgeError } from "./store/errors.ts";
import { KnowledgeStore } from "./store/store.ts";
import { createKnowledgeForSession, KnowledgeSessionVisibility, ownerKindOf } from "./visibility.ts";

/** How long the Agent Profile read behind the collection views is reused (profile events clear it at once). */
export const KNOWLEDGE_PROFILES_CACHE_MS = 60_000;

type Logger = Pick<Console, "warn" | "error">;

/** The `/events` broadcaster (`Broadcaster` satisfies it). */
export interface KnowledgePublisher {
  publish(channel: string, type: string, payload: unknown): void;
}

/** What the service runs of the linking module. `KnowledgeLinkingService` is it. */
export type KnowledgeLinking = KnowledgeLinkingRouteService & Pick<KnowledgeLinkingService, "start" | "stop" | "status" | "entriesChanged" | "events">;

/** Builds the linking module once, with the opening's store and graph (`KnowledgeLinkingOptions`). */
export type KnowledgeLinkingFactory = (ports: {
  store: KnowledgeStore;
  graph: KnowledgeGraph;
  runtime: KnowledgeRuntimePort;
  settings: KnowledgeSettingsPort;
}) => KnowledgeLinking;

/** An embedder source over a runtime (the gated one: null while the plugin is off). */
export type KnowledgeEmbedderSourceFactory = (runtime: KnowledgeRuntimePort) => KnowledgeEmbedderSource & { dispose?(): Promise<void> };

/** What the daemon records about one session now. */
export interface KnowledgeSessionInfo {
  /** Its Agent Profile; null or absent = Global (what a chat whose profile was deleted becomes at its next start). */
  profileId?: string | null;
  /** `SessionSummary.owner`: a workflow's, or the plugin's own indexer chats' `{kind: "knowledge-indexer", runId}`. */
  owner?: SessionOwner;
}

export interface KnowledgeServiceOptions {
  /** The appdir base (`paths.baseDir`); every path comes from the `packages/config` helpers. */
  appdir: string;
  /** `PluginsService`: the plugin record (switch, settings, runtime version) and its `"changed"` events. */
  plugins: KnowledgeSettingsPlugins & KnowledgeRuntimeTrackerOptions["plugins"];
  /** `AgentAccountsService`: the indexing account is checked to be a Claude account. */
  accounts: KnowledgeSettingsAccounts;
  /** The session's record now (its tab), or null for a session the daemon does not know (it sees nothing). */
  session(sessionId: string): KnowledgeSessionInfo | null;
  /** The Agent Profiles' store: each chat's ticked collections, and the profiles per collection. */
  profiles: Pick<SessionProfileStore, "list" | "read">;
  /** Subscribe to Agent Profile changes and deletions (by profile id); answers the unsubscribe. */
  onProfileChange?(listener: (profileId: string) => void): () => void;
  /** The `/events` broadcaster. */
  publisher: KnowledgePublisher;
  /**
   * The knowledge tools a chat is advertised may have changed (the plugin was switched, a collection
   * was created, renamed or deleted, a profile's collections changed): push every open chat's manifest.
   */
  toolsChanged?(): void;
  /** Linking. Absent (tests of the rest): linking stays paused ("not built") and ignores changes. */
  linking?: KnowledgeLinkingFactory;
  /** Overrides the runtime tracker (tests). */
  runtime?: KnowledgeRuntimePort;
  /** Overrides the ONNX embedder over the runtime (tests pass a fake). */
  embedders?: KnowledgeEmbedderSourceFactory;
  logger?: Logger;
  now?: () => Date;
}

/** The knowledge base, open from the first switch-on until the daemon stops. */
interface Opening {
  store: KnowledgeStore;
  graph: KnowledgeGraph;
  search: KnowledgeSearch;
  embedders: KnowledgeEmbedderSource & { dispose?(): Promise<void> };
  linking: KnowledgeLinking;
  unsubscribe: (() => void)[];
}

type ProfilesByCollection = Map<string, { id: string; name: string }[]>;

const NO_TOKENS: KnowledgeStatus["tokens"] = { week: { in: 0, out: 0 }, total: { in: 0, out: 0 } };

/** Linking when none is built (tests) or building it failed: paused, with the reason; ignores changes. */
class NoLinking implements KnowledgeLinking {
  readonly events = new EventEmitter<{ status: [] }>();

  constructor(
    private readonly settings: KnowledgeSettingsPort,
    private readonly message: string
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  entriesChanged(): void {}

  status(): KnowledgeLinkingState {
    if (!this.settings.enabled()) return { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries: 0 };
    return { state: "paused", reason: "error", message: this.message, resumesAt: null, pendingEntries: 0 };
  }

  snapshot(): KnowledgeLinkingSnapshot {
    return { linking: this.status(), lastRun: null, recentRuns: [], workers: [], tokens: NO_TOKENS, lastError: null };
  }

  async rebuild(): Promise<{ queued: boolean; running: boolean }> {
    throw new KnowledgeError("KNOWLEDGE_NOT_INSTALLED", this.message);
  }

  async rebuildEstimate(): Promise<{ entries: number; tasks: number }> {
    return { entries: 0, tasks: 0 };
  }

  isActiveWorker(): boolean {
    return false;
  }

  async workerNext(): Promise<{ kind: "done"; reason: "run-cancelled" }> {
    return { kind: "done", reason: "run-cancelled" };
  }

  async workerSubmit(): Promise<{ accepted: false; error: string }> {
    return { accepted: false, error: "No linking run is in flight; end your turn." };
  }
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
  /** The runtime as the embedder sees it: none while the plugin is off, so the model is released. */
  private readonly embedderRuntime: KnowledgeRuntimePort;
  private opening: Opening | null = null;
  private openError: { message: string; at: string } | null = null;
  /** Openings (and the closing at stop), one at a time. */
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
  /** The graph's counts last announced (`knowledge.changed {graph: true}` when they move). */
  private graphKey = "0/0";
  private profiles: { at: number; map: ProfilesByCollection } | null = null;
  private profilesRead: { generation: number; promise: Promise<ProfilesByCollection> } | null = null;
  /** Bumped by every profile event: a read started before it is not cached. */
  private profileGeneration = 0;
  private profileChain: Promise<void> = Promise.resolve();

  constructor(options: KnowledgeServiceOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
    this.settings = new KnowledgeSettingsService({ plugins: options.plugins, accounts: options.accounts, logger: this.logger });
    this.tracker = options.runtime ? null : new KnowledgeRuntimeTracker({ baseDir: options.appdir, plugins: options.plugins, logger: this.logger });
    this.runtime = options.runtime ?? this.tracker!;
    const runtime = this.runtime;
    const settings = this.settings;
    this.embedderRuntime = {
      current: () => (settings.enabled() ? runtime.current() : null),
      onChange: (listener) => {
        const offRuntime = runtime.onChange(() => listener(this.embedderRuntime.current()));
        const offSettings = settings.onChange(() => listener(this.embedderRuntime.current()));
        return () => {
          offRuntime();
          offSettings();
        };
      }
    };
    this.visibility = new KnowledgeSessionVisibility({
      session: (sessionId) => {
        const session = options.session(sessionId);
        if (!session) return null;
        const ownerKind = ownerKindOf(session.owner);
        return { profileId: session.profileId ?? null, ...(ownerKind !== undefined ? { ownerKind } : {}) };
      },
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
   * Follow the plugin record, the runtime and the Agent Profiles, and open the knowledge base when
   * the plugin is on (linking then loads its graph and resumes). Call after `PluginsService.start`
   * and once the daemon's in-process API exists (linking's worker chats use it). Never rejects.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribers.push(this.settings.onChange(() => this.settingsChanged()));
    this.unsubscribers.push(this.runtime.onChange(() => this.publishStatus()));
    const unsubscribeProfiles = this.options.onProfileChange?.((profileId) => this.profileChanged(profileId));
    if (unsubscribeProfiles) this.unsubscribers.push(unsubscribeProfiles);
    await this.tracker?.start().catch((error) => this.logger.warn("knowledge: the runtime state could not be read", error));
    await this.openIfEnabled();
  }

  /** Stop following everything; linking stops first (its child is stopped, its chats left running), then search, the store, the embedder. Idempotent; never rejects. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      this.tracker?.stop();
      this.settings.dispose();
      await this.enqueue(() => this.close());
      await this.profileChain;
    })();
    return this.stopping;
  }

  /** Every opening and profile event queued so far has been handled, and search is idle (tests). */
  async settled(): Promise<void> {
    await this.chain;
    await this.profileChain;
    await this.opening?.search.idle();
  }

  /** The linking module (null until the knowledge base opened). */
  linking(): KnowledgeLinking | null {
    return this.opening?.linking ?? null;
  }

  /** The open knowledge base, opening it first if the plugin is on. Throws the refusal the routes answer. */
  private async ready(): Promise<Opening> {
    if (this.opening === null) await this.openIfEnabled();
    const opening = this.opening;
    if (opening) return opening;
    if (!this.settings.enabled() || this.stopped) {
      throw new KnowledgeError("KNOWLEDGE_DISABLED", "The Knowledge Graph plugin is off. Turn it on in Settings → Plugins.");
    }
    if (!this.started) throw new KnowledgeError("KNOWLEDGE_BUSY", "The Knowledge Graph plugin is still starting. Try again in a moment.");
    throw new KnowledgeError("KNOWLEDGE_ERROR", `The knowledge base could not be opened (${this.openError?.message ?? "unknown error"}). See the daemon log.`);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    this.chain = run.catch((error) => this.logger.error("knowledge: opening or closing the knowledge base failed", error));
    return this.chain;
  }

  private openIfEnabled(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started && !this.stopped && this.opening === null && this.settings.enabled()) await this.open();
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
    const embedders = (this.options.embedders ?? ((runtime) => runtimeEmbedderSource(runtime)))(this.embedderRuntime);
    const search = new KnowledgeSearch({ store, graph, embedders, indexDir: knowledgeIndexDir(appdir), logger: this.logger });
    // Text indexing runs in the background; queries wait for it.
    void search.start().catch((error) => this.logger.warn("knowledge: indexing the entries failed", error));
    const linking = this.buildLinking(store, graph);
    const opening: Opening = { store, graph, search, embedders, linking, unsubscribe: [] };
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
    const onLinkingStatus = (): void => this.linkingMoved();
    linking.events.on("status", onLinkingStatus);
    opening.unsubscribe.push(() => linking.events.off("status", onLinkingStatus));
    this.opening = opening;
    this.openError = null;
    this.collectionsKey = collectionsKeyOf(store);
    try {
      // Loads state.json and the recorded graph, then resumes or schedules a run.
      await linking.start();
    } catch (error) {
      this.logger.error("knowledge: starting linking failed", error);
      opening.linking = new NoLinking(this.settings, `Linking could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.linkingMoved();
    // The collection views read it; profile events then keep it current.
    void this.readProfiles().catch(() => undefined);
    this.publishStatus();
  }

  private buildLinking(store: KnowledgeStore, graph: KnowledgeGraph): KnowledgeLinking {
    const factory = this.options.linking;
    if (!factory) return new NoLinking(this.settings, "Graph linking is not available in this build.");
    try {
      return factory({ store, graph, runtime: this.runtime, settings: this.settings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`knowledge: the linking module could not be built (${message})`);
      return new NoLinking(this.settings, `Linking could not start: ${message}`);
    }
  }

  private async close(): Promise<void> {
    const opening = this.opening;
    if (!opening) return;
    this.opening = null;
    for (const unsubscribe of opening.unsubscribe.splice(0)) unsubscribe();
    await opening.linking.stop().catch((error: unknown) => this.logger.warn("knowledge: stopping linking failed", error));
    await opening.search.stop().catch((error: unknown) => this.logger.warn("knowledge: stopping search failed", error));
    await opening.store.idle();
    await opening.embedders.dispose?.().catch((error: unknown) => this.logger.warn("knowledge: releasing the embedder failed", error));
  }

  // -------------------------------------------------------------------------
  // Status and events
  // -------------------------------------------------------------------------

  /** The linking state (linking's own, or why there is none yet). Never throws. */
  linkingStatus(): KnowledgeLinkingState {
    return this.snapshot().linking;
  }

  private snapshot(): KnowledgeLinkingSnapshot {
    const opening = this.opening;
    if (opening) {
      try {
        return opening.linking.snapshot();
      } catch (error) {
        this.logger.warn("knowledge: linking could not report its status", error);
      }
    }
    const paused = (reason: "plugin-off" | "error", message: string): KnowledgeLinkingState => ({ state: "paused", reason, message, resumesAt: null, pendingEntries: 0 });
    const linking = !this.settings.enabled()
      ? paused("plugin-off", "The Knowledge Graph plugin is off.")
      : this.openError
        ? paused("error", `The knowledge base could not be opened: ${this.openError.message}`)
        : ({ state: "idle" } as const);
    return { linking, lastRun: null, recentRuns: [], workers: [], tokens: NO_TOKENS, lastError: this.openError };
  }

  private counts(): KnowledgeStatusCounts {
    const opening = this.opening;
    const graph = opening?.graph.counts() ?? { nodes: 0, edges: 0 };
    return {
      enabled: this.settings.enabled(),
      installed: this.runtime.current() !== null,
      entries: opening?.store.listMeta().length ?? 0,
      concepts: graph.nodes,
      edges: graph.edges,
      collections: opening?.store.listCollections().length ?? 0
    };
  }

  /** `GET knowledgeRoutes.status`. Counts are those of the knowledge base (zero before it first opened). */
  status(): KnowledgeStatus {
    return buildKnowledgeStatus(this.snapshot(), this.counts());
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

  /** Linking moved: the status, and `knowledge.changed {graph: true}` when a run (re)loaded the graph. */
  private linkingMoved(): void {
    const counts = this.opening?.graph.counts();
    const key = counts ? `${counts.nodes}/${counts.edges}` : this.graphKey;
    if (key !== this.graphKey) {
      this.graphKey = key;
      this.publishChanged({ graph: true });
    }
    this.publishStatus();
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
    // Switched off: the embedder source drops its model now (its runtime reads as none).
    if (!this.settings.enabled()) this.opening?.embedders.current();
    void this.openIfEnabled().then(() => {
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
   * Every knowledge route on one transport (both register them; remote HTTP behind the bearer hook
   * like every `/api` route): settings, the data routes (409 `KNOWLEDGE_DISABLED` while off), and
   * linking's status, rebuild and worker routes. In-chat tools reach them through the unix app's
   * in-process client with the agent's principal, which is all the worker routes accept.
   */
  registerRoutes(app: FastifyInstance): void {
    const logger = this.logger;
    const service = this;
    registerKnowledgeSettingsRoutes(app, { settings: this.settings, logger });
    registerKnowledgeDataRoutes(app, {
      // Read per request, after `ready` (the opening exists then, until the daemon stops).
      get store() {
        return service.opening!.store;
      },
      get search() {
        return service.opening!.search;
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
    // Linking's routes read the module of the moment (none before the knowledge base opened).
    const current = (): KnowledgeLinkingRouteService => this.opening?.linking ?? new NoLinking(this.settings, "The knowledge base is not open.");
    registerKnowledgeLinkingRoutes(app, {
      linking: {
        snapshot: () => this.snapshot(),
        rebuild: async () => {
          const opening = await this.ready();
          return opening.linking.rebuild();
        },
        rebuildEstimate: () => current().rebuildEstimate(),
        isActiveWorker: (owner) => current().isActiveWorker(owner),
        workerNext: (sessionId, signal) => current().workerNext(sessionId, signal),
        workerSubmit: (sessionId, taskId, answer, signal) => current().workerSubmit(sessionId, taskId, answer, signal)
      },
      counts: () => this.counts(),
      sessionOwner: (sessionId) => this.options.session(sessionId)?.owner,
      logger
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
