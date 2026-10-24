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

import type { ThreadCacheBackend } from "./persistent-cache";
import type { AgentChatThreadState, ThreadStore } from "./store";
import type { AgentChatStreamOptions, AgentChatTransport } from "./transport";
import { activity, ev, resetBuilders } from "./test-helpers";

type Page = ReturnType<typeof isolatedPage>;
type Destroyable = ThreadStore & { destroy?: () => void };

const pages: Page[] = [];
function newPage(): Page {
  const page = isolatedPage();
  pages.push(page);
  return page;
}

afterEach(() => {
  for (const page of pages.splice(0)) page.dispose();
});

// ---------------------------------------------------------------------------
// The device and the host
// ---------------------------------------------------------------------------

function memoryBackend(): ThreadCacheBackend & { metas: Map<string, Record<string, unknown>> } {
  const metas = new Map<string, Record<string, unknown>>();
  const bodies = new Map<string, unknown>();
  return {
    metas,
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
        metas.set(meta.key, structuredClone(meta) as unknown as Record<string, unknown>);
        if (body !== undefined) bodies.set(body.key, structuredClone(body));
      }
    }
  };
}

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
async function openPage(log: DomainEvent[], backend: ThreadCacheBackend | null) {
  const page = newPage();
  const cache = page.persistentCache;
  cache.setThreadCacheBackend(backend);
  const host = fakeHost(log);
  cache.bindThreadCacheScope(host.transport, { kind: "remote", endpoint: "https://daemon.example" });
  const store = page.store.createThreadStore("s1", { transport: host.transport }) as Destroyable;
  return { page, cache, host, store, state: (): AgentChatThreadState => store.getState() };
}

const texts = (state: AgentChatThreadState): string[] =>
  state.rows.flatMap((row) => (row.kind === "message" ? [row.message.text] : []));

/** Everything a thread's view reads that the host decides, for comparing two loads. */
function hostDecided(state: AgentChatThreadState) {
  const { slice } = state;
  return {
    head: slice.head,
    entries: slice.entries,
    turns: slice.turns,
    checkpoints: slice.checkpoints,
    pending: slice.pending,
    roster: slice.roster,
    seq: slice.seq,
    turnStatus: slice.turnStatus,
    sessionStatus: slice.sessionStatus,
    goal: slice.goal,
    connection: slice.connection,
    rows: state.rows.map((row) => row.id)
  };
}

/** A first page that synchronized at `seq` and was then killed: what it left on the device. */
async function leaveDeviceCopy(log: DomainEvent[], backend: ThreadCacheBackend, seq: number): Promise<void> {
  const first = await openPage(log, backend);
  await settle();
  assert.deepEqual(first.host.opened, [{}], "nothing on the device yet: a cold stream");
  first.host.push({ kind: "snapshot", thread: snapshotAt(log, seq) }, { kind: "synchronized", hostInstanceId: "host-1" });
  // A killed page gets no teardown; its last write came from the throttle or
  // from `pagehide`. The generation's own flush on teardown stands in for both.
  first.store.destroy?.();
  await first.cache.threadCacheIdle();
  await settle();
}

beforeEach(() => {
  resetBuilders();
});

// ---------------------------------------------------------------------------

