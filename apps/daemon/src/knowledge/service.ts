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
import { join } from "node:path";
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
import { knowledgeClusterLabelsPath, knowledgeConceptMergesPath, knowledgeConceptSummariesPath, knowledgeIndexDir } from "@orquester/config";

import { profileKnowledgeCollections, profilesForCollection } from "../session-profiles/knowledge.ts";
import type { SessionProfileStore } from "../session-profiles/store.ts";
import type { ManifestKnowledge } from "../session-tools/manifest.ts";
import { KnowledgeRuntimeTracker, type KnowledgeRuntimeTrackerOptions } from "./install/runtime.ts";
import type { KnowledgeLinkGraphView } from "./linking/context.ts";
import type { KnowledgeLinkingService, KnowledgeLinkingSnapshot } from "./linking/service.ts";
import type { KnowledgePairChecksPort, KnowledgeRoundTaskSource, KnowledgeRuntimePort, KnowledgeSettingsPort } from "./ports.ts";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import { buildKnowledgeStatus, registerKnowledgeLinkingRoutes, type KnowledgeLinkingRouteService, type KnowledgeStatusCounts } from "./routes-linking.ts";
import { KnowledgeClusterLabels, type ClusterDescription } from "./search/cluster-labels.ts";
import { ConceptMergeCheckSource } from "./search/concept-merge-checks.ts";
import { KnowledgeConceptMerges, conceptThresholdsFor } from "./search/concept-merges.ts";
import { KnowledgeConceptSummaries } from "./search/concept-summaries.ts";
import { findContradictions } from "./search/contradictions.ts";
import { runtimeEmbedderSource, type KnowledgeEmbedderSource } from "./search/embedder.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { knowledgeScope } from "./search/visibility.ts";
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

/**
 * What the service runs of the linking module. `KnowledgeLinkingService` is it. `pairChecks` and
 * `gapQueued` are phase 2's seams for insights (the spec's "Shared seams").
 */
export type KnowledgeLinking = KnowledgeLinkingRouteService &
  Pick<KnowledgeLinkingService, "start" | "stop" | "status" | "entriesChanged" | "events" | "gapQueued"> & {
    readonly pairChecks: KnowledgePairChecksPort;
  };

