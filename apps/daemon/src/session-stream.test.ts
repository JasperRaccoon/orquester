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

  /** A slow link: write out `bytes` of what is queued, oldest first, firing callbacks of whole frames. */
  drain(bytes: number): void {
    while (this.pending.length > 0 && bytes >= this.pending[0]!.size) {
      const write = this.pending.shift()!;
      bytes -= write.size;
      this.bufferedAmount -= write.size;
      write.cb?.();
    }
    if (this.pending.length > 0 && bytes > 0) {
      this.pending[0]!.size -= bytes;
      this.bufferedAmount -= bytes;
    }
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

function rig(limits = LIMITS) {
  const socket = new FakeSocket();
  const sessions = new FakeSessions();
  const stream = createSessionStream(socket, sessions, limits);
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("backpressure", () => {
  test("output past the high-water mark is held, not sent, until the socket drains", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150)); // sent: the buffer was below the mark
    sessions.out("held-1");
    sessions.out("held-2");
    assert.deepEqual(socket.take(), [{ t: "out", id: "s", data: "x".repeat(150) }]);
    socket.flush(); // the write callbacks see the drain
    assert.deepEqual(socket.take(), [{ t: "out", id: "s", data: "held-1held-2" }]);
    sessions.out("live");
    assert.deepEqual(socket.take(), [{ t: "out", id: "s", data: "live" }]);
    assert.equal(sessions.scrollbacks, 1, "no resync when the held output fit its budget");
  });

  test("held output past its budget is dropped; the drain brings reset, a fresh snapshot, then live output", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150));
    sessions.out("y".repeat(120)); // held, over the 100-char budget → overflowed
    sessions.out("dropped");
    assert.deepEqual(socket.take().map((f) => f.t), ["out"]);
    assert.equal(sessions.scrollbacks, 1, "no resync while the socket is still backed up");
    sessions.snapshot = "FRESH";
    socket.flush();
    await tick();
    sessions.out("after");
    assert.deepEqual(socket.take(), [
      { t: "reset", id: "s" },
      { t: "out", id: "s", data: "FRESH", replay: true },
      { t: "out", id: "s", data: "after" }
    ]);
  });

  test("a partial drain above the low-water mark keeps holding", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    socket.flush();
    sessions.out("x".repeat(150));
    sessions.out("held");
    // Something else still sits in the buffer above the low-water mark.
    socket.bufferedAmount += 50;
    socket.flush();
    await tick();
    assert.deepEqual(socket.take(), [{ t: "out", id: "s", data: "x".repeat(150) }]);
    assert.equal(sessions.scrollbacks, 1);
  });

  test("every terminal that overflowed is resynced; others are not", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "a" });
    await message({ t: "sub", id: "b" });
    socket.take();
    socket.flush();
    sessions.out("x".repeat(150)); // both subscribed to the same fake emitter
    assert.equal(socket.take().length, 1, "only the first fits; the second overflowed its budget");
    socket.flush();
    await tick();
    assert.deepEqual(socket.take(), [
      { t: "reset", id: "b" },
      { t: "out", id: "b", data: "SNAP", replay: true }
    ]);
  });

  test("an exit while held follows the held output", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150));
    sessions.out("tail");
    sessions.emitter.emit("exit", 0);
    socket.take();
    socket.flush();
    assert.deepEqual(socket.take(), [
      { t: "out", id: "s", data: "tail" },
      { t: "end", id: "s" }
    ]);
  });

  test("an exit while overflowed is delivered after the resync snapshot", async () => {
    const { socket, sessions, message } = rig();
    await message({ t: "sub", id: "s" });
    socket.take();
    sessions.out("x".repeat(150));
    sessions.out("y".repeat(120));
    sessions.emitter.emit("exit", 1);
    assert.deepEqual(socket.take().map((f) => f.t), ["out"]);
    socket.flush();
    await tick();
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
    sessions.out("y".repeat(120));
    socket.take();
    sessions.capture = deferred();
    socket.flush();
    sessions.out("z".repeat(150)); // held during the capture, over budget → dropped
    sessions.capture.resolve();
    await tick();
    assert.deepEqual(socket.take().map((f) => f.t), ["reset", "out"]);
    assert.equal(sessions.scrollbacks, 2);
    // The snapshot frames drain → the stale terminal is resynced again.
    sessions.capture = null;
    socket.flush();
    await tick();
    assert.equal(sessions.scrollbacks, 3);
    assert.deepEqual(socket.take().map((f) => f.t), ["reset", "out"]);
  });

  test("a slow link behind a snapshot near the budget does not loop on snapshots", async () => {
    // The review's case: a snapshot almost as large as the high-water mark,
    // modest output, and a link that drains a little more than it gets.
    const { socket, sessions, message } = rig({ highWater: 1000, lowWater: 250 });
    sessions.snapshot = "s".repeat(950);
    await message({ t: "sub", id: "s" });
    let produced = "";
    for (let i = 0; i < 200; i += 1) {
      // Two lines a tick, ~160 bytes framed; the link carries 200.
      for (const half of ["a", "b"]) {
        const line = `line ${String(i).padStart(3, "0")}${half} ${"x".repeat(40)}\n`;
        produced += line;
        sessions.out(line);
      }
      socket.drain(200);
      await tick();
    }
    socket.flush();
    const frames = socket.take();
    const replays = frames.filter((f) => f.t === "out" && f.replay);
    const live = frames
      .filter((f): f is Extract<TerminalStreamServerFrame, { t: "out" }> => f.t === "out" && !f.replay)
      .map((f) => f.data)
      .join("");
    assert.equal(replays.length, 1, "only the subscribe snapshot");
    assert.equal(sessions.scrollbacks, 1);
    assert.equal(live, produced, "every line arrived, in order");
  });

  test("after one real overflow a slow link recovers to live output", async () => {
    const { socket, sessions, message } = rig({ highWater: 1000, lowWater: 250 });
    sessions.snapshot = "s".repeat(900);
    await message({ t: "sub", id: "s" });
    // A burst the link can't carry: one resync.
    for (let i = 0; i < 40; i += 1) sessions.out("b".repeat(100));
    let after = "";
    for (let i = 0; i < 300; i += 1) {
      const line = `line ${String(i).padStart(3, "0")} ${"x".repeat(30)}\n`;
      sessions.out(line);
      if (sessions.scrollbacks >= 2) after += line;
      socket.drain(120);
      await tick();
    }
    socket.flush();
    await tick();
    const frames = socket.take();
    assert.equal(sessions.scrollbacks, 2, "the subscribe snapshot and one resync");
    assert.equal(frames.filter((f) => f.t === "reset").length, 1);
    const lastReplay = frames.map((f) => f.t === "out" && f.replay === true).lastIndexOf(true);
    const live = frames
      .slice(lastReplay + 1)
      .filter((f): f is Extract<TerminalStreamServerFrame, { t: "out" }> => f.t === "out")
      .map((f) => f.data)
      .join("");
    assert.ok(live.length > 0 && after.endsWith(live), "live output resumed after the resync and kept up");
    assert.ok(live.endsWith("line 299 " + "x".repeat(30) + "\n"));
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
    socket.take();
    stream.onClose();
    sessions.out("late");
    sessions.emitter.emit("exit", 0);
    await message({ t: "ping" });
    assert.deepEqual(socket.take(), []);
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
