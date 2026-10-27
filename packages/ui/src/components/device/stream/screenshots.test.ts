import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { act } from "react";
import { streamDom } from "./testing/dom.ts";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ScreenshotPollSession } from "./screenshots.ts";
import { fakeCanvas, fakeImageBitmaps, fakeWebSocketClass, settle, browserApis, restoreBrowserApis } from "./testing/fakes.ts";

const URL = "http://hub.test/vendor/serve-emu/api/screenshot?device=emulator-5600";
const fixture = streamDom();
const sessions: ScreenshotPollSession[] = [];
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 }));
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  restoreBrowserApis();
  mock.timers.reset();
});

it("polls with POST about once a second and paints each screenshot", async () => {
  const requests: Array<{ url: string; method?: string; auth: string | null }> = [];
  const signals: AbortSignal[] = [];
  let status = 200;
  const fetch = (async (url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    requests.push({ url, method: init?.method, auth: new Headers(init?.headers).get("authorization") });
    return new Response(status === 200 ? new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)]) : null, { status });
  }) as unknown as typeof globalThis.fetch;
  const bitmaps = fakeImageBitmaps(() => ({ width: 720, height: 1280 }));
  const frames: number[] = [];
  browserApis({ fetch, createImageBitmap: bitmaps.createImageBitmap });
  const session = new ScreenshotPollSession({
    url: URL,
    headers: { Authorization: "Bearer t" },
    canvas: fakeCanvas(),
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
  // 610d3c53 fixes retained abort closures after each completed poll.
  for (let poll = 0; poll < 3; poll++) {
    mock.timers.tick(1_000);
    await settle();
    assert.ok(signals.every((signal) => getEventListeners(signal, "abort").length <= 1), "completed polls do not accumulate abort handlers");
  }
  status = 403;
  mock.timers.tick(1_000);
  await settle();
  assert.equal(session.error?.code, "unauthorized");
  mock.timers.tick(10_000);
  await settle();
  assert.equal(requests.length, 6);
  session.close();
  assert.ok(signals.every((signal) => signal.aborted));
  assert.ok(signals.every((signal) => getEventListeners(signal, "abort").length === 0));
});

const EMU_WS = "ws://daemon.test/ws-device/local/vendor/serve-emu/ws?device=emulator-5600&frame-meta=1&token=t";
const SHOT = "http://daemon.test/api/devices/hosts/local/hub/vendor/serve-emu/api/screenshot?device=emulator-5600";
const AUTH = { Authorization: "Bearer t" };

describe("useDeviceStream without WebCodecs", () => {
  it("falls back to screenshots plus an input-only socket when the browser can't decode H.264", async () => {
    const ws = fakeWebSocketClass();
    const requests: Array<[string, string | undefined, string | null]> = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      requests.push([url, init?.method, new Headers(init?.headers).get("authorization")]);
      return new Response(new Blob([Uint8Array.of(1)]));
    }) as unknown as typeof globalThis.fetch;
    const bitmaps = fakeImageBitmaps();
    browserApis({ WebSocket: ws.WebSocket, fetch, createImageBitmap: bitmaps.createImageBitmap, VideoDecoder: undefined, EncodedVideoChunk: undefined });
    await fixture.render({
      platform: "android",
      urls: { video: EMU_WS, screenshot: SHOT, headers: AUTH },
      enabled: true,
    });
    assert.equal(fixture.handle.transport, "screenshots");
    assert.equal(ws.instances[0]!.url, "ws://daemon.test/ws-device/local/vendor/serve-emu/ws?device=emulator-5600&token=t&video=0");
    await act(() => settle());
    assert.deepEqual(requests, [[SHOT, "POST", "Bearer t"]]);
    assert.equal(fixture.handle.state, "live");
    act(() => ws.instances[0]!.serverOpen());
    assert.equal(fixture.handle.sendButton("home"), true);
  });

  it("reports an error for Android without WebCodecs and no screenshot URL", async () => {
    const ws = fakeWebSocketClass();
    browserApis({ WebSocket: ws.WebSocket, VideoDecoder: undefined, EncodedVideoChunk: undefined });
    await fixture.render({ platform: "android", urls: { video: EMU_WS }, enabled: true });
    assert.equal(fixture.handle.state, "error");
    assert.equal(fixture.handle.error?.code, "unsupported");
  });

});
