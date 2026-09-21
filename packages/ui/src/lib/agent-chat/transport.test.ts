import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { StreamHandlers, Transporter, TransportRequest, TransportResponse } from "../transporter";

import type { AgentChatStreamFrame } from "@orquester/api/agent-chat";

import {
  AgentChatCommandError,
  attachmentRefFromUpload,
  createAgentChatTransport,
  resolveAgentChatTransport
} from "./transport";
import { ev, resetBuilders, snapshot } from "./test-helpers";

interface OpenStream {
  path: string;
  handlers: StreamHandlers;
  closed: boolean;
}

class FakeTransporter implements Transporter {
  readonly kind = "fake";
  readonly requests: TransportRequest[] = [];
  readonly streams: OpenStream[] = [];
  responses: Array<TransportResponse<unknown>> = [];

  async request<T>(req: TransportRequest): Promise<TransportResponse<T>> {
    this.requests.push(req);
    const next = this.responses.shift();
    return (next ?? { status: 200, ok: true, data: { seq: 1 } }) as TransportResponse<T>;
  }

  openStream(path: string, handlers: StreamHandlers): { close(): void } {
    const entry: OpenStream = { path, handlers, closed: false };
    this.streams.push(entry);
    return {
      close: () => {
        entry.closed = true;
      }
    };
  }

  get latest(): OpenStream {
    return this.streams[this.streams.length - 1]!;
  }
}

