import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";

import {
  agentRowsFrameOf,
  applyAgentRows,
  applyDomainEvent,
  createEmptyThreadState,
  omitOnDemandAgentRows,
  toThreadSnapshot,
  type AgentChatStreamFrame,
  type AgentRowsFrame,
  type DomainEvent,
  type HistoryImportProgress,
  type ThreadActivityItem,
  type ThreadFoldState,
  type ThreadItem,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { createThreadStream } from "./stream.ts";

interface FakeResponse {
  response: ServerResponse;
  lines: string[];
  /** Make the next `write` report backpressure instead of flushing. */
  stall(): void;
  /** Every `write` reports backpressure until the next `drain()`. */
  hold(): void;
  drain(): void;
  ended: boolean;
  closeFromClient(): void;
}

function fakeResponse(): FakeResponse {
  const lines: string[] = [];
  let stalled = false;
  let holding = false;
  let drainListener: (() => void) | null = null;
  const closeListeners: Array<() => void> = [];
  const state = {
    ended: false
  };
  const response = {
    statusCode: 0,
    setHeader(): void {},
    flushHeaders(): void {},
    on(event: string, listener: () => void): void {
      if (event === "close") closeListeners.push(listener);
    },
    once(event: string, listener: () => void): void {
      if (event === "drain") drainListener = listener;
    },
    write(chunk: string): boolean {
      lines.push(chunk.replace(/\n$/, ""));
      if (holding) return false;
      if (stalled) {
        stalled = false;
        return false;
      }
      return true;
    },
    end(): void {
      state.ended = true;
    }
  } as unknown as ServerResponse;

  return {
    response,
    lines,
    stall(): void {
      stalled = true;
    },
    hold(): void {
      holding = true;
    },
    drain(): void {
      holding = false;
      drainListener?.();
      drainListener = null;
    },
    get ended(): boolean {
      return state.ended;
    },
    closeFromClient(): void {
      for (const listener of closeListeners) listener();
    }
  };
}

function event(seq: number, overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    seq,
    eventId: `e${seq}`,
    threadId: "t1",
    type: "thread.message-sent",
    payload: {
      messageId: `m${seq}`,
      role: "assistant",
      text: "x",
      streaming: false,
      turnId: null
    },
    occurredAt: "1970-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    ...overrides
  } as DomainEvent;
}

function toolUpdate(seq: number, toolUseId: string | null, turnId = "turn-1"): DomainEvent {
  return {
    seq,
    eventId: `e${seq}`,
    threadId: "t1",
    type: "thread.activity-appended",
    payload: {
      activity: {
        kind: "activity",
        id: `a${seq}`,
        tone: "tool",
        activityKind: "tool.updated",
        summary: "running",
        payload: toolUseId === null ? {} : { toolUseId },
        turnId,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z"
      }
    },
    occurredAt: "1970-01-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as DomainEvent;
}

function parse(lines: string[]): Array<AgentChatStreamFrame | { kind: string }> {
  return lines
    .filter((line) => !line.startsWith(":"))
    .map((line) => JSON.parse(line) as AgentChatStreamFrame);
}

const snapshot = (seq: number): ThreadSnapshotPayload =>
  ({
    head: { id: "t1", seq },
    items: [],
    turns: [],
    checkpoints: [],
    pending: { approvals: [], userInputs: [] },
    roster: [],
    seq
  }) as unknown as ThreadSnapshotPayload;

describe("thread stream — the live tail is attached before the read (§6.3)", () => {
  it("loses no event published while the read is in flight, and duplicates none", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let emit: (events: DomainEvent[]) => void = () => undefined;
    const readGateHandles: Array<() => void> = [];
    const readGate = new Promise<void>((resolve) => {
      readGateHandles.push(() => resolve());
    });
    const releaseRead = (): void => {
      readGateHandles.forEach((fn) => fn());
    };

    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async (): Promise<AgentChatStreamFrame[]> => {
        emit([event(4)]);
        await readGate;
        return [{ kind: "snapshot", thread: snapshot(5) }];
      },
    });

    const started = stream.start();
    await new Promise((resolve) => setImmediate(resolve));
    // Two more events land while the read is still parked.
    emit([event(6)]);
    releaseRead();
    await started;

    const frames = parse(fake.lines);
    assert.equal(frames[0]?.kind, "snapshot");
    // seq 4 is already inside the snapshot (seq 5) and is dropped; seq 6 is not.
    assert.deepEqual(
      frames.slice(1, -1).map((frame) => (frame as { seq: number }).seq),
      [6]
    );
    assert.equal(frames.at(-1)?.kind, "synchronized");
    assert.equal(
      (frames.at(-1) as { hostInstanceId: string }).hostInstanceId,
      "host-1",
      "a restarted host is not a reconnect (§8)"
    );
    stream.close();
  });

  it("pushes `synchronized` after everything buffered, never straight to the socket", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let emit: (events: DomainEvent[]) => void = () => undefined;
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => {
        emit([event(2), event(3)]);
        return [{ kind: "event", seq: 1, event: event(1) }];
      },
    });
    await stream.start();
    const frames = parse(fake.lines);
    assert.deepEqual(
      frames.map((frame) => ("seq" in frame ? frame.seq : frame.kind)),
      [1, 2, 3, "synchronized"]
    );
    stream.close();
  });
});

