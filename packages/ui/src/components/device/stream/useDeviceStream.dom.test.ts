/**
 * `useDeviceStream` in a DOM: it owns a canvas, connects only while enabled,
 * routes input through the right channel, falls back from H.264 to MJPEG
 * when the host never sends video, and closes everything on unmount.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { act } from "react";
import {
  encodeAvccEnvelope,
  fakeImageBitmaps,
  fakeStreamingFetch,
  fakeVideoDecoderClass,
  fakeWebSocketClass,
  readWsFixture,
  settle,
  browserApis,
  restoreBrowserApis
} from "./testing/fakes.ts";
import type { UseDeviceStreamOptions } from "./useDeviceStream.ts";
import { streamDom } from "./testing/dom.ts";

const EMU_WS = "ws://daemon.test/ws-device/local/vendor/serve-emu/ws?device=emulator-5600&frame-meta=1&token=t";
const AVCC = "http://daemon.test/api/devices/hosts/mac/hub/vendor/serve-sim/helper/UDID/stream.avcc";
/** The fetched URLs' auth: a header, never `?token=` (the WebSocket URLs keep theirs). */
const AUTH = { Authorization: "Bearer t" };
const SIM_WS = "ws://daemon.test/ws-device/mac/vendor/serve-sim/helper/ws?device=UDID&token=t";

const fixture = streamDom();
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 }));
afterEach(() => {
  restoreBrowserApis();
  mock.timers.reset();
});

describe("useDeviceStream", () => {
  it("streams Android over serve-emu while enabled and routes input through the same socket", async () => {
    const ws = fakeWebSocketClass();
    const decoders = fakeVideoDecoderClass();
    browserApis({ WebSocket: ws.WebSocket, VideoDecoder: decoders.VideoDecoder, EncodedVideoChunk: decoders.EncodedVideoChunk });
    let frames = 0;
    const props: UseDeviceStreamOptions = {
      platform: "android",
      urls: { video: EMU_WS },
      enabled: false,
      onFrame: () => frames++,
    };
    await fixture.render(props);
    assert.equal(fixture.handle.state, "closed");
    assert.equal(ws.instances.length, 0);
    const canvas = fixture.handle.canvas;
    assert.ok(canvas);

    await fixture.render({ ...props, enabled: true });
    assert.equal(fixture.handle.transport, "serve-emu");
    assert.equal(fixture.handle.state, "connecting");
    const socket = ws.instances[0]!;
    assert.equal(socket.url, EMU_WS);
    act(() => socket.serverOpen());
    assert.equal(fixture.handle.inputReady, true);
    await act(async () => {
      for (const frame of readWsFixture("serve-emu-semu-v1.bin")) socket.receive(frame);
      await settle();
    });
    assert.equal(fixture.handle.state, "live");
    assert.ok(frames > 0);
    assert.deepEqual(fixture.handle.screenConfig, { width: 720, height: 1280, orientation: "portrait" });
    assert.equal(fixture.handle.canvas, canvas, "the canvas is stable");
    act(() => mock.timers.tick(1_000));
    assert.equal(fixture.handle.stats?.decoder, "avc1.42c020");

    fixture.handle.sendTouch("begin", 0.5, 0.5);
    fixture.handle.sendTouch("move", 0.5, 0.4);
    fixture.handle.sendTouch("move", 0.5, 0.3);
    fixture.runFrames();
    fixture.handle.sendTouch("end", 0.5, 0.3);
    assert.equal(fixture.handle.sendKey({ key: "c", code: "KeyC", ctrlKey: true }, "down"), true);
    assert.equal(fixture.handle.sendKey({ key: "x", code: "KeyX" }, "down"), true);
    assert.equal(fixture.handle.sendButton("back"), true);
    assert.equal(fixture.handle.sendText("hi"), true);
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

    await fixture.render({ ...props, enabled: false });
    assert.equal(socket.readyState, 3);
    assert.equal(fixture.handle.state, "closed");
  });

  it("switches iOS from H.264 to MJPEG when the host only sends the seed", async () => {
    const ws = fakeWebSocketClass();
    const http = fakeStreamingFetch();
    const decoders = fakeVideoDecoderClass();
    const bitmaps = fakeImageBitmaps();
    const warnings: string[] = [];
    browserApis({ WebSocket: ws.WebSocket, fetch: http.fetch, createImageBitmap: bitmaps.createImageBitmap, VideoDecoder: decoders.VideoDecoder, EncodedVideoChunk: decoders.EncodedVideoChunk });
    await fixture.render({
      platform: "ios",
      urls: { video: AVCC, input: SIM_WS, headers: AUTH },
      enabled: true,
      hostCaps: { h264: true },
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(fixture.handle.transport, "serve-sim-h264");
    await act(() => settle());
    assert.equal(http.requests[0]!.url, AVCC);
    assert.equal(new Headers(http.requests[0]!.init?.headers).get("authorization"), "Bearer t");
    await act(async () => {
      http.requests[0]!.push(encodeAvccEnvelope(4, Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)));
      await settle();
    });
    assert.equal(fixture.handle.state, "live");
    act(() => mock.timers.tick(2_000));
    assert.equal(fixture.handle.state, "stalled");
    act(() => mock.timers.tick(6_000));
    await act(() => settle());
    assert.equal(fixture.handle.transport, "serve-sim-mjpeg");
    assert.equal(http.requests.at(-1)!.url, "http://daemon.test/api/devices/hosts/mac/hub/vendor/serve-sim/helper/UDID/stream.mjpeg");
    assert.equal(new Headers(http.requests.at(-1)!.init?.headers).get("authorization"), "Bearer t", "the MJPEG fallback keeps the header");
    assert.ok(warnings.length > 0, "fallback is observable to the caller");
    assert.equal(ws.instances[0]!.readyState, 3, "the old input connection is closed");

    const sim = ws.instances.at(-1)!;
    act(() => {
      sim.serverOpen();
      sim.receive(Uint8Array.of(0x83).buffer);
    });
    assert.equal(fixture.handle.inputReady, true);
    assert.equal(fixture.handle.sendButton("recents"), true);
    assert.equal(fixture.handle.sendButton("back"), false);
    assert.equal(fixture.handle.sendKey({ key: "a", code: "KeyA" }, "down"), true);
    const sent = sim.sent.map((b) => (b as Uint8Array)[0]);
    assert.deepEqual(sent, [0x04, 0x06]);
  });
});
