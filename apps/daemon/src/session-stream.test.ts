import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import type { SessionSummary, TerminalStreamServerFrame } from "@orquester/api";

import { createSessionStream, type SessionStreamSessions, type SessionStreamSocket } from "./session-stream.ts";

/** A socket whose send buffer only drains when the test flushes it. */
class FakeSocket implements SessionStreamSocket {
  frames: TerminalStreamServerFrame[] = [];
  private pending: Array<{ size: number; cb?: (error?: Error) => void }> = [];
  bufferedAmount = 0;

  send(data: string, cb?: (error?: Error) => void): void {
    this.frames.push(JSON.parse(data) as TerminalStreamServerFrame);
    this.pending.push({ size: data.length, cb });
    this.bufferedAmount += data.length;
  }

  /** Write out every queued frame, firing their callbacks in order. */
  flush(): void {
    const pending = this.pending;
    this.pending = [];
    for (const write of pending) {
      this.bufferedAmount -= write.size;
      write.cb?.();
    }
  }

  take(): TerminalStreamServerFrame[] {
    const frames = this.frames;
    this.frames = [];
    return frames;
  }
}

/** A deferred value the test resolves by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

class FakeSessions implements SessionStreamSessions {
  readonly emitter = new EventEmitter();
  status: SessionSummary["status"] = "running";
  exists = true;
  snapshot = "SNAP";
  /** When set, scrollback() waits on it (a capture in flight). */
  capture: { promise: Promise<void>; resolve: (value: void) => void } | null = null;
  scrollbacks = 0;
  resizes: Array<[number, number]> = [];
  inputs: string[] = [];
  settle: { promise: Promise<void>; resolve: (value: void) => void } | null = null;
  settleSignal: AbortSignal | undefined;

  get(id: string): SessionSummary | undefined {
    if (!this.exists) return undefined;
    return {
      id,
      kind: "shell",
      refId: "sh",
      title: "sh",
      projectPath: "/p",
      cwd: "/p",
      cols: 80,
      rows: 24,
      status: this.status,
      order: 0,
      createdAt: "2026-10-22T00:00:00.000Z"
    };
  }
  async scrollback(): Promise<string> {
    this.scrollbacks += 1;
    if (this.capture) await this.capture.promise;
    return this.snapshot;
  }
  subscribe(_id: string, onOutput: (data: string) => void, onExit: (code: number) => void): () => void {
    this.emitter.on("output", onOutput);
    this.emitter.on("exit", onExit);
    return () => {
      this.emitter.off("output", onOutput);
      this.emitter.off("exit", onExit);
    };
  }
  input(_id: string, data: string): void {
    this.inputs.push(data);
  }
  resize(_id: string, cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  async settleResize(_id: string, signal?: AbortSignal): Promise<void> {
    this.settleSignal = signal;
    if (this.settle) await this.settle.promise;
  }
  out(data: string): void {
    this.emitter.emit("output", data);
  }
}

const LIMITS = { highWater: 100, lowWater: 20 };

function rig() {
  const socket = new FakeSocket();
  const sessions = new FakeSessions();
  const stream = createSessionStream(socket, sessions, LIMITS);
  const message = (frame: object) => stream.onMessage(JSON.stringify(frame));
  return { socket, sessions, stream, message };
}

describe("subscribe", () => {
  test("sends the snapshot as a replay, then live output", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    sessions.out("live");
    assert.deepEqual(socket.take(), [
      { t: "out", id: "s", data: "SNAP", replay: true },
      { t: "out", id: "s", data: "live" }
    ]);
  });

  test("output produced during the capture follows the snapshot instead of being lost", async () => {
    const { socket, sessions, message } = rig();
    sessions.capture = deferred();
    const done = message({ t: "sub", id: "s" });
    sessions.out("during");
    sessions.capture.resolve();
    await done;
    assert.deepEqual(socket.take(), [
      { t: "out", id: "s", data: "SNAP", replay: true },
      { t: "out", id: "s", data: "during" }
    ]);
  });

  test("an unsub during the capture wins and nothing streams", async () => {
    const { socket, sessions, message } = rig();
    sessions.capture = deferred();
    const done = message({ t: "sub", id: "s" });
    await message({ t: "unsub", id: "s" });
    sessions.capture.resolve();
    await done;
    sessions.out("late");
    assert.deepEqual(socket.take(), []);
    assert.equal(sessions.emitter.listenerCount("output"), 0);
  });

  test("an unknown session ends at once", async () => {
    const { socket, sessions, message } = rig();
    sessions.exists = false;
    await message({ t: "sub", id: "s" });
    assert.deepEqual(socket.take(), [{ t: "end", id: "s" }]);
  });

  test("a session that exited before the sub gets its snapshot then end", async () => {
    const { socket, sessions, message } = rig();
    sessions.status = "exited";
    await message({ t: "sub", id: "s" });
    assert.deepEqual(socket.take(), [
      { t: "out", id: "s", data: "SNAP", replay: true },
      { t: "end", id: "s" }
    ]);
    assert.equal(sessions.emitter.listenerCount("output"), 0);
  });

  test("an exit during the capture ends after the snapshot, once", async () => {
    const { socket, sessions, message } = rig();
    sessions.capture = deferred();
    const done = message({ t: "sub", id: "s" });
    sessions.emitter.emit("exit", 0);
    sessions.status = "exited";
    sessions.capture.resolve();
    await done;
    assert.deepEqual(socket.take(), [
      { t: "out", id: "s", data: "SNAP", replay: true },
      { t: "end", id: "s" }
    ]);
  });
});