describe("thread stream — live delivery", () => {
  it("coalesces live tool updates on the 50 ms window and flushes on any other frame", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let emit: ((events: DomainEvent[]) => void) = () => undefined;
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => [],
    });
    await stream.start();
    fake.lines.length = 0;

    emit([toolUpdate(10, "tool-a")]);
    emit([toolUpdate(11, "tool-a")]);
    assert.equal(fake.lines.length, 0, "updates wait on the window");
    t.mock.timers.tick(50);
    assert.deepEqual(
      parse(fake.lines).map((frame) => (frame as { seq: number }).seq),
      [11]
    );

    fake.lines.length = 0;
    emit([toolUpdate(12, "tool-a")]);
    emit([event(13)]);
    assert.deepEqual(
      parse(fake.lines).map((frame) => (frame as { seq: number }).seq),
      [12, 13],
      "a non-update frame flushes the run immediately"
    );
    fake.lines.length = 0;
    emit([toolUpdate(14, null), toolUpdate(15, null), toolUpdate(16, "same", "turn-1"), toolUpdate(17, "same", "turn-2")]);
    t.mock.timers.tick(50);
    assert.deepEqual(parse(fake.lines).map((frame) => (frame as { seq: number }).seq), [14, 15, 16, 17]);
    stream.close();
  });

  it("sends `:hb` on the heartbeat interval", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async () => () => undefined,
      read: async () => [],
    });
    await stream.start();
    assert.equal(fake.lines.includes(":hb"), false);
    t.mock.timers.tick(15_000);
    assert.equal(fake.lines.at(-1), ":hb");
    t.mock.timers.tick(15_000);
    assert.equal(fake.lines.filter((line) => line === ":hb").length, 2);
    stream.close();
  });

  it("closes the stream when the undrained write buffer passes its budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let emit: ((events: DomainEvent[]) => void) = () => undefined;
    const closed: string[] = [];
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => [],
      onClose: (reason) => closed.push(reason)
    });
    await stream.start();

    // Every write stalls, so nothing is ever released from the charge.
    for (let index = 0; index < 20 && !stream.closed; index += 1) {
      fake.stall();
      emit([event(100 + index, { type: "thread.message-sent", payload: { messageId: "large", role: "assistant", text: "x".repeat(1024 * 1024), streaming: true, turnId: null } })]);
    }
    assert.equal(stream.closed, true);
    assert.deepEqual(closed, ["budget"]);
    assert.equal(JSON.parse(fake.lines.at(-1) ?? "{}").kind, "error");
    assert.equal(fake.ended, true);
  });

  it("releases the charge once the socket drains", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let emit: ((events: DomainEvent[]) => void) = () => undefined;
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => [],
    });
    await stream.start();
    for (let index = 0; index < 20; index += 1) {
      fake.stall();
      emit([event(200 + index, { type: "thread.message-sent", payload: { messageId: "large", role: "assistant", text: "x".repeat(1024 * 1024), streaming: true, turnId: null } })]);
      fake.drain();
    }
    assert.equal(stream.closed, false, "a client that keeps up is never cut");
    stream.close();
  });

  it("stops writing once the client disconnects", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let emit: ((events: DomainEvent[]) => void) = () => undefined;
    const closed: string[] = [];
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => [],
      onClose: (reason) => closed.push(reason)
    });
    await stream.start();
    fake.closeFromClient();
    const before = fake.lines.length;
    emit([event(42)]);
    assert.equal(fake.lines.length, before);
    assert.deepEqual(closed, ["client"]);
    t.mock.timers.tick(30_000);
    assert.equal(fake.lines.length, before, "heartbeats stop after disconnect");
  });
});

