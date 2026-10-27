/**
 * `useDeviceStream` in a DOM: it owns a canvas, connects only while enabled,
 * routes input through the right channel, falls back from H.264 to MJPEG
 * when the host never sends video, and closes everything on unmount.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { BrowserStreamCaps } from "./capabilities.ts";
import {
  encodeAvccEnvelope,
  fakeImageBitmaps,
  fakeStreamingFetch,
  fakeVideoDecoderClass,
  fakeWebSocketClass,
  readWsFixture,
  settle,
  testDeps
} from "./testing/fakes.ts";
import { serveSimStreamUrl, useDeviceStream, withQueryParams, type DeviceStreamHandle, type UseDeviceStreamOptions } from "./useDeviceStream.ts";

const FULL: BrowserStreamCaps = { webCodecs: true, h264Baseline: true, h264High: true };
const NONE: BrowserStreamCaps = { webCodecs: false, h264Baseline: false, h264High: false };
const EMU_WS = "ws://daemon.test/ws-device/local/vendor/serve-emu/ws?device=emulator-5600&frame-meta=1&token=t";
const SHOT = "http://daemon.test/api/devices/hosts/local/hub/vendor/serve-emu/api/screenshot?device=emulator-5600";
const AVCC = "http://daemon.test/api/devices/hosts/mac/hub/vendor/serve-sim/helper/UDID/stream.avcc";
/** The fetched URLs' auth: a header, never `?token=` (the WebSocket URLs keep theirs). */
const AUTH = { Authorization: "Bearer t" };
const SIM_WS = "ws://daemon.test/ws-device/mac/vendor/serve-sim/helper/ws?device=UDID&token=t";

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "navigator"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let frameQueue: FrameRequestCallback[] = [];

