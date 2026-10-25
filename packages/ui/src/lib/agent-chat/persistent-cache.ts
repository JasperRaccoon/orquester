// Ported in spirit from T3 Code (MIT):
//   apps/web/src/connection/storage.ts (the IndexedDB `thread` store)
//   packages/client-runtime/src/state/threads.ts:190-252 (load the cached snapshot, seed the cursor)
//   packages/client-runtime/src/state/cachePersistence.ts (500 ms first delay, then at most one save per 10 s)

/**
 * Agent chat — the **device cache** of chat threads (IndexedDB).
 *
 * The retained-thread cache (`retention.ts`) lives in page memory, so it dies
 * with the page — and a mobile OS kills a backgrounded PWA all the time. This
 * module keeps the same value on the device instead: per (daemon connection,
 * session) the thread snapshot as this client folded it, the `seq` it was
 * folded to, and the `hostInstanceId` it synchronized under. A thread opened
 * with nothing in memory paints that snapshot at once — fed through the
 * store's own `snapshot` frame path — and its stream resumes with
 * `after=<seq>`, so the host sends only what happened since (or a snapshot,
 * when it cannot: the store's existing resume and resync rules decide).
 *
 * **A cache, never an authority.** Every record is validated field-wise on
 * the way back in (`deserializeFoldState`, the host's own `state.json`
 * check), stamped with this format's version AND the fold's
 * (`FOLD_SNAPSHOT_VERSION`: a snapshot folded by other fold code, replayed
 * forward by this one, would not be the fold of the log), and anything that
 * does not match is deleted, not trusted. A thread the host no longer has
 * (`gone`) or that was deleted is dropped.
 *
 * **What is saved.** Only the live window — the fold. Older history pages and
 * the bridge are never written, and the history bounds are saved as they
 * describe that window. Writes follow T3's cadence: the first one 500 ms after
 * the first change, then at most one per 10 s per thread, and only for a state
 * whose cursor and content were applied together (the store's state is always
 * that) under a host the stream synchronized with. A page going hidden writes
 * what is pending at once — that is the last chance before the OS kills it.
 * Like T3, nothing is written while a turn is running — serializing a
 * several-MiB thread is a main-thread task, and a streaming turn is when the
 * page can least afford one — except as the page goes hidden or the
 * generation is torn down, when nobody is looking and it may be the last
 * chance. The snapshot is serialized once per write (`JSON.stringify`),
 * never per event, at an idle moment where the page can say so, and
 * IndexedDB then clones one string rather than an object graph.
 *
 * **Bounds.** At most {@link THREAD_CACHE_MAX_ENTRIES} threads and
 * {@link THREAD_CACHE_MAX_TOTAL_CHARS} characters across all of them; the least
 * recently used go first. A thread bigger than
 * {@link THREAD_CACHE_MAX_ENTRY_CHARS} is not kept at all.
 *
 * **Privacy.** Chat content rests on the device: {@link clearThreadCache} runs
 * when the daemon credential is dropped (sign-out, a revoked session) and
 * when a remote is removed. A clear is recorded durably (`localStorage`)
 * before anything is deleted, and every read and write checks it, so it is
 * final even when IndexedDB is stuck or the page closes at once.
 *
 * **No IndexedDB, or no `localStorage` to record clears in** (Node tests,
 * private modes that refuse them, a runtime without them): every entry point
 * answers "nothing" and the store behaves exactly as it does without this
 * module.
 */