/** A timer queue the test drives, so nothing waits on a real clock. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.set(id, { fn, at: ms });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    runAll(): void {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) {
        entry.fn();
      }
    },
    get size(): number {
      return pending.size;
    }
  };
}

const line = (frame: AgentChatStreamFrame): string => `${JSON.stringify(frame)}\n`;

beforeEach(() => {
  resetBuilders();
});

describe("the stream reader", () => {
  it("opens without a cursor from a cold start and decodes frames in order", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const frames: AgentChatStreamFrame[] = [];
    const timers = fakeTimers();
    const handle = transport.stream("s1", { ...timers }, { onFrame: (frame) => frames.push(frame) });

    assert.equal(transporter.latest.path, "/api/sessions/s1/events");
    transporter.latest.handlers.onData(
      line({ kind: "snapshot", thread: snapshot({ seq: 3 }) }) +
        ":hb\n" +
        line({ kind: "event", seq: 4, event: ev("thread.reverted", { turnCount: 1 }, { seq: 4 }) }) +
        line({ kind: "synchronized", hostInstanceId: "h1" })
    );

    assert.deepEqual(frames.map((frame) => frame.kind), ["snapshot", "event", "synchronized"]);
    assert.equal(handle.lastSeq, 4);
    assert.equal(handle.hostInstanceId, "h1");
    handle.close();
  });

  it("resumes from the highest applied sequence after a drop", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const timers = fakeTimers();
    const handle = transport.stream("s1", { ...timers, random: () => 0 }, { onFrame: () => {} });

    transporter.latest.handlers.onData(
      line({ kind: "event", seq: 7, event: ev("thread.reverted", { turnCount: 1 }, { seq: 7 }) })
    );
    transporter.latest.handlers.onEnd();
    timers.runAll();

    assert.equal(transporter.streams.length, 2);
    assert.equal(transporter.latest.path, "/api/sessions/s1/events?after=7");
    handle.close();
  });

  it("drops a replayed event so a reconnect duplicates nothing", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const frames: AgentChatStreamFrame[] = [];
    const timers = fakeTimers();
    const handle = transport.stream("s1", { ...timers, random: () => 0 }, {
      onFrame: (frame) => frames.push(frame)
    });

    const event = (seq: number): AgentChatStreamFrame => ({
      kind: "event",
      seq,
      event: ev("thread.reverted", { turnCount: seq }, { seq })
    });
    transporter.latest.handlers.onData(line(event(1)) + line(event(2)));
    transporter.latest.handlers.onEnd();
    timers.runAll();
    // The host replays from the cursor; 2 overlaps and must be dropped.
    transporter.latest.handlers.onData(line(event(2)) + line(event(3)));

    assert.deepEqual(
      frames.map((frame) => (frame.kind === "event" ? frame.seq : frame.kind)),
      [1, 2, 3]
    );
    handle.close();
  });

  it("asks for a snapshot when the host instance changed", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const timers = fakeTimers();
    const handle = transport.stream(
      "s1",
      { ...timers, after: 5, hostInstanceId: "h1", random: () => 0 },
      { onFrame: () => {} }
    );
    assert.equal(transporter.latest.path, "/api/sessions/s1/events?after=5");

    transporter.latest.handlers.onData(line({ kind: "synchronized", hostInstanceId: "h2" }));
    transporter.latest.handlers.onEnd();
    timers.runAll();
    assert.equal(
      transporter.latest.path,
      "/api/sessions/s1/events",
      "a changed instance id is a resync, not a resume"
    );
    handle.close();
  });

  it("survives a chunk boundary inside a frame and a malformed line", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const frames: AgentChatStreamFrame[] = [];
    const timers = fakeTimers();
    const handle = transport.stream("s1", { ...timers }, { onFrame: (frame) => frames.push(frame) });

    const whole = line({ kind: "synchronized", hostInstanceId: "h1" });
    transporter.latest.handlers.onData("{oops\n");
    transporter.latest.handlers.onData(whole.slice(0, 10));
    transporter.latest.handlers.onData(whole.slice(10));
    assert.equal(frames.length, 1);
    handle.close();
  });

  it("reports the reconnect and stops for good on close", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const timers = fakeTimers();
    const seen: Array<{ attempt: number; reason: string }> = [];
    const handle = transport.stream("s1", { ...timers, random: () => 0 }, {
      onFrame: () => {},
      onReconnect: (info) => seen.push({ attempt: info.attempt, reason: info.reason })
    });
    transporter.latest.handlers.onEnd();
    assert.deepEqual(seen, [{ attempt: 1, reason: "ended" }]);

    handle.close();
    timers.runAll();
    assert.equal(transporter.streams.length, 1, "a closed stream never reconnects");
  });

  it("closes a wedged stream once the heartbeat window lapses", () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    const timers = fakeTimers();
    const handle = transport.stream("s1", { ...timers, random: () => 0 }, { onFrame: () => {} });
    // The stall timer fires, then the scheduled reconnect fires.
    timers.runAll();
    timers.runAll();
    assert.equal(transporter.streams.length, 2);
    handle.close();
  });
});

describe("commands", () => {
  it("posts to the right route and returns the receipt", async () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    transporter.responses.push({ status: 200, ok: true, data: { seq: 12 } });
    const receipt = await transport.command("s1", "session/stop", { commandId: "c1" });
    assert.deepEqual(receipt, { seq: 12 });
    assert.equal(transporter.requests[0]?.path, "/api/sessions/s1/session/stop");
    assert.deepEqual(transporter.requests[0]?.body, { commandId: "c1" });
  });

  it("turns an error envelope into a typed error", async () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    transporter.responses.push({
      status: 409,
      ok: false,
      data: { error: { code: "COMMAND_REJECTED", message: "revert past turnCount" } }
    });
    await assert.rejects(
      () => transport.command("s1", "revert", { commandId: "c1", targetTurnCount: 9 }),
      (error: unknown) => {
        assert.ok(error instanceof AgentChatCommandError);
        assert.equal(error.code, "COMMAND_REJECTED");
        assert.equal(error.retryable, false);
        return true;
      }
    );
  });

  it("marks HOST_UNAVAILABLE retryable — the same commandId may be re-posted", async () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    transporter.responses.push({
      status: 503,
      ok: false,
      data: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } }
    });
    await assert.rejects(
      () => transport.command("s1", "compact", { commandId: "c1" }),
      (error: unknown) => error instanceof AgentChatCommandError && error.retryable
    );
  });

  it("defaults the turn diff to ignoring whitespace", async () => {
    const transporter = new FakeTransporter();
    const transport = createAgentChatTransport(transporter);
    transporter.responses.push({ status: 200, ok: true, data: {} });
    await transport.turnDiff("s1", 3);
    assert.deepEqual(transporter.requests[0]?.query, { ignoreWhitespace: 1 });
  });
});

describe("attachments", () => {
  it("turns an upload response into metadata only — never bytes, never a data URL", () => {
    assert.deepEqual(
      attachmentRefFromUpload({ path: "/a/b.png", name: "b.png", size: 12 }, {
        name: "b.png",
        type: "image/PNG"
      }),
      { type: "image", id: "/a/b.png", name: "b.png", mimeType: "image/png", sizeBytes: 12 }
    );
    assert.deepEqual(
      attachmentRefFromUpload({ path: "/a/b.bin", name: "b.bin", size: 3 }, { name: "b.bin" }),
      { type: "file", id: "/a/b.bin", name: "b.bin", sizeBytes: 3 }
    );
  });
});

describe("resolveAgentChatTransport", () => {
  it("memoises per transporter so a re-render never re-opens a stream", () => {
    const transporter = new FakeTransporter();
    assert.equal(resolveAgentChatTransport(transporter), resolveAgentChatTransport(transporter));
  });

  it("prefers a transporter's own implementation", () => {
    const own = {} as never;
    const transporter = new FakeTransporter() as FakeTransporter & Transporter;
    transporter.agentChat = () => own;
    assert.equal(resolveAgentChatTransport(transporter), own);
  });
});
