import { isolatedPage } from "./testing/isolated-page";
/**
 * The thread store over the device cache (`persistent-cache.ts`): a thread
 * opened after a reload — or a PWA the OS killed — paints its saved copy
 * before any frame and resumes from the saved cursor, and ends up exactly
 * where a cold load would.
 *
 * A reload is simulated in-process (`isolatedPage`): every module-level
 * memory of the page is dropped — the in-memory retention included — and only
 * the device storage, a backend shared by every page here, stays.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  foldThread,
  toThreadSnapshot,
  type AgentChatCommandName,
  type AgentChatStreamFrame,
  type DomainEvent,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { threadCacheScopeFor } from "./persistent-cache";
import { fakeIndexedDb } from "./testing/indexed-db";
import type { AgentChatThreadState, ThreadStore } from "./store";
import type { AgentChatStreamOptions, AgentChatTransport } from "./transport";
import { activity, ev, resetBuilders } from "./test-helpers";

type Page = ReturnType<typeof isolatedPage>;
type Destroyable = ThreadStore & { destroy?: () => void };

/** The tab's `localStorage`, which survives a reload: where clears are recorded. */
const local = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => void local.set(key, value),
  removeItem: (key: string) => void local.delete(key)
};

const pages: Page[] = [];
function newPage(storage?: ReturnType<typeof fakeIndexedDb> | null): Page {
  if (storage === null) Reflect.deleteProperty(globalThis, "indexedDB");
  else if (storage !== undefined) globalThis.indexedDB = storage.factory;
  const page = isolatedPage();
  pages.push(page);
  return page;
}

afterEach(() => {
  for (const page of pages.splice(0)) page.dispose();
  Reflect.deleteProperty(globalThis, "indexedDB");
});

// ---------------------------------------------------------------------------
// The device and the host
// ---------------------------------------------------------------------------

/** The thread's log, as the host holds it. */
function hostLog(): DomainEvent[] {
  return [
    ev("thread.created", {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "Fix the build",
      adapter: "claude",
      refId: "claude",
      accountId: "acc-1",
      home: "account",
      modelSelection: { model: "sonnet" },
      runtimeMode: "approval-required"
    }),
    ev("thread.message-sent", { messageId: "u1", role: "user", text: "fix the build", streaming: false, turnId: null }),
    ev("thread.session-set", { session: { status: "running", activeTurnId: "t1" } }),
    ev("thread.message-sent", { messageId: "a1", role: "assistant", text: "Looking.", streaming: false, turnId: "t1" }),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", { requestId: "r1", requestType: "command_execution_approval" }, {
        tone: "approval",
        turnId: "t1"
      })
    }),
    // Saved here (seq 5): the approval is pending in the device copy.
    ev("thread.activity-appended", {
      activity: activity("approval.resolved", { requestId: "r1", decision: "accept" }, { turnId: "t1" })
    }),
    ev("thread.message-sent", { messageId: "a2", role: "assistant", text: "Fixed it.", streaming: false, turnId: "t1" }),
    ev("thread.session-set", { session: { status: "ready", activeTurnId: null } })
  ] as DomainEvent[];
}

const snapshotAt = (log: readonly DomainEvent[], seq: number): ThreadSnapshotPayload =>
  toThreadSnapshot(foldThread(log.filter((event) => event.seq <= seq)));

const eventFrames = (log: readonly DomainEvent[], after: number): AgentChatStreamFrame[] =>
  log.filter((event) => event.seq > after).map((event) => ({ kind: "event", seq: event.seq, event }));

