/**
 * The device cache of chat threads (`persistent-cache.ts`): records, their
 * validation and versions, eviction, the write cadence, connection isolation
 * and the IndexedDB adapter. The store's use of it is `store.device-cache.test.ts`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { FOLD_SNAPSHOT_VERSION, type AgentChatStreamFrame } from "@orquester/api/agent-chat";

import type { PersistableThreadState } from "./persistent-cache";
import { isolatedPage } from "./testing/isolated-page";
import { fakeIndexedDb } from "./testing/indexed-db";

let page: ReturnType<typeof isolatedPage>;
let cache: typeof import("./persistent-cache");
let bindThreadCacheScope: typeof cache.bindThreadCacheScope;
let clearThreadCache: typeof cache.clearThreadCache;
let linkThreadCache: typeof cache.linkThreadCache;
let threadCacheScopeFor: typeof cache.threadCacheScopeFor;
const SCOPE_A = "remote|https://a.example";
const SCOPE_B = "remote|https://b.example";
const threadCacheKey = (scope: string, id: string) => `${scope}\u0000${id}`;
async function loadPersistedThread(scope: string, id: string) {
  const endpoint = new Map([[SCOPE_A, "https://a.example"], [SCOPE_B, "https://b.example"]]).get(scope)!;
  const link = linkThreadCache(transportFor(endpoint), id, { load: true });
  try { return await link?.restored ?? null; }
  finally { link?.close(); }
}
import { applyFrame, createReducerState, patchSlice } from "./reducer.logic";
import { head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const settled = (): Promise<void> => backend.idle();


function transportFor(endpoint: string): object {
  const transport = {};
  bindThreadCacheScope(transport, { kind: "remote", endpoint });
  return transport;
}

let backend: ReturnType<typeof fakeIndexedDb>;
/** The page's `localStorage`: where clears are recorded. */
const local = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => void local.set(key, value),
  removeItem: (key: string) => void local.delete(key)
};

function useStorage(factory: IDBFactory | undefined): void {
  page?.dispose();
  if (factory === undefined) Reflect.deleteProperty(globalThis, "indexedDB");
  else globalThis.indexedDB = factory;
  page = isolatedPage();
  cache = page.persistentCache;
  ({ bindThreadCacheScope, clearThreadCache, linkThreadCache, threadCacheScopeFor } = cache);
}

beforeEach(() => {
  resetBuilders();
  local.clear();
  backend = fakeIndexedDb();
  useStorage(backend.factory);
});

afterEach(async () => {
  await clearThreadCache();
  await settled();
  page.dispose();
  Reflect.deleteProperty(globalThis, "indexedDB");
  mock.timers.reset();
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
    assert.notEqual(
      threadCacheScopeFor({ kind: "local", endpoint: "https://a.example" }),
      SCOPE_A
    );
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
    useStorage(undefined);
    assert.equal(linkThreadCache(transportFor("https://a.example"), "s1", { load: true }), null);
  });
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