describe("thread stream — history replay progress", () => {
  it("announces a replay still running after `synchronized`, then every change live", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    let progress: (step: HistoryImportProgress) => void = () => undefined;
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (_listener, onHistoryImport) => {
        progress = onHistoryImport ?? (() => undefined);
        // The orchestrator tells a new subscriber where a running replay is.
        progress({ phase: "reading", done: 0, total: null });
        return () => undefined;
      },
      read: async () => {
        progress({ phase: "importing", done: 100, total: 400 });
        return [{ kind: "snapshot", thread: snapshot(1) }];
      }
    });
    await stream.start();
    progress({ phase: "done", done: 400, total: 400 });

    assert.deepEqual(
      parse(fake.lines).map((frame) => frame.kind),
      ["snapshot", "synchronized", "history-import", "history-import"]
    );
    const [before, after] = parse(fake.lines).slice(2) as Array<{ progress: HistoryImportProgress }>;
    assert.deepEqual(before?.progress, { phase: "importing", done: 100, total: 400 }, "only the latest");
    assert.equal(after?.progress.phase, "done");
    stream.close();
  });

  it("says nothing about a replay that ended before the stream went live", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (_listener, onHistoryImport) => {
        onHistoryImport?.({ phase: "reading", done: 0, total: null });
        onHistoryImport?.({ phase: "done", done: 0, total: 0 });
        return () => undefined;
      },
      read: async () => [{ kind: "snapshot", thread: snapshot(1) }]
    });
    await stream.start();
    assert.deepEqual(
      parse(fake.lines).map((frame) => frame.kind),
      ["snapshot", "synchronized"]
    );
    stream.close();
  });
});

// ---------------------------------------------------------------------------
// On-demand agent rows: the frame rides the stream in order
// ---------------------------------------------------------------------------

/** A tiny host: a real fold, applied and then published in one step, as `commit` does. */
function foldHost() {
  let seq = 0;
  let state: ThreadFoldState = createEmptyThreadState();
  let listener: (events: DomainEvent[]) => void = () => undefined;
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  const build = (type: DomainEvent["type"], payload: unknown): DomainEvent =>
    ({
      seq: ++seq,
      eventId: `e${seq}`,
      threadId: "t1",
      type,
      payload,
      occurredAt: at(seq),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }) as DomainEvent;
  const commit = (events: DomainEvent[]): void => {
    for (const one of events) state = applyDomainEvent(state, one);
    listener(events);
  };
  const activityOf = (
    activityKind: string,
    payload: Record<string, unknown>,
    id: string,
    agentId?: string
  ): ThreadActivityItem => ({
    kind: "activity",
    id,
    tone: "tool",
    activityKind,
    summary: activityKind,
    payload,
    turnId: "turn-1",
    createdAt: at(seq + 1),
    updatedAt: at(seq + 1),
    ...(agentId !== undefined ? { agentId } : {})
  });
  return {
    get state() {
      return state;
    },
    listen(next: (events: DomainEvent[]) => void) {
      listener = next;
    },
    created(): DomainEvent {
      return build("thread.created", {
        projectPath: "/w/p",
        cwd: "/w/p",
        title: "t",
        adapter: "claude",
        refId: "claude",
        accountId: "acc-1",
        home: "account",
        modelSelection: { model: "sonnet" },
        runtimeMode: "approval-required"
      });
    },
    running(): DomainEvent {
      return build("thread.session-set", { session: { status: "running", activeTurnId: "turn-1" } });
    },
    row(activityKind: string, payload: Record<string, unknown>, id: string, agentId?: string): DomainEvent {
      return build("thread.activity-appended", { activity: activityOf(activityKind, payload, id, agentId) });
    },
    words(messageId: string, text: string, agentId: string, streaming: boolean): DomainEvent {
      return build("thread.message-sent", { messageId, role: "assistant", text, streaming, turnId: "turn-1", agentId });
    },
    commit,
    snapshot(): ThreadSnapshotPayload {
      return toThreadSnapshot(state);
    },
    frame(agentIds: readonly string[]): AgentRowsFrame {
      return agentRowsFrameOf({ items: state.items, roster: state.roster, seq: state.seq, agentIds });
    }
  };
}