import {
  deserializeFoldState,
  FOLD_SNAPSHOT_VERSION,
  isSettledTurnState,
  toThreadSnapshot,
  type ThreadHistoryBounds,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import type { AgentChatHistoryState, AgentChatThreadSlice } from "./contracts";
import { historyBoundsFromSnapshot } from "./history.logic";
import { omittedAgentIdsOf, type AgentChatReducerState } from "./reducer.logic";

// ---------------------------------------------------------------------------
// Bounds and cadence
// ---------------------------------------------------------------------------

/** This record format. Bump it whenever what is written changes shape or meaning. */
export const THREAD_CACHE_VERSION = 1;
/**
 * The same format for a snapshot that holds only part of the rows: on-demand
 * agent rows (`agent-rows.ts`) left some agents' own rows out, and its
 * `omittedAgentIds` say whose. Its own version so a bundle from before it —
 * which would paint the copy as whole and never load those rows — drops the
 * record instead of trusting it; a whole snapshot is still written as
 * {@link THREAD_CACHE_VERSION}, which every bundle reads.
 */
export const THREAD_CACHE_PARTIAL_VERSION = 2;

/** Whether `v` is a record format this bundle reads. */
function isReadableVersion(v: unknown): boolean {
  return v === THREAD_CACHE_VERSION || v === THREAD_CACHE_PARTIAL_VERSION;
}
/** How many threads are kept on the device; the least recently used go first. */
export const THREAD_CACHE_MAX_ENTRIES = 20;
/** One thread's serialized snapshot above this is not kept (UTF-16 code units). */
export const THREAD_CACHE_MAX_ENTRY_CHARS = 8 * 1024 * 1024;
/** Every thread's serialized snapshot together, at most (UTF-16 code units). */
export const THREAD_CACHE_MAX_TOTAL_CHARS = 16 * 1024 * 1024;
/** The first write waits this long after the first change (T3: 500 ms). */
export const THREAD_CACHE_FIRST_SAVE_DELAY_MS = 500;
/** Then at most one write per thread per this interval (T3: 10 s). */
export const THREAD_CACHE_SAVE_INTERVAL_MS = 10_000;
/**
 * How long a thread's open waits for its saved copy before it streams as if
 * there were none. IndexedDB normally answers in milliseconds; WebKit has
 * been known to leave a request hanging after a page resumes, and a chat must
 * never wait on that.
 */
export const THREAD_CACHE_LOAD_TIMEOUT_MS = 750;

/** How long a due write may wait for an idle moment. */
const IDLE_WRITE_TIMEOUT_MS = 2_000;
type IdleScheduler = (run: () => void, options?: { timeout: number }) => unknown;

const DB_NAME = "orquester-agent-chat";
const DB_VERSION = 1;
const META_STORE = "thread-meta";
const BODY_STORE = "thread-body";
const KEY_SEPARATOR = "\u0000";

// ---------------------------------------------------------------------------
// Connection identity
// ---------------------------------------------------------------------------

/** The connection fields that name a daemon (`UiConnection`'s). */
export interface ThreadCacheConnection {
  kind: string;
  endpoint: string;
}

/**
 * The cache scope of a daemon connection: its kind and endpoint. Two daemons
 * never share an entry; two clients of the same daemon (a rebuilt client
 * after a sign-in, a second window) do.
 */
export function threadCacheScopeFor(connection: ThreadCacheConnection): string {
  const endpoint = connection.endpoint.trim().replace(/\/+$/, "");
  return `${connection.kind}|${endpoint}`;
}

/** The scope each chat transport was built for (`ApiClient.agentChat`). */
const scopes = new WeakMap<object, string>();

/** Record which daemon a chat transport talks to; a store built on it caches under that scope. */
export function bindThreadCacheScope(transport: object, connection: ThreadCacheConnection): void {
  scopes.set(transport, threadCacheScopeFor(connection));
}

/** The scope a transport was bound to, or `null` (a transport nobody bound caches nothing). */
export function threadCacheScopeOf(transport: object): string | null {
  return scopes.get(transport) ?? null;
}

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/** The small, always-read half of a record: what eviction and the version check need. */
export interface ThreadCacheMeta {
  key: string;
  v: number;
  /** `FOLD_SNAPSHOT_VERSION` of the fold that produced the snapshot. */
  fold: number;
  scope: string;
  sessionId: string;
  seq: number;
  hostInstanceId: string;
  /** The clear generation of its scope it was written under (`clearGenerationOf`). */
  cleared: string;
  /** Epoch ms of the write. */
  savedAt: number;
  /** Epoch ms of the last write or read: the eviction order. */
  usedAt: number;
  /** Length of `body.json`. */
  chars: number;
}

/** The large half: the snapshot, serialized once. */
export interface ThreadCacheBody {
  key: string;
  v: number;
  seq: number;
  json: string;
}

/**
 * What the cache needs from storage. The IndexedDB implementation is
 * {@link indexedDbThreadCacheBackend}; tests inject their own.
 */
export interface ThreadCacheBackend {
  /** Both halves of one key, as stored — unvalidated; `undefined` for a missing half. */
  read(key: string): Promise<{ meta: unknown; body: unknown }>;
  /** Every meta record, as stored — unvalidated. */
  readMetas(): Promise<unknown[]>;
  /** Every key either store holds, orphans included. */
  readKeys(): Promise<string[]>;
  /** One atomic change: puts (a meta alone touches it) and removals of both halves. */
  write(change: {
    put?: ReadonlyArray<{ meta: ThreadCacheMeta; body?: ThreadCacheBody }>;
    remove?: readonly string[];
  }): Promise<void>;
}

/** `undefined` until first asked for: resolved lazily, so a page without chats opens nothing. */
let backendOverride: ThreadCacheBackend | null | undefined;
let defaultBackend: ThreadCacheBackend | null | undefined;

/** Test seam: the backend every call uses from now on (`null`: none; `undefined`: the default). */
export function setThreadCacheBackend(backend: ThreadCacheBackend | null | undefined): void {
  backendOverride = backend;
}

function activeBackend(): ThreadCacheBackend | null {
  if (backendOverride !== undefined) {
    return backendOverride;
  }
  if (defaultBackend === undefined) {
    defaultBackend = indexedDbThreadCacheBackend();
  }
  return defaultBackend;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * The IndexedDB backend, or `null` where there is no IndexedDB. Two object
 * stores keyed by `key`: the metas (small, read whole for eviction) and the
 * bodies (read one at a time).
 */
export function indexedDbThreadCacheBackend(
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB
): ThreadCacheBackend | null {
  if (factory === undefined || factory === null || typeof factory.open !== "function") {
    return null;
  }
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(DB_NAME, DB_VERSION);
      } catch (error) {
        // A private mode that refuses IndexedDB throws here.
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of [META_STORE, BODY_STORE]) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "key" });
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the database: let it, and open afresh next time.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    return opening;
  };
  return {
    async read(key) {
      const db = await database();
      const transaction = db.transaction([META_STORE, BODY_STORE], "readonly");
      const [meta, body] = await Promise.all([
        requestResult(transaction.objectStore(META_STORE).get(key)),
        requestResult(transaction.objectStore(BODY_STORE).get(key))
      ]);
      return { meta, body };
    },
    async readMetas() {
      const db = await database();
      return requestResult(db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll());
    },
    async readKeys() {
      const db = await database();
      const transaction = db.transaction([META_STORE, BODY_STORE], "readonly");
      const [metaKeys, bodyKeys] = await Promise.all([
        requestResult(transaction.objectStore(META_STORE).getAllKeys()),
        requestResult(transaction.objectStore(BODY_STORE).getAllKeys())
      ]);
      return [...new Set([...metaKeys, ...bodyKeys].filter((key): key is string => typeof key === "string"))];
    },
    async write(change) {
      const db = await database();
      const transaction = db.transaction([META_STORE, BODY_STORE], "readwrite");
      const done = transactionDone(transaction);
      const metas = transaction.objectStore(META_STORE);
      const bodies = transaction.objectStore(BODY_STORE);
      for (const key of change.remove ?? []) {
        metas.delete(key);
        bodies.delete(key);
      }
      for (const { meta, body } of change.put ?? []) {
        metas.put(meta);
        if (body !== undefined) bodies.put(body);
      }
      await done;
    }
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A validated saved thread. */
export interface PersistedThread {
  scope: string;
  sessionId: string;
  seq: number;
  hostInstanceId: string;
  savedAt: number;
  /** Exactly what a `snapshot` frame carries. */
  snapshot: ThreadSnapshotPayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isStamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function threadCacheKey(scope: string, sessionId: string): string {
  return `${scope}${KEY_SEPARATOR}${sessionId}`;
}

/** A meta of THIS format and fold, internally consistent; `null` for anything else. */
function parseMeta(value: unknown): ThreadCacheMeta | null {
  if (!isRecord(value)) return null;
  const { key, v, fold, scope, sessionId, seq, hostInstanceId, cleared, savedAt, usedAt, chars } = value;
  if (
    !isReadableVersion(v) ||
    fold !== FOLD_SNAPSHOT_VERSION ||
    typeof scope !== "string" ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    key !== threadCacheKey(scope, sessionId) ||
    !isSequence(seq) ||
    typeof hostInstanceId !== "string" ||
    hostInstanceId.length === 0 ||
    hostInstanceId.length > 256 ||
    typeof cleared !== "string" ||
    cleared.length === 0 ||
    cleared.length > 256 ||
    !isStamp(savedAt) ||
    !isStamp(usedAt) ||
    typeof chars !== "number" ||
    !Number.isSafeInteger(chars) ||
    chars < 0 ||
    chars > THREAD_CACHE_MAX_ENTRY_CHARS
  ) {
    return null;
  }
  return { key, v: v as number, fold, scope, sessionId, seq, hostInstanceId, cleared, savedAt, usedAt, chars };
}

/**
 * The snapshot a saved body decodes to, validated as the host validates its
 * own `state.json` (`deserializeFoldState`: every field of every object the
 * fold builds, against its declared type), then rebuilt through
 * `toThreadSnapshot` so it holds exactly the declared fields. `null` for
 * anything that is not a snapshot of `sessionId` folded to `seq`.
 */
function parsePersistedSnapshot(
  value: unknown,
  sessionId: string,
  seq: number
): ThreadSnapshotPayload | null {
  if (!isRecord(value)) return null;
  const fold = deserializeFoldState({
    head: value.head,
    items: value.items,
    turns: value.turns,
    checkpoints: value.checkpoints,
    pending: value.pending,
    roster: value.roster,
    goal: value.goal === undefined ? null : value.goal,
    // A snapshot carries no tombstones: a `snapshot` frame re-derives them from the rows.
    closedRequestIds: [],
    ...(value.answeredApprovals !== undefined ? { answeredApprovals: value.answeredApprovals } : {}),
    ...(value.answeredQuestions !== undefined ? { answeredQuestions: value.answeredQuestions } : {}),
    seq: value.seq,
    deleted: false
  });
  if (fold === null || fold.head === null || fold.head.id !== sessionId || fold.seq !== seq) {
    return null;
  }
  const snapshot = toThreadSnapshot(fold);
  const history = historyBoundsFromSnapshot(value as unknown as ThreadSnapshotPayload);
  // Whose rows the saved copy does not hold (on-demand agent rows): restored
  // with it, so its drill-ins load them rather than show what is left.
  const omittedAgentIds = omittedAgentIdsOf(value.omittedAgentIds);
  return {
    ...snapshot,
    ...(history !== null ? { history } : {}),
    ...(omittedAgentIds !== undefined ? { omittedAgentIds: [...omittedAgentIds] } : {})
  };
}

/** Both halves of a record, validated against each other and the key asked for. */
export function parsePersistedThread(
  metaValue: unknown,
  bodyValue: unknown,
  scope: string,
  sessionId: string
): PersistedThread | null {
  const meta = parseMeta(metaValue);
  if (meta === null || meta.scope !== scope || meta.sessionId !== sessionId) return null;
  if (
    !isRecord(bodyValue) ||
    bodyValue.key !== meta.key ||
    bodyValue.v !== meta.v ||
    bodyValue.seq !== meta.seq ||
    typeof bodyValue.json !== "string" ||
    bodyValue.json.length !== meta.chars
  ) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyValue.json);
  } catch {
    return null;
  }
  const snapshot = parsePersistedSnapshot(decoded, sessionId, meta.seq);
  if (snapshot === null) return null;
  // A whole record that names omitted rows is not one this format writes.
  if ((meta.v === THREAD_CACHE_PARTIAL_VERSION) !== (snapshot.omittedAgentIds !== undefined)) return null;
  return {
    scope,
    sessionId,
    seq: meta.seq,
    hostInstanceId: meta.hostInstanceId,
    savedAt: meta.savedAt,
    snapshot
  };
}

