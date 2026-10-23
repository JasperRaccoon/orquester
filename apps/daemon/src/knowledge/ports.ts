/**
 * Knowledge Graph plugin — the seams between its daemon modules (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md).
 *
 * - `install/`    the runtime (uv, the pinned myKG venv with its prompt overlay,
 *                 the embedding model) and the plugin's settings.
 * - `store/`      entries, collections, the myKG input mirror.
 * - `search/`     embeddings, BM25, the in-memory graph, visibility-scoped queries.
 * - `linking/`    the coalesced run queue, the myKG child, the inbox, worker sessions.
 * - `visibility`  which collections a calling chat can see (its profile).
 * - `service.ts`  composes them; `routes*.ts` serve them.
 *
 * Each module implements its port and receives the others through these
 * interfaces only, so they can be built and tested apart.
 */

import type {
  KnowledgeEntry,
  KnowledgeEntryMeta,
  KnowledgeLinkState,
  KnowledgeLinkingState,
  KnowledgeRebuildEstimate,
  KnowledgeSettings,
  KnowledgeStatus,
  KnowledgeVisibility,
  KnowledgeWorkerNextResponse,
  KnowledgeWorkerSubmitResponse
} from "@orquester/api";

import type { DaemonApi } from "../mcp/daemon-api.ts";

// ---------------------------------------------------------------------------
// install/
// ---------------------------------------------------------------------------

/** An installed, smoke-tested runtime. */
export interface KnowledgeRuntime {
  /** The pinned myKG version, e.g. "0.4.10". */
  mykgVersion: string;
  /** Absolute path of the `mykg` entry point inside the venv. */
  mykgBin: string;
  /** The venv's python (for the rare helper that needs it). */
  pythonBin: string;
  /** Directory holding the embedding model files (local, hash-checked). */
  embeddingModelDir: string;
  /** e.g. "Xenova/all-MiniLM-L6-v2". */
  embeddingModelId: string;
  /** Embedding vector length. */
  embeddingDimensions: number;
}

export interface KnowledgeRuntimePort {
  /** The active runtime, or null while not installed. */
  current(): KnowledgeRuntime | null;
  onChange(listener: (runtime: KnowledgeRuntime | null) => void): () => void;
}

