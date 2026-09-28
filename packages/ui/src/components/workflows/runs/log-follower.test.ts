import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWorkflowLogWindow, type WorkflowLogWindow } from "../../../lib/api-client.ts";
import { readWholeLog, startLogFollower } from "./log-follower.ts";

type FollowState = { following: boolean; loading: boolean; error: string | null };

function receipt() {
  let resolve!: (state: FollowState) => void;
  const promise = new Promise<FollowState>((done) => { resolve = done; });
  return { promise, resolve };
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
    const s = server("aSbSc\n".repeat(10), 7, { live: false });
    const texts: string[] = [];
    const settled = receipt();
    startLogFollower({ read: (o) => s.read(o), live: () => false, onText: (t) => texts.push(t), onState: settled.resolve });
    assert.deepEqual(await settled.promise, { following: false, loading: false, error: null });
    assert.equal(texts.join(""), "a«secret:S»b«secret:S»c\n".repeat(10));
    // The daemon cursor counts raw bytes; redaction makes displayed text longer.
    assert.deepEqual(s.reads, [0, 7, 14, 21, 28, 35, 42, 49, 56]);
  });

  it("polls a live log, and a failed read resumes from the same offset once — no duplicates", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const live = { live: true };
    const s = server("one\n", 1024, live);
    const texts: string[] = [];
    let settled = receipt();
    const follower = startLogFollower({ read: (o) => s.read(o), live: () => live.live, onText: (text) => texts.push(text), onState: (state) => settled.resolve(state) });
    t.after(() => follower.stop());
    await settled.promise;
    assert.deepEqual(texts, ["one\n"]);
    s.failOnce();
    settled = receipt();
    t.mock.timers.runAll();
    assert.deepEqual(await settled.promise, { following: true, loading: false, error: null });
    s.append("two\n");
    settled = receipt();
    t.mock.timers.runAll();
    await settled.promise;
    assert.deepEqual(texts, ["one\n", "two\n"]);
    assert.deepEqual(s.reads, [0, 4, 4]);
    live.live = false;
    settled = receipt();
    t.mock.timers.runAll();
    assert.deepEqual(await settled.promise, { following: false, loading: false, error: null });
    t.mock.timers.runAll();
    assert.deepEqual(s.reads, [0, 4, 4, 8]);
  });

  it("an error on a finished log is reported, not appended", async () => {
    const texts: string[] = [];
    const settled = receipt();
    startLogFollower({
      read: async () => { throw new Error("404"); },
      live: () => false,
      onText: (text) => texts.push(text),
      onState: settled.resolve
    });
    const state = await settled.promise;
    assert.deepEqual(texts, []);
    assert.equal(state.following, false);
    assert.equal(state.loading, false);
    assert.ok(state.error);
  });

  it("stop() ends it: no further reads, including after wake", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = server("x\n", 1024, { live: true });
    const settled = receipt();
    const follower = startLogFollower({ read: (o) => s.read(o), live: () => true, onText: () => undefined, onState: settled.resolve });
    t.after(() => follower.stop());
    await settled.promise;
    follower.stop();
    t.mock.timers.runAll();
    follower.wake();
    assert.deepEqual(s.reads, [0]);
  });

  it("a live log held at a partial last line waits for the next poll instead of spinning", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reads = 0;
    let allowedReads = 1;
    let settled = receipt();
    const follower = startLogFollower({
      read: async (offset) => {
        reads += 1;
        // Stop a broken immediate-retry loop so it fails below instead of hanging.
        assert.ok(reads <= allowedReads);
        return { text: "", nextOffset: offset, eof: false, size: 10, live: true };
      },
      live: () => true,
      onText: () => undefined,
      onState: (state) => settled.resolve(state)
    });
    t.after(() => follower.stop());
    await settled.promise;
    assert.equal(reads, 1);
    allowedReads = 2;
    settled = receipt();
    t.mock.timers.runAll();
    await settled.promise;
    assert.equal(reads, 2);
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