/** The client side: frames applied in wire order, as the reducer does. */
function clientOf(lines: string[]): { fold: ThreadFoldState; omitted: Set<string>; frames: Array<{ kind: string }> } {
  let fold = createEmptyThreadState();
  const omitted = new Set<string>();
  const frames = parse(lines);
  for (const frame of frames) {
    if (frame.kind === "snapshot") {
      const thread = (frame as { thread: ThreadSnapshotPayload }).thread;
      fold = {
        ...createEmptyThreadState(),
        head: thread.head,
        items: thread.items,
        activities: thread.items.filter((item): item is ThreadActivityItem => item.kind === "activity"),
        turns: thread.turns,
        roster: thread.roster,
        pending: thread.pending,
        seq: thread.seq
      };
      for (const id of thread.omittedAgentIds ?? []) omitted.add(id);
    } else if (frame.kind === "event") {
      fold = applyDomainEvent(fold, (frame as { event: DomainEvent }).event);
    } else if (frame.kind === "agent-rows") {
      const rows = frame as AgentRowsFrame;
      assert.equal(rows.seq, fold.seq, "the frame lands at exactly the position the client applied");
      fold = applyAgentRows(fold, rows);
      for (const id of rows.agentIds) omitted.delete(id);
    }
  }
  return { fold, omitted, frames };
}

const ownRows = (items: readonly ThreadItem[], agentId: string): ThreadItem[] =>
  items.filter((item) => item.agentId === agentId);

const activityIdOf = (frame: { kind: string }): string | null => {
  if (frame.kind !== "event") return null;
  const event = (frame as unknown as { event: DomainEvent }).event;
  return event.type === "thread.activity-appended" ? event.payload.activity.id : null;
};