/** What the cache reads off a thread store's state. */
export interface PersistableThreadState {
  reducer: AgentChatReducerState;
  slice: AgentChatThreadSlice;
}

/**
 * The history bounds as they describe the window being saved. Once the
 * window has evicted rows since the snapshot the bounds came from, their
 * cursor names the block below the window as it WAS: older history exists
 * whatever they said, and the first page is asked for without a cursor
 * (`nextHistoryCursor`) — which is what a saved `beforeCursor: null` does.
 */
function boundsOfWindow(
  history: AgentChatHistoryState,
  evicted: boolean
): ThreadHistoryBounds | null {
  const bounds = history.bounds;
  if (bounds === null) return null;
  if (!history.windowEvicted && !evicted) return bounds;
  return { ...bounds, hasOlder: true, beforeCursor: null, oldestRetainedOrdinal: null };
}

/**
 * The snapshot of a store's state as it would be saved: the fold's own §6.3
 * read shape (`toThreadSnapshot`) plus the window's bounds. `null` for a
 * state there is nothing to keep of — headless, deleted, or never folded.
 */
export function persistableSnapshotOf(state: PersistableThreadState): ThreadSnapshotPayload | null {
  const fold = state.reducer.fold;
  if (fold.head === null || fold.deleted || fold.seq <= 0 || fold.head.id !== state.slice.sessionId) {
    return null;
  }
  const snapshot = toThreadSnapshot(fold);
  // The fold stamps the head with every event; one from a snapshot whose head
  // was folded further than its floor is saved at the floor it resumes from.
  const head = snapshot.head.seq === fold.seq ? snapshot.head : { ...snapshot.head, seq: fold.seq };
  const history = boundsOfWindow(state.slice.history, fold.evicted !== undefined);
  const omittedAgentIds = state.slice.omittedAgentIds;
  return {
    ...snapshot,
    head,
    ...(history !== null ? { history } : {}),
    ...(omittedAgentIds !== undefined && omittedAgentIds.length > 0 ? { omittedAgentIds: [...omittedAgentIds] } : {})
  };
}

