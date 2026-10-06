import test, { afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  DesktopAudioController,
  type AudioSocket,
  type DecoderSink,
  type DesktopAudioControllerDeps,
  type DesktopAudioDecoderKind,
  type DesktopAudioInputs
} from "./controller.ts";
import type { DesktopAudioStats } from "./jitter-buffer.ts";

class FakeSocket implements AudioSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onmessage: AudioSocket["onmessage"] = null;
  onclose: AudioSocket["onclose"] = null;
  onerror: AudioSocket["onerror"] = null;
  sent: string[] = [];
  closedWith: number | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1005): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

interface Harness {
  controller: DesktopAudioController;
  sockets: FakeSocket[];
  decoders: { kind: string; decoded: number[]; payloads: number[][]; sink: DecoderSink; closed: boolean }[];
  players: { pushed: Float32Array[][]; disposed: boolean; onStats(stats: DesktopAudioStats): void }[];
  volumes: number[];
  outputs: number;
  readonly current: FakeSocket | undefined;
}

// Controllers hold keepalive intervals while streaming; close them so the test process can exit.
const live: DesktopAudioController[] = [];
afterEach(() => {
  for (const controller of live.splice(0)) controller.dispose();
});

async function harness(kind: DesktopAudioDecoderKind | Promise<DesktopAudioDecoderKind> = "webcodecs"): Promise<Harness> {
  const h: Omit<Harness, "controller" | "current"> = { sockets: [], decoders: [], players: [], volumes: [], outputs: 0 };
  const deps: DesktopAudioControllerDeps = {
    detectDecoder: () => Promise.resolve(kind),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      h.sockets.push(socket);
      return socket;
    },
    createDecoder: (decoderKind, sink) => {
      const decoder = { kind: decoderKind, decoded: [] as number[], payloads: [] as number[][], sink, closed: false };
      h.decoders.push(decoder);
      return {
        decode(seq, packet) {
          decoder.decoded.push(seq);
          decoder.payloads.push([...packet]);
        },
        close() {
          decoder.closed = true;
        }
      };
    },
    createOutput: (volume) => {
      h.outputs++;
      h.volumes.push(volume);
      return {
        setVolume: (next) => h.volumes.push(next),
        openPlayer: async ({ onStats }) => {
          const player = { pushed: [] as Float32Array[][], disposed: false, onStats };
          h.players.push(player);
          return {
            push: (planes) => player.pushed.push(planes),
            dispose: () => {
              player.disposed = true;
            }
          };
        },
        dispose: () => {}
      };
    }
  };
  const controller = new DesktopAudioController(deps);
  live.push(controller);
  await flush();
  return Object.defineProperties(h, {
    controller: { value: controller },
    current: { get: () => h.sockets.at(-1) }
  }) as Harness;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const PLAYING: DesktopAudioInputs = { url: "wss://host/ws-desktop-audio/d1?token=t", active: true, unlocked: true, muted: false, volume: 0.8 };

function packet(seq: number, bytes: number[] = [0xfc, 0xff, 0xfe], type = 1): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + bytes.length);
  const view = new DataView(buffer);
  view.setUint8(0, type);
  view.setUint32(4, seq, false);
  new Uint8Array(buffer, 8).set(bytes);
  return buffer;
}

function isOpen(socket: FakeSocket | undefined): boolean {
  return socket !== undefined && socket.closedWith === null;
}

// ---------- decision table ----------

test("the controller streams only with an active unlocked unmuted tab and a URL", async () => {
  const h = await harness();
  for (const patch of [
    { url: null }, { url: "" }, { active: false }, { unlocked: false }, { muted: true }
  ]) {
    h.controller.update(PLAYING);
    assert.equal(isOpen(h.current), true);
    assert.equal(h.current?.binaryType, "arraybuffer");
    h.controller.update({ ...PLAYING, ...patch });
    assert.equal(isOpen(h.current), false, JSON.stringify(patch));
  }
});

test("staying in the playing state keeps the one socket", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  h.controller.update({ ...PLAYING, volume: 0.3 });
  h.controller.update(PLAYING);
  assert.equal(h.sockets.length, 1);
  assert.ok(isOpen(h.current));
});

test("a new url (fresh token) replaces the socket", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  h.controller.update({ ...PLAYING, url: "wss://host/ws-desktop-audio/d1?token=u" });
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0]!.closedWith, 1000);
  assert.equal(h.current!.url, "wss://host/ws-desktop-audio/d1?token=u");
});

test("no socket without a usable decoder; none until detection finishes", async () => {
  const none = await harness("none");
  none.controller.update(PLAYING);
  assert.equal(none.sockets.length, 0);
  assert.equal(none.controller.getSnapshot().decoder, "none");

  let resolve!: (kind: DesktopAudioDecoderKind) => void;
  const pending = await harness(new Promise<DesktopAudioDecoderKind>((r) => (resolve = r)));
  pending.controller.update(PLAYING);
  assert.equal(pending.controller.getSnapshot().decoder, "checking");
  assert.equal(pending.sockets.length, 0);
  resolve("wasm");
  await flush();
  assert.equal(pending.sockets.length, 1);
  assert.equal(pending.decoders[0]!.kind, "wasm");
});

// ---------- volume ----------

test("volume drives the gain; mute zeroes it and closes the socket", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  assert.deepEqual(h.volumes, [0.8], "the GainNode starts at the volume");
  h.controller.update({ ...PLAYING, volume: 0.25 });
  assert.equal(h.volumes.at(-1), 0.25);
  h.controller.update({ ...PLAYING, volume: 7 });
  assert.equal(h.volumes.at(-1), 1);
  h.controller.update({ ...PLAYING, muted: true });
  assert.equal(h.volumes.at(-1), 0);
  assert.equal(isOpen(h.current), false);
  assert.equal(h.outputs, 1, "one GainNode per desktop, reused across streams");
});