function fakeHost(log: DomainEvent[]) {
  const opened: AgentChatStreamOptions[] = [];
  const commands: Array<{ name: AgentChatCommandName; body: unknown }> = [];
  const counters = { reads: 0 };
  let handlers: Parameters<AgentChatTransport["stream"]>[2] | null = null;
  const transport = {
    stream(_sessionId, options, next) {
      opened.push(options);
      handlers = next;
      return { lastSeq: options.after ?? 0, hostInstanceId: options.hostInstanceId ?? null, resetCursor() {}, retry() {}, close() {} };
    },
    async command(_sessionId, name, body) {
      commands.push({ name, body });
      return { seq: 1 };
    },
    async read() {
      counters.reads += 1;
      return { kind: "snapshot", thread: snapshotAt(log, log.length) };
    },
    async providers() {
      return { providers: [], hostInstanceId: "host-1" };
    }
  } as Partial<AgentChatTransport> as AgentChatTransport;
  return {
    transport,
    opened,
    commands,
    get reads() {
      return counters.reads;
    },
    push(...frames: AgentChatStreamFrame[]) {
      if (handlers?.onFrames) handlers.onFrames(frames);
      else for (const frame of frames) handlers?.onFrame(frame);
    },
    gone() {
      handlers?.onGone?.({ message: "no such thread" });
    }
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Open `s1` on a fresh page, with the device storage `backend` (or none). */
async function openPage(log: DomainEvent[], backend: ReturnType<typeof fakeIndexedDb> | null) {
  const page = newPage(backend);
  const cache = page.persistentCache;
  const host = fakeHost(log);
  cache.bindThreadCacheScope(host.transport, { kind: "remote", endpoint: "https://daemon.example" });
  const store = page.store.createThreadStore("s1", { transport: host.transport }) as Destroyable;
  return { page, cache, host, store, state: (): AgentChatThreadState => store.getState(), async saved() {
    const link = cache.linkThreadCache(host.transport, "s1", { load: true });
    try { return await link?.restored ?? null; }
    finally { link?.close(); }
  } };
}

const texts = (state: AgentChatThreadState): string[] =>
  state.rows.flatMap((row) => (row.kind === "message" ? [row.message.text] : []));

/** A first page that synchronized at `seq` and was then killed: what it left on the device. */
async function leaveDeviceCopy(log: DomainEvent[], backend: ReturnType<typeof fakeIndexedDb>, seq: number): Promise<void> {
  const first = await openPage(log, backend);
  await settle();
  assert.deepEqual(first.host.opened, [{}], "nothing on the device yet: a cold stream");
  first.host.push({ kind: "snapshot", thread: snapshotAt(log, seq) }, { kind: "synchronized", hostInstanceId: "host-1" });
  // A killed page gets no teardown; its last write came from the throttle or
  // from `pagehide`. The generation's own flush on teardown stands in for both.
  first.store.destroy?.();
  await backend.idle();
  await settle();
}

beforeEach(() => {
  resetBuilders();
  local.clear();
});

// ---------------------------------------------------------------------------

describe("a thread opened with a copy on the device", () => {
  it("paints the copy before any frame, resumes by cursor and applies the replay", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);

    const reopened = await openPage(log, backend);
    await settle();
    // Painted from the device: the rows, at the saved seq, before any frame.
    assert.deepEqual(texts(reopened.state()), ["fix the build", "Looking."]);
    assert.equal(reopened.state().slice.seq, 5);
    assert.equal(reopened.state().slice.connection, "connecting", "Connecting… until the host confirms it");
    assert.equal(reopened.state().slice.fromDeviceCache, true);
    // And the stream asks only for what happened since.
    assert.deepEqual(reopened.host.opened, [{ after: 5, hostInstanceId: "host-1" }]);
    assert.equal(reopened.host.reads, 0, "no full snapshot was fetched");

    // The host replays seq 6…8 and confirms.
    reopened.host.push(...eventFrames(log, 5), { kind: "synchronized", hostInstanceId: "host-1" });
    assert.equal(reopened.state().slice.connection, "synchronized");
    assert.equal(reopened.state().slice.fromDeviceCache, false);

    assert.deepEqual(reopened.state().slice.pending.approvals, [], "the replay resolved the cached approval");
    assert.equal(texts(reopened.state()).at(-1), "Fixed it.");

    // The device copy moves forward with the thread.
    reopened.store.destroy?.();
    await backend.idle();
    const saved = await reopened.saved();
    assert.equal(saved?.seq, 8);
  });

  it("keeps a bounded snapshot's history cursor and cut: the copy loads older from them after a reload", async () => {
    // The stream's bounded snapshot: the turns before the window are a "load older" away. Saved
    // before its window evicted — its cursor — and after (`boundsOfWindow`) — its cut alone.
    const fresh = { indexed: true, hasOlder: true, beforeCursor: "cursor-recent", oldestRetainedOrdinal: 6, totalTurns: 15, windowCut: "cursor-recent" };
    const evicted = { ...fresh, beforeCursor: null, oldestRetainedOrdinal: null };
    for (const [bounds, expected] of [
      [fresh, [{ before: "cursor-recent", windowCut: undefined }]],
      [evicted, [{ before: undefined, windowCut: "cursor-recent" }]]
    ] as const) {
      resetBuilders();
      const log = hostLog();
      const backend = fakeIndexedDb();
      const first = await openPage(log, backend);
      await settle();
      first.host.push(
        { kind: "snapshot", thread: { ...snapshotAt(log, 5), history: bounds } },
        { kind: "synchronized", hostInstanceId: "host-1" }
      );
      first.store.destroy?.();
      await backend.idle();
      await settle();

      const reopened = await openPage(log, backend);
      const asked: Array<{ before: string | undefined; windowCut: string | undefined }> = [];
      reopened.host.transport.readHistory = async (_sessionId, query) => {
        asked.push({ before: query.before, windowCut: query.windowCut });
        return { threadId: "s1", turns: [], items: [], checkpoints: [], page: { beforeCursor: null }, seq: 8 };
      };
      await settle();
      assert.deepEqual(reopened.state().slice.history.bounds, bounds, "the copy's bounds are the snapshot's");
      reopened.host.push(...eventFrames(log, 5), { kind: "synchronized", hostInstanceId: "host-1" });
      await reopened.state().actions.loadOlderHistory();
      assert.deepEqual(asked, expected, "load older asks below the bounded window, never below its cut");
      reopened.store.destroy?.();
      for (const page of pages.splice(0)) page.dispose();
    }
  });

  it("offers nothing pending from the copy until the host confirms the thread", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);

    const reopened = await openPage(log, backend);
    await settle();
    // The fold still knows the request — the replay must converge — …
    assert.deepEqual(reopened.state().slice.pending.approvals.map((request) => request.requestId), ["r1"]);
    // … but it cannot be answered: it may have been settled long since.
    await assert.rejects(
      reopened.state().actions.respondApproval({ requestId: "r1", decision: "accept" }),
      /catching up/
    );
    assert.deepEqual(reopened.host.commands, [], "nothing reached the host");

    // Confirmed, and the replay says it was answered elsewhere meanwhile.
    reopened.host.push(...eventFrames(log, 5), { kind: "synchronized", hostInstanceId: "host-1" });
    assert.deepEqual(reopened.state().slice.pending.approvals, []);
    reopened.store.destroy?.();
  });

  it("answers a request once the host has confirmed it still stands", async () => {
    const log = hostLog().slice(0, 5);
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);

    const reopened = await openPage(log, backend);
    await settle();
    reopened.host.push({ kind: "synchronized", hostInstanceId: "host-1" });
    await reopened.state().actions.respondApproval({ requestId: "r1", decision: "accept" });
    assert.deepEqual(reopened.host.commands.map((command) => command.name), ["approval"]);
    reopened.store.destroy?.();
  });

  it("re-reads the thread over a fresh stream when the host restarted, and replaces the device copy", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);

    const reopened = await openPage(log, backend);
    await settle();
    assert.deepEqual(reopened.host.opened, [{ after: 5, hostInstanceId: "host-1" }]);
    // The new host replays — and then some, while a separate re-read would
    // still be on its way — but under another instance: resync, not resume.
    reopened.host.push(...eventFrames(log, 5).slice(0, 1), { kind: "synchronized", hostInstanceId: "host-2" });
    reopened.host.push(...eventFrames(log, 6));
    await settle();
    // The re-read rides the stream: reopened without a cursor, nothing read beside it.
    assert.deepEqual(reopened.host.opened, [{ after: 5, hostInstanceId: "host-1" }, {}]);
    assert.equal(reopened.host.reads, 0);
    assert.equal(reopened.state().slice.fromDeviceCache, true, "nothing is confirmed yet");
    // Nothing of this in-between state reaches the device.
    reopened.store.destroy?.();
    await backend.idle();
    assert.equal((await reopened.saved())?.hostInstanceId, "host-1");

    const again = await openPage(log, backend);
    await settle();
    again.host.push({ kind: "synchronized", hostInstanceId: "host-2" });
    await settle();
    assert.deepEqual(again.host.opened, [{ after: 5, hostInstanceId: "host-1" }, {}]);
    // The fresh stream: the host's snapshot, then live.
    again.host.push({ kind: "snapshot", thread: snapshotAt(log, 8) }, { kind: "synchronized", hostInstanceId: "host-2" });
    assert.equal(again.state().slice.connection, "synchronized", "and the thread is live again");
    assert.equal(again.state().slice.fromDeviceCache, false);
    assert.equal(again.state().slice.seq, 8);
    again.store.destroy?.();
    await backend.idle();
    const saved = await again.saved();
    assert.equal(saved?.hostInstanceId, "host-2");
    assert.equal(saved?.seq, 8);
  });

  it("never rolls a host change back over events the stream already delivered", async () => {
    const log = hostLog();
    const cold = await openPage(log, null);
    await settle();
    cold.host.push({ kind: "snapshot", thread: snapshotAt(log, 5) }, { kind: "synchronized", hostInstanceId: "host-1" });
    // The host restarts: its stream says so, and goes on delivering.
    cold.host.push({ kind: "synchronized", hostInstanceId: "host-2" }, ...eventFrames(log, 5));
    await settle();
    assert.equal(cold.host.reads, 0, "no re-read that could land older than the stream");
    assert.deepEqual(cold.host.opened, [{}, {}]);
    cold.host.push({ kind: "snapshot", thread: snapshotAt(log, 8) }, { kind: "synchronized", hostInstanceId: "host-2" });
    assert.equal(cold.state().slice.seq, 8);
    assert.equal(cold.state().slice.connection, "synchronized");
    cold.store.destroy?.();
  });

  it("acts on nothing in the copy - rewind, Stop, a task's Stop - until the host confirms it", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);
    const reopened = await openPage(log, backend);
    await settle();
    const { actions } = reopened.state();
    await assert.rejects(actions.rewindTo({ messageId: "u1", targetTurnCount: 0 }), /catching up/);
    await assert.rejects(actions.interrupt(), /catching up/);
    await assert.rejects(actions.stopTask({ taskId: "task-1" }), /catching up/);
    assert.equal(reopened.host.commands.length, 0, "nothing reached the host");
    reopened.host.push(...eventFrames(log, 5), { kind: "synchronized", hostInstanceId: "host-1" });
    await reopened.state().actions.interrupt();
    assert.deepEqual(reopened.host.commands.map((command) => command.name), ["interrupt"]);
    reopened.store.destroy?.();
  });

  it("stops a live thread's writes for good when its daemon is signed out of", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    const live = await openPage(log, backend);
    await settle();
    live.host.push({ kind: "snapshot", thread: snapshotAt(log, 5) }, { kind: "synchronized", hostInstanceId: "host-1" });
    await live.cache.clearThreadCache(threadCacheScopeFor({ kind: "remote", endpoint: "https://daemon.example" }));
    // Frames still in flight, then the teardown's flush: none of it is written back.
    live.host.push(...eventFrames(log, 5));
    live.store.destroy?.();
    await backend.idle();
    await settle();
    assert.equal((await backend.all("thread-meta")).length, 0);
  });

  it("holds a clear another tab recorded, and a clear whose deletes never ran", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    // Another tab signs out while this one has a pending change.
    const live = await openPage(log, backend);
    await settle();
    live.host.push({ kind: "snapshot", thread: snapshotAt(log, 5) }, { kind: "synchronized", hostInstanceId: "host-1" });
    const other = newPage(fakeIndexedDb());
    await other.persistentCache.clearThreadCache(threadCacheScopeFor({ kind: "remote", endpoint: "https://daemon.example" }));
    live.store.destroy?.();
    await backend.idle();
    assert.equal((await backend.all("thread-meta")).length, 0, "refused when it would land");

    // A copy left on the device; its clear is recorded, but the deletes never ran.
    await leaveDeviceCopy(log, backend, 5);
    assert.equal((await backend.all("thread-meta")).length, 1);
    const stale = newPage(fakeIndexedDb());
    await stale.persistentCache.clearThreadCache();
    const reopened = await openPage(log, backend);
    await settle();
    assert.deepEqual(reopened.host.opened, [{}], "the cleared copy is not painted");
    assert.equal(reopened.state().rows.length, 0);
    await backend.idle();
    assert.equal((await backend.all("thread-meta")).length, 0, "and the next page deletes it");
    reopened.store.destroy?.();
  });

  it("caches nothing where clears cannot be recorded", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    const globals = globalThis as { localStorage?: unknown };
    const saved = globals.localStorage;
    delete globals.localStorage;
    try {
      const page = await openPage(log, backend);
      await settle();
      page.host.push({ kind: "snapshot", thread: snapshotAt(log, 5) }, { kind: "synchronized", hostInstanceId: "host-1" });
      page.store.destroy?.();
      await backend.idle();
      assert.equal((await backend.all("thread-meta")).length, 0);
    } finally {
      globals.localStorage = saved;
    }
  });

  it("drops the copy of a thread the host no longer has", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);
    assert.equal((await backend.all("thread-meta")).length, 1);

    const reopened = await openPage(log, backend);
    await settle();
    reopened.host.gone();
    assert.equal(reopened.state().slice.connection, "gone");
    await backend.idle();
    assert.equal((await backend.all("thread-meta")).length, 0);
    reopened.store.destroy?.();
    await backend.idle();
    assert.equal((await backend.all("thread-meta")).length, 0, "and the teardown does not write it back");
  });

  it("ignores a copy another app version wrote, and loads cold", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);
    for (const meta of await backend.all("thread-meta")) await backend.put("thread-meta", { ...meta, v: 999 });

    const reopened = await openPage(log, backend);
    await settle();
    assert.deepEqual(reopened.host.opened, [{}]);
    assert.equal(reopened.state().rows.length, 0);
    assert.equal(reopened.state().slice.fromDeviceCache, undefined);
    assert.equal((await backend.all("thread-meta")).length, 0, "deleted, never trusted");
    reopened.store.destroy?.();
  });

  it("behaves exactly as before with no device storage", async () => {
    const log = hostLog();
    const reopened = await openPage(log, null);
    await settle();
    assert.deepEqual(reopened.host.opened, [{}]);
    assert.equal(reopened.state().slice.connection, "idle");
    reopened.store.destroy?.();
  });

  it("forgets the daemon's copies on sign-out", async () => {
    const log = hostLog();
    const backend = fakeIndexedDb();
    await leaveDeviceCopy(log, backend, 5);
    const page = newPage(backend);
    await page.persistentCache.clearThreadCache(
      page.persistentCache.threadCacheScopeFor({ kind: "remote", endpoint: "https://daemon.example/" })
    );
    assert.equal((await backend.all("thread-meta")).length, 0);
  });
});