describe("thread stream — on-demand agent rows", () => {
  it("announces its id on `synchronized`, and a stream without the opt-in takes no request", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const plain = fakeResponse();
    const without = createThreadStream({
      response: plain.response,
      hostInstanceId: "host-1",
      subscribe: async () => () => undefined,
      read: async () => [{ kind: "snapshot", thread: snapshot(1) }]
    });
    await without.start();
    assert.deepEqual(parse(plain.lines).at(-1), { kind: "synchronized", hostInstanceId: "host-1" });
    assert.equal(without.streamId, undefined);
    assert.equal(without.requestAgentRows(["a"]), "closed");
    without.close();

    const fake = fakeResponse();
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async () => () => undefined,
      read: async () => [{ kind: "snapshot", thread: snapshot(1) }],
      agentRows: { streamId: "s-1", frame: () => null }
    });
    await stream.start();
    assert.deepEqual(parse(fake.lines).at(-1), { kind: "synchronized", hostInstanceId: "host-1", streamId: "s-1" });
    assert.equal(stream.streamId, "s-1");
    stream.close();
    assert.equal(stream.requestAgentRows(["a"]), "closed", "a closed stream takes none");
  });

  it("an agent message streaming while the request lands ends up whole, with no delta twice", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = foldHost();
    // A settled agent `a` with a call and words; the snapshot leaves them out.
    host.commit([
      host.created(),
      host.running(),
      host.row("task.started", { taskId: "a", agentKind: "agent", title: "A" }, "a-launch"),
      host.row("tool.started", { toolUseId: "a1", title: "Bash" }, "a1-start", "a"),
      host.row("tool.completed", { toolUseId: "a1", title: "Bash" }, "a1-done", "a"),
      host.words("aw1", "first words", "a", false),
      host.row("task.completed", { taskId: "a", agentKind: "agent", status: "completed" }, "a-end")
    ]);
    const fake = fakeResponse();
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        host.listen(listener);
        return () => undefined;
      },
      read: async () => [{ kind: "snapshot", thread: omitOnDemandAgentRows(host.snapshot()) }],
      agentRows: { streamId: "s-1", frame: (agentIds) => host.frame(agentIds) }
    });
    await stream.start();
    assert.deepEqual(clientOf(fake.lines).omitted, new Set(["a"]));

    // The agent is resumed: a new message streams, a call's update waits on the coalescing window…
    host.commit([host.row("task.started", { taskId: "a", agentKind: "agent", title: "A" }, "a-relaunch")]);
    host.commit([host.words("aw2", "Hel", "a", true)]);
    host.commit([host.row("tool.updated", { toolUseId: "a2", title: "Bash" }, "a2-update", "a")]);
    // …and the client's request lands mid-message.
    assert.equal(stream.requestAgentRows(["a"]), "ok");
    host.commit([host.words("aw2", "lo", "a", true)]);
    host.commit([host.words("aw2", " world", "a", true)]);
    // The close: empty text keeps what streamed.
    host.commit([host.words("aw2", "", "a", false)]);
    t.mock.timers.tick(50);

    const client = clientOf(fake.lines);
    const kinds = client.frames.map((frame) => frame.kind);
    const rowsAt = kinds.indexOf("agent-rows");
    assert.ok(rowsAt > kinds.indexOf("synchronized"));
    // The update in its window was committed before the frame's fold: it went first.
    const updateAt = client.frames.findIndex((frame) => activityIdOf(frame) === "a2-update");
    assert.ok(updateAt >= 0 && updateAt < rowsAt, "flushed ahead of the frame");
    assert.deepEqual(client.omitted, new Set());
    const words = client.fold.items.filter((item) => item.id === "aw2");
    assert.equal(words.length, 1, "one message");
    assert.equal(words[0]?.kind === "message" ? words[0].text : null, "Hello world", "every delta exactly once");
    // The agent's rows are exactly the host's, and so is the whole window.
    assert.deepEqual(ownRows(client.fold.items, "a"), ownRows(host.state.items, "a"));
    assert.deepEqual(
      client.fold.items.map((item) => item.id),
      host.state.items.map((item) => item.id)
    );
    stream.close();
  });

  it("a request before the stream is live is written right after `synchronized`, every buffered event before it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = foldHost();
    host.commit([
      host.created(),
      host.running(),
      host.row("task.started", { taskId: "a", agentKind: "agent" }, "a-launch"),
      host.row("tool.started", { toolUseId: "a1" }, "a1-start", "a"),
      host.row("task.completed", { taskId: "a", agentKind: "agent", status: "completed" }, "a-end")
    ]);
    const fake = fakeResponse();
    let releaseRead: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        host.listen(listener);
        return () => undefined;
      },
      read: async () => {
        const read = omitOnDemandAgentRows(host.snapshot());
        await gate;
        return [{ kind: "snapshot", thread: read }];
      },
      agentRows: { streamId: "s-1", frame: (agentIds) => host.frame(agentIds) }
    });
    const started = stream.start();
    await new Promise((resolve) => setImmediate(resolve));
    // A row lands while the read is out, and a request is already in.
    host.commit([host.row("tool.output", { toolUseId: "a1", delta: "late" }, "a1-out", "a")]);
    assert.equal(stream.requestAgentRows(["a"]), "ok");
    releaseRead();
    await started;
    const client = clientOf(fake.lines);
    assert.deepEqual(
      client.frames.map((frame) => frame.kind),
      ["snapshot", "event", "synchronized", "agent-rows"]
    );
    assert.deepEqual(ownRows(client.fold.items, "a"), ownRows(host.state.items, "a"));
    stream.close();
  });
});