// ---------- packets ----------

test("audio packet headers deliver unsigned big-endian sequences and reject invalid frames", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  const socket = h.current!;
  socket.receive(packet(0x01020304, [9, 8, 7]));
  const flagged = packet(5, [6]);
  new DataView(flagged).setUint8(1, 0xff);
  new DataView(flagged).setUint16(2, 0xabcd);
  socket.receive(flagged);
  socket.receive(packet(0xffffffff, [5]));
  for (const invalid of [packet(1, [1], 2), packet(1, []), new ArrayBuffer(3)]) socket.receive(invalid);
  assert.deepEqual(h.decoders[0]!.decoded, [0x01020304, 5, 0xffffffff]);
  assert.deepEqual(h.decoders[0]!.payloads, [[9, 8, 7], [6], [5]]);
});

test("audio state messages reach the viewer and malformed messages leave it unchanged", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  h.current!.receive('{"type":"state","audio":"unavailable","reason":"no pulse","sampleRate":48000,"channels":2,"frameMs":10}');
  assert.deepEqual(h.controller.getSnapshot().serverState, {
    type: "state", audio: "unavailable", reason: "no pulse", sampleRate: 48000, channels: 2, frameMs: 10
  });
  h.current!.receive('{"type":"state","audio":"available","sampleRate":48000,"channels":2,"frameMs":10}');
  const before = h.controller.getSnapshot().serverState;
  assert.equal(before?.audio, "available");
  for (const text of ['{"type":"state","audio":"maybe"}', "not json", "null"]) h.current!.receive(text);
  assert.deepEqual(h.controller.getSnapshot().serverState, before);
});

test("packets reach the decoder in order and a seq gap inserts nothing", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  const socket = h.current!;
  socket.open();
  for (const seq of [10, 11, 14, 15]) socket.receive(packet(seq, [seq]));
  socket.receive(packet(16, [1], 7)); // not an Opus packet: ignored
  socket.receive("garbage");
  const decoder = h.decoders[0]!;
  assert.deepEqual(decoder.decoded, [10, 11, 14, 15]);
  assert.deepEqual(decoder.payloads, [[10], [11], [14], [15]]);
});

test("decoded frames wait for the player, then flow; closing disposes both", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  const decoder = h.decoders[0]!;
  const early = [new Float32Array(480), new Float32Array(480)];
  decoder.sink.frames(early);
  await flush();
  const player = h.players[0]!;
  assert.deepEqual(player.pushed, [early]);
  const later = [new Float32Array(480), new Float32Array(480)];
  decoder.sink.frames(later);
  assert.equal(player.pushed.length, 2);

  player.onStats({ depthMs: 35, targetMs: 40, underruns: 1, drops: 0 });
  assert.equal(h.controller.getSnapshot().stats?.targetMs, 40);

  h.controller.update({ ...PLAYING, active: false });
  assert.equal(player.disposed, true);
  assert.equal(decoder.closed, true);
  assert.equal(h.controller.getSnapshot().stats, null);
});

// ---------- keepalive and reconnect ----------

test("keepalive pings every 10 s and drops a silent connection", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness();
  h.controller.update(PLAYING);
  const socket = h.current!;
  socket.open();
  socket.receive(packet(1));
  t.mock.timers.tick(10_000);
  assert.deepEqual(socket.sent, ['{"type":"ping"}']);
  socket.receive('{"type":"pong"}');
  t.mock.timers.tick(10_000);
  assert.equal(socket.sent.length, 2);
  // Nothing at all for a full interval: dead.
  t.mock.timers.tick(10_000);
  assert.equal(isOpen(socket), false);
  assert.ok(h.controller.getSnapshot().error);
  t.mock.timers.tick(500);
  assert.equal(h.sockets.length, 2, "reconnected after the backoff");
});

test("an unexpected close reconnects with growing backoff; data resets it", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness();
  h.controller.update(PLAYING);
  h.current!.serverClose(1011, "desktop not running");
  assert.ok(h.controller.getSnapshot().error?.includes("desktop not running"));
  t.mock.timers.tick(499);
  assert.equal(h.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 2);
  h.current!.serverClose(1006);
  t.mock.timers.tick(999);
  assert.equal(h.sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 3);

  // A good packet clears the error and the backoff.
  h.current!.open();
  h.current!.receive(packet(1));
  assert.equal(h.controller.getSnapshot().error, null);
  h.current!.serverClose(1006);
  t.mock.timers.tick(500);
  assert.equal(h.sockets.length, 4);
});

test("pausing cancels a pending reconnect", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness();
  h.controller.update(PLAYING);
  h.current!.serverClose(1006);
  h.controller.update({ ...PLAYING, muted: true });
  t.mock.timers.tick(20_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.controller.getSnapshot().error, null);
});

test("a decoder error tears the stream down and retries", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness();
  h.controller.update(PLAYING);
  await flush();
  h.decoders[0]!.sink.error("The audio decoder failed: boom");
  assert.equal(h.controller.getSnapshot().error, "The audio decoder failed: boom");
  assert.equal(isOpen(h.sockets[0]), false);
  assert.equal(h.decoders[0]!.closed, true);
  assert.equal(h.players[0]!.disposed, true);
  t.mock.timers.tick(500);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.decoders.length, 2);
});

test("dispose closes everything and a later update reopens (StrictMode remount)", async () => {
  const h = await harness();
  h.controller.update(PLAYING);
  h.controller.dispose();
  assert.equal(isOpen(h.sockets[0]), false);
  h.controller.update(PLAYING);
  assert.equal(h.sockets.length, 2);
  assert.ok(isOpen(h.current));
  assert.equal(h.outputs, 2);
});