// ---------------------------------------------------------------------------
// Clears that outlive the page
// ---------------------------------------------------------------------------

/**
 * The durable record of a clear (`localStorage`): one token per daemon scope,
 * and one for "every scope", re-minted by every clear. A record is written
 * with the generation of its scope as it stood (`ThreadCacheMeta.cleared`) and
 * is valid only while that generation still stands — so a clear holds even
 * when its deletes never ran (a stuck database, a page closed right after the
 * sign-out), and a write decided before it, in this tab or another, is
 * refused at the moment it would land.
 */
const CLEARED_KEY_PREFIX = "orquester:agent-chat-device-cache-cleared:";
const CLEARED_ALL_KEY = `${CLEARED_KEY_PREFIX}*`;
const CLEARED_TOKEN = /^[A-Za-z0-9-]{1,64}$/;
/** The generation of a scope nothing ever cleared. */
const NEVER_CLEARED = "0";

function durableStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage !== undefined && storage !== null && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function mintToken(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoRef?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** One marker, validated; a corrupt one is replaced by a fresh clear. `null`: unreadable storage. */
function readMarker(storage: Storage, key: string): string | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return NEVER_CLEARED;
    if (CLEARED_TOKEN.test(raw)) return raw;
    // Doubt about a clear is a clear: whatever was written under it is invalid.
    const token = mintToken();
    storage.setItem(key, token);
    return token;
  } catch {
    return null;
  }
}

