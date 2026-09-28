import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWorkflowLogWindow, type WorkflowLogWindow } from "../../../lib/api-client.ts";
import { readWholeLog, startLogFollower, type LogFollowerTimers } from "./log-follower.ts";

class ManualTimers implements LogFollowerTimers {
  queue: { id: number; fn: () => void; ms: number }[] = [];
  private seq = 0;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.push({ id, fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  }
  fire(): void {
    const next = this.queue.shift();
    next?.fn();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A raw file of `raw`, served in windows of `size` bytes; the text is "redacted" (longer than the raw bytes). */
function server(raw: string, size: number, liveRef: { live: boolean }) {
  const reads: number[] = [];
  let failNext = false;
  return {
    reads,
    failOnce() {
      failNext = true;
    },
    append(more: string) {
      raw += more;
    },
    async read(offset: number): Promise<WorkflowLogWindow> {
      reads.push(offset);
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("gone"), { status: 502 });
      }
      const slice = raw.slice(offset, offset + size);
      const nextOffset = offset + slice.length;
      return { text: slice.replace(/S/g, "«secret:S»"), nextOffset, eof: nextOffset >= raw.length, size: raw.length, live: liveRef.live };
    }
  };
}

describe("the log follower", () => {
  it("reads a finished log to its end, window after window, by the daemon's offsets", async () => {
    const live = { live: false };
    const s = server("aSbSc\n".repeat(10), 7, live);
    const texts: string[] = [];
    let final: unknown = null;
    startLogFollower({ read: (o) => s.read(o), live: () => false, onText: (t) => texts.push(t), onState: (st) => (final = st), timers: new ManualTimers() });
    await settle();
    assert.equal(texts.join("").replace(/«secret:S»/g, "S"), "aSbSc\n".repeat(10));
    assert.deepEqual(final, { following: false, loading: false, error: null });
    // Offsets are the raw file's, never the (longer) redacted text's.
    assert.deepEqual(s.reads, [0, 7, 14, 21, 28, 35, 42, 49, 56]);
  });

  it("polls a live log, and a failed read resumes from the same offset once — no duplicates", async () => {
    const live = { live: true };
    const s = server("one\n", 1024, live);
    const timers = new ManualTimers();
    const texts: string[] = [];
    startLogFollower({ read: (o) => s.read(o), live: () => live.live, onText: (t) => texts.push(t), onState: () => undefined, timers });
    await settle();
    assert.deepEqual(texts, ["one\n"]);
    assert.equal(timers.queue.length, 1, "one poll timer");
    s.failOnce();
    timers.fire();
    await settle();
    assert.equal(timers.queue.length, 1, "exactly one retry timer after an error");
    s.append("two\n");
    timers.fire();
    await settle();
    assert.deepEqual(texts, ["one\n", "two\n"]);
    assert.deepEqual(s.reads, [0, 4, 4]);
    live.live = false;
    timers.fire();
    await settle();
    assert.equal(timers.queue.length, 0, "stops once the block is over");
  });

  it("an error on a finished log is reported, not appended", async () => {
    const texts: string[] = [];
    let final: { error: string | null } | null = null;
    startLogFollower({
      read: async () => {
        throw new Error("404");
      },
      live: () => false,
      onText: (t) => texts.push(t),
      onState: (st) => (final = st),
      timers: new ManualTimers(),
      errorText: () => "The log could not be read."
    });
    await settle();
    assert.deepEqual(texts, []);
    assert.equal(final!.error, "The log could not be read.");
  });

  it("stop() ends it: no further reads, no timer", async () => {
    const live = { live: true };
    const s = server("x\n", 1024, live);
    const timers = new ManualTimers();
    const follower = startLogFollower({ read: (o) => s.read(o), live: () => true, onText: () => undefined, onState: () => undefined, timers });
    await settle();
    follower.stop();
    assert.equal(timers.queue.length, 0);
    follower.wake();
    await settle();
    assert.equal(s.reads.length, 1);
  });

  it("a live log held at a partial last line waits for the next poll instead of spinning", async () => {
    const timers = new ManualTimers();
    let reads = 0;
    startLogFollower({
      read: async (offset) => {
        reads += 1;
        return { text: "", nextOffset: offset, eof: false, size: 10, live: true };
      },
      live: () => true,
      onText: () => undefined,
      onState: () => undefined,
      timers
    });
    await settle();
    assert.equal(reads, 1);
    assert.equal(timers.queue.length, 1);
  });

  it("readWholeLog reads every window to the end (the download)", async () => {
    const s = server("0123456789".repeat(5), 16, { live: false });
    const parts = await readWholeLog((o) => s.read(o));
    assert.equal(parts.join(""), "0123456789".repeat(5));
  });

  it("parseWorkflowLogWindow reads the X-Log-* headers, case-insensitively", () => {
    const data = new TextEncoder().encode("abc").buffer as ArrayBuffer;
    const window = parseWorkflowLogWindow(data, { "X-Log-Next-Offset": "10", "x-log-eof": "0", "x-log-size": "20", "x-log-live": "1" }, 7);
    assert.deepEqual(window, { text: "abc", nextOffset: 10, eof: false, size: 20, live: true });
    // Headers stripped: the window is the rest, by its own bytes.
    assert.deepEqual(parseWorkflowLogWindow(data, {}, 7), { text: "abc", nextOffset: 10, eof: true, size: 10, live: false });
  });
});