describe("backpressure", () => {
  test("output past the high-water mark is dropped, not queued, until the socket drains", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150)); // sent: buffer was empty
    sessions.out("dropped-1");
    sessions.out("dropped-2");
    assert.deepEqual(
      socket.take().map((f) => (f.t === "out" ? f.data.length : f.t)),
      [150]
    );
    assert.equal(sessions.scrollbacks, 1, "no resync while the socket is still backed up");
  });

  test("a drained socket gets reset, a fresh snapshot, then live output again", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150));
    sessions.out("dropped");
    socket.take();
    sessions.snapshot = "FRESH";
    socket.flush(); // the write callback sees the drain
    await new Promise<void>((resolve) => setImmediate(resolve));
    sessions.out("after");
    assert.deepEqual(socket.take(), [
      { t: "reset", id: "s" },
      { t: "out", id: "s", data: "FRESH", replay: true },
      { t: "out", id: "s", data: "after" }
    ]);
  });

  test("a partial drain above the low-water mark does not resync yet", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    socket.flush();
    sessions.out("x".repeat(150));
    sessions.out("dropped");
    // Something else still sits in the buffer above the low-water mark.
    socket.bufferedAmount += 50;
    socket.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(socket.take(), [{ t: "out", id: "s", data: "x".repeat(150) }]);
    assert.equal(sessions.scrollbacks, 1);
  });

  test("every terminal that overflowed is resynced; quiet ones are not", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "a" });
    await message({ t: "sub", id: "b" });
    socket.take();
    socket.flush();
    sessions.out("x".repeat(150)); // both subscribed to the same fake emitter
    assert.equal(socket.take().length, 1, "only the first fits; the second overflowed");
    socket.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frames = socket.take();
    assert.deepEqual(frames, [
      { t: "reset", id: "b" },
      { t: "out", id: "b", data: "SNAP", replay: true }
    ]);
  });

  test("an exit while overflowed is delivered after the resync snapshot", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150));
    sessions.out("dropped");
    sessions.emitter.emit("exit", 1);
    assert.deepEqual(socket.take().map((f) => f.t), ["out"]);
    socket.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(socket.take(), [
      { t: "reset", id: "s" },
      { t: "out", id: "s", data: "SNAP", replay: true },
      { t: "end", id: "s" }
    ]);
  });

  test("output held during a resync that outgrows the budget triggers another resync", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150));
    sessions.out("dropped");
    socket.take();
    sessions.capture = deferred();
    socket.flush();
    sessions.out("y".repeat(150)); // held during the capture, over budget → dropped
    sessions.capture.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frames = socket.take();
    assert.deepEqual(frames.map((f) => f.t), ["reset", "out"]);
    assert.equal(sessions.scrollbacks, 2);
    // The snapshot frames drain → the stale terminal is resynced again.
    sessions.capture = null;
    socket.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sessions.scrollbacks, 3);
    assert.deepEqual(socket.take().map((f) => f.t), ["reset", "out"]);
  });

  test("pong and end are never dropped", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.bufferedAmount = 10_000;
    await message({ t: "ping" });
    sessions.emitter.emit("exit", 0);
    assert.deepEqual(socket.take().slice(-2), [{ t: "pong" }, { t: "end", id: "s" }]);
  });

  test("a closed socket stops everything", async () => {
    const { socket, sessions, message, stream } = rig();
    await message({ t: "sub", id: "s" });
    stream.onClose();
    sessions.out("late");
    socket.take();
    assert.equal(sessions.emitter.listenerCount("output"), 0);
  });
});

describe("resize resync", () => {
  test("the first resize after a sub re-snapshots once the backend applied it, not on a timer", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.settle = deferred();
    const done = message({ t: "resize", id: "s", cols: 120, rows: 40 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sessions.resizes, [[120, 40]]);
    assert.deepEqual(socket.take(), [], "no snapshot before the resize is applied");
    sessions.snapshot = "WIDE";
    sessions.settle.resolve();
    await done;
    assert.deepEqual(socket.take(), [
      { t: "reset", id: "s" },
      { t: "out", id: "s", data: "WIDE", replay: true }
    ]);
    // Later resizes don't re-snapshot.
    sessions.settle = null;
    await message({ t: "resize", id: "s", cols: 100, rows: 30 });
    assert.deepEqual(socket.take(), []);
  });

  test("an unsub while waiting for the resize cancels the wait and the snapshot", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.settle = deferred();
    const done = message({ t: "resize", id: "s", cols: 120, rows: 40 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await message({ t: "unsub", id: "s" });
    assert.equal(sessions.settleSignal?.aborted, true);
    sessions.settle.resolve();
    await done;
    assert.deepEqual(socket.take(), []);
  });

  test("input and resize reach the session", async () => {
    const { sessions, message } = rig();
    await message({ t: "input", id: "s", data: "ls\r" });
    await message({ t: "resize", id: "s", cols: 90, rows: 20 });
    assert.deepEqual(sessions.inputs, ["ls\r"]);
    assert.deepEqual(sessions.resizes, [[90, 20]]);
  });
});