/** Builds the linking module once, with the opening's store and graph (`KnowledgeLinkingOptions`). */
export type KnowledgeLinkingFactory = (ports: {
  store: KnowledgeStore;
  graph: KnowledgeGraph;
  runtime: KnowledgeRuntimePort;
  settings: KnowledgeSettingsPort;
  /** Search and the concept graph as phase 2 linking reads them (`linkGraphView`). */
  graphView: KnowledgeLinkGraphView;
  /** LLM work for linking's idle rounds: concept merge checks, cluster names and concept summaries (`KnowledgeLinkingOptions.roundTasks`). */
  roundTasks: readonly KnowledgeRoundTaskSource[];
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
  /** `AgentAccountsService`: the indexing policy's accounts are checked to be Claude accounts. */
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
}

/** The knowledge base, open from the first switch-on until the daemon stops. */
interface Opening {
  store: KnowledgeStore;
  graph: KnowledgeGraph;
  search: KnowledgeSearch;
  embedders: KnowledgeEmbedderSource & { dispose?(): Promise<void> };
  linking: KnowledgeLinking;
  /** Automatic concept merges over the graph (phase 2 spec, "Concept merges"). */
  conceptMerges: KnowledgeConceptMerges;
  /** LLM topic names of similarity clusters (`search/cluster-labels.ts`). */
  clusterLabels: KnowledgeClusterLabels;
  unsubscribe: (() => void)[];
}

type ProfilesByCollection = Map<string, { id: string; name: string }[]>;

const NO_TOKENS: KnowledgeStatus["tokens"] = { week: { in: 0, out: 0 }, total: { in: 0, out: 0 } };

/** Pair checks while no linking module checks pairs: none, and never a change. */
const NO_PAIR_CHECKS: KnowledgePairChecksPort = {
  all: () => [],
  get: () => null,
  onChange: () => () => {}
};

/**
 * What phase 2 linking reads of search and the concept graph (`linking/context.ts`): the vector
 * index of the moment, an entry's concepts, and the concepts a `contradicts` edge joins (unscoped:
 * linking sees every entry).
 */
export function linkGraphView(
  store: Pick<KnowledgeStore, "listCollections">,
  graph: KnowledgeGraph,
  search: Pick<KnowledgeSearch, "vectorIndex" | "vectorsIdle">,
  concepts?: Pick<KnowledgeConceptMerges, "vectors">
): KnowledgeLinkGraphView {
  const everything = () => knowledgeScope({ kind: "all" }, store.listCollections().map((collection) => collection.id));
  return {
    vectors: () => search.vectorIndex(),
    vectorsSettled: () => search.vectorsIdle(),
    graphRevision: () => graph.contentRevision(),
    // Concept vectors of a calibrated model only (what their closeness means is known).
    ...(concepts
      ? {
          conceptVector: (conceptId: string) => {
            const set = concepts.vectors.current();
            return set && conceptThresholdsFor(set.modelId) ? (set.vectors.get(conceptId) ?? null) : null;
          }
        }
      : {}),
    conceptsOf: (entryId) => graph.conceptsOfEntry(entryId, everything()),
    sameQuestion: (a, b) => graph.sameQuestion(a, b),
    // The graph's adjacency, not a concept detail (which also ranks similar concepts): read per concept of every linked entry.
    contradicting: (conceptId) => {
      const scope = everything();
      const self = graph.canonicalConceptId(conceptId);
      const out = new Set<string>();
      for (const edge of graph.visibleEdgesOfType("contradicts", scope, [self])) {
        const other = graph.conceptRef(edge.from === self ? edge.to : edge.from, scope);
        if (other) out.add(other.id);
      }
      return [...out];
    }
  };
}

/** Concept types that name a thing rather than a topic: a cluster name must not be one of them alone. */
const ENTITY_CONCEPT_TYPES: ReadonlySet<string> = new Set([
  "person",
  "organization",
  "company",
  "product",
  "tool",
  "app",
  "platform",
  "platformapi",
  "aiservice",
  "channel",
  "agentskill",
  "storefront"
]);
/** Concept types left out of a cluster's shown concepts (who wrote it, not what it is about). */
const AUTHOR_CONCEPT_TYPES: ReadonlySet<string> = new Set(["person", "organization", "company"]);

/**
 * A similarity cluster as its naming task shows it (`cluster-labels.ts`): member titles in the order
 * given (most central first) with syntheses last (hub notes that cite every topic), the concepts at
 * least two members share (by count; authors left out), and the names the label must not be alone
 * (authors, handles, entity concepts).
 */
export function describeCluster(
  store: Pick<KnowledgeStore, "getMeta">,
  graph: Pick<KnowledgeGraph, "conceptsOfEntry">,
  memberIds: readonly string[],
  scope: ReturnType<typeof knowledgeScope>
): ClusterDescription | null {
  const titles: string[] = [];
  const later: string[] = [];
  const forbidden = new Set<string>();
  const counts = new Map<string, { name: string; type: string; count: number }>();
  for (const id of memberIds) {
    const meta = store.getMeta(id);
    if (!meta) continue;
    (meta.kind === "synthesis" ? later : titles).push(meta.title);
    if (meta.author) forbidden.add(meta.author);
    if (meta.handle) forbidden.add(meta.handle);
    for (const concept of graph.conceptsOfEntry(id, scope)) {
      const type = concept.type.toLowerCase();
      if (ENTITY_CONCEPT_TYPES.has(type)) forbidden.add(concept.name);
      if (AUTHOR_CONCEPT_TYPES.has(type)) continue;
      const seen = counts.get(concept.id);
      if (seen) seen.count += 1;
      else counts.set(concept.id, { name: concept.name, type: concept.type, count: 1 });
    }
  }
  titles.push(...later);
  if (titles.length === 0) return null;
  const concepts = [...counts.values()]
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, type }) => ({ name, type }));
  return { titles, concepts, forbidden: [...forbidden] };
}

/** Linking when none is built (tests) or building it failed: paused, with the reason; ignores changes. */
class NoLinking implements KnowledgeLinking {
  readonly events = new EventEmitter<{ status: [] }>();
  readonly pairChecks = NO_PAIR_CHECKS;

