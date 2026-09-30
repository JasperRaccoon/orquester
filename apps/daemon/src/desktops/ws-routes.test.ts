import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as connectTcp, createServer as createNetServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { DESKTOP_AUDIO_HEADER_BYTES, desktopRoutes, type DesktopAudioStateMessage } from "@orquester/api";
import { desktopAudioState, frameDesktopAudioPacket, type DesktopAudioHub, type DesktopAudioSink } from "./audio.ts";
import { registerDesktopWsRoutes, type DesktopWsDeps } from "./ws-routes.ts";

// Route-level coverage for /ws-desktop and /ws-desktop-audio against a real
// fastify + @fastify/websocket instance. A fake unix socket stands in for Xvnc's
// `vnc.sock`, and a fake hub for the audio encoder.

const TOKEN = "good-token";
const DESKTOP_ID = "desk-1";

interface FakeVnc {
  path: string;
  server: Server;
  connections: Socket[];
  nextConnection: () => Promise<Socket>;
}

async function fakeVnc(t: TestContext): Promise<FakeVnc> {
  const dir = mkdtempSync(join(tmpdir(), "orq-desktop-ws-"));
  const path = join(dir, "vnc.sock");
  const connections: Socket[] = [];
  const waiters: Array<(socket: Socket) => void> = [];
  let handedOut = 0;
  const server = createNetServer((socket) => {
    connections.push(socket);
    const waiter = waiters.shift();
    if (waiter) {
      handedOut += 1;
      waiter(socket);
    }
  });
  await new Promise<void>((resolvePromise) => server.listen(path, resolvePromise));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    path,
    server,
    connections,
    /** The next connection not yet handed out (already accepted, or the next to arrive). */
    nextConnection: () =>
      new Promise<Socket>((resolvePromise) => {
        const ready = waiters.length === 0 ? connections[handedOut] : undefined;
        if (ready) {
          handedOut += 1;
          resolvePromise(ready);
        } else {
          waiters.push(resolvePromise);
        }
      })
  };
}

interface FakeHub {
  hub: DesktopAudioHub;
  sinks: DesktopAudioSink[];
  subscribed: Promise<DesktopAudioSink>;
  unsubscribed: Promise<void>;
}

function fakeHub(): FakeHub {
  const sinks: DesktopAudioSink[] = [];
  let onSubscribe!: (sink: DesktopAudioSink) => void;
  let onUnsubscribe!: () => void;
  const subscribed = new Promise<DesktopAudioSink>((resolvePromise) => (onSubscribe = resolvePromise));
  const unsubscribed = new Promise<void>((resolvePromise) => (onUnsubscribe = resolvePromise));
  const hub = {
    subscribe(desktopId: string, pulseSocketPath: string, sink: DesktopAudioSink) {
      assert.equal(desktopId, DESKTOP_ID);
      assert.equal(pulseSocketPath, "/run/desk-1/pulse/native");
      sinks.push(sink);
      sink.sendState(desktopAudioState("available"));
      onSubscribe(sink);
      return () => onUnsubscribe();
    },
    stopDesktop() {},
    shutdown() {}
  } as unknown as DesktopAudioHub;
  return { hub, sinks, subscribed, unsubscribed };
}

async function startApp(t: TestContext, deps: Partial<DesktopWsDeps>): Promise<number> {
  const app = Fastify();
  await app.register(websocketPlugin);
  await registerDesktopWsRoutes(app, {
    authorize: (token) => token === TOKEN,
    vncSocketPath: () => null,
    audioSource: () => null,
    audio: fakeHub().hub,
    ...deps
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  return (app.server.address() as AddressInfo).port;
}

const vncUrl = (port: number, token = TOKEN) =>
  `ws://127.0.0.1:${port}${desktopRoutes.vncSocket(DESKTOP_ID)}?token=${encodeURIComponent(token)}`;
const audioUrl = (port: number, token = TOKEN) =>
  `ws://127.0.0.1:${port}${desktopRoutes.audioSocket(DESKTOP_ID)}?token=${encodeURIComponent(token)}`;

function closeOf(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolvePromise) =>
    client.once("close", (code, reason) => resolvePromise({ code, reason: reason.toString() }))
  );
}

function opened(client: WebSocket): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    client.once("open", () => resolvePromise());
    client.once("error", reject);
  });
}

/** Resolve once `socket` has received `length` bytes. */
function readBytes(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= length) {
        socket.off("data", onData);
        resolvePromise(Buffer.concat(chunks));
      }
    };
    socket.on("data", onData);
  });
}

