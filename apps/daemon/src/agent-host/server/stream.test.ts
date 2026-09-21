import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";

import {
  AGENT_CHAT_HEARTBEAT_LINE,
  type AgentChatStreamFrame,
  type DomainEvent,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { createTestTimers } from "../orchestration/testing/fakes.ts";
import { coalesceToolUpdates, createThreadStream, serializedSize } from "./stream.ts";

interface FakeResponse {
  response: ServerResponse;
  lines: string[];
  /** Make the next `write` report backpressure instead of flushing. */
  stall(): void;
  drain(): void;
  ended: boolean;
  closeFromClient(): void;
}

function fakeResponse(): FakeResponse {
  const lines: string[] = [];
  let stalled = false;
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
    drain(): void {
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

describe("thread stream — coalescing (§5.6, §6.3)", () => {
  it("keeps only the latest update per stable tool id in a run", () => {
    const events = [toolUpdate(1, "tool-a"), toolUpdate(2, "tool-a"), toolUpdate(3, "tool-b")];
    const survivors = coalesceToolUpdates(events);
    assert.deepEqual(
      survivors.map((entry) => entry.seq),
      [2, 3]
    );
  });

  it("lets anonymous updates through — labels are not unique in parallel", () => {
    const events = [toolUpdate(1, null), toolUpdate(2, null)];
    assert.equal(coalesceToolUpdates(events).length, 2);
  });

  it("a non-update frame closes the run immediately", () => {
    const events = [toolUpdate(1, "tool-a"), event(2), toolUpdate(3, "tool-a")];
    assert.deepEqual(
      coalesceToolUpdates(events).map((entry) => entry.seq),
      [1, 2, 3]
    );
  });

  it("does not collapse across turns", () => {
    const events = [toolUpdate(1, "tool-a", "turn-1"), toolUpdate(2, "tool-a", "turn-2")];
    assert.equal(coalesceToolUpdates(events).length, 2);
  });
});

describe("thread stream — the live tail is attached before the read (§6.3)", () => {
  it("loses no event published while the read is in flight, and duplicates none", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
    let attached = false;
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
        attached = true;
        return () => {
          attached = false;
        };
      },
      read: async (): Promise<AgentChatStreamFrame[]> => {
        // The subscription must already be attached by now.
        assert.ok(attached, "live delivery is attached before the read");
        emit([event(4)]);
        await readGate;
        return [{ kind: "snapshot", thread: snapshot(5) }];
      },
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle)
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

  it("pushes `synchronized` after everything buffered, never straight to the socket", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
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
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle)
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
  it("coalesces live tool updates on the 50 ms window and flushes on any other frame", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
    let emit: ((events: DomainEvent[]) => void) = () => undefined;
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => [],
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle)
    });
    await stream.start();
    fake.lines.length = 0;

    emit([toolUpdate(10, "tool-a")]);
    emit([toolUpdate(11, "tool-a")]);
    assert.equal(fake.lines.length, 0, "updates wait on the window");
    timers.runDue(50);
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
    stream.close();
  });

  it("sends `:hb` on the heartbeat interval", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async () => () => undefined,
      read: async () => [],
      heartbeatMs: 15_000,
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle)
    });
    await stream.start();
    assert.equal(fake.lines.includes(AGENT_CHAT_HEARTBEAT_LINE), false);
    timers.runDue(15_000);
    assert.equal(fake.lines.at(-1), AGENT_CHAT_HEARTBEAT_LINE);
    timers.runDue(30_000);
    assert.equal(fake.lines.filter((line) => line === AGENT_CHAT_HEARTBEAT_LINE).length, 2);
    stream.close();
  });

  it("closes the stream when the undrained write buffer passes its budget", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
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
      bufferLimitBytes: 400,
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle),
      onClose: (reason) => closed.push(reason)
    });
    await stream.start();

    // Every write stalls, so nothing is ever released from the charge.
    for (let index = 0; index < 20 && !stream.closed; index += 1) {
      fake.stall();
      emit([event(100 + index)]);
    }
    assert.equal(stream.closed, true);
    assert.deepEqual(closed, ["budget"]);
    assert.match(fake.lines.at(-1) ?? "", /Resume from the last received sequence/);
    assert.equal(fake.ended, true);
  });

  it("releases the charge once the socket drains", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
    let emit: ((events: DomainEvent[]) => void) = () => undefined;
    const stream = createThreadStream({
      response: fake.response,
      hostInstanceId: "host-1",
      subscribe: async (listener) => {
        emit = listener;
        return () => undefined;
      },
      read: async () => [],
      bufferLimitBytes: 400,
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle)
    });
    await stream.start();
    for (let index = 0; index < 20; index += 1) {
      fake.stall();
      emit([event(200 + index)]);
      fake.drain();
    }
    assert.equal(stream.closed, false, "a client that keeps up is never cut");
    stream.close();
  });

  it("stops writing once the client disconnects", async () => {
    const fake = fakeResponse();
    const timers = createTestTimers();
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
      setTimer: (fn, ms) => timers.setTimer(fn, ms),
      clearTimer: (handle) => timers.clearTimer(handle),
      onClose: (reason) => closed.push(reason)
    });
    await stream.start();
    fake.closeFromClient();
    const before = fake.lines.length;
    emit([event(42)]);
    assert.equal(fake.lines.length, before);
    assert.deepEqual(closed, ["client"]);
    assert.equal(timers.pending, 0, "no heartbeat is left behind");
  });
});

describe("thread stream — byte accounting", () => {
  it("measures an event once and caches it by identity", () => {
    const sample = event(1);
    const first = serializedSize(sample);
    assert.equal(serializedSize(sample), first);
    assert.equal(first, Buffer.byteLength(JSON.stringify(sample)));
  });
});