  constructor(
    private readonly settings: KnowledgeSettingsPort,
    private readonly message: string
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  entriesChanged(): void {}

  gapQueued(): ReadonlySet<string> {
    return new Set();
  }

  status(): KnowledgeLinkingState {
    if (!this.settings.enabled()) return { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries: 0 };
    return { state: "paused", reason: "error", message: this.message, resumesAt: null, pendingEntries: 0 };
  }

  snapshot(): KnowledgeLinkingSnapshot {
    return { linking: this.status(), lastRun: null, recentRuns: [], workers: [], tokens: NO_TOKENS, lastError: null };
  }

  async rebuild(): Promise<{ queued: boolean; running: boolean }> {
    // The runtime is there (the route checked): linking itself failed, an unexpected error.
    throw new KnowledgeError("KNOWLEDGE_ERROR", this.message);
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
  /** The graph's revision last announced (`knowledge.changed {graph: true}` when it moves). */
  private graphRevision = 0;
  /**
   * The contradicting entry pairs (graph and pair checks, every entry) as last announced: a pair
   * check that changes them announces `knowledge.changed {graph: true}` (insights, edges, panels).
   */
  private contradictionsKey: string | null = null;
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
    await this.opening?.conceptMerges.idle();
  }

  /** The linking module (null until the knowledge base opened). */
  linking(): KnowledgeLinking | null {
    return this.opening?.linking ?? null;
  }

  /**
   * The LLM pair checks linking recorded (phase 2 spec, "Pair checks"), for insights: none until the
   * knowledge base opened or without linking. Read it per use: the opening's linking can be replaced.
   */
  pairChecks(): KnowledgePairChecksPort {
    return this.opening?.linking.pairChecks ?? NO_PAIR_CHECKS;
  }

  /** Entries link gaps queued for re-linking (an insights gap's `queued`): none until the knowledge base opened. */
  gapQueued(): ReadonlySet<string> {
    return this.opening?.linking.gapQueued() ?? new Set();
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
      store = await KnowledgeStore.open({ appdir, logger: this.logger });
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
    // The merge overlay is read and applied before linking loads the graph; concept vectors and
    // merge planning follow every load in the background.
    const conceptMerges = new KnowledgeConceptMerges({
      graph,
      embedders,
      path: knowledgeConceptMergesPath(appdir),
      vectorsDir: join(knowledgeIndexDir(appdir), "concepts"),
      logger: this.logger
    });
    // LLM quality work answered in linking's idle rounds: concept pairs the name guards refused, and
    // topic names for the similarity clusters (read by the similarity graph).
    const everything = () => knowledgeScope({ kind: "all" }, store.listCollections().map((collection) => collection.id));
    const clusterLabels = new KnowledgeClusterLabels({
      path: knowledgeClusterLabelsPath(appdir),
      describe: (memberIds) => describeCluster(store, graph, memberIds, everything()),
      refresh: async () => void (await search.similarity.graph({}, everything())),
      logger: this.logger
    });
    await clusterLabels.load();
    search.similarity.connectClusterLabels(clusterLabels);
    const conceptChecks = new ConceptMergeCheckSource({
      merges: conceptMerges,
      entry: async (id) => {
        const entry = await store.getEntry(id);
        return entry ? { title: entry.title, body: entry.body } : null;
      }
    });
    // Neutral, attributed summaries of concepts with several entries (read by concept details).
    const conceptSummaries = new KnowledgeConceptSummaries({
      path: knowledgeConceptSummariesPath(appdir),
      concepts: () => graph.currentConcepts(),
      meta: (id) => store.getMeta(id),
      body: async (id) => (await store.getEntry(id))?.body ?? null,
      contradicting: () =>
        findContradictions({ graph, scope: everything(), pairChecks: this.pairChecks(), accept: () => true, entryMeta: (id) => store.getMeta(id) }).values(),
      onConceptsChange: (listener) => {
        const offLoad = graph.onLoad(listener);
        const offMerges = conceptMerges.onChange(listener);
        return () => {
          offLoad();
          offMerges();
        };
      },
      logger: this.logger
    });
    await conceptSummaries.load();
    search.connectConceptSummaries(conceptSummaries);
    const linking = this.buildLinking(store, graph, search, conceptMerges, [conceptChecks, clusterLabels, conceptSummaries]);
    await conceptMerges.start();
    const opening: Opening = { store, graph, search, embedders, linking, conceptMerges, clusterLabels, unsubscribe: [] };
    opening.unsubscribe.push(() => search.similarity.connectClusterLabels(null));
    opening.unsubscribe.push(() => search.connectConceptSummaries(null));
    // A new concept summary changes concept details.
    opening.unsubscribe.push(conceptSummaries.onChange(() => this.publishChanged({ graph: true })));
    // A new cluster name redraws the similarity layer.
    opening.unsubscribe.push(clusterLabels.onChange(() => this.publishChanged({ graph: true })));
    // Insights and similar entries read linking's pair checks and queued link gaps (phase 2 spec,
    // "Shared seams"); the gap set is read on each use, so a linking swapped for NoLinking counts.
    const connectSearch = (): void =>
      search.connectLinking({
        pairChecks: opening.linking.pairChecks,
        linkGapQueued: (a, b) => {
          const queued = opening.linking.gapQueued();
          return queued.has(a) && queued.has(b);
        }
      });
    connectSearch();
    opening.unsubscribe.push(() => search.connectLinking({}));
    opening.unsubscribe.push(conceptMerges.onChange(() => this.linkingMoved()));
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
    // A run's verdict on its entries: the entry lists and panels show the link state and count,
    // and the status its failed count. (A whole rebuild's worth is sent as `[]`, which clients
    // read as "refetch every entry".)
    opening.unsubscribe.push(
      store.onLinkStateChange((entryIds) => {
        this.publishChanged({ entryIds: entryIds.length > 500 ? [] : [...entryIds] });
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
      connectSearch();
    }
    this.linkingMoved();
    // Pair checks a round records (or an edit drops) may change which entries contradict: views
    // refetch insights, edges and panels then. Read after start: the checks on disk are loaded.
    this.contradictionsKey = this.contradictionsNow();
    const off = opening.linking.pairChecks.onChange(() => this.pairChecksMoved());
    opening.unsubscribe.push(off);
    // The collection views read it; profile events then keep it current.
    void this.readProfiles().catch(() => undefined);
    this.publishStatus();
  }

  /** Every contradicting entry pair now (the graph's and the pair checks'), as a comparable key. */
  private contradictionsNow(): string | null {
    const opening = this.opening;
    if (!opening) return null;
    const scope = knowledgeScope({ kind: "all" }, opening.store.listCollections().map((collection) => collection.id));
    const found = findContradictions({
      graph: opening.graph,
      scope,
      pairChecks: opening.linking.pairChecks,
      accept: () => true,
      entryMeta: (id) => opening.store.getMeta(id)
    });
    return [...found.keys()].sort().join("\n");
  }

  /** Pair checks moved: announce the graph when the set of contradicting pairs did. */
  private pairChecksMoved(): void {
    let key: string | null;
    try {
      key = this.contradictionsNow();
    } catch (error) {
      this.logger.warn("knowledge: reading contradictions after a pair check failed", error);
      return;
    }
    if (key === this.contradictionsKey) return;
    this.contradictionsKey = key;
    this.publishChanged({ graph: true });
    this.publishStatus();
  }

  private buildLinking(
    store: KnowledgeStore,
    graph: KnowledgeGraph,
    search: KnowledgeSearch,
    conceptMerges: KnowledgeConceptMerges,
    roundTasks: readonly KnowledgeRoundTaskSource[]
  ): KnowledgeLinking {
    const factory = this.options.linking;
    if (!factory) return new NoLinking(this.settings, "Graph linking is not available in this build.");
    try {
      return factory({ store, graph, runtime: this.runtime, settings: this.settings, graphView: linkGraphView(store, graph, search, conceptMerges), roundTasks });
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
    await opening.conceptMerges.stop().catch((error: unknown) => this.logger.warn("knowledge: stopping concept merges failed", error));
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
    const metas = opening?.store.listMeta() ?? [];
    const runtime = this.runtime.current();
    // The model's files are in place, and — while the knowledge base is open — its embedder has not
    // failed to load (the vector index then answers no model).
    let embeddingModelReady = runtime !== null && runtime.embeddingModelReady !== false;
    if (embeddingModelReady && opening && this.settings.enabled()) embeddingModelReady = opening.search.vectorIndex().modelId() !== null;
    return {
      enabled: this.settings.enabled(),
      installed: runtime !== null,
      embeddingModelReady,
      entries: metas.length,
      failedEntries: metas.filter((meta) => meta.linkState === "failed").length,
      concepts: graph.nodes,
      edges: graph.edges,
      collections: opening?.store.listCollections().length ?? 0,
      conceptMerges: opening?.conceptMerges.count() ?? 0
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

  /** Linking moved: the status, and `knowledge.changed {graph: true}` when a run (re)loaded the graph (whatever its size). */
  private linkingMoved(): void {
    const revision = this.opening?.graph.revision() ?? this.graphRevision;
    if (revision !== this.graphRevision) {
      this.graphAnnounced(revision);
      this.publishChanged({ graph: true });
    }
    this.publishStatus();
  }

  /** `knowledge.changed {graph: true}` goes out for this graph revision: later pair checks compare with its contradictions. */
  private graphAnnounced(revision: number): void {
    this.graphRevision = revision;
    if (this.contradictionsKey !== null) this.contradictionsKey = this.contradictionsNow();
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

  /**
   * A profile changed or was deleted: re-read the profiles, push manifests when its collections
   * changed, and tell the collection views (their profile chips) when what they show of it moved.
   */
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
      if (after !== null && (before === null || shown(before, profileId) !== shown(after, profileId))) this.publishChanged({ collections: true });
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
  /** `mode`: the app's transport; the worker routes are the unix-socket app's only. */
  registerRoutes(app: FastifyInstance, mode: "local" | "remote" = "local"): void {
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
          // A route that moved the graph (a concept merge undone) announced it: not again; the status counts it.
          const graphMoved = type === KNOWLEDGE_CHANGED_EVENT && (payload as KnowledgeChangedEvent | null)?.graph === true;
          if (graphMoved) this.graphAnnounced(this.opening?.graph.revision() ?? this.graphRevision);
          this.options.publisher.publish(channel, type, payload);
          if (graphMoved) this.publishStatus();
          if (type === KNOWLEDGE_CHANGED_EVENT && (payload as KnowledgeChangedEvent | null)?.collections === true) this.collectionsMaybeChanged();
        }
      },
      profilesForCollection: () => this.profilesForCollection(),
      logger,
      get conceptMerges() {
        return service.opening?.conceptMerges ?? null;
      }
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
        workerNext: (sessionId, signal, taskId) => current().workerNext(sessionId, signal, taskId),
        workerSubmit: (sessionId, taskId, answer, signal) => current().workerSubmit(sessionId, taskId, answer, signal)
      },
      counts: () => this.counts(),
      sessionOwner: (sessionId) => this.options.session(sessionId)?.owner,
      workerRoutes: mode === "local",
      logger
    });
  }
}

/** The collections as the manifests name them: ids and names, in order. */
function collectionsKeyOf(store: KnowledgeStore): string {
  return JSON.stringify(store.listCollections().map((collection) => [collection.id, collection.name]));
}

/** What the collection views show of one profile (its name under each collection it ticks), as a comparable key. */
function shown(map: ProfilesByCollection, profileId: string): string {
  const parts: string[] = [];
  for (const [collectionId, profiles] of map) {
    const profile = profiles.find((p) => p.id === profileId);
    if (profile) parts.push(`${collectionId}=${profile.name}`);
  }
  return JSON.stringify(parts.sort());
}

/** The collection ids one profile ticks in a profiles-by-collection map, as a comparable key. */
function ticked(map: ProfilesByCollection, profileId: string): string {
  const ids: string[] = [];
  for (const [collectionId, profiles] of map) if (profiles.some((profile) => profile.id === profileId)) ids.push(collectionId);
  return ids.sort().join(",");
}