/**
 * The clear generation of `scope` now, or `null` when it cannot be read — and
 * then nothing is cached at all: content whose clear could not be recorded
 * must not be kept.
 */
export function clearGenerationOf(scope: string): string | null {
  const storage = durableStorage();
  if (storage === null) return null;
  const all = readMarker(storage, CLEARED_ALL_KEY);
  const own = readMarker(storage, `${CLEARED_KEY_PREFIX}${scope}`);
  return all === null || own === null ? null : `${all}.${own}`;
}

function markCleared(scope: string | undefined): void {
  try {
    durableStorage()?.setItem(scope === undefined ? CLEARED_ALL_KEY : `${CLEARED_KEY_PREFIX}${scope}`, mintToken());
  } catch {
    /* storage refused the write: every later read fails `clearGenerationOf` the same way */
  }
}

/** Whether a stored meta was written under its scope's standing generation. */
function writtenUnderCurrentGeneration(meta: ThreadCacheMeta): boolean {
  return meta.cleared === clearGenerationOf(meta.scope);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Writes run one at a time, in order; reads do not wait for them. */
let chain: Promise<void> = Promise.resolve();
/** The one write waiting per key: a newer save replaces it, so a stuck database holds one copy per thread. */
const waitingWrites = new Map<string, () => Promise<void>>();

function enqueue(run: () => Promise<void>): Promise<void> {
  const next = chain.then(run).catch((error: unknown) => {
    warnOnce(error);
  });
  chain = next;
  return next;
}

let warned = false;
function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("agent chat: the device cache of chats is unavailable", error);
}

/**
 * A read outlived {@link THREAD_CACHE_LOAD_TIMEOUT_MS} and has not answered
 * since: further opens do not wait on the device at all.
 */
let storageUnresponsive = false;

/** Epoch ms; replaceable in tests through `mock.timers`' `Date`. */
const now = (): number => Date.now();

/** The stored meta of `key`, validated, as it stands now. */
async function currentMeta(backend: ThreadCacheBackend, key: string): Promise<ThreadCacheMeta | null> {
  const found = (await backend.readMetas()).find((value) => isRecord(value) && value.key === key);
  return found === undefined ? null : parseMeta(found);
}

/**
 * Read a saved thread. Resolves `null` — never rejects — when there is none,
 * when there is no storage, and for a record that does not validate or was
 * written before its scope's last clear (which is deleted). A record read is
 * touched, so it is the last to be evicted.
 */
export async function loadPersistedThread(
  scope: string,
  sessionId: string
): Promise<PersistedThread | null> {
  const backend = activeBackend();
  const generation = clearGenerationOf(scope);
  if (backend === null || generation === null) return null;
  const key = threadCacheKey(scope, sessionId);
  let stored: { meta: unknown; body: unknown };
  try {
    stored = await backend.read(key);
  } catch (error) {
    warnOnce(error);
    return null;
  }
  if (stored.meta === undefined && stored.body === undefined) return null;
  // Cleared while the read was out: what it found is gone.
  if (clearGenerationOf(scope) !== generation) return null;
  const meta = parseMeta(stored.meta);
  const record =
    meta !== null && meta.cleared === generation
      ? parsePersistedThread(stored.meta, stored.body, scope, sessionId)
      : null;
  if (record === null) {
    void enqueue(() => backend.write({ remove: [key] }));
    return null;
  }
  // Touched as it stands when the touch runs: a save queued meanwhile wrote a
  // newer meta, which an older copy must not overwrite.
  void enqueue(async () => {
    const current = await currentMeta(backend, key);
    if (current === null || current.savedAt !== meta!.savedAt || !writtenUnderCurrentGeneration(current)) return;
    await backend.write({ put: [{ meta: { ...current, usedAt: now() } }] });
  });
  return record;
}

/**
 * Save a thread (serialized already) under the clear generation it was read
 * in, evicting the least recently used entries past the count and size
 * bounds. Dropped when its scope has been cleared since — checked when the
 * write runs, so a clear in another tab counts too.
 */