before(() => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  const define = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  for (const name of globals) define(name, (dom.window as unknown as Record<string, unknown>)[name]);
  define("requestAnimationFrame", (callback: FrameRequestCallback) => frameQueue.push(callback));
  define("cancelAnimationFrame", () => {});
  // jsdom has no 2D canvas; a recording context is enough for painting.
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

after(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const runFrames = () =>
  act(() => {
    const queued = frameQueue;
    frameQueue = [];
    for (const callback of queued) callback(0);
  });

describe("useDeviceStream", () => {
  let root: Root;
  let host: HTMLElement;
  let handle: DeviceStreamHandle;

  const Probe = (props: UseDeviceStreamOptions) => {
    handle = useDeviceStream(props);
    return null;
  };
  const render = (props: UseDeviceStreamOptions) => act(() => root.render(createElement(Probe, props)));

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    frameQueue = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mock.timers.reset();
  });

  it("streams Android over serve-emu while enabled and routes input through the same socket", async () => {
    const ws = fakeWebSocketClass();
    const decoders = fakeVideoDecoderClass();
    let frames = 0;
    const props: UseDeviceStreamOptions = {
      platform: "android",
      urls: { video: EMU_WS },
      enabled: false,
      browserCaps: FULL,
      onFrame: () => frames++,
      deps: testDeps({ WebSocket: ws.WebSocket, VideoDecoder: decoders.VideoDecoder, EncodedVideoChunk: decoders.EncodedVideoChunk })
    };
    render(props);
    assert.equal(handle.state, "closed");
    assert.equal(ws.instances.length, 0);
    const canvas = handle.canvas;
    assert.ok(canvas instanceof dom.window.HTMLCanvasElement);

    render({ ...props, enabled: true });
    assert.equal(handle.transport, "serve-emu");
    assert.equal(handle.state, "connecting");
    const socket = ws.instances[0]!;
    assert.equal(socket.url, EMU_WS);
    act(() => socket.serverOpen());
    assert.equal(handle.inputReady, true);
    await act(async () => {
      for (const frame of readWsFixture("serve-emu-semu-v1.bin")) socket.receive(frame);
      await settle();
    });
    assert.equal(handle.state, "live");
    assert.ok(frames > 0);
    assert.deepEqual(handle.screenConfig, { width: 720, height: 1280, orientation: "portrait" });
    assert.equal(handle.canvas, canvas, "the canvas is stable");
    act(() => mock.timers.tick(1_000));
    assert.equal(handle.stats?.decoder, "avc1.42c020");

    handle.sendTouch("begin", 0.5, 0.5);
    handle.sendTouch("move", 0.5, 0.4);
    handle.sendTouch("move", 0.5, 0.3);
    runFrames();
    handle.sendTouch("end", 0.5, 0.3);
    assert.equal(handle.sendKey({ key: "c", code: "KeyC", ctrlKey: true }, "down"), true);
    assert.equal(handle.sendKey({ key: "x", code: "KeyX" }, "down"), true);
    assert.equal(handle.sendButton("back"), true);
    assert.equal(handle.sendText("hi"), true);
    const input = socket.json().filter((m) => (m as { type: string }).type !== "reset-video");
    assert.deepEqual(input, [
      { type: "touch", action: "down", x: 0.5, y: 0.5, ack: false },
      { type: "touch", action: "move", x: 0.5, y: 0.3, ack: false },
      { type: "touch", action: "up", x: 0.5, y: 0.3, ack: false },
      { type: "key", keycode: 31, action: "down", metaState: 0x1000 },
      { type: "text", text: "x" },
      { type: "back" },
      { type: "text", text: "hi" }
    ]);

    render({ ...props, enabled: false });
    assert.equal(socket.readyState, 3);
    assert.equal(handle.state, "closed");
  });

  it("falls back to screenshots plus an input-only socket when the browser can't decode H.264", async () => {
    const ws = fakeWebSocketClass();
    const requests: Array<[string, string | undefined, string | null]> = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      requests.push([url, init?.method, new Headers(init?.headers).get("authorization")]);
      return new Response(new Blob([Uint8Array.of(1)]));
    }) as unknown as typeof globalThis.fetch;
    const bitmaps = fakeImageBitmaps();
    render({
      platform: "android",
      urls: { video: EMU_WS, screenshot: SHOT, headers: AUTH },
      enabled: true,
      browserCaps: NONE,
      deps: testDeps({ WebSocket: ws.WebSocket, fetch, createImageBitmap: bitmaps.createImageBitmap })
    });
    assert.equal(handle.transport, "screenshots");
    assert.equal(ws.instances[0]!.url, "ws://daemon.test/ws-device/local/vendor/serve-emu/ws?device=emulator-5600&token=t&video=0");
    await act(() => settle());
    assert.deepEqual(requests, [[SHOT, "POST", "Bearer t"]]);
    assert.equal(handle.state, "live");
    act(() => ws.instances[0]!.serverOpen());
    assert.equal(handle.sendButton("home"), true);
  });

  it("reports an error for Android without WebCodecs and no screenshot URL", () => {
    const ws = fakeWebSocketClass();
    render({ platform: "android", urls: { video: EMU_WS }, enabled: true, browserCaps: NONE, deps: testDeps({ WebSocket: ws.WebSocket }) });
    assert.equal(handle.state, "error");
    assert.equal(handle.error?.code, "unsupported");
  });

  it("switches iOS from H.264 to MJPEG when the host only sends the seed", async () => {
    const ws = fakeWebSocketClass();
    const http = fakeStreamingFetch();
    const decoders = fakeVideoDecoderClass();
    const bitmaps = fakeImageBitmaps();
    const warnings: string[] = [];
    render({
      platform: "ios",
      urls: { video: AVCC, input: SIM_WS, headers: AUTH },
      enabled: true,
      browserCaps: FULL,
      hostCaps: { h264: true },
      onWarning: (message) => warnings.push(message),
      deps: testDeps({
        WebSocket: ws.WebSocket,
        fetch: http.fetch,
        createImageBitmap: bitmaps.createImageBitmap,
        VideoDecoder: decoders.VideoDecoder,
        EncodedVideoChunk: decoders.EncodedVideoChunk
      })
    });
    assert.equal(handle.transport, "serve-sim-h264");
    await act(() => settle());
    assert.equal(http.requests[0]!.url, AVCC);
    assert.equal(new Headers(http.requests[0]!.init?.headers).get("authorization"), "Bearer t");
    await act(async () => {
      http.requests[0]!.push(encodeAvccEnvelope(4, Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)));
      await settle();
    });
    assert.equal(handle.state, "live");
    act(() => mock.timers.tick(2_000));
    assert.equal(handle.state, "stalled");
    act(() => mock.timers.tick(6_000));
    await act(() => settle());
    assert.equal(handle.transport, "serve-sim-mjpeg");
    assert.equal(http.requests.at(-1)!.url, serveSimStreamUrl(AVCC, "stream.mjpeg"));
    assert.equal(new Headers(http.requests.at(-1)!.init?.headers).get("authorization"), "Bearer t", "the MJPEG fallback keeps the header");
    assert.match(warnings.join("\n"), /Switching to MJPEG/);
    assert.equal(ws.instances.length, 2, "the input socket is reopened with the new session");

    const sim = ws.instances.at(-1)!;
    act(() => {
      sim.serverOpen();
      sim.receive(Uint8Array.of(0x83).buffer);
    });
    assert.equal(handle.inputReady, true);
    assert.equal(handle.sendButton("recents"), true);
    assert.equal(handle.sendButton("back"), false);
    assert.equal(handle.sendKey({ key: "a", code: "KeyA" }, "down"), true);
    const sent = sim.sent.map((b) => (b as Uint8Array)[0]);
    assert.deepEqual(sent, [0x04, 0x06]);
  });
});

describe("URL helpers", () => {
  it("swaps the serve-sim stream file and keeps the query", () => {
    assert.equal(serveSimStreamUrl(AVCC, "stream.mjpeg"), AVCC.replace("stream.avcc", "stream.mjpeg"));
    assert.equal(serveSimStreamUrl("/hub/helper/U/stream.mjpeg", "stream.avcc"), "/hub/helper/U/stream.avcc");
  });

  it("sets and deletes query parameters on absolute and relative URLs", () => {
    assert.equal(withQueryParams("/a/ws?device=x&frame-meta=1&token=t", { video: "0", "frame-meta": null }), "/a/ws?device=x&token=t&video=0");
    assert.equal(withQueryParams("wss://h/ws?a=1", { b: "2" }), "wss://h/ws?a=1&b=2");
  });
});
