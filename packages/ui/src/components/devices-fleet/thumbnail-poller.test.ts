import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  THUMBNAIL_INTERVAL_MS,
  ThumbnailPoller,
  thumbnailBackoffMs,
  thumbnailErrorText,
  type ThumbnailDeps,
  type ThumbnailSnapshot
} from "./thumbnail-poller.ts";

interface Pending {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  resolve: (response: { ok: boolean; status: number; blob: () => Promise<Blob> }) => void;
  reject: (error: unknown) => void;
}

/** A clock, timers and fetches the test advances by hand. */
function harness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const fetches: Pending[] = [];
  const revoked: string[] = [];
  let created = 0;
  const deps: ThumbnailDeps = {
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        fetches.push({ url, headers: init.headers, signal: init.signal, resolve: resolve as Pending["resolve"], reject });
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
    createObjectURL: () => `blob:${++created}`,
    revokeObjectURL: (url) => {
      revoked.push(url);
    }
  };
  const snapshots: ThumbnailSnapshot[] = [];
  const poller = new ThumbnailPoller(deps, (snapshot) => snapshots.push(snapshot));
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    poller,
    fetches,
    revoked,
    snapshots,
    timers,
    /** Move the clock, firing due timers in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    async answer(index: number, ok = true, status = 200, bytes = 10) {
      fetches[index]!.resolve({ ok, status, blob: async () => new Blob([new Uint8Array(bytes)]) });
      await flush();
    },
    async fail(index: number) {
      fetches[index]!.reject(new TypeError("network"));
      await flush();
    },
    flush
  };
}

describe("thumbnail poller", () => {
  it("polls only while it has a URL, is on screen and the page is visible", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot");
    assert.equal(h.fetches.length, 0, "not on screen yet");
    h.poller.setOnScreen(true);
    assert.equal(h.fetches.length, 1);
    assert.equal(h.poller.snapshot.status, "loading");
    await h.answer(0);
    assert.deepEqual(h.poller.snapshot, { status: "live", src: "blob:1", error: null, frameAt: 0 });
  });

  it("asks about once a second, one request at a time", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot");
    h.poller.setOnScreen(true);
    h.advance(300);
    await h.answer(0);
    assert.equal(h.fetches.length, 1, "the next waits for the interval");
    h.advance(THUMBNAIL_INTERVAL_MS - 300 - 1);
    assert.equal(h.fetches.length, 1);
    h.advance(1);
    assert.equal(h.fetches.length, 2, "an interval after the previous one started");
    // A slow capture: the next starts right after it lands.
    h.advance(2_500);
    assert.equal(h.fetches.length, 2, "never two at once");
    await h.answer(1);
    h.advance(0);
    assert.equal(h.fetches.length, 3);
    assert.deepEqual(h.revoked, ["blob:1"], "the replaced frame is revoked");
  });

  it("pauses off screen (aborting the request, keeping the frame) and resumes at once after the interval", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot");
    h.poller.setOnScreen(true);
    await h.answer(0);
    h.advance(THUMBNAIL_INTERVAL_MS);
    assert.equal(h.fetches.length, 2);
    h.poller.setOnScreen(false);
    assert.equal(h.fetches[1]!.signal.aborted, true);
    await h.flush();
    assert.equal(h.poller.snapshot.status, "paused");
    assert.equal(h.poller.snapshot.src, "blob:1");
    h.advance(10_000);
    assert.equal(h.fetches.length, 2, "nothing while off screen");
    assert.equal(h.timers.size, 0);
    h.poller.setOnScreen(true);
    assert.equal(h.fetches.length, 3, "the interval passed: at once");
    assert.equal(h.poller.snapshot.status, "live");
  });

  it("pauses while the page is hidden", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot");
    h.poller.setOnScreen(true);
    await h.answer(0);
    h.poller.setPageVisible(false);
    h.advance(5_000);
    assert.equal(h.fetches.length, 1);
    assert.equal(h.poller.snapshot.status, "paused");
    h.poller.setPageVisible(true);
    assert.equal(h.fetches.length, 2);
  });

  it("keeps the last frame on failure and backs off, then recovers", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot");
    h.poller.setOnScreen(true);
    await h.answer(0);
    h.advance(THUMBNAIL_INTERVAL_MS);
    await h.answer(1, false, 502);
    assert.equal(h.poller.snapshot.status, "error");
    assert.equal(h.poller.snapshot.src, "blob:1");
    assert.equal(h.poller.snapshot.error, "The host did not answer");
    h.advance(thumbnailBackoffMs(1) - 1);
    assert.equal(h.fetches.length, 2);
    h.advance(1);
    assert.equal(h.fetches.length, 3);
    await h.fail(2);
    assert.equal(h.poller.snapshot.error, "Can't reach the host");
    h.advance(thumbnailBackoffMs(2));
    assert.equal(h.fetches.length, 4);
    await h.answer(3);
    assert.equal(h.poller.snapshot.status, "live");
    h.advance(THUMBNAIL_INTERVAL_MS);
    assert.equal(h.fetches.length, 5, "back to the interval");
  });

  it("starts over on a new URL and frees everything on dispose", async () => {
    const h = harness();
    h.poller.setUrl("http://d/a");
    h.poller.setOnScreen(true);
    await h.answer(0);
    h.poller.setUrl("http://d/b");
    assert.deepEqual(h.revoked, ["blob:1"]);
    assert.equal(h.fetches[1]!.url, "http://d/b");
    await h.answer(1);
    h.poller.setUrl(null);
    assert.equal(h.poller.snapshot.status, "off");
    assert.deepEqual(h.revoked, ["blob:1", "blob:2"]);
    h.poller.setUrl("http://d/c");
    await h.answer(2);
    h.advance(THUMBNAIL_INTERVAL_MS);
    h.poller.dispose();
    assert.equal(h.fetches[3]!.signal.aborted, true);
    assert.deepEqual(h.revoked, ["blob:1", "blob:2", "blob:3"]);
    assert.equal(h.timers.size, 0);
    h.poller.setOnScreen(true);
    assert.equal(h.fetches.length, 4, "a disposed poller stays quiet");
  });

  it("sends the auth headers with every request; new headers start over, equal ones do not", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot?device=x", { Authorization: "Bearer one" });
    h.poller.setOnScreen(true);
    assert.deepEqual(h.fetches[0]!.headers, { Authorization: "Bearer one" });
    assert.ok(!h.fetches[0]!.url.includes("token="));
    await h.answer(0);
    h.poller.setUrl("http://d/shot?device=x", { Authorization: "Bearer one" });
    assert.equal(h.fetches.length, 1, "the same URL and headers (a re-render) change nothing");
    h.poller.setUrl("http://d/shot?device=x", { Authorization: "Bearer two" });
    assert.equal(h.fetches.length, 2, "a new credential starts over");
    assert.deepEqual(h.fetches[1]!.headers, { Authorization: "Bearer two" });
    h.poller.dispose();
  });

  it("an empty answer keeps polling without replacing the frame", async () => {
    const h = harness();
    h.poller.setUrl("http://d/shot");
    h.poller.setOnScreen(true);
    await h.answer(0, true, 200, 0);
    assert.equal(h.poller.snapshot.status, "loading");
    assert.equal(h.poller.snapshot.src, null);
    h.advance(THUMBNAIL_INTERVAL_MS);
    assert.equal(h.fetches.length, 2);
  });
});

describe("thumbnail words and pauses", () => {
  it("back off 2 s, 5 s, 15 s, then 30 s", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(thumbnailBackoffMs), [THUMBNAIL_INTERVAL_MS, 2_000, 5_000, 15_000, 30_000, 30_000]);
  });

  it("name what failed", () => {
    assert.equal(thumbnailErrorText(null), "Can't reach the host");
    assert.equal(thumbnailErrorText(401), "Not allowed to view it");
    assert.equal(thumbnailErrorText(404), "The device is gone");
    assert.equal(thumbnailErrorText(503), "The host did not answer");
    assert.equal(thumbnailErrorText(418), "The host answered 418");
  });
});