describe("thread stream — on-demand agent rows are paced under the budget", () => {
  /** A host whose agents each own one row of `bytes` characters, settled. */
  function bigAgents(count: number, bytes: number) {
    const host = foldHost();
    host.commit([host.created(), host.running()]);
    for (let n = 0; n < count; n += 1) {
      host.commit([
        host.row("task.started", { taskId: `a${n}`, agentKind: "agent" }, `a${n}-launch`),
        host.row("tool.completed", { toolUseId: `c${n}`, output: "x".repeat(bytes) }, `a${n}-row`, `a${n}`),
        host.row("task.completed", { taskId: `a${n}`, agentKind: "agent", status: "completed" }, `a${n}-end`)
      ]);
    }
    return host;
  }

  it("writes one frame per agent, the next only once the socket drained under the cap, and never trips the budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = bigAgents(6, 1_500_000);
    const fake = fakeResponse();
    const closed: string[] = [];
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        host.listen(listener);
        return () => undefined;
      },
      read: async () => [{ kind: "snapshot", thread: omitOnDemandAgentRows(host.snapshot()) }],
      agentRows: { streamId: "s-1", frame: (agentIds) => host.frame(agentIds) },
      onClose: (reason) => closed.push(reason)
    });
    await stream.start();
    const frames = () => parse(fake.lines).filter((frame) => frame.kind === "agent-rows") as AgentRowsFrame[];
    // A slow phone: nothing drains until it says so. Six agents of 1.5 MB are 9 MB in all.
    fake.hold();
    assert.equal(stream.requestAgentRows(["a0", "a1", "a2", "a3", "a4", "a5", "a0"]), "ok");
    assert.deepEqual(frames().map((frame) => frame.agentIds), [["a0"], ["a1"]], "two frames' worth undrained, then it waits");
    for (let round = 0; round < 3; round += 1) fake.drain();
    assert.deepEqual(frames().map((frame) => frame.agentIds), [["a0"], ["a1"], ["a2"], ["a3"], ["a4"], ["a5"]]);
    assert.deepEqual(closed, [], "never cut for its budget");
    stream.close();
  });

  it("an agent whose rows pass the frame cap gets its newest rows, marked truncated", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const host = foldHost();
    host.commit([host.created(), host.running(), host.row("task.started", { taskId: "a", agentKind: "agent" }, "a-launch")]);
    for (let n = 0; n < 3; n += 1) {
      host.commit([host.row("tool.completed", { toolUseId: `c${n}`, output: "x".repeat(900_000) }, `a-row-${n}`, "a")]);
    }
    host.commit([host.row("task.completed", { taskId: "a", agentKind: "agent", status: "completed" }, "a-end")]);
    const frame = agentRowsFrameOf({ items: host.state.items, roster: host.state.roster, seq: host.state.seq, agentIds: ["a"], maxBytes: 2 * 1024 * 1024 });
    assert.equal(frame.truncated, true);
    assert.deepEqual(frame.items.map((item) => item.id), ["a-row-1", "a-row-2"], "the newest that fit");
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 2 * 1024 * 1024);
    const whole = agentRowsFrameOf({ items: host.state.items, roster: host.state.roster, seq: host.state.seq, agentIds: ["a"], maxBytes: 8 * 1024 * 1024 });
    assert.equal(whole.truncated, undefined);
  });

  it("a thread the host can no longer read: the request says so and the stream closes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = fakeResponse();
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async () => () => undefined,
      read: async () => [{ kind: "snapshot", thread: snapshot(1) }],
      agentRows: { streamId: "s-1", frame: () => null }
    });
    await stream.start();
    assert.equal(stream.requestAgentRows(["a"]), "gone");
    assert.equal(stream.closed, true);
  });
});
