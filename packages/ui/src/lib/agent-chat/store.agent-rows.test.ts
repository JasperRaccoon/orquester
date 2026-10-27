import { isolatedPage } from "./testing/isolated-page";
/**
 * The thread store over on-demand agent rows (`agent-rows.logic.ts`): the
 * stream opts in, the parent's view of a snapshot that left the settled
 * agents' rows out is the full one's, a drill-in — or a live event — asks for
 * an agent's rows on the live stream, and every way the host can answer
 * (the frame, a gone stream, a host from before the route, a host that names
 * no stream) leaves the drill-in correct.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  agentRowsFrameOf,
  applyDomainEvent,
  foldThread,
  omitOnDemandAgentRows,
  toThreadSnapshot,
  type AgentChatStreamFrame,
  type AgentRowsRequest,
  type DomainEvent,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import type { AgentChatThreadState, ThreadStore } from "./store";
import type { AgentChatStreamHandlers, AgentChatStreamOptions, AgentChatTransport } from "./transport";
import { agentFleetLog } from "./testing/agent-fleet";

type Page = ReturnType<typeof isolatedPage>;
type Destroyable = ThreadStore & { destroy?: () => void };

let page: Page;
beforeEach(() => {
  page = isolatedPage();
});
afterEach(() => {
  page.dispose();
});

const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

type Answer = "deliver" | "route-miss" | "stream-gone" | "hold";

/** A host over a real fold: snapshots, replays, the frame on the stream it names. */
function fakeHost() {
  const log = agentFleetLog();
  let fold: ThreadFoldState = foldThread(log);
  const streams: Array<{ options: AgentChatStreamOptions; handlers: AgentChatStreamHandlers; id: string | null; closed: boolean }> = [];
  const posts: AgentRowsRequest[] = [];
  const reads: Array<{ agentRows?: string }> = [];
  let answer: Answer = "deliver";
  let held: Array<() => void> = [];
  const current = () => streams.at(-1)!;
  const deliver = (body: AgentRowsRequest): void => {
    const open = streams.find((stream) => stream.id === body.streamId && !stream.closed);
    if (open === undefined) return;
    open.handlers.onFrames?.([agentRowsFrameOf({ items: fold.items, roster: fold.roster, seq: fold.seq, agentIds: body.agentIds })]);
  };
  const transport = {
    stream(_sessionId, streamOptions, handlers) {
      const entry = { options: streamOptions, handlers, id: null as string | null, closed: false };
      streams.push(entry);
      return {
        lastSeq: streamOptions.after ?? 0,
        hostInstanceId: streamOptions.hostInstanceId ?? null,
        resetCursor() {},
        retry() {},
        close() {
          entry.closed = true;
        }
      };
    },
    async command() {
      return { seq: 1 };
    },
    async read(_sessionId, readOptions) {
      reads.push({ ...(readOptions?.agentRows !== undefined ? { agentRows: readOptions.agentRows } : {}) });
      const thread = toThreadSnapshot(fold);
      return { kind: "snapshot", thread: readOptions?.agentRows === "on-demand" ? omitOnDemandAgentRows(thread) : thread };
    },
    async requestAgentRows(_sessionId, body) {
      posts.push(body);
      if (answer === "route-miss") {
        throw Object.assign(new Error("No route for POST /threads/s1/agent-rows."), { status: 404, code: "THREAD_NOT_FOUND" });
      }
      if (answer === "stream-gone") {
        throw Object.assign(new Error("That stream is no longer open."), { status: 404, code: "STREAM_NOT_FOUND" });
      }
      if (answer === "hold") {
        held.push(() => deliver(body));
        return { ok: true };
      }
      queueMicrotask(() => deliver(body));
      return { ok: true };
    },
    async providers() {
      return { providers: [], hostInstanceId: "host-1" };
    }
  } as Partial<AgentChatTransport> as AgentChatTransport;
  let streamCount = 0;
  return {
    transport,
    streams,
    posts,
    reads,
    get fold() {
      return fold;
    },
    answer(next: Answer) {
      answer = next;
    },
    release() {
      const run = held;
      held = [];
      for (const one of run) one();
    },
    /**
     * Answer the newest stream's (next) connection as a host does: a snapshot
     * — or a replay past its cursor — then `synchronized`, naming the
     * connection when it opted in (and `streamId` is not false).
     */
    open(openOptions: { streamId?: boolean; snapshot?: boolean } = {}) {
      const stream = current();
      const optedIn = stream.options.agentRows === "on-demand";
      streamCount += 1;
      stream.id = optedIn && openOptions.streamId !== false ? `stream-${streamCount}` : null;
      const frames: AgentChatStreamFrame[] = [];
      const after = stream.options.after;
      if (openOptions.snapshot !== true && after !== undefined && after > 0) {
        for (const event of log.filter((candidate) => candidate.seq > after)) {
          frames.push({ kind: "event", seq: event.seq, event });
        }
      } else {
        const thread = toThreadSnapshot(fold);
        frames.push({ kind: "snapshot", thread: optedIn ? omitOnDemandAgentRows(thread) : thread });
      }
      frames.push({
        kind: "synchronized",
        hostInstanceId: "host-1",
        ...(stream.id !== null ? { streamId: stream.id } : {})
      } as AgentChatStreamFrame);
      stream.handlers.onOpen?.();
      stream.handlers.onFrames?.(frames);
    },
    /** The newest stream's connection drops: the reader says so before it reconnects. */
    drop() {
      current().handlers.onReconnect?.({ attempt: 1, delayMs: 0, reason: "ended" });
    },
    /** A live event: folded here, sent on the newest stream (unless `quiet`). */
    live(event: DomainEvent, quiet = false) {
      log.push(event);
      fold = applyDomainEvent(fold, event);
      if (!quiet) current().handlers.onFrames?.([{ kind: "event", seq: event.seq, event }]);
    },
    nextEvent(type: DomainEvent["type"], payload: unknown): DomainEvent {
      const seq = log.at(-1)!.seq + 1;
      return {
        seq,
        eventId: `e${seq}`,
        threadId: "s1",
        type,
        payload,
        occurredAt: new Date(Date.UTC(2026, 3, 2) + seq * 1000).toISOString(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      } as DomainEvent;
    }
  };
}

function open(host: ReturnType<typeof fakeHost>) {
  const store = page.store.createThreadStore("s1", { transport: host.transport }) as Destroyable;
  return { store, state: (): AgentChatThreadState => store.getState() };
}

describe("on-demand agent rows — the store", () => {
  it("opts in on its stream and its reads, preserving parent messages and pending requests", async () => {
    const lazyHost = fakeHost();
    const lazy = open(lazyHost);
    await settle();
    assert.equal(lazyHost.streams[0]!.options.agentRows, "on-demand");
    lazyHost.open();
    await settle();
    assert.deepEqual(lazy.state().slice.omittedAgentIds, ["a1", "a2", "a3", "a4", "a6", "n1"]);
    assert.deepEqual(lazy.state().rows.flatMap((row) => row.kind === "message" ? [row.message.id] : []), ["u1", "p-say", "p-say-2"]);
    assert.deepEqual(lazy.state().slice.pending.approvals.map((request) => request.requestId), ["r-a6"]);
    await lazy.state().actions.refresh();
    assert.deepEqual(lazyHost.reads, [{ agentRows: "on-demand" }]);
    lazy.store.destroy?.();
  });

  it("a drill-in asks on the live stream, never before it is live, batched, and its rows land", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    host.drop();
    const releaseA1 = state().actions.wantAgentRows!("a1");
    const releaseA3 = state().actions.wantAgentRows!("a3");
    await settle();
    assert.deepEqual(host.posts, [], "nothing before the stream is live");
    host.open();
    await settle();
    assert.deepEqual(host.posts, [{ streamId: "stream-2", agentIds: ["a1", "a3"] }], "one request for both");
    assert.deepEqual(state().slice.omittedAgentIds, ["a2", "a4", "a6", "n1"]);
    const own = (agentId: string) => state().slice.entries.filter((item) => item.agentId === agentId);
    assert.deepEqual(own("a1"), host.fold.items.filter((item) => item.agentId === "a1"));
    // Wanting a loaded agent again asks for nothing.
    const again = state().actions.wantAgentRows!("a1");
    await settle();
    assert.equal(host.posts.length, 1);
    again();
    releaseA1();
    releaseA3();
    store.destroy?.();
  });

  it("a live event of an omitted agent loads it by itself", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    await settle();
    assert.deepEqual(host.posts, []);
    // a2 is relaunched: its rows arrive live.
    host.live(host.nextEvent("thread.activity-appended", {
      activity: {
        kind: "activity",
        id: "a2-relaunch-call",
        tone: "tool",
        activityKind: "tool.started",
        summary: "tool.started",
        payload: { toolUseId: "a2-new", title: "Bash" },
        turnId: "t1",
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        agentId: "a2"
      }
    }));
    await settle();
    assert.deepEqual(host.posts, [{ streamId: "stream-1", agentIds: ["a2"] }]);
    assert.equal(state().slice.omittedAgentIds?.includes("a2"), false);
    assert.deepEqual(
      state().slice.entries.filter((item) => item.agentId === "a2"),
      host.fold.items.filter((item) => item.agentId === "a2")
    );
    store.destroy?.();
  });

  it("a reconnect's new snapshot says what is omitted now, and an open drill-in asks again on the new stream", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    await settle();
    const release = state().actions.wantAgentRows!("a4");
    await settle();
    assert.equal(state().slice.omittedAgentIds?.includes("a4"), false);
    // The connection drops; the host answers the reconnect with a snapshot (no usable cursor).
    host.drop();
    host.open({ snapshot: true });
    await settle();
    assert.deepEqual(host.posts.map((post) => post.streamId), ["stream-1", "stream-2"]);
    assert.equal(state().slice.omittedAgentIds?.includes("a4"), false, "loaded again");
    release();
    store.destroy?.();
  });

  it("a resume by cursor keeps what was omitted, and asks on the resumed stream", async () => {
    const host = fakeHost();
    const first = open(host);
    await settle();
    host.open();
    await settle();
    const omitted = first.state().slice.omittedAgentIds;
    first.store.destroy?.();
    // The retained copy resumes by cursor.
    const second = open(host);
    await settle();
    const resumed = host.streams.at(-1)!;
    assert.equal(resumed.options.agentRows, "on-demand");
    assert.equal(resumed.options.after, host.fold.seq);
    assert.deepEqual(second.state().slice.omittedAgentIds, omitted, "retained with its omitted set");
    const release = second.state().actions.wantAgentRows!("a6");
    await settle();
    assert.deepEqual(host.posts, [], "the retained stream id is not this connection's");
    host.open();
    await settle();
    assert.deepEqual(host.posts, [{ streamId: "stream-2", agentIds: ["a6"] }]);
    release();
    second.store.destroy?.();
  });

  it("a gone stream is not asked again; the next one is", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    await settle();
    host.answer("stream-gone");
    const release = state().actions.wantAgentRows!("a1");
    await settle();
    await settle();
    assert.equal(host.posts.length, 1);
    assert.equal(state().slice.omittedAgentIds?.includes("a1"), true);
    host.answer("deliver");
    host.live(host.nextEvent("thread.message-sent", { messageId: "p-more", role: "assistant", text: "x", streaming: false, turnId: "t1" }));
    await settle();
    assert.equal(host.posts.length, 1, "not on the stream that answered gone");
    host.drop();
    host.open({ snapshot: true });
    await settle();
    assert.deepEqual(host.posts.map((post) => post.streamId), ["stream-1", "stream-2"]);
    assert.equal(state().slice.omittedAgentIds?.includes("a1"), false);
    release();
    store.destroy?.();
  });

  it("a host from before the route: the store reads the thread whole, without the opt-in", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    await settle();
    host.answer("route-miss");
    const release = state().actions.wantAgentRows!("a3");
    await settle();
    assert.equal(host.streams.length, 2, "reopened");
    assert.equal(host.streams[0]!.closed, true);
    const reopened = host.streams[1]!;
    assert.equal(reopened.options.agentRows, undefined, "no opt-in any more");
    assert.equal(reopened.options.after, undefined, "a snapshot, not a resume");
    host.open();
    await settle();
    assert.equal(state().slice.omittedAgentIds, undefined);
    assert.deepEqual(state().slice.entries, host.fold.items);
    release();
    store.destroy?.();
  });

  it("a copy with omitted rows resumed on a host that names no stream reads the thread whole", async () => {
    const host = fakeHost();
    const first = open(host);
    await settle();
    host.open();
    await settle();
    first.store.destroy?.();
    const second = open(host);
    await settle();
    assert.ok((second.state().slice.omittedAgentIds?.length ?? 0) > 0);
    // An older host: the resume replays and synchronizes with no stream id.
    host.open({ streamId: false });
    await settle();
    const reread = host.streams.at(-1)!;
    assert.equal(host.streams.length, 3);
    assert.equal(reread.options.after, undefined, "asked for a snapshot");
    second.store.destroy?.();
  });

  it("a frame a snapshot read beside the stream outran is dropped and asked for again", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    await settle();
    host.answer("hold");
    const release = state().actions.wantAgentRows!("a1");
    await settle();
    assert.equal(host.posts.length, 1);
    // The frame is built; the host moves on before the stream carries the next event, and a
    // refresh read beside the stream lands newer than the frame.
    const stale = agentRowsFrameOf({ items: host.fold.items, roster: host.fold.roster, seq: host.fold.seq, agentIds: ["a1"] });
    host.live(host.nextEvent("thread.message-sent", { messageId: "p-late", role: "assistant", text: "late", streaming: false, turnId: "t1" }), true);
    await state().actions.refresh();
    assert.equal(state().slice.seq, host.fold.seq);
    host.answer("deliver");
    host.streams.at(-1)!.handlers.onFrames?.([stale]);
    await settle();
    assert.equal(host.posts.length, 2, "asked again");
    assert.equal(state().slice.omittedAgentIds?.includes("a1"), false);
    assert.deepEqual(
      state().slice.entries.filter((item) => item.agentId === "a1"),
      host.fold.items.filter((item) => item.agentId === "a1")
    );
    release();
    store.destroy?.();
  });
});

describe("on-demand agent rows — the store after a host restart", () => {
  it("never asks on the connection a changed host instance made it close", async () => {
    const host = fakeHost();
    const { store, state } = open(host);
    await settle();
    host.open();
    await settle();
    host.answer("hold");
    // The host restarts under the stream: its marker names a new instance (and a stream id).
    const first = host.streams[0]!;
    const release = state().actions.wantAgentRows!("a1");
    first.handlers.onFrames?.([
      { kind: "synchronized", hostInstanceId: "host-2", streamId: "stream-dead" } as AgentChatStreamFrame
    ]);
    await settle();
    assert.equal(first.closed, true, "re-read on a fresh connection");
    assert.equal(host.streams.length, 2);
    assert.ok(!host.posts.some((post) => post.streamId === "stream-dead"), "nothing asked on the closed one");
    release();
    store.destroy?.();
  });
});
