/**
 * The device cache of chat threads (`persistent-cache.ts`): records, their
 * validation and versions, eviction, the write cadence, connection isolation
 * and the IndexedDB adapter. The store's use of it is `store.device-cache.test.ts`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { FOLD_SNAPSHOT_VERSION, type AgentChatStreamFrame } from "@orquester/api/agent-chat";

import {
  bindThreadCacheScope,
  clearGenerationOf,
  clearThreadCache,
  evictionsFor,
  indexedDbThreadCacheBackend,
  linkThreadCache,
  loadPersistedThread,
  parsePersistedSnapshot,
  persistableSnapshotOf,
  setThreadCacheBackend,
  threadCacheIdle,
  threadCacheKey,
  threadCacheScopeFor,
  threadCacheScopeOf,
  THREAD_CACHE_FIRST_SAVE_DELAY_MS,
  THREAD_CACHE_LOAD_TIMEOUT_MS,
  THREAD_CACHE_MAX_ENTRIES,
  THREAD_CACHE_MAX_ENTRY_CHARS,
  THREAD_CACHE_MAX_TOTAL_CHARS,
  THREAD_CACHE_SAVE_INTERVAL_MS,
  THREAD_CACHE_PARTIAL_VERSION,
  THREAD_CACHE_VERSION,
  type PersistableThreadState,
  type ThreadCacheBackend,
  type ThreadCacheMeta
} from "./persistent-cache";
import { applyFrame, createReducerState, patchSlice } from "./reducer.logic";
import { head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface MemoryBackend extends ThreadCacheBackend {
  metas: Map<string, unknown>;
  bodies: Map<string, unknown>;
  /** Writes that carried a body: what the cadence is measured by. */
  bodyWrites: number;
}

function memoryBackend(): MemoryBackend {
  const metas = new Map<string, unknown>();
  const bodies = new Map<string, unknown>();
  const backend: MemoryBackend = {
    metas,
    bodies,
    bodyWrites: 0,
    async read(key) {
      return { meta: structuredClone(metas.get(key)), body: structuredClone(bodies.get(key)) };
    },
    async readMetas() {
      return [...metas.values()].map((meta) => structuredClone(meta));
    },
    async readKeys() {
      return [...new Set([...metas.keys(), ...bodies.keys()])];
    },
    async write(change) {
      for (const key of change.remove ?? []) {
        metas.delete(key);
        bodies.delete(key);
      }
      for (const { meta, body } of change.put ?? []) {
        metas.set(meta.key, structuredClone(meta));
        if (body !== undefined) {
          bodies.set(body.key, structuredClone(body));
          backend.bodyWrites += 1;
        }
      }
    }
  };
  return backend;
}

function fakeStore(initial: PersistableThreadState) {
  let state = initial;
  const listeners = new Set<(next: PersistableThreadState, previous: PersistableThreadState) => void>();
  return {
    getState: () => state,
    subscribe(listener: (next: PersistableThreadState, previous: PersistableThreadState) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: PersistableThreadState) {
      const previous = state;
      state = next;
      for (const listener of listeners) listener(next, previous);
    },
    apply(...frames: AgentChatStreamFrame[]) {
      let reducer = state.reducer;
      for (const frame of frames) reducer = applyFrame(reducer, frame);
      this.set({ reducer, slice: reducer.slice });
    }
  };
}

const EMPTY: PersistableThreadState = (() => {
  const reducer = createReducerState("s1");
  return { reducer, slice: reducer.slice };
})();

function threadSnapshot(seq: number, texts: string[] = ["hello", "hi"], sessionId = "s1") {
  return snapshot({
    head: head({ id: sessionId, seq }),
    items: texts.map((text, index) =>
      message(index % 2 === 0 ? "user" : "assistant", text, { createdAt: stamp(index + 1) })
    ),
    seq
  });
}

/** A thread at `seq`, synchronized with `host`. */
function synchronizedState(seq: number, host = "host-1", texts?: string[]): PersistableThreadState {
  let reducer = applyFrame(createReducerState("s1"), { kind: "snapshot", thread: threadSnapshot(seq, texts) });
  reducer = applyFrame(reducer, { kind: "synchronized", hostInstanceId: host });
  return { reducer, slice: reducer.slice };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Let every queued write settle (mocked timers do not hold promises). */
async function settled(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await threadCacheIdle();
    await Promise.resolve();
  }
}