describe("a thread opened with a copy on the device", () => {
  it("paints the copy before any frame, resumes with after=<seq>, and converges on the cold load", async () => {
    const log = hostLog();
    const backend = memoryBackend();
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

    // Exactly what a cold load of the same thread shows.
    const cold = await openPage(log, null);
    await settle();
    assert.deepEqual(cold.host.opened, [{}]);
    cold.host.push({ kind: "snapshot", thread: snapshotAt(log, 8) }, { kind: "synchronized", hostInstanceId: "host-1" });
    assert.deepEqual(hostDecided(reopened.state()), hostDecided(cold.state()));
    assert.deepEqual(texts(reopened.state()), texts(cold.state()));
    assert.equal(texts(reopened.state()).at(-1), "Fixed it.");

    // The device copy moves forward with the thread.
    reopened.store.destroy?.();
    cold.store.destroy?.();
    await reopened.cache.threadCacheIdle();
    const saved = await reopened.cache.loadPersistedThread(
      reopened.cache.threadCacheScopeFor({ kind: "remote", endpoint: "https://daemon.example" }),
      "s1"
    );
    assert.equal(saved?.seq, 8);
  });

  it("offers nothing pending from the copy until the host confirms the thread", async () => {
    const log = hostLog();
    const backend = memoryBackend();
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
    const backend = memoryBackend();
    await leaveDeviceCopy(log, backend, 5);

    const reopened = await openPage(log, backend);
    await settle();
    reopened.host.push({ kind: "synchronized", hostInstanceId: "host-1" });
    await reopened.state().actions.respondApproval({ requestId: "r1", decision: "accept" });
    assert.deepEqual(reopened.host.commands.map((command) => command.name), ["approval"]);
    reopened.store.destroy?.();
  });

  it("re-reads the thread when the host restarted, and replaces the device copy", async () => {
    const log = hostLog();
    const backend = memoryBackend();
    await leaveDeviceCopy(log, backend, 5);

    const reopened = await openPage(log, backend);
    await settle();
    assert.deepEqual(reopened.host.opened, [{ after: 5, hostInstanceId: "host-1" }]);
    // The new host replays, but under another instance: resync, not resume.
    reopened.host.push(...eventFrames(log, 5), { kind: "synchronized", hostInstanceId: "host-2" });
    await settle();
    assert.equal(reopened.host.reads, 1, "a full snapshot was read");
    assert.equal(reopened.state().slice.connection, "synchronized", "and the thread is live again");
    assert.equal(reopened.state().slice.fromDeviceCache, false);
    assert.equal(reopened.state().slice.seq, 8);

    reopened.store.destroy?.();
    await reopened.cache.threadCacheIdle();
    const scope = reopened.cache.threadCacheScopeFor({ kind: "remote", endpoint: "https://daemon.example" });
    const saved = await reopened.cache.loadPersistedThread(scope, "s1");
    assert.equal(saved?.hostInstanceId, "host-2");
    assert.equal(saved?.seq, 8);
  });

  it("drops the copy of a thread the host no longer has", async () => {
    const log = hostLog();
    const backend = memoryBackend();
    await leaveDeviceCopy(log, backend, 5);
    assert.equal(backend.metas.size, 1);

    const reopened = await openPage(log, backend);
    await settle();
    reopened.host.gone();
    assert.equal(reopened.state().slice.connection, "gone");
    await reopened.cache.threadCacheIdle();
    assert.equal(backend.metas.size, 0);
    reopened.store.destroy?.();
    await reopened.cache.threadCacheIdle();
    assert.equal(backend.metas.size, 0, "and the teardown does not write it back");
  });

  it("ignores a copy another app version wrote, and loads cold", async () => {
    const log = hostLog();
    const backend = memoryBackend();
    await leaveDeviceCopy(log, backend, 5);
    for (const meta of backend.metas.values()) meta.v = 999;

    const reopened = await openPage(log, backend);
    await settle();
    assert.deepEqual(reopened.host.opened, [{}]);
    assert.equal(reopened.state().rows.length, 0);
    assert.equal(reopened.state().slice.fromDeviceCache, undefined);
    assert.equal(backend.metas.size, 0, "deleted, never trusted");
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
    const backend = memoryBackend();
    await leaveDeviceCopy(log, backend, 5);
    const page = newPage();
    page.persistentCache.setThreadCacheBackend(backend);
    await page.persistentCache.clearThreadCache(
      page.persistentCache.threadCacheScopeFor({ kind: "remote", endpoint: "https://daemon.example/" })
    );
    assert.equal(backend.metas.size, 0);
  });
});