function saveSerializedThread(
  input: { scope: string; sessionId: string; seq: number; hostInstanceId: string; json: string; partial: boolean },
  generation: string
): Promise<void> {
  const backend = activeBackend();
  if (backend === null) return Promise.resolve();
  const key = threadCacheKey(input.scope, input.sessionId);
  const first = !waitingWrites.has(key);
  waitingWrites.set(key, async () => {
    if (clearGenerationOf(input.scope) !== generation) return;
    const stamp = now();
    const v = input.partial ? THREAD_CACHE_PARTIAL_VERSION : THREAD_CACHE_VERSION;
    const meta: ThreadCacheMeta = {
      key,
      v,
      fold: FOLD_SNAPSHOT_VERSION,
      scope: input.scope,
      sessionId: input.sessionId,
      seq: input.seq,
      hostInstanceId: input.hostInstanceId,
      cleared: generation,
      savedAt: stamp,
      usedAt: stamp,
      chars: input.json.length
    };
    const body: ThreadCacheBody = { key, v, seq: input.seq, json: input.json };
    const remove = evictionsFor(await backend.readMetas(), meta);
    if (clearGenerationOf(input.scope) !== generation) return;
    await backend.write({ put: [{ meta, body }], remove });
  });
  if (!first) return chain;
  return enqueue(async () => {
    const run = waitingWrites.get(key);
    waitingWrites.delete(key);
    await run?.();
  });
}

/**
 * Which stored entries go to make room for `incoming`: every meta that does
 * not validate (another version's, a corrupt one) or was written before its
 * scope's last clear, and then, newest use first, whatever no longer fits the
 * count or the size bound.
 */
export function evictionsFor(
  stored: readonly unknown[],
  incoming: ThreadCacheMeta,
  current: (meta: ThreadCacheMeta) => boolean = writtenUnderCurrentGeneration
): string[] {
  const remove: string[] = [];
  const kept: ThreadCacheMeta[] = [];
  for (const value of stored) {
    const meta = parseMeta(value);
    if (meta === null || !current(meta)) {
      if (isRecord(value) && typeof value.key === "string" && value.key !== incoming.key) remove.push(value.key);
      continue;
    }
    if (meta.key !== incoming.key) kept.push(meta);
  }
  kept.sort((left, right) => right.usedAt - left.usedAt);
  let count = 1;
  let chars = incoming.chars;
  for (const meta of kept) {
    if (count < THREAD_CACHE_MAX_ENTRIES && chars + meta.chars <= THREAD_CACHE_MAX_TOTAL_CHARS) {
      count += 1;
      chars += meta.chars;
    } else {
      remove.push(meta.key);
    }
  }
  return remove;
}

/** Forget one saved thread (the host no longer has it, it was deleted, or it outgrew the bound). */
export function dropPersistedThread(scope: string, sessionId: string): Promise<void> {
  const backend = activeBackend();
  if (backend === null) return Promise.resolve();
  const key = threadCacheKey(scope, sessionId);
  waitingWrites.delete(key);
  return enqueue(() => backend.write({ remove: [key] }));
}

/** The live generations' links, so a clear can stop them (`linkThreadCache`). */
const liveLinks = new Set<{ scope: string; revoke(): void }>();

/**
 * Forget every saved thread of one daemon connection — or of every
 * connection, with no scope. Run when the daemon credential is dropped and
 * when a remote is removed: chat content must not outlive the sign-in it was
 * read under.
 *
 * Final at once, whatever the database does: the clear is recorded durably
 * first (`clearGenerationOf`), which invalidates every record written before
 * it and refuses every write decided before it, here or in another tab; the
 * live generations of the scope stop writing for good; and the deletes are
 * queued. A page that dies before they run deletes the rest on its next
 * start (`sweepStale`).
 */
export function clearThreadCache(scope?: string): Promise<void> {
  markCleared(scope);
  for (const link of [...liveLinks]) {
    if (scope === undefined || link.scope === scope) link.revoke();
  }
  const prefix = scope === undefined ? null : `${scope}${KEY_SEPARATOR}`;
  for (const key of [...waitingWrites.keys()]) {
    if (prefix === null || key.startsWith(prefix)) waitingWrites.delete(key);
  }
  const backend = activeBackend();
  if (backend === null) return Promise.resolve();
  return enqueue(async () => {
    const keys = await backend.readKeys();
    const remove = prefix === null ? keys : keys.filter((key) => key.startsWith(prefix));
    if (remove.length > 0) await backend.write({ remove });
  });
}

/**
 * Once per page, before its first thread links: delete every record that is
 * not valid now — another version's, a corrupt one, one written before its
 * scope's last clear (whose deletes a closed page never ran) — and every
 * body without a meta.
 */
