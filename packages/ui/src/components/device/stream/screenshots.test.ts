import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, it, mock } from "node:test";
import { ScreenshotPollSession } from "./screenshots.ts";
import { fakeCanvas, fakeImageBitmaps, settle, testDeps } from "./testing/fakes.ts";

const URL = "http://hub.test/vendor/serve-emu/api/screenshot?device=emulator-5600";
const sessions: ScreenshotPollSession[] = [];
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  mock.timers.reset();
});

it("retains only the current wait's abort listener across successful polls", async () => {
  const signals: AbortSignal[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Response(new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)]));
  }) as unknown as typeof globalThis.fetch;
  const bitmaps = fakeImageBitmaps(() => ({ width: 720, height: 1280 }));
  const session = new ScreenshotPollSession({
    url: URL,
    canvas: fakeCanvas(),
    deps: testDeps({ fetch, createImageBitmap: bitmaps.createImageBitmap })
  });
  sessions.push(session);
  await settle();
  const signal = signals[0];
  assert.ok(signal);
  const listeners = getEventListeners(signal, "abort").length;
  for (let poll = 0; poll < 3; poll++) {
    mock.timers.tick(1_000);
    await settle();
    assert.equal(getEventListeners(signal, "abort").length, listeners, "completed waits release their abort listeners");
  }
  session.close();
  assert.equal(signal.aborted, true);
  await settle();
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

it("polls with POST about once a second and paints each screenshot", async () => {
  const requests: Array<{ url: string; method?: string; auth: string | null }> = [];
  let status = 200;
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, auth: new Headers(init?.headers).get("authorization") });
    return new Response(status === 200 ? new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)]) : null, { status });
  }) as unknown as typeof globalThis.fetch;
  const bitmaps = fakeImageBitmaps(() => ({ width: 720, height: 1280 }));
  const frames: number[] = [];
  const session = new ScreenshotPollSession({
    url: URL,
    headers: { Authorization: "Bearer t" },
    canvas: fakeCanvas(),
    deps: testDeps({ fetch, createImageBitmap: bitmaps.createImageBitmap }),
    onFrame: () => frames.push(Date.now())
  });
  sessions.push(session);
  await settle();
  // The bearer rides as a header, never as `?token=` in the URL.
  assert.deepEqual(requests, [{ url: URL, method: "POST", auth: "Bearer t" }]);
  assert.equal(session.state, "live");
  mock.timers.tick(1_000);
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(frames, [0, 1_000]);
  assert.equal(session.stats().decoder, "png");
  status = 403;
  mock.timers.tick(1_000);
  await settle();
  assert.equal(session.error?.code, "unauthorized");
  mock.timers.tick(10_000);
  await settle();
  assert.equal(requests.length, 3);
});