const SCOPE_A = threadCacheScopeFor({ kind: "remote", endpoint: "https://a.example/" });
const SCOPE_B = threadCacheScopeFor({ kind: "remote", endpoint: "https://b.example" });

function transportFor(endpoint: string): object {
  const transport = {};
  bindThreadCacheScope(transport, { kind: "remote", endpoint });
  return transport;
}

let backend: MemoryBackend;
/** The page's `localStorage`: where clears are recorded. */
const local = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => void local.set(key, value),
  removeItem: (key: string) => void local.delete(key)
};

beforeEach(async () => {
  resetBuilders();
  local.clear();
  backend = memoryBackend();
  setThreadCacheBackend(backend);
  await clearThreadCache();
  await settled();
});

afterEach(() => {
  mock.timers.reset();
  setThreadCacheBackend(undefined);
});

/** Save `state` for `s1` under the transport's scope, through a link's close. */
async function save(transport: object, state: PersistableThreadState): Promise<void> {
  const link = linkThreadCache(transport, state.slice.sessionId, { load: false })!;
  const store = fakeStore(EMPTY);
  link.watch(store);
  store.set(state);
  link.close();
  await settled();
}

// ---------------------------------------------------------------------------
// Connection identity
// ---------------------------------------------------------------------------

describe("connection identity", () => {
  it("names a daemon by kind and endpoint, ignoring a trailing slash", () => {
    assert.equal(
      threadCacheScopeFor({ kind: "remote", endpoint: "https://a.example/" }),
      threadCacheScopeFor({ kind: "remote", endpoint: "https://a.example" })
    );
    assert.notEqual(SCOPE_A, SCOPE_B);
    assert.notEqual(
      threadCacheScopeFor({ kind: "local", endpoint: "https://a.example" }),
      SCOPE_A
    );
    assert.equal(threadCacheScopeOf(transportFor("https://a.example")), SCOPE_A);
    assert.equal(threadCacheScopeOf({}), null, "an unbound transport has no scope");
  });

  it("never lets two daemons share an entry, and clears one daemon's alone", async () => {
    const a = transportFor("https://a.example");
    const b = transportFor("https://b.example");
    await save(a, synchronizedState(5, "host-a", ["from a"]));
    await save(b, synchronizedState(9, "host-b", ["from b"]));

    const fromA = await loadPersistedThread(SCOPE_A, "s1");
    const fromB = await loadPersistedThread(SCOPE_B, "s1");
    assert.equal(fromA?.seq, 5);
    assert.equal(fromA?.hostInstanceId, "host-a");
    assert.deepEqual(fromA?.snapshot.items.map((item) => item.kind === "message" && item.text), ["from a"]);
    assert.equal(fromB?.seq, 9);
    assert.deepEqual(fromB?.snapshot.items.map((item) => item.kind === "message" && item.text), ["from b"]);

    await clearThreadCache(SCOPE_A);
    await settled();
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
    assert.equal((await loadPersistedThread(SCOPE_B, "s1"))?.seq, 9);
  });

  it("links nothing for a transport bound to no connection, or with no storage", () => {
    assert.equal(linkThreadCache({}, "s1", { load: true }), null);
    setThreadCacheBackend(null);
    assert.equal(linkThreadCache(transportFor("https://a.example"), "s1", { load: true }), null);
  });
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

describe("records", () => {
  it("round-trips the snapshot a snapshot frame would carry", async () => {
    const state = synchronizedState(5);
    await save(transportFor("https://a.example"), state);
    const record = await loadPersistedThread(SCOPE_A, "s1");
    assert.ok(record);
    assert.equal(record.seq, 5);
    assert.equal(record.hostInstanceId, "host-1");
    assert.deepEqual(record.snapshot, persistableSnapshotOf(state));
    // And folded as a frame it is the same thread.
    const refolded = applyFrame(createReducerState("s1"), { kind: "snapshot", thread: record.snapshot });
    assert.deepEqual(refolded.slice.entries, state.slice.entries);
    assert.deepEqual(refolded.slice.pending, state.slice.pending);
  });

  it("ignores and deletes a record of another format or fold version", async () => {
    const key = threadCacheKey(SCOPE_A, "s1");
    for (const change of [{ v: THREAD_CACHE_PARTIAL_VERSION + 1 }, { fold: FOLD_SNAPSHOT_VERSION - 1 }]) {
      await save(transportFor("https://a.example"), synchronizedState(5));
      backend.metas.set(key, { ...(backend.metas.get(key) as object), ...change });
      assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null, JSON.stringify(change));
      await settled();
      assert.equal(backend.metas.has(key), false, "deleted, not kept around");
      assert.equal(backend.bodies.has(key), false);
    }
  });

  it("ignores and deletes a record whose halves do not validate", async () => {
    const key = threadCacheKey(SCOPE_A, "s1");
    const corruptions: Array<[string, (meta: Record<string, unknown>, body: Record<string, unknown>) => void]> = [
      ["meta not an object", (meta) => { for (const field of Object.keys(meta)) delete meta[field]; }],
      ["meta for another session", (meta) => { meta.sessionId = "s2"; }],
      ["no host instance", (meta) => { meta.hostInstanceId = ""; }],
      ["body at another seq", (_meta, body) => { body.seq = 4; }],
      ["body not JSON", (meta, body) => { body.json = "{"; meta.chars = 1; }],
      ["length disagrees", (meta) => { meta.chars = 3; }],
      ["a snapshot of another thread", (meta, body) => {
        body.json = JSON.stringify(persistableSnapshotOf(synchronizedState(5)))!.replaceAll("\"s1\"", "\"s2\"");
        meta.chars = (body.json as string).length;
      }],
      ["an item of the wrong shape", (meta, body) => {
        const value = JSON.parse(body.json as string) as { items: unknown[] };
        value.items.push({ kind: "message", id: 7 });
        body.json = JSON.stringify(value);
        meta.chars = (body.json as string).length;
      }],
      ["missing body", (_meta, body) => { body.missing = true; }]
    ];
    for (const [name, corrupt] of corruptions) {
      await save(transportFor("https://a.example"), synchronizedState(5));
      const meta = backend.metas.get(key) as Record<string, unknown>;
      const body = backend.bodies.get(key) as Record<string, unknown>;
      corrupt(meta, body);
      if (body.missing === true) backend.bodies.delete(key);
      assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null, name);
      await settled();
      assert.equal(backend.metas.has(key), false, `${name}: deleted`);
    }
  });

  it("validates the snapshot field-wise, as the host validates its own state.json", () => {
    const good = persistableSnapshotOf(synchronizedState(5))!;
    assert.ok(parsePersistedSnapshot(JSON.parse(JSON.stringify(good)), "s1", 5));
    assert.equal(parsePersistedSnapshot({ ...good, seq: 6 }, "s1", 5), null, "folded to another seq");
    assert.equal(parsePersistedSnapshot({ ...good, pending: { approvals: [{}] } }, "s1", 5), null);
    assert.equal(parsePersistedSnapshot({ ...good, head: null }, "s1", 5), null, "headless");
    assert.equal(parsePersistedSnapshot(null, "s1", 5), null);
  });

  it("saves the window only, with a cursor-less bound once the window has evicted", () => {
    // A bounded snapshot's: its cut outlives the cursor an eviction makes stale.
    const bounds = { indexed: true, hasOlder: false, beforeCursor: "c1", oldestRetainedOrdinal: 1, totalTurns: 3, windowCut: "c1" };
    const base = synchronizedState(5);
    const withBounds = patchSlice(base.reducer, { history: { ...base.slice.history, bounds } });
    const kept = persistableSnapshotOf({ reducer: withBounds, slice: withBounds.slice })!;
    assert.deepEqual(kept.history, bounds);
    const evicted = patchSlice(withBounds, {
      history: {
        ...withBounds.slice.history,
        windowEvicted: true,
        pages: [{ items: [message("user", "older")], turns: [], beforeCursor: null } as never]
      }
    });
    const saved = persistableSnapshotOf({ reducer: evicted, slice: evicted.slice })!;
    assert.deepEqual(saved.history, { ...bounds, hasOlder: true, beforeCursor: null, oldestRetainedOrdinal: null });
    assert.equal(saved.history?.windowCut, "c1", "the cut is kept with the window it describes");
    assert.equal(
      parsePersistedSnapshot(JSON.parse(JSON.stringify(saved)), "s1", 5)?.history?.windowCut,
      "c1",
      "and read back"
    );
    assert.ok(!JSON.stringify(saved).includes("older"), "a loaded page is never saved");
  });

  it("keeps nothing of a headless, deleted or unfolded thread", () => {
    assert.equal(persistableSnapshotOf(EMPTY), null);
    const state = synchronizedState(5);
    const deleted = { ...state.reducer, fold: { ...state.reducer.fold, deleted: true } };
    assert.equal(persistableSnapshotOf({ reducer: deleted, slice: deleted.slice }), null);
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

function meta(key: string, usedAt: number, chars = 10): ThreadCacheMeta {
  return {
    key: threadCacheKey(SCOPE_A, key),
    v: THREAD_CACHE_VERSION,
    fold: FOLD_SNAPSHOT_VERSION,
    scope: SCOPE_A,
    sessionId: key,
    seq: 1,
    hostInstanceId: "h",
    cleared: clearGenerationOf(SCOPE_A)!,
    savedAt: usedAt,
    usedAt,
    chars
  };
}

describe("eviction", () => {
  it(`keeps the ${THREAD_CACHE_MAX_ENTRIES} most recently used threads`, () => {
    const stored = Array.from({ length: THREAD_CACHE_MAX_ENTRIES }, (_, index) => meta(`t${index}`, 100 + index));
    const removed = evictionsFor(stored, meta("new", 1_000));
    assert.deepEqual(removed, [threadCacheKey(SCOPE_A, "t0")], "the least recently used one goes");
    // Rewriting a thread already there evicts nothing.
    assert.deepEqual(evictionsFor(stored, meta("t5", 1_000)), []);
  });

  it("keeps the total under the size bound, newest first", () => {
    const entry = THREAD_CACHE_MAX_ENTRY_CHARS;
    const fit = Math.floor(THREAD_CACHE_MAX_TOTAL_CHARS / entry);
    // `fit` full-size threads fill the bound: a new one leaves room for `fit - 1` of them.
    const stored = Array.from({ length: fit }, (_, index) => meta(`t${index}`, index + 1, entry));
    assert.deepEqual(evictionsFor(stored, meta("new", 100, entry)), [threadCacheKey(SCOPE_A, "t0")]);
    // A small newcomer fits beside all of them, and a small old one beside the newest.
    assert.deepEqual(evictionsFor(stored, meta("new", 100, THREAD_CACHE_MAX_TOTAL_CHARS - fit * entry)), []);
    assert.deepEqual(
      evictionsFor([...stored, meta("tiny", 0, 1)], meta("new", 100, entry)).sort(),
      [threadCacheKey(SCOPE_A, "t0"), threadCacheKey(SCOPE_A, "tiny")].sort(),
      "a full bound has no room for even one more character"
    );
  });

  it("drops records it cannot read", () => {
    const removed = evictionsFor([{ key: "junk", v: 99 }, { nokey: true }, meta("ok", 1)], meta("new", 2));
    assert.deepEqual(removed, ["junk"]);
  });

  it("evicts through a save", async () => {
    for (let index = 0; index < THREAD_CACHE_MAX_ENTRIES; index += 1) {
      backend.metas.set(threadCacheKey(SCOPE_A, `t${index}`), meta(`t${index}`, index));
      backend.bodies.set(threadCacheKey(SCOPE_A, `t${index}`), { key: threadCacheKey(SCOPE_A, `t${index}`) });
    }
    await save(transportFor("https://a.example"), synchronizedState(5));
    assert.equal(backend.metas.size, THREAD_CACHE_MAX_ENTRIES);
    assert.equal(backend.metas.has(threadCacheKey(SCOPE_A, "t0")), false);
    assert.equal(backend.bodies.has(threadCacheKey(SCOPE_A, "t0")), false);
    assert.equal(backend.metas.has(threadCacheKey(SCOPE_A, "s1")), true);
  });
});

// ---------------------------------------------------------------------------
// The write cadence
// ---------------------------------------------------------------------------

describe("the write cadence", () => {
  it("writes 500 ms after the first change, then at most once per 10 s", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(synchronizedState(5));
    mock.timers.tick(THREAD_CACHE_FIRST_SAVE_DELAY_MS - 1);
    await settled();
    assert.equal(backend.bodyWrites, 0);
    mock.timers.tick(1);
    await settled();
    assert.equal(backend.bodyWrites, 1, "the first write");

    // A streaming turn: a frame every 100 ms for 25 s.
    let seq = 5;
    const writesAt: number[] = [];
    for (let elapsed = 0; elapsed < 25_000; elapsed += 100) {
      seq += 1;
      store.apply({
        kind: "event",
        seq,
        event: {
          seq,
          eventId: `e${seq}`,
          threadId: "s1",
          type: "thread.message-sent",
          payload: { messageId: "m-stream", role: "assistant", text: `${seq} `, streaming: true, turnId: null },
          occurredAt: stamp(seq),
          commandId: null,
          causationEventId: null,
          metadata: {}
        } as never
      });
      const before = backend.bodyWrites;
      mock.timers.tick(100);
      await settled();
      if (backend.bodyWrites !== before) writesAt.push(Date.now());
    }
    assert.ok(writesAt.length >= 2 && writesAt.length <= 3, `writes at ${writesAt.join(", ")}`);
    let previous = 1_000_000 + THREAD_CACHE_FIRST_SAVE_DELAY_MS;
    for (const at of writesAt) {
      assert.ok(at - previous >= THREAD_CACHE_SAVE_INTERVAL_MS, `a write ${at - previous} ms after the last`);
      previous = at;
    }
    // What is saved is a state whose cursor and content agree.
    const record = await loadPersistedThread(SCOPE_A, "s1");
    assert.ok(record);
    assert.equal(record.snapshot.seq, record.seq);
    assert.equal(record.snapshot.head.seq, record.seq);
    link.close();
  });

  it("never writes a state the host has not confirmed, nor one before any host", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    // A snapshot frame, not yet synchronized: "connecting".
    store.apply({ kind: "snapshot", thread: threadSnapshot(5) });
    mock.timers.tick(30_000);
    await settled();
    assert.equal(backend.bodyWrites, 0);
    store.apply({ kind: "synchronized", hostInstanceId: "host-1" });
    mock.timers.tick(THREAD_CACHE_FIRST_SAVE_DELAY_MS);
    await settled();
    assert.equal(backend.bodyWrites, 1, "written once synchronized");
    link.close();
  });

  it("holds a changed host's state until its re-read lands", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(synchronizedState(5));
    mock.timers.tick(THREAD_CACHE_FIRST_SAVE_DELAY_MS);
    await settled();
    assert.equal(backend.bodyWrites, 1);
    // The host restarted: synchronized under host-2, old fold still there.
    store.apply({ kind: "synchronized", hostInstanceId: "host-2" });
    const s = store.getState();
    const live = patchSlice(s.reducer, { connection: "reconnecting" });
    store.set({ reducer: live, slice: live.slice });
    mock.timers.tick(60_000);
    await settled();
    assert.equal(backend.bodyWrites, 1, "never (old fold, new host)");
    // The re-read's snapshot, then live.
    store.apply({ kind: "snapshot", thread: threadSnapshot(8, ["hello", "hi", "after restart"]) });
    const synced = patchSlice(store.getState().reducer, { connection: "synchronized" });
    store.set({ reducer: synced, slice: synced.slice });
    mock.timers.tick(THREAD_CACHE_SAVE_INTERVAL_MS);
    await settled();
    assert.equal(backend.bodyWrites, 2);
    const record = await loadPersistedThread(SCOPE_A, "s1");
    assert.equal(record?.hostInstanceId, "host-2");
    assert.equal(record?.seq, 8);
    link.close();
  });

  it("writes what is pending when the generation closes — unless a clear came first", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const first = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    first.watch(store);
    store.set(synchronizedState(5));
    first.close();
    await settled();
    assert.equal(backend.bodyWrites, 1, "flushed on close");

    const second = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const again = fakeStore(synchronizedState(5));
    second.watch(again);
    again.set(synchronizedState(6));
    // Signed out before the throttle let it go.
    await clearThreadCache(SCOPE_A);
    second.close();
    mock.timers.tick(60_000);
    await settled();
    assert.equal(backend.bodyWrites, 1, "a change decided before the clear is never written");
    assert.equal(backend.metas.size, 0);
  });

  it("writes nothing while a turn runs, then once it settles — or as the page hides", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const listeners = new Map<string, () => void>();
    const page = {
      visibilityState: "visible",
      addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type)
    };
    const globals = globalThis as { window?: unknown; document?: unknown };
    globals.window = page;
    globals.document = page;
    try {
      const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
      const store = fakeStore(EMPTY);
      link.watch(store);
      const session = (status: "running" | "ready", seq: number): AgentChatStreamFrame => ({
        kind: "event",
        seq,
        event: {
          seq,
          eventId: `e${seq}`,
          threadId: "s1",
          type: "thread.session-set",
          payload: { session: { status, activeTurnId: status === "running" ? "t1" : null } },
          occurredAt: stamp(seq),
          commandId: null,
          causationEventId: null,
          metadata: {}
        } as never
      });
      store.set(synchronizedState(5));
      store.apply(session("running", 6));
      mock.timers.tick(60_000);
      await settled();
      assert.equal(backend.bodyWrites, 0, "not mid-turn");

      // The page goes to the background mid-turn: the last chance, taken.
      page.visibilityState = "hidden";
      listeners.get("visibilitychange")?.();
      await settled();
      assert.equal(backend.bodyWrites, 1);
      assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.seq, 6);

      page.visibilityState = "visible";
      store.apply(session("ready", 7));
      mock.timers.tick(THREAD_CACHE_SAVE_INTERVAL_MS);
      await settled();
      assert.equal(backend.bodyWrites, 2, "written once the turn settled");
      assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.seq, 7);
      link.close();
      assert.equal(listeners.size, 0, "the page's listeners go with the generation");
    } finally {
      delete globals.window;
      delete globals.document;
    }
  });

  it("never writes the device's own copy before the host confirmed it, even reconnecting", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    const copy = synchronizedState(5);
    const unconfirmed = patchSlice(
      { ...copy.reducer, fold: { ...copy.reducer.fold } },
      { connection: "reconnecting", fromDeviceCache: true }
    );
    store.set({ reducer: unconfirmed, slice: unconfirmed.slice });
    mock.timers.tick(60_000);
    link.close();
    await settled();
    assert.equal(backend.bodyWrites, 0);
  });

  it("refuses a write once another tab cleared the scope", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(synchronizedState(5));
    // Another tab's sign-out: only its durable record is shared.
    for (const key of [...local.keys()]) local.delete(key);
    local.set(`orquester:agent-chat-device-cache-cleared:${SCOPE_A}`, "other-tab");
    link.close();
    await settled();
    assert.equal(backend.bodyWrites, 0);
  });

  it("does not rewrite the copy it was painted from", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    await save(transportFor("https://a.example"), synchronizedState(5));
    const writes = backend.bodyWrites;
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: true })!;
    const record = await link.restored;
    assert.equal(record?.seq, 5);
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(synchronizedState(5));
    mock.timers.tick(60_000);
    link.close();
    await settled();
    assert.equal(backend.bodyWrites, writes);
  });

  it("drops the entry when the host says the thread is gone, or it is deleted", async () => {
    for (const ending of ["gone", "deleted"] as const) {
      await save(transportFor("https://a.example"), synchronizedState(5));
      assert.equal(backend.metas.size, 1);
      const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: true })!;
      await link.restored;
      const store = fakeStore(synchronizedState(5));
      link.watch(store);
      const current = store.getState().reducer;
      const next =
        ending === "gone"
          ? patchSlice(current, { connection: "gone" })
          : { ...current, fold: { ...current.fold, deleted: true } };
      store.set({ reducer: next, slice: next.slice });
      link.close();
      await settled();
      assert.equal(backend.metas.size, 0, ending);
      assert.equal(backend.bodies.size, 0, ending);
    }
  });

  it("does not keep a thread larger than the per-entry bound", async () => {
    await save(transportFor("https://a.example"), synchronizedState(5));
    const huge = "x".repeat(THREAD_CACHE_MAX_ENTRY_CHARS);
    await save(transportFor("https://a.example"), synchronizedState(6, "host-1", ["hello", huge]));
    assert.equal(backend.metas.size, 0, "the older, smaller copy goes too: it is stale");
  });
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("loading", () => {
  it("answers none after the bound when storage does not answer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let answerRead: (value: { meta: unknown; body: unknown }) => void = () => {};
    const hanging = memoryBackend();
    setThreadCacheBackend({ ...hanging, read: () => new Promise((resolve) => { answerRead = resolve; }) });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: true })!;
    let answer: unknown = "pending";
    void link.restored!.then((value) => { answer = value; });
    mock.timers.tick(THREAD_CACHE_LOAD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(answer, "pending");
    mock.timers.tick(1);
    await flush();
    assert.equal(answer, null);
    // The next thread does not wait on storage that is still not answering…
    assert.equal(linkThreadCache(transportFor("https://a.example"), "s2", { load: true })!.restored, null);
    // … until it answers again.
    answerRead({ meta: undefined, body: undefined });
    await flush();
    assert.notEqual(linkThreadCache(transportFor("https://a.example"), "s3", { load: true })!.restored, null);
  });

  it("answers none when storage fails", async () => {
    setThreadCacheBackend({ ...memoryBackend(), read: async () => { throw new Error("quota"); } });
    const warn = mock.method(console, "warn", () => {});
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
    warn.mock.restore();
  });

  it("never touches a newer save back to the meta it read", async () => {
    mock.timers.enable({ apis: ["Date"], now: 5_000 });
    await save(transportFor("https://a.example"), synchronizedState(5));
    mock.timers.tick(1_000);
    // A newer save, stuck in the write queue for now…
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = true;
    setThreadCacheBackend({
      ...backend,
      readMetas: async () => {
        if (gated) {
          gated = false;
          await gate;
        }
        return backend.readMetas();
      }
    });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(synchronizedState(6));
    link.close();
    // … and a read of the older copy, whose touch queues behind it.
    assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.seq, 5);
    release();
    await settled();
    setThreadCacheBackend(backend);
    assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.seq, 6, "the newer copy still validates");
  });

  it("touches what it reads, so it is the last to be evicted", async () => {
    mock.timers.enable({ apis: ["Date"], now: 5_000 });
    await save(transportFor("https://a.example"), synchronizedState(5));
    mock.timers.tick(10_000);
    await loadPersistedThread(SCOPE_A, "s1");
    await settled();
    const stored = backend.metas.get(threadCacheKey(SCOPE_A, "s1")) as ThreadCacheMeta;
    assert.equal(stored.usedAt, 15_000);
    assert.equal(stored.savedAt, 5_000);
  });
});