let swept = false;
function sweepStale(backend: ThreadCacheBackend): void {
  if (swept) return;
  swept = true;
  void enqueue(async () => {
    const valid = new Set<string>();
    for (const value of await backend.readMetas()) {
      const meta = parseMeta(value);
      if (meta !== null && writtenUnderCurrentGeneration(meta)) valid.add(meta.key);
    }
    const remove = (await backend.readKeys()).filter((key) => !valid.has(key));
    if (remove.length > 0) await backend.write({ remove });
  });
}

/** Resolves once every write queued so far has settled (tests, and a caller that must wait). */
export function threadCacheIdle(): Promise<void> {
  return chain;
}

// ---------------------------------------------------------------------------
// One store generation's link
// ---------------------------------------------------------------------------

/** The slice of a zustand store the link watches. */
export interface WatchableThreadStore {
  getState(): PersistableThreadState;
  subscribe(listener: (state: PersistableThreadState, previous: PersistableThreadState) => void): () => void;
}

export interface ThreadCacheLink {
  /**
   * The saved copy, read once: `null` when there is none, it does not
   * validate, or it took longer than {@link THREAD_CACHE_LOAD_TIMEOUT_MS}.
   * Absent when the link was made without a load (the thread was retained in
   * memory, which is newer).
   */
  readonly restored: Promise<PersistedThread | null> | null;
  /** Start saving the store's state (once). */
  watch(store: WatchableThreadStore): void;
  /** The generation is gone: write what is pending, if it may be, and stop. */
  close(): void;
}

/**
 * Whether a state may be saved: a folded, headed, live thread whose fold and
 * host instance agree and that the host has confirmed. Not while
 * `connecting` — between a `snapshot` and the `synchronized` that confirms it
 * — nor while it is still the device's own unconfirmed copy
 * (`fromDeviceCache`, in `reconnecting`/`error` too), nor once the host said
 * the thread is `gone`.
 */
function savable(state: PersistableThreadState): boolean {
  const { connection } = state.slice;
  return (
    connection !== "idle" &&
    connection !== "connecting" &&
    connection !== "gone" &&
    state.slice.fromDeviceCache !== true &&
    state.reducer.hostInstanceId !== null &&
    persistableSnapshotOf(state) !== null
  );
}

/** One comparable key for an omitted set (sorted already). */
function omittedKey(ids: readonly string[] | undefined): string {
  return ids === undefined ? "" : ids.join("\u0000");
}

/** A turn is under way: the session is running, or the latest turn has not settled. */
function turnRunning(slice: AgentChatThreadSlice): boolean {
  return (
    slice.sessionStatus === "running" ||
    (slice.turnStatus !== null && !isSettledTurnState(slice.turnStatus))
  );
}

/**
 * Link one store generation to the device cache, or `null` when there is
 * nothing to link to (no storage, no durable record of clears, or a transport
 * bound to no connection).
 */
