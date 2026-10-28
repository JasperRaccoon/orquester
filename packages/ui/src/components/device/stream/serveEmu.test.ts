import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ServeEmuSession } from "./serveEmu.ts";
import { fakeCanvas, fakeVideoDecoderClass, fakeWebSocketClass, readWsFixture, settle, browserApis, restoreBrowserApis } from "./testing/fakes.ts";
import type { DeviceStreamState } from "./types.ts";

// PTS bytes in the redacted captured hub messages (microseconds, big-endian).
const recordedPts = [42152605, 42481638, 42584979, 42685988, 42786445, 43456101, 43969561, 44469827, 44975995];
const recorded = readWsFixture("serve-emu-semu-v1.bin") as ArrayBuffer[];
const URL = "ws://hub.test/vendor/serve-emu/ws?device=emulator-5600&frame-meta=1&token=t";

const sessions: ServeEmuSession[] = [];
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  restoreBrowserApis();
  mock.timers.reset();
});

function setup(decoderOptions: Parameters<typeof fakeVideoDecoderClass>[0] = {}) {
  const sockets = fakeWebSocketClass();
  const decoders = fakeVideoDecoderClass(decoderOptions);
  const canvas = fakeCanvas();
  const frames: number[] = [];
  const states: DeviceStreamState[] = [];
  const warnings: string[] = [];
  const inputReady: boolean[] = [];
  browserApis({ WebSocket: sockets.WebSocket, VideoDecoder: decoders.VideoDecoder, EncodedVideoChunk: decoders.EncodedVideoChunk });
  const session = new ServeEmuSession({
    url: URL,
    canvas,
    onFrame: () => frames.push(canvas.width),
    onState: (state) => states.push(state),
    onWarning: (message) => warnings.push(message),
    onInputReady: (ready) => inputReady.push(ready)
  });
  sessions.push(session);
  return { session, sockets, decoders, canvas, frames, states, warnings, inputReady, socket: () => sockets.instances.at(-1)! };
}