// ---------------------------------------------------------------------------
// The IndexedDB adapter
// ---------------------------------------------------------------------------

/** Just enough of IndexedDB for the adapter: async requests, transactions that complete. */
function fakeIndexedDb(): IDBFactory {
  const databases = new Map<string, { version: number; stores: Map<string, Map<string, unknown>> }>();
  const request = <T>(run: () => T) => {
    const handle: { result?: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      error: null,
      onsuccess: null,
      onerror: null
    };
    queueMicrotask(() => {
      handle.result = run();
      handle.onsuccess?.();
    });
    return handle;
  };
  const open = (name: string, version: number) => {
    const handle: Record<string, unknown> & { result?: unknown } = {};
    setImmediate(() => {
      let db = databases.get(name);
      const upgrade = db === undefined || db.version < version;
      db ??= { version, stores: new Map() };
      databases.set(name, db);
      const stores = db.stores;
      handle.result = {
        objectStoreNames: { contains: (store: string) => stores.has(store) },
        createObjectStore: (store: string) => void stores.set(store, new Map()),
        close: () => {},
        transaction: (names: string | string[]) => {
          const transaction: Record<string, unknown> = {
            objectStore: (store: string) => {
              assert.ok(([] as string[]).concat(names).includes(store), `${store} is in the transaction`);
              const rows = stores.get(store)!;
              return {
                get: (key: string) => request(() => structuredClone(rows.get(key))),
                getAll: () => request(() => [...rows.values()].map((row) => structuredClone(row))),
                getAllKeys: () => request(() => [...rows.keys()]),
                put: (value: { key: string }) => request(() => void rows.set(value.key, structuredClone(value))),
                delete: (key: string) => request(() => void rows.delete(key))
              };
            }
          };
          setImmediate(() => (transaction.oncomplete as (() => void) | undefined)?.());
          return transaction;
        }
      };
      if (upgrade) (handle.onupgradeneeded as (() => void) | undefined)?.();
      (handle.onsuccess as (() => void) | undefined)?.();
    });
    return handle;
  };
  return { open } as unknown as IDBFactory;
}

