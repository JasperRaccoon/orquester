/**
 * Knowledge Graph — this client's copy of the plugin's shared daemon state:
 * the status (counts and linking state) and the collections. Entries, the
 * graph and item details are read by the Knowledge view itself, on demand; this
 * store tells it when to read them again through revision counters.
 *
 * It converges on the daemon three ways, which race freely:
 *
 * - a **load** per connection (connect, reconnect and the plugin turning on —
 *   the app store), and the view's own retries;
 * - a refetch after each **mutation** (collection and entry edits are not
 *   applied optimistically: the daemon's answer is the only truth);
 * - `KNOWLEDGE_CHANNEL` **events**, routed here by the app store's
 *   `applyEvent`: `knowledge.status` replaces the status, `knowledge.changed`
 *   refetches what it names (collections; entries, which also move collection
 *   counts, and with `collections` the graph's colours; the graph).
 *
 * Every write is validated first (`validate.ts`). An answer never undoes a
 * change that landed while it was in flight: each slot carries a sequence
 * number that every event and load bumps, and a read whose slot moved
 * meanwhile drops its answer.
 *
 * Per connection: `resetKnowledge()` runs on a connection switch and when the
 * plugin turns off (the app store), and a call through a client of another
 * connection resets first.
 */

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_STATUS_EVENT,
  type CreateKnowledgeCollectionRequest,
  type EventMessage,
  type KnowledgeCollectionsResponse,
  type KnowledgeStatus,
  type UpdateKnowledgeCollectionRequest,
  type UpdateKnowledgeEntryRequest
} from "@orquester/api";

import { parseKnowledgeChangedEvent, parseKnowledgeStatus } from "./validate";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface KnowledgeApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  getKnowledgeStatus(signal?: AbortSignal): Promise<KnowledgeStatus>;
  listKnowledgeCollections(signal?: AbortSignal): Promise<KnowledgeCollectionsResponse>;
  createKnowledgeCollection(req: CreateKnowledgeCollectionRequest): Promise<unknown>;
  updateKnowledgeCollection(id: string, req: UpdateKnowledgeCollectionRequest): Promise<unknown>;
  deleteKnowledgeCollection(id: string): Promise<unknown>;
  updateKnowledgeEntry(id: string, req: UpdateKnowledgeEntryRequest): Promise<unknown>;
  deleteKnowledgeEntry(id: string): Promise<unknown>;
}

export interface KnowledgeState {
  /** Null until it first loads on this connection. */
  status: KnowledgeStatus | null;
  /** Why the last status read failed (cleared by the next good one). */
  statusError: unknown;
  /** Null until it first loads on this connection. */
  collections: KnowledgeCollectionsResponse | null;
  collectionsError: unknown;
  /**
   * Bumped whenever entries changed (an event naming them, an edit or delete
   * here): entry lists read again, and detail panels whose entries are in
   * `changedEntryIds` (null = any) do too.
   */
  entriesRevision: number;
  changedEntryIds: readonly string[] | null;
  /** Bumped when the graph was reloaded (after a linking run) or entries were deleted. */
  graphRevision: number;
}

const INITIAL: KnowledgeState = {
  status: null,
  statusError: null,
  collections: null,
  collectionsError: null,
  entriesRevision: 0,
  changedEntryIds: null,
  graphRevision: 0
};