describe("records", () => {

  it("ignores and deletes a record of another format or fold version", async () => {
    const key = threadCacheKey(SCOPE_A, "s1");
    for (const change of [{ v: 99 }, { fold: -1 }]) {
      await save(transportFor("https://a.example"), synchronizedState(5));
      await backend.put("thread-meta", { ...(await backend.read("thread-meta", key)), ...change });
      assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null, JSON.stringify(change));
      await settled();
      assert.equal(((await backend.read("thread-meta", key)) !== undefined), false, "deleted, not kept around");
      assert.equal(((await backend.read("thread-body", key)) !== undefined), false);
    }
  });

  it("ignores and deletes a record whose halves do not validate", async () => {
    const key = threadCacheKey(SCOPE_A, "s1");
    const corruptions: Array<[string, (meta: Record<string, unknown>, body: Record<string, unknown>) => void]> = [
      ["meta for another session", (meta) => { meta.sessionId = "s2"; }],
      ["no host instance", (meta) => { meta.hostInstanceId = ""; }],
      ["body at another seq", (_meta, body) => { body.seq = 4; }],
      ["headless", (meta, body) => {
        const value = JSON.parse(body.json as string);
        value.head = null;
        body.json = JSON.stringify(value);
        meta.chars = (body.json as string).length;
      }],
      ["malformed pending approval", (meta, body) => {
        const value = JSON.parse(body.json as string);
        value.pending = { approvals: [{}] };
        body.json = JSON.stringify(value);
        meta.chars = (body.json as string).length;
      }],
      ["body not JSON", (meta, body) => { body.json = "{"; meta.chars = 1; }],
      ["length disagrees", (meta) => { meta.chars = 3; }],
      ["a snapshot of another thread", (meta, body) => {
        body.json = (body.json as string).replaceAll("\"s1\"", "\"s2\"");
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
      const meta = (await backend.read("thread-meta", key)) as Record<string, unknown>;
      const body = (await backend.read("thread-body", key)) as Record<string, unknown>;
      corrupt(meta, body);
      await backend.put("thread-meta", meta);
      if (body.missing === true) await backend.remove("thread-body", key);
      else await backend.put("thread-body", body);
      assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null, name);
      await settled();
      assert.equal(((await backend.read("thread-meta", key)) !== undefined), false, `${name}: deleted`);
    }
  });

  it("saves the window only, with a cursor-less bound once the window has evicted", async () => {
    // A bounded snapshot's: its cut outlives the cursor an eviction makes stale.
    const bounds = { indexed: true, hasOlder: false, beforeCursor: "c1", oldestRetainedOrdinal: 1, totalTurns: 3, windowCut: "c1" };
    const base = synchronizedState(5);
    const withBounds = patchSlice(base.reducer, { history: { ...base.slice.history, bounds } });
    await save(transportFor("https://a.example"), { reducer: withBounds, slice: withBounds.slice });
    assert.deepEqual((await loadPersistedThread(SCOPE_A, "s1"))?.snapshot.history, bounds);
    const evicted = patchSlice(withBounds, {
      history: {
        ...withBounds.slice.history,
        windowEvicted: true,
        pages: [{ items: [message("user", "older")], turns: [], beforeCursor: null } as never]
      }
    });
    await save(transportFor("https://a.example"), { reducer: evicted, slice: evicted.slice });
    const saved = (await loadPersistedThread(SCOPE_A, "s1"))!.snapshot;
    assert.deepEqual(saved.history, { ...bounds, hasOlder: true, beforeCursor: null, oldestRetainedOrdinal: null });
    assert.equal(saved.history?.windowCut, "c1", "the cut is kept with the window it describes");
    assert.ok(!JSON.stringify(saved).includes("older"), "a loaded page is never saved");
  });

});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

function meta(id: string, usedAt: number, chars = 10) {
  return { key: threadCacheKey(SCOPE_A, id), v: 1, fold: FOLD_SNAPSHOT_VERSION, scope: SCOPE_A, sessionId: id,
    seq: 1, hostInstanceId: "h", cleared: "0.0", savedAt: usedAt, usedAt, chars };
}

describe("eviction", () => {
  it("evicts through a save", async () => {
    for (let index = 0; index < 20; index += 1) {
      await backend.put("thread-meta", meta(`t${index}`, index));
      await backend.put("thread-body", { key: threadCacheKey(SCOPE_A, `t${index}`) });
    }
    await save(transportFor("https://a.example"), synchronizedState(5));
    assert.equal((await backend.all("thread-meta")).length, 20);
    assert.equal(await backend.read("thread-meta", threadCacheKey(SCOPE_A, "t0")), undefined);
    assert.equal(await backend.read("thread-body", threadCacheKey(SCOPE_A, "t0")), undefined);
    assert.ok(await backend.read("thread-meta", threadCacheKey(SCOPE_A, "s1")));
    await save(transportFor("https://a.example"), synchronizedState(6));
    assert.equal((await backend.all("thread-meta")).length, 20, "replacing a copy evicts nothing else");
  });

  it("keeps the total under the size bound, newest first", async () => {
    await backend.put("thread-meta", meta("older", 1, 8 * 1024 * 1024));
    await backend.put("thread-meta", meta("newer", 2, 8 * 1024 * 1024));
    await backend.put("thread-meta", { key: "junk", v: 99 });
    await save(transportFor("https://a.example"), synchronizedState(5));
    assert.deepEqual((await backend.all("thread-meta")).map((row) => row.key).sort(), [threadCacheKey(SCOPE_A, "newer"), threadCacheKey(SCOPE_A, "s1")].sort());
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
    mock.timers.tick(500 - 1);
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
    let previous = 1_000_000 + 500;
    for (const at of writesAt) {
      assert.ok(at - previous >= 10_000, `a write ${at - previous} ms after the last`);
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
    mock.timers.tick(500);
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
    mock.timers.tick(500);
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
    mock.timers.tick(10_000);
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
    assert.equal((await backend.all("thread-meta")).length, 0);
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
      mock.timers.tick(10_000);
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
      assert.equal((await backend.all("thread-meta")).length, 1);
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
      assert.equal((await backend.all("thread-meta")).length, 0, ending);
      assert.equal((await backend.all("thread-body")).length, 0, ending);
    }
  });

  it("does not keep a thread larger than the per-entry bound", async () => {
    await save(transportFor("https://a.example"), synchronizedState(5));
    const huge = "x".repeat((8 * 1024 * 1024));
    await save(transportFor("https://a.example"), synchronizedState(6, "host-1", ["hello", huge]));
    assert.equal((await backend.all("thread-meta")).length, 0, "the older, smaller copy goes too: it is stale");
  });
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("loading", () => {
  it("answers none after the bound when storage does not answer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let answerRead!: () => void;
    const gate = new Promise<void>((resolve) => { answerRead = resolve; });
    backend.beforeRead = (_store, operation) => operation === "get" ? gate : undefined;
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: true })!;
    let answer: unknown = "pending";
    void link.restored!.then((value) => { answer = value; });
    mock.timers.tick(750 - 1);
    await flush();
    assert.equal(answer, "pending");
    mock.timers.tick(1);
    await flush();
    assert.equal(answer, null);
    // The next thread does not wait on storage that is still not answering…
    assert.equal(linkThreadCache(transportFor("https://a.example"), "s2", { load: true })!.restored, null);
    // … until it answers again.
    backend.beforeRead = undefined;
    answerRead();
    await flush();
    assert.notEqual(linkThreadCache(transportFor("https://a.example"), "s3", { load: true })!.restored, null);
  });

  it("answers none when storage fails", async () => {
    backend.beforeRead = () => { throw new Error("quota"); };
    const warn = mock.method(console, "warn", () => {});
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
    useStorage({ open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory);
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null, "private-mode opening refusal is also optional storage");
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
    backend.beforeRead = async (_store, operation) => {
      if (gated && operation === "getAll") {
        gated = false;
        await gate;
      }
    };
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(synchronizedState(6));
    link.close();
    // … and a read of the older copy, whose touch queues behind it.
    assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.seq, 5);
    release();
    await settled();
    backend.beforeRead = undefined;
    assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.seq, 6, "the newer copy still validates");
  });

  it("touches what it reads, so it is the last to be evicted", async () => {
    mock.timers.enable({ apis: ["Date"], now: 5_000 });
    await save(transportFor("https://a.example"), synchronizedState(5));
    mock.timers.tick(10_000);
    await loadPersistedThread(SCOPE_A, "s1");
    await settled();
    const stored = (await backend.read("thread-meta", threadCacheKey(SCOPE_A, "s1")))!;
    assert.equal(stored.usedAt, 15_000);
    assert.equal(stored.savedAt, 5_000);
  });
});