export function linkThreadCache(
  transport: object,
  sessionId: string,
  options: { load: boolean }
): ThreadCacheLink | null {
  const scope = threadCacheScopeOf(transport);
  const backend = activeBackend();
  if (scope === null || backend === null) {
    return null;
  }
  /** The clear generation this generation reads and writes under; a clear ends it. */
  const generation = clearGenerationOf(scope);
  if (generation === null) {
    return null;
  }
  sweepStale(backend);
  let store: WatchableThreadStore | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  /** The scope was cleared (a sign-out): this generation never writes again. */
  let revoked = false;
  /**
   * What the device holds for this thread, as far as this generation knows —
   * and whose rows it lacks: an `agent-rows` frame changes the copy without
   * moving its cursor.
   */
  let saved: { seq: number; hostInstanceId: string; omitted: string } | null = null;
  /** A change not yet written. */
  let dirty = false;
  let lastWriteAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A due write waiting for the page to be idle; no other is scheduled meanwhile. */
  let idleWait = false;
  /**
   * The host changed under the stream and the fresh snapshot has not landed
   * yet: the fold is the old host's, the instance id the new one's. Never
   * saved so.
   */
  let resyncPending = false;

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const registration = {
    scope,
    revoke(): void {
      revoked = true;
      dirty = false;
      saved = null;
      cancelTimer();
    }
  };
  liveLinks.add(registration);

  // Storage that left a read hanging is not waited on again until it answers.
  const restored = options.load && !storageUnresponsive
    ? new Promise<PersistedThread | null>((resolve) => {
        const bound = setTimeout(() => {
          storageUnresponsive = true;
          resolve(null);
        }, THREAD_CACHE_LOAD_TIMEOUT_MS);
        bound.unref?.();
        void loadPersistedThread(scope, sessionId).then((record) => {
          storageUnresponsive = false;
          clearTimeout(bound);
          if (record !== null && saved === null && !revoked) {
            saved = {
              seq: record.seq,
              hostInstanceId: record.hostInstanceId,
              omitted: omittedKey(record.snapshot.omittedAgentIds)
            };
          }
          resolve(revoked ? null : record);
        });
      })
    : null;

  /**
   * Write what is pending, if it may be written. `final` — the page going
   * hidden, the generation torn down — also writes a running turn: nobody is
   * looking, and it may be the last chance before the OS kills the page.
   */
  const flush = (final: boolean): void => {
    cancelTimer();
    if (store === null || !dirty) return;
    if (revoked || clearGenerationOf(scope) !== generation) {
      // Cleared since — here or in another tab: what is pending belonged to it.
      registration.revoke();
      return;
    }
    const state = store.getState();
    // A turn still running is written once it settles — a change of its own.
    if (resyncPending || !savable(state) || (!final && turnRunning(state.slice))) return;
    const seq = state.reducer.fold.seq;
    const hostInstanceId = state.reducer.hostInstanceId!;
    const omitted = omittedKey(state.slice.omittedAgentIds);
    dirty = false;
    if (saved !== null && saved.seq === seq && saved.hostInstanceId === hostInstanceId && saved.omitted === omitted) {
      // The device already holds this cursor under this host (the copy it was painted from).
      return;
    }
    const snapshot = persistableSnapshotOf(state)!;
    const json = JSON.stringify(snapshot);
    lastWriteAt = now();
    if (json.length > THREAD_CACHE_MAX_ENTRY_CHARS) {
      saved = null;
      void dropPersistedThread(scope, sessionId);
      return;
    }
    saved = { seq, hostInstanceId, omitted };
    void saveSerializedThread(
      { scope, sessionId, seq, hostInstanceId, json, partial: snapshot.omittedAgentIds !== undefined },
      generation
    );
  };

  const schedule = (): void => {
    if (timer !== null || idleWait || closed || revoked) return;
    const delay =
      lastWriteAt === null
        ? THREAD_CACHE_FIRST_SAVE_DELAY_MS
        : Math.max(THREAD_CACHE_FIRST_SAVE_DELAY_MS, lastWriteAt + THREAD_CACHE_SAVE_INTERVAL_MS - now());
    timer = setTimeout(() => {
      timer = null;
      // Serializing a big thread is the one long task here: out of the way
      // of a scroll or a keystroke when the page can say so.
      const idle = (globalThis as { requestIdleCallback?: IdleScheduler }).requestIdleCallback;
      if (typeof idle !== "function") {
        flush(false);
        return;
      }
      idleWait = true;
      idle(() => {
        idleWait = false;
        if (!closed) flush(false);
      }, { timeout: IDLE_WRITE_TIMEOUT_MS });
    }, delay);
    timer.unref?.();
  };

  const drop = (): void => {
    cancelTimer();
    dirty = false;
    saved = null;
    void dropPersistedThread(scope, sessionId);
  };

  const onChange = (state: PersistableThreadState, previous: PersistableThreadState): void => {
    if (closed || revoked) return;
    const { reducer, slice } = state;
    // The host holds no such thread, or it was deleted: nothing of it stays.
    if (slice.connection === "gone" || reducer.fold.deleted) {
      if (previous.slice.connection !== "gone" && !previous.reducer.fold.deleted) drop();
      return;
    }
    const hostChanged =
      previous.reducer.hostInstanceId !== null &&
      reducer.hostInstanceId !== previous.reducer.hostInstanceId;
    const replaced = reducer.historyEpoch !== previous.reducer.historyEpoch;
    if (hostChanged) {
      // A snapshot in the same update was the new host's answer already.
      resyncPending = !replaced;
    } else if (replaced) {
      resyncPending = false;
    }
    if (
      reducer.fold !== previous.reducer.fold ||
      reducer.hostInstanceId !== previous.reducer.hostInstanceId ||
      slice.history.bounds !== previous.slice.history.bounds ||
      // An agent's rows loaded: what the copy lacks moved, its cursor did not.
      slice.omittedAgentIds !== previous.slice.omittedAgentIds
    ) {
      dirty = true;
    }
    // A pending change waits for a state it may be saved in — the
    // `synchronized` after a replay is a change of its own.
    if (dirty) schedule();
  };

  const pageHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";
  const onHide = (): void => {
    if (pageHidden()) flush(true);
  };
  const onPageHide = (): void => flush(true);
  const lifecycle =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof document.addEventListener === "function";

  return {
    restored,
    watch(next) {
      if (store !== null || closed) return;
      store = next;
      unsubscribe = next.subscribe(onChange);
      if (lifecycle) {
        // The last chance before a mobile OS kills a backgrounded page.
        window.addEventListener("pagehide", onPageHide);
        document.addEventListener("visibilitychange", onHide);
      }
    },
    close() {
      if (closed) return;
      flush(true);
      closed = true;
      cancelTimer();
      liveLinks.delete(registration);
      unsubscribe?.();
      unsubscribe = null;
      if (lifecycle) {
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onHide);
      }
    }
  };
}