export interface KnowledgeSettingsPort {
  /** Whether the plugin is enabled on this server. */
  enabled(): boolean;
  get(): KnowledgeSettings;
  onChange(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// store/
// ---------------------------------------------------------------------------

/**
 * - `added` / `deleted` — entries created or removed.
 * - `edited` — fields that reach the myKG input file changed (body, title,
 *   kind, author, handle, postedAt): the entry needs re-linking.
 * - `relabelled` — only collections changed: never re-linked.
 */
export interface KnowledgeEntryChange {
  kind: "added" | "edited" | "deleted" | "relabelled";
  entryIds: string[];
}

export interface KnowledgeStorePort {
  /** Every entry's metadata (no bodies), from memory. */
  listMeta(): readonly KnowledgeEntryMeta[];
  getMeta(id: string): KnowledgeEntryMeta | null;
  getEntry(id: string): Promise<KnowledgeEntry | null>;
  /** The directory myKG reads; the store keeps one `<entryId>.md` per entry in sync. */
  readonly mykgInputDir: string;
  setLinkState(ids: readonly string[], state: KnowledgeLinkState): Promise<void>;
  onChange(listener: (change: KnowledgeEntryChange) => void): () => void;
}

// ---------------------------------------------------------------------------
// search/
// ---------------------------------------------------------------------------

export interface KnowledgeGraphPort {
  /**
   * Load myKG's `nodes.jsonl` / `edges.jsonl` from a session's output dir and
   * swap them in atomically (in-flight queries keep the old graph).
   */
  load(outputDir: string): Promise<{ nodes: number; edges: number }>;
  counts(): { nodes: number; edges: number };
}

// ---------------------------------------------------------------------------
// linking/
// ---------------------------------------------------------------------------

export interface KnowledgeLinkingPort {
  status(): KnowledgeLinkingState;
  /** A store change; schedules a coalesced run when it needs linking. */
  entriesChanged(change: KnowledgeEntryChange): void;
}

/** The run history part of `KnowledgeStatus`, which only linking knows. */
export type KnowledgeLinkingReport = Pick<KnowledgeStatus, "lastRun" | "recentRuns" | "workers" | "tokens" | "lastError">;

/**
 * What `KnowledgeService` hands the linking module each time the knowledge base opens (the plugin
 * is switched on, or the daemon starts with it on). Every port is live for that opening only: the
 * module is stopped before the plugin is switched off or the daemon stops, and a later opening
 * builds a new module with new ports.
 */
export interface KnowledgeLinkingContext {
  /** The appdir (`packages/config` path helpers: `knowledgeMykgDir`, `knowledgeStatePath`, …). */
  appdir: string;
  store: KnowledgeStorePort;
  /** Load a myKG session's output after a run (or at start, from the recorded session). */
  graph: KnowledgeGraphPort;
  /** The installed runtime (`mykgBin`, …), null while not installed. */
  runtime: KnowledgeRuntimePort;
  /** The plugin's switch and settings (account, model, concurrency). */
  settings: KnowledgeSettingsPort;
  /** The daemon's in-process API (worker sessions are started through it); null until it exists. */
  api(): DaemonApi | null;
  /** Whether a session is one of the plugin's worker sessions (`owner.kind === "knowledge-indexer"`). */
  isWorker(sessionId: string): Promise<boolean>;
  /** Tell the service `status()` or `report()` changed: it republishes `knowledge.status`. */
  statusChanged(): void;
  /** Tell the service the graph was (re)loaded: it publishes `knowledge.changed` `{ graph: true }` and the status. */
  graphChanged(): void;
  /** The `/events` broadcaster, for anything beyond the status and graph signals above. */
  publisher: KnowledgePublisher;
  logger: { warn(message: string): void; error(message: string): void };
}

/**
 * The linking module as the service runs it: the port, plus optional lifecycle and the handlers the
 * service's routes delegate to. Absent handlers answer as if linking were not built (the worker
 * routes say `done`, the rebuild routes refuse with `KNOWLEDGE_NOT_INSTALLED`).
 */
export interface KnowledgeLinkingModule extends KnowledgeLinkingPort {
  /** Called once after construction: resume a recorded run, load the recorded graph, … Errors are logged, never fatal. */
  start?(): Promise<void>;
  /** Stop timers, children and worker sessions it owns. Called once; must not throw for long (it is bounded at shutdown). */
  stop?(): Promise<void>;
  /** Run history for `GET /api/knowledge/status`; absent → no runs, no workers, no tokens. */
  report?(): KnowledgeLinkingReport;
  /** `POST knowledgeRoutes.workerNext` for a session the service checked is a worker. */
  workerNext?(sessionId: string): Promise<KnowledgeWorkerNextResponse>;
  /** `POST knowledgeRoutes.workerSubmit` for a session the service checked is a worker. */
  workerSubmit?(sessionId: string, submission: { taskId: string; answer: string }): Promise<KnowledgeWorkerSubmitResponse>;
  /** `GET knowledgeRoutes.rebuildEstimate`. */
  rebuildEstimate?(): Promise<KnowledgeRebuildEstimate>;
  /** `POST knowledgeRoutes.rebuild`: queue a full re-extraction (throw a `KnowledgeError` to refuse, e.g. `KNOWLEDGE_BUSY`). */
  rebuild?(): Promise<void>;
}

/** Builds the linking module for one opening of the knowledge base (`KnowledgeService.attachLinking`). */
export type KnowledgeLinkingFactory = (context: KnowledgeLinkingContext) => KnowledgeLinkingModule;

/** The `/events` broadcaster (`Broadcaster` satisfies it). */
export interface KnowledgePublisher {
  publish(channel: string, type: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------------

export interface KnowledgeVisibilityPort {
  /**
   * What the calling chat can see: `all` with no session (the user in the UI)
   * or a session without a profile; else its profile's `knowledgeCollections`.
   */
  forSession(sessionId: string | undefined): Promise<KnowledgeVisibility>;
}