// ---------------------------------------------------------------------------
// The IndexedDB adapter
// ---------------------------------------------------------------------------

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
    assert.equal((await backend.read("thread-meta", key))!.v, 2);
    const record = await loadPersistedThread(SCOPE_A, "s1");
    assert.ok(record);
    assert.deepEqual(record.snapshot.omittedAgentIds, ["a", "b"]);
    assert.equal(record.snapshot.history?.windowCut, "c1", "and the bounded snapshot's cut with them");
    const refolded = applyFrame(createReducerState("s1"), { kind: "snapshot", thread: record.snapshot });
    assert.deepEqual(refolded.slice.omittedAgentIds, ["a", "b"], "a restored copy knows what it lacks");
    assert.equal(refolded.slice.history.bounds?.windowCut, "c1");
    // A whole copy is still the format every bundle reads.
    await save(transportFor("https://a.example"), synchronizedState(6));
    assert.equal((await backend.read("thread-meta", key))!.v, 1);
    assert.equal((await loadPersistedThread(SCOPE_A, "s1"))?.snapshot.omittedAgentIds, undefined);
  });

  it("a record whose version and omitted list disagree is not read", async () => {
    const key = threadCacheKey(SCOPE_A, "s1");
    // Written partial, claimed whole: a bundle from before would paint it as whole.
    await save(transportFor("https://a.example"), partialState(5));
    for (const store of ["thread-meta", "thread-body"]) {
      await backend.put(store, { ...(await backend.read(store, key)), v: 1 });
    }
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
    await settled();
    // Written whole, claimed partial.
    await save(transportFor("https://a.example"), synchronizedState(5));
    for (const store of ["thread-meta", "thread-body"]) {
      await backend.put(store, { ...(await backend.read(store, key)), v: 2 });
    }
    assert.equal(await loadPersistedThread(SCOPE_A, "s1"), null);
  });

  it("rewrites the copy when an agent's rows load, though its cursor did not move", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const link = linkThreadCache(transportFor("https://a.example"), "s1", { load: false })!;
    const store = fakeStore(EMPTY);
    link.watch(store);
    store.set(partialState(5));
    mock.timers.tick(500);
    await settled();
    const writes = backend.bodyWrites;
    assert.ok(writes >= 1);
    store.apply({ kind: "agent-rows", seq: 5, agentIds: ["a"], items: [], after: [] });
    mock.timers.tick(10_000);
    await settled();
    link.close();
    await settled();
    assert.ok(backend.bodyWrites > writes, "written again");
    assert.deepEqual((await loadPersistedThread(SCOPE_A, "s1"))?.snapshot.omittedAgentIds, ["b"]);
  });
});