describe("ServeEmuSession", () => {
  it("replays the recorded hub stream: configures from the SPS and decodes every frame in order", async () => {
    const t = setup();
    const socket = t.socket();
    assert.equal(socket.url, URL);
    assert.equal(socket.binaryType, "arraybuffer");
    socket.serverOpen();
    assert.deepEqual(t.inputReady, [true]);
    for (const frame of recorded) socket.receive(frame);
    await settle();
    assert.deepEqual(t.decoders.log.configs.map((c) => [c.codec, c.optimizeForLatency, "description" in c]), [["avc1.42c020", true, false]]);
    // Every frame arrived while the decoder configured; they are decoded in order, keyframe first.
    const chunks = t.decoders.log.chunks;
    assert.deepEqual(chunks.map((c) => c.type), ["key", ...Array(recorded.length - 1).fill("delta")]);
    assert.deepEqual(chunks.map((c) => c.timestamp), recordedPts);
    assert.equal(t.frames.length, recorded.length);
    assert.equal(t.session.state, "live");
    assert.deepEqual([t.canvas.width, t.canvas.height], [720, 1280]);
    assert.equal(t.session.stats().decoder, "avc1.42c020");
    assert.equal(t.session.stats().bytesReceived, recorded.reduce((n, f) => n + f.byteLength, 0));
  });

  it("decodes deltas with their SEMU pts once configured, and drops deltas before a keyframe", async () => {
    const t = setup();
    const socket = t.socket();
    socket.serverOpen();
    socket.receive(recorded[1]!); // a delta first: nothing to configure from, so ask for a keyframe
    assert.deepEqual(t.socket().json(), [{ type: "reset-video", ack: false }]);
    socket.receive(recorded[0]!);
    await settle();
    for (const frame of recorded.slice(1)) socket.receive(frame);
    const timestamps = t.decoders.log.chunks.map((c) => c.timestamp);
    assert.deepEqual(timestamps, recordedPts);
    assert.deepEqual(t.decoders.log.chunks.map((c) => c.type), ["key", ...Array(recorded.length - 1).fill("delta")]);
    assert.equal(t.frames.length, recorded.length);
  });

  it("rebuilds the decoder after a video-session message and asks for a keyframe", async () => {
    const t = setup();
    const socket = t.socket();
    socket.serverOpen();
    socket.receive(recorded[0]!);
    await settle();
    socket.receive(JSON.stringify({ type: "video-session", size: { width: 1280, height: 720 } }));
    assert.deepEqual(socket.json().at(-1), { type: "reset-video", ack: false });
    socket.receive(recorded[1]!); // stale delta from the old encoder: dropped
    socket.receive(recorded[0]!);
    await settle();
    assert.deepEqual(t.decoders.log.chunks.map((chunk) => chunk.type), ["key", "key"], "the stale delta never reaches the new decoder");
    assert.equal(t.frames.length, 2);
    assert.equal(t.session.state, "live");
  });

  it("surfaces rejected input and unknown messages as warnings and ignores acks", () => {
    const t = setup();
    const socket = t.socket();
    socket.serverOpen();
    socket.receive(JSON.stringify({ ok: true }));
    socket.receive(JSON.stringify({ ok: false, error: "session is starting" }));
    socket.receive(JSON.stringify({ type: "mystery" }));
    socket.receive("not json");
    assert.equal(t.warnings.length, 3);
    assert.ok(t.warnings[0]!.includes("session is starting"), "the provider rejection is available to the caller");
  });

  it("sends serve-emu input JSON: touch, keys, buttons and chunked text", () => {
    const t = setup();
    const socket = t.socket();
    assert.equal(t.session.sendTouch("begin", 0.5, 0.5), false, "nothing is sent before the socket opens");
    socket.serverOpen();
    t.session.sendTouch("begin", 0.25, 1.5);
    t.session.sendTouch("move", 0.3, 0.6);
    t.session.sendTouch("end", -1, 0.6);
    t.session.sendKey(67);
    t.session.sendKey(31, "down", 0x1000);
    t.session.sendButton("recents");
    assert.equal(t.session.sendText("a".repeat(301)), true);
    assert.deepEqual(socket.json(), [
      { type: "touch", action: "down", x: 0.25, y: 1, ack: false },
      { type: "touch", action: "move", x: 0.3, y: 0.6, ack: false },
      { type: "touch", action: "up", x: 0, y: 0.6, ack: false },
      { type: "key", keycode: 67 },
      { type: "key", keycode: 31, action: "down", metaState: 0x1000 },
      { type: "recents" },
      { type: "text", text: "a".repeat(300) },
      { type: "text", text: "a" }
    ]);
  });

  it("fails fatally when the browser can't decode the stream's profile", async () => {
    const t = setup({ supported: () => false });
    t.socket().serverOpen();
    t.socket().receive(recorded[0]!);
    await settle();
    assert.equal(t.session.state, "error");
    assert.equal(t.session.error?.code, "unsupported");
    assert.equal(t.session.error?.fatal, true);
  });

  it("resyncs on a decoder error without dropping the connection", async () => {
    const t = setup();
    const socket = t.socket();
    socket.serverOpen();
    socket.receive(recorded[0]!);
    await settle();
    t.decoders.log.instances[0]!.fail(new Error("corrupt"));
    assert.equal(t.warnings.length, 1);
    assert.deepEqual(socket.json().at(-1), { type: "reset-video", ack: false });
    assert.equal(t.sockets.instances.length, 1);
    socket.receive(recorded[0]!);
    await settle();
    assert.equal(t.frames.length, 2);
    assert.equal(t.session.state, "live");
  });

  it("reconnects with backoff when the socket drops, and stops on a policy close", () => {
    const t = setup();
    t.socket().serverOpen();
    t.socket().serverClose(1006);
    assert.equal(t.session.state, "connecting");
    assert.equal(t.session.error?.code, "network");
    mock.timers.tick(500);
    assert.equal(t.sockets.instances.length, 2);
    t.socket().serverClose(1008, "bad token");
    assert.equal(t.session.state, "error");
    assert.equal(t.session.error?.code, "unauthorized");
    mock.timers.tick(60_000);
    assert.equal(t.sockets.instances.length, 2);
  });

  it("close() closes the socket and goes quiet", () => {
    const t = setup();
    const socket = t.socket();
    socket.serverOpen();
    t.session.close();
    assert.equal(socket.readyState, 3);
    assert.equal(t.session.state, "closed");
    socket.receive(recorded[0]!);
    assert.equal(t.decoders.log.configs.length, 0);
    assert.equal(t.session.sendButton("home"), false);
  });

  it("input-only mode is live on open and never decodes", async () => {
    const sockets = fakeWebSocketClass();
    const decoders = fakeVideoDecoderClass();
    browserApis({ WebSocket: sockets.WebSocket, VideoDecoder: decoders.VideoDecoder, EncodedVideoChunk: decoders.EncodedVideoChunk });
    const session = new ServeEmuSession({
      url: URL.replace("frame-meta=1", "video=0"),
      canvas: fakeCanvas(),
      video: false
    });
    sockets.instances[0]!.serverOpen();
    assert.equal(session.state, "live");
    mock.timers.tick(120_000);
    assert.equal(session.state, "live");
    assert.equal(sockets.instances.length, 1, "an input-only connection has no video-silence reconnect");
    sockets.instances[0]!.receive(recorded[0]!);
    await settle();
    assert.equal(decoders.log.configs.length, 0);
    assert.equal(session.sendButton("home"), true);
    session.close();
  });
});