export const knowledgeStore = createStore<KnowledgeState>(() => INITIAL);

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetKnowledge`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let connectionId: string | null = null;
/** The client events refetch through (the last one a load came from). */
let client: KnowledgeApi | null = null;
const seq = { status: 0, collections: 0 };
/** Single-flight collection reads: one in flight, at most one more queued behind it. */
let collectionsInFlight: Promise<void> | null = null;
let collectionsAgain = false;

const resetListeners = new Set<() => void>();

/**
 * Run `listener` on every {@link resetKnowledge} (connection switch, plugin
 * off) — for caches kept beside this store, such as the citation answers. The
 * state alone cannot say so: a reset before any entry changed leaves the
 * revision counters where they were.
 */
export function onKnowledgeReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/** Forget everything (connection switch, plugin off). */
export function resetKnowledge(): void {
  generation += 1;
  connectionId = null;
  client = null;
  seq.status += 1;
  seq.collections += 1;
  collectionsInFlight = null;
  collectionsAgain = false;
  knowledgeStore.setState(INITIAL, true);
  for (const listener of [...resetListeners]) listener();
}

/** Adopt `api`; a client of another connection resets the store first. */
function adopt(api: KnowledgeApi): void {
  const id = api.connection?.id ?? null;
  if (connectionId !== null && id !== connectionId) resetKnowledge();
  connectionId = id;
  client = api;
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/** Read the status; rejects with the request's error (also kept in `statusError`). */
export async function loadKnowledgeStatus(api: KnowledgeApi): Promise<void> {
  adopt(api);
  const gen = generation;
  const mine = ++seq.status;
  try {
    const status = await api.getKnowledgeStatus();
    if (gen !== generation || mine !== seq.status) return;
    knowledgeStore.setState({ status, statusError: null });
  } catch (error) {
    if (gen === generation && mine === seq.status) knowledgeStore.setState({ statusError: error });
    throw error;
  }
}

async function readCollections(api: KnowledgeApi): Promise<void> {
  const gen = generation;
  const mine = ++seq.collections;
  try {
    const collections = await api.listKnowledgeCollections();
    if (gen !== generation || mine !== seq.collections) return;
    knowledgeStore.setState({ collections, collectionsError: null });
  } catch (error) {
    if (gen === generation && mine === seq.collections) knowledgeStore.setState({ collectionsError: error });
    throw error;
  }
}

/**
 * Read the collections. Calls while a read is in flight coalesce into one more
 * read after it (whose answer then reflects every change before the call).
 */
export function loadKnowledgeCollections(api: KnowledgeApi): Promise<void> {
  adopt(api);
  if (collectionsInFlight) {
    collectionsAgain = true;
    return collectionsInFlight;
  }
  const gen = generation;
  const run = (async () => {
    try {
      await readCollections(api);
      while (collectionsAgain && gen === generation) {
        collectionsAgain = false;
        await readCollections(api);
      }
    } finally {
      if (gen === generation) {
        collectionsInFlight = null;
        collectionsAgain = false;
      }
    }
  })();
  collectionsInFlight = run;
  return run;
}

/** Status and collections, as on connect and when the plugin turns on. Rejects with the first failure. */
export async function loadKnowledge(api: KnowledgeApi): Promise<void> {
  const results = await Promise.allSettled([loadKnowledgeStatus(api), loadKnowledgeCollections(api)]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

const quietly = (promise: Promise<unknown>): void => void promise.catch(() => undefined);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bumpEntries(ids: readonly string[] | null): void {
  knowledgeStore.setState((state) => ({ entriesRevision: state.entriesRevision + 1, changedEntryIds: ids }));
}

function bumpGraph(): void {
  knowledgeStore.setState((state) => ({ graphRevision: state.graphRevision + 1 }));
}

/** One `KNOWLEDGE_CHANNEL` event (the app store routes them here). A malformed payload is ignored. */
export function applyKnowledgeEvent(event: EventMessage): void {
  if (event.type === KNOWLEDGE_STATUS_EVENT) {
    const status = parseKnowledgeStatus(event.payload);
    if (!status) return;
    // Newer than any read in flight: that read's answer is dropped.
    seq.status += 1;
    knowledgeStore.setState({ status, statusError: null });
    return;
  }
  if (event.type !== KNOWLEDGE_CHANGED_EVENT) return;
  const change = parseKnowledgeChangedEvent(event.payload);
  if (!change) return;
  const entriesChanged = change.entryIds !== undefined;
  if (entriesChanged) bumpEntries(change.entryIds!.length > 0 ? change.entryIds! : null);
  // Entries relabelled or deleted (anywhere: `collections` comes with them) recolour or drop
  // concepts at once, as this client's own edits do; a linking run reloads the graph.
  if (change.graph || (entriesChanged && change.collections)) bumpGraph();
  // Entry changes move collection counts (added, relabelled, deleted).
  if ((change.collections || entriesChanged) && client) quietly(loadKnowledgeCollections(client));
}

// ---------------------------------------------------------------------------
// Mutations (no optimistic writes: each refetches what it changed)
// ---------------------------------------------------------------------------

/**
 * Run `call`, then refetch; rejects with the call's error (an ApiError carrying `{ code, message }`).
 * `after.done` runs once the call succeeded and before anything refetches, so a view can let go of
 * what the call removed first.
 */
async function mutate(
  api: KnowledgeApi,
  call: () => Promise<unknown>,
  after: { entries?: readonly string[] | null; graph?: boolean; done?: () => void }
): Promise<void> {
  adopt(api);
  const gen = generation;
  await call();
  if (gen !== generation) return;
  after.done?.();
  if (after.entries !== undefined) bumpEntries(after.entries);
  if (after.graph) bumpGraph();
  await loadKnowledgeCollections(api).catch(() => undefined);
}

export function createKnowledgeCollection(api: KnowledgeApi, req: CreateKnowledgeCollectionRequest): Promise<void> {
  return mutate(api, () => api.createKnowledgeCollection(req), {});
}

export function updateKnowledgeCollection(api: KnowledgeApi, id: string, req: UpdateKnowledgeCollectionRequest): Promise<void> {
  return mutate(api, () => api.updateKnowledgeCollection(id, req), {});
}

/**
 * Its entries lose the label (those with no other collection become Unfiled), so entry lists and the
 * graph's colours move too. `onDeleted` runs once it is gone and before those refetch: a view
 * filtered to it falls back first, so no read names a collection that no longer exists.
 */
export function deleteKnowledgeCollection(api: KnowledgeApi, id: string, onDeleted?: (id: string) => void): Promise<void> {
  return mutate(api, () => api.deleteKnowledgeCollection(id), { entries: null, graph: true, ...(onDeleted ? { done: () => onDeleted(id) } : {}) });
}

export function updateKnowledgeEntry(api: KnowledgeApi, id: string, req: UpdateKnowledgeEntryRequest): Promise<void> {
  // Relabelling recolours its concepts at once (collections are not part of the graph).
  return mutate(api, () => api.updateKnowledgeEntry(id, req), { entries: [id], graph: req.collections !== undefined });
}

export function deleteKnowledgeEntry(api: KnowledgeApi, id: string): Promise<void> {
  return mutate(api, () => api.deleteKnowledgeEntry(id), { entries: [id], graph: true });
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const subscribe = (listener: () => void) => knowledgeStore.subscribe(listener);

/** A slot of the store; the selector must return a value stable between changes. */
export function useKnowledgeState<T>(select: (state: KnowledgeState) => T): T {
  const snapshot = () => select(knowledgeStore.getState());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useKnowledgeCollections(): KnowledgeCollectionsResponse | null {
  return useKnowledgeState((state) => state.collections);
}