/** One masked client→server WebSocket frame (RFC 6455 §5.2), for hand-built upgrades. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  assert.ok(payload.length < 126);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

test("both routes reject a missing or invalid token with 1008 after the upgrade", { timeout: 15_000 }, async (t) => {
  let looked = 0;
  const port = await startApp(t, {
    vncSocketPath: () => {
      looked += 1;
      return "/nonexistent";
    },
    audioSource: () => {
      looked += 1;
      return { unavailable: "x" };
    }
  });
  for (const url of [vncUrl(port, "bad"), audioUrl(port, "bad"), vncUrl(port).split("?")[0]!]) {
    const client = new WebSocket(url);
    const closed = closeOf(client);
    await opened(client);
    const { code, reason } = await closed;
    assert.equal(code, 1008);
    assert.equal(reason, "unauthorized");
  }
  assert.equal(looked, 0);
});

test("a desktop that isn't running closes with 1011", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orq-desktop-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let vncPath: string | null = null;
  const port = await startApp(t, { vncSocketPath: () => vncPath, audioSource: () => null });

  for (const url of [vncUrl(port), audioUrl(port)]) {
    const client = new WebSocket(url);
    const { code, reason } = await closeOf(client);
    assert.equal(code, 1011);
    assert.equal(reason, "desktop not running");
  }
  // Known but its socket is gone (Xvnc died between lookup and connect).
  vncPath = join(dir, "missing.sock");
  const client = new WebSocket(vncUrl(port));
  const { code, reason } = await closeOf(client);
  assert.equal(code, 1011);
  assert.equal(reason, "desktop not running");
});

test("RFB relay round trip: binary both ways, either side closing closes both", { timeout: 15_000 }, async (t) => {
  const vnc = await fakeVnc(t);
  const port = await startApp(t, { vncSocketPath: (id) => (id === DESKTOP_ID ? vnc.path : null) });

  const client = new WebSocket(vncUrl(port));
  const connection = vnc.nextConnection();
  await opened(client);
  const upstream = await connection;

  const fromServer = new Promise<Buffer>((resolvePromise) =>
    client.once("message", (data, isBinary) => {
      assert.equal(isBinary, true);
      resolvePromise(data as Buffer);
    })
  );
  upstream.write("RFB 003.008\n");
  assert.equal((await fromServer).toString(), "RFB 003.008\n");

  const received = readBytes(upstream, 12);
  client.send(Buffer.from("RFB 003.008\n"));
  assert.equal((await received).toString(), "RFB 003.008\n");

  // Upstream closing closes the client.
  const closed = closeOf(client);
  upstream.end();
  assert.equal((await closed).code, 1000);

  // Client closing closes the upstream.
  const second = new WebSocket(vncUrl(port));
  const secondConnection = vnc.nextConnection();
  await opened(second);
  const secondUpstream = await secondConnection;
  const upstreamClosed = new Promise<void>((resolvePromise) => secondUpstream.once("close", () => resolvePromise()));
  second.close();
  await upstreamClosed;
});

test("bytes sent before the upstream connects are delivered in order", { timeout: 15_000 }, async (t) => {
  const vnc = await fakeVnc(t);
  const port = await startApp(t, { vncSocketPath: () => vnc.path });

  // Hand-built upgrade with frames in the SAME write: they reach the route as the
  // upgrade's `head`, before its unix connect can complete, so they go through the
  // pre-open queue. A text ping rides along and must not reach the VNC socket.
  const key = Buffer.from("0123456789abcdef").toString("base64");
  const frames = [
    clientFrame(0x2, Buffer.from("one|")),
    clientFrame(0x1, Buffer.from(JSON.stringify({ type: "ping", t: 7 }))),
    clientFrame(0x2, Buffer.from("two|")),
    clientFrame(0x2, Buffer.from("three"))
  ];
  const request = Buffer.from(
    `GET ${desktopRoutes.vncSocket(DESKTOP_ID)}?token=${TOKEN} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
  const raw = connectTcp(port, "127.0.0.1");
  t.after(() => raw.destroy());
  const connection = vnc.nextConnection();
  raw.write(Buffer.concat([request, ...frames]));

  const upstream = await connection;
  const expected = "one|two|three";
  assert.equal((await readBytes(upstream, expected.length)).toString(), expected);

  // Then many messages in a burst from a normal client keep their order too.
  const client = new WebSocket(vncUrl(port));
  const secondConnection = vnc.nextConnection();
  client.on("open", () => {
    for (let i = 0; i < 200; i += 1) client.send(Buffer.from(`${String(i).padStart(3, "0")},`));
  });
  const second = await secondConnection;
  const burst = (await readBytes(second, 200 * 4)).toString();
  assert.equal(burst, Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")},`).join(""));
  client.close();
});

test("ping is answered with pong on the same socket, queued behind RFB data already sent", { timeout: 15_000 }, async (t) => {
  const vnc = await fakeVnc(t);
  const port = await startApp(t, { vncSocketPath: () => vnc.path });

  const client = new WebSocket(vncUrl(port));
  const connection = vnc.nextConnection();
  await opened(client);
  const upstream = await connection;
  const forwarded: Buffer[] = [];
  upstream.on("data", (chunk: Buffer) => forwarded.push(chunk));

  // The viewer stops reading while the desktop pushes 4 MB (under the 8 MB HWM, so
  // the relay reads it all and queues it on the WebSocket). Once the fake Xvnc's
  // write has been handed to the kernel, at most the unix socket's buffer is still
  // unread by the relay, so nearly all of it is queued ahead of the pong.
  client.pause();
  const total = 4 * 1024 * 1024;
  await new Promise<void>((resolvePromise) => upstream.write(Buffer.alloc(total, 0xab), () => resolvePromise()));

  let binaryBeforePong = 0;
  let binaryTotal = 0;
  let pong: unknown = null;
  const done = new Promise<void>((resolvePromise) => {
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryTotal += (data as Buffer).length;
        if (pong === null) binaryBeforePong += (data as Buffer).length;
      } else {
        pong = JSON.parse((data as Buffer).toString());
      }
      if (pong !== null && binaryTotal >= total) resolvePromise();
    });
  });
  client.send(JSON.stringify({ type: "ping", t: 1234.5 }));
  client.send("not json");
  client.send(JSON.stringify({ type: "other" }));
  client.resume();
  await done;

  assert.deepEqual(pong, { type: "pong", t: 1234.5 });
  assert.equal(binaryTotal, total);
  assert.ok(binaryBeforePong >= total - 1024 * 1024, `only ${binaryBeforePong} RFB bytes preceded the pong`);

  // Control frames never reach the VNC socket: a later binary frame arrives alone.
  const marker = readBytes(upstream, 3);
  client.send(Buffer.from("end"));
  await marker;
  assert.equal(Buffer.concat(forwarded).toString(), "end");
  client.close();
});

test("audio route: state message first, then framed packets; ping/pong; close unsubscribes", { timeout: 15_000 }, async (t) => {
  const fake = fakeHub();
  const port = await startApp(t, {
    audioSource: (id) => (id === DESKTOP_ID ? { pulseSocketPath: "/run/desk-1/pulse/native" } : null),
    audio: fake.hub
  });

  const client = new WebSocket(audioUrl(port));
  const messages: Array<{ binary: boolean; data: Buffer }> = [];
  let onMessages!: () => void;
  const gotAll = new Promise<void>((resolvePromise) => (onMessages = resolvePromise));
  client.on("message", (data, isBinary) => {
    messages.push({ binary: isBinary, data: data as Buffer });
    if (messages.length === 4) onMessages();
  });
  await opened(client);
  const sink = await fake.subscribed;
  assert.equal(sink.bufferedAmount(), 0);
  sink.send(frameDesktopAudioPacket(0, Buffer.from([0xf4, 1, 2])));
  sink.send(frameDesktopAudioPacket(1, Buffer.from([0xf4, 3])));
  client.send(JSON.stringify({ type: "ping" }));
  await gotAll;

  assert.equal(messages[0]!.binary, false);
  const state = JSON.parse(messages[0]!.data.toString()) as DesktopAudioStateMessage;
  assert.deepEqual(state, { type: "state", audio: "available", sampleRate: 48000, channels: 2, frameMs: 10 });
  const [first, second] = [messages[1]!, messages[2]!];
  assert.equal(first.binary, true);
  assert.deepEqual([...first.data.subarray(0, DESKTOP_AUDIO_HEADER_BYTES)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...first.data.subarray(DESKTOP_AUDIO_HEADER_BYTES)], [0xf4, 1, 2]);
  assert.equal(second.data.readUInt32BE(4), 1);
  assert.deepEqual(JSON.parse(messages[3]!.data.toString()), { type: "pong" });

  client.close();
  await fake.unsubscribed;
});

test("audio route: sink.close (desktop stopped) closes the socket with 1011", { timeout: 15_000 }, async (t) => {
  const fake = fakeHub();
  const port = await startApp(t, {
    audioSource: () => ({ pulseSocketPath: "/run/desk-1/pulse/native" }),
    audio: fake.hub
  });
  const client = new WebSocket(audioUrl(port));
  const closed = closeOf(client);
  const sink = await fake.subscribed;
  sink.close?.();
  assert.deepEqual(await closed, { code: 1011, reason: "desktop not running" });
  await fake.unsubscribed;
});

test("audio route: running without audio sends state unavailable and stays open for pings", { timeout: 15_000 }, async (t) => {
  const fake = fakeHub();
  const port = await startApp(t, {
    audioSource: () => ({ unavailable: "pulseaudio is not installed" }),
    audio: fake.hub
  });
  const client = new WebSocket(audioUrl(port));
  const messages: unknown[] = [];
  const two = new Promise<void>((resolvePromise) =>
    client.on("message", (data, isBinary) => {
      assert.equal(isBinary, false);
      messages.push(JSON.parse((data as Buffer).toString()));
      if (messages.length === 1) client.send(JSON.stringify({ type: "ping" }));
      if (messages.length === 2) resolvePromise();
    })
  );
  await two;
  assert.deepEqual(messages, [
    {
      type: "state",
      audio: "unavailable",
      reason: "pulseaudio is not installed",
      sampleRate: 48000,
      channels: 2,
      frameMs: 10
    },
    { type: "pong" }
  ]);
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal(fake.sinks.length, 0);
  client.close();
});