describe("the IndexedDB adapter", () => {
  it("is absent without IndexedDB", () => {
    assert.equal(indexedDbThreadCacheBackend(undefined), null);
  });

  it("reads back what it wrote, both halves, and removes both", async () => {
    const idb = indexedDbThreadCacheBackend(fakeIndexedDb())!;
    setThreadCacheBackend(idb);
    await save(transportFor("https://a.example"), synchronizedState(5));
    const record = await loadPersistedThread(SCOPE_A, "s1");
    assert.equal(record?.seq, 5);
    assert.deepEqual(await idb.readKeys(), [threadCacheKey(SCOPE_A, "s1")]);
    assert.equal((await idb.readMetas()).length, 1);
    await clearThreadCache();
    await settled();
    assert.deepEqual(await idb.readKeys(), []);
    assert.deepEqual(await idb.read(threadCacheKey(SCOPE_A, "s1")), { meta: undefined, body: undefined });
  });

  it("answers none where opening the database throws (a private mode)", async () => {
    const refusing = { open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory;
    setThreadCacheBackend(indexedDbThreadCacheBackend(refusing));
    const warn = mock.method(console, "warn", () => {});
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
    warn.mock.restore();
  });
});

// ---------------------------------------------------------------------------
// On-demand agent rows
// ---------------------------------------------------------------------------

describe("on-demand agent rows", () => {
  /** A synchronized thread whose snapshot left agent `a`'s rows out. */
  function partialState(seq: number): PersistableThreadState {
    let reducer = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: {
        ...threadSnapshot(seq),
        omittedAgentIds: ["a", "b"],
        // A bounded snapshot's too: the device keeps its cut beside what it lacks.
        history: { indexed: true, hasOlder: true, beforeCursor: "c1", oldestRetainedOrdinal: 4, totalTurns: 9, windowCut: "c1" }
      }
    });
    reducer = applyFrame(reducer, { kind: "synchronized", hostInstanceId: "host-1", streamId: "s-1" });
    return { reducer, slice: reducer.slice };
  }

  it("a partial copy is saved as its own version with whose rows it lacks, and restored with them", async () => {
    const state = partialState(5);
    await save(transportFor("https://a.example"), state);
    const key = threadCacheKey(SCOPE_A, "s1");
    assert.equal((backend.metas.get(key) as ThreadCacheMeta).v, THREAD_CACHE_PARTIAL_VERSION);
    const record = await loadPersistedThread(SCOPE_A, "s1");
    assert.ok(record);
    assert.deepEqual(record.snapshot.omittedAgentIds, ["a", "b"]);
    assert.equal(record.snapshot.history?.windowCut, "c1", "and the bounded snapshot's cut with them");
    assert.deepEqual(record.snapshot, persistableSnapshotOf(state));
    const refolded = applyFrame(createReducerState("s1"), { kind: "snapshot", thread: record.snapshot });
    assert.deepEqual(refolded.slice.omittedAgentIds, ["a", "b"], "a restored copy knows what it lacks");
    assert.equal(refolded.slice.history.bounds?.windowCut, "c1");
    // A whole copy is still the format every bundle reads.
    await save(transportFor("https://a.example"), synchronizedState(6));
    assert.equal((backend.metas.get(key) as ThreadCacheMeta).v, THREAD_CACHE_VERSION);
    assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.snapshot.omittedAgentIds, undefined);
  });

  it("a record whose version and omitted list disagree is not read", async () => {
    const key = threadCacheKey(SCOPE_A, "s1");
    // Written partial, claimed whole: a bundle from before would paint it as whole.
    await save(transportFor("https://a.example"), partialState(5));
    for (const half of [backend.metas, backend.bodies]) {
      half.set(key, { ...(half.get(key) as object), v: THREAD_CACHE_VERSION });
    }
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
    await settled();
    // Written whole, claimed partial.
    await save(transportFor("https://a.example"), synchronizedState(5));
    for (const half of [backend.metas, backend.bodies]) {
      half.set(key, { ...(half.get(key) as object), v: THREAD_CACHE_PARTIAL_VERSION });
    }
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
  });

  it("rewrites the copy when an agent's rows load, though its cursor did not move", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(partialState(5));
    mock.timers.tick(THREAD_CACHE_FIRST_SAVE_DELAY_MS);
    await settled();
    const writes = backend.bodyWrites;
    assert.ok(writes >= 1);
    store.apply({ kind: "agent-rows", seq: 5, agentIds: ["a"], items: [], after: [] });
    mock.timers.tick(THREAD_CACHE_SAVE_INTERVAL_MS);
    await settled();
    link.close();
    await settled();
    assert.ok(backend.bodyWrites > writes, "written again");
    assert.deepEqual((await loadPersistedThread(SCOPE_A, "s1"))?.snapshot.omittedAgentIds, ["b"]);
  });
});
