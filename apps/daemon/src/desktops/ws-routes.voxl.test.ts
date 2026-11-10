import { strict as assert } from "node:assert";
import type { IncomingHttpHeaders } from "node:http";
import { connect as connectTcp, type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { desktopRoutes } from "@orquester/api";
import type { DesktopAudioHub } from "./audio.ts";
import { VoxlUnavailableError, type VoxlLease } from "./voxl-streams.ts";
import { registerDesktopWsRoutes, type DesktopWsDeps } from "./ws-routes.ts";

// The /ws-desktop-voxl relay against a real fastify + @fastify/websocket instance and a fake voxl
// (a `ws` server on 127.0.0.1 that checks what voxl checks: the Bearer password, the Host, no Origin).

const TOKEN = "good-token";
const DESKTOP_ID = "desk-1";
const PASSWORD = "0123456789abcdef";

interface FakeVoxl {
  port: number;
  /** The upgrade requests' headers, in order. */
  upgrades: IncomingHttpHeaders[];
  nextClient(): Promise<WebSocket>;
  lease(password?: string): VoxlLease & { released: Promise<void> };
}

async function fakeVoxl(t: TestContext): Promise<FakeVoxl> {
  const upgrades: IncomingHttpHeaders[] = [];
  const clients: WebSocket[] = [];
  const waiters: Array<(ws: WebSocket) => void> = [];
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/ws",
    // As voxl's login and access checks: the password, an IP Host, no foreign Origin.
    verifyClient: ({ req }, done) => {
      upgrades.push(req.headers);
      const authorized = req.headers.authorization === `Bearer ${PASSWORD}`;
      done(authorized && req.headers.origin === undefined, authorized ? 403 : 401);
    }
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.on("connection", (ws) => {
    clients.push(ws);
    waiters.shift()?.(ws);
  });
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  let handedOut = 0;
  return {
    port,
    upgrades,
    nextClient: () =>
      new Promise((resolve) => {
        const ready = clients[handedOut];
        if (ready) {
          handedOut += 1;
          resolve(ready);
        } else {
          waiters.push((ws) => {
            handedOut += 1;
            resolve(ws);
          });
        }
      }),
    lease: (password = PASSWORD) => {
      let onRelease!: () => void;
      const released = new Promise<void>((resolve) => (onRelease = resolve));
      return {
        port,
        password,
        connect: () =>
          new Promise((resolve, reject) => {
            const socket = connectTcp({ host: "127.0.0.1", port }, () => resolve(socket));
            socket.once("error", reject);
          }),
        release: onRelease,
        released
      };
    }
  };
}

async function startApp(t: TestContext, deps: Partial<DesktopWsDeps>): Promise<number> {
  const app = Fastify();
  await app.register(websocketPlugin);
  await registerDesktopWsRoutes(app, {
    authorize: (token) => token === TOKEN,
    vncSocketPath: () => null,
    audioSource: () => null,
    audio: {} as DesktopAudioHub,
    ...deps
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const client of app.websocketServer.clients) client.terminate();
    await app.close();
  });
  return (app.server.address() as AddressInfo).port;
}

const voxlUrl = (port: number, token = TOKEN) => `ws://127.0.0.1:${port}${desktopRoutes.voxlSocket(DESKTOP_ID)}?token=${encodeURIComponent(token)}`;

function closeOf(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => client.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

function opened(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

/** The next `count` messages on `ws`, as they arrived. */
function messages(ws: WebSocket, count: number): Promise<Array<{ data: Buffer; binary: boolean }>> {
  return new Promise((resolve) => {
    const got: Array<{ data: Buffer; binary: boolean }> = [];
    const onMessage = (data: Buffer, binary: boolean) => {
      got.push({ data: Buffer.from(data), binary });
      if (got.length === count) {
        ws.off("message", onMessage);
        resolve(got);
      }
    };
    ws.on("message", onMessage);
  });
}

test("voxl relay: a missing or wrong token closes with 1008 and never reaches voxl", async (t) => {
  let asked = 0;
  const port = await startApp(t, {
    voxlUpstream: () => {
      asked += 1;
      return null;
    }
  });
  for (const url of [`ws://127.0.0.1:${port}${desktopRoutes.voxlSocket(DESKTOP_ID)}`, voxlUrl(port, "bad")]) {
    const client = new WebSocket(url);
    const { code } = await closeOf(client);
    assert.equal(code, 1008);
  }
  assert.equal(asked, 0);
});

test("voxl relay: voxl dialed with the Bearer password, a loopback Host and no Origin; frames 1:1 both ways", async (t) => {
  const voxl = await fakeVoxl(t);
  const lease = voxl.lease();
  const port = await startApp(t, { voxlUpstream: () => async () => lease });
  // The browser's Origin stays on its side of the relay.
  const client = new WebSocket(voxlUrl(port), { origin: "https://orquester.example.com" });
  await opened(client);
  const upstream = await voxl.nextClient();
  assert.deepEqual(
    { authorization: voxl.upgrades[0]!.authorization, host: voxl.upgrades[0]!.host, origin: voxl.upgrades[0]!.origin },
    { authorization: `Bearer ${PASSWORD}`, host: `127.0.0.1:${voxl.port}`, origin: undefined }
  );
  assert.equal(voxl.upgrades[0]!["sec-websocket-extensions"], undefined, "permessage-deflate is off");

  // voxl → viewer: a text hello, then binary frames, boundaries kept.
  const toViewer = messages(client, 3);
  upstream.send(JSON.stringify({ t: "hello", w: 1280, h: 800 }));
  upstream.send(Buffer.from([1, 2, 3]));
  upstream.send(Buffer.from([4]));
  assert.deepEqual(
    (await toViewer).map((m) => [m.binary, m.binary ? [...m.data] : m.data.toString()]),
    [
      [false, JSON.stringify({ t: "hello", w: 1280, h: 800 })],
      [true, [1, 2, 3]],
      [true, [4]]
    ]
  );

  // viewer → voxl: text commands as sent (an oversized `sz` clamped, a malformed one dropped), binary as is.
  const toVoxl = messages(upstream, 4);
  client.send("a,7");
  client.send("sz,99999,100");
  client.send("sz,abc");
  client.send("kf");
  client.send(Buffer.from([9, 9]));
  assert.deepEqual(
    (await toVoxl).map((m) => [m.binary, m.binary ? [...m.data] : m.data.toString()]),
    [
      [false, "a,7"],
      [false, "sz,7680,240"],
      [false, "kf"],
      [true, [9, 9]]
    ]
  );

  // voxl closing closes the viewer with its code; the lease goes with it.
  const closed = closeOf(client);
  upstream.close(4001, "bye");
  assert.deepEqual(await closed, { code: 4001, reason: "bye" });
  await lease.released;
});

test("voxl relay: the viewer closing closes voxl's socket and releases the lease", async (t) => {
  const voxl = await fakeVoxl(t);
  const lease = voxl.lease();
  const port = await startApp(t, { voxlUpstream: () => async () => lease });
  const client = new WebSocket(voxlUrl(port));
  await opened(client);
  const upstream = await voxl.nextClient();
  const upstreamClosed = new Promise<number>((resolve) => upstream.once("close", (code) => resolve(code)));
  client.close(1000, "done");
  assert.equal(await upstreamClosed, 1000);
  await lease.released;
});

test("voxl relay: every frame arrives intact and in order through a viewer that stops reading (past the high-water mark)", async (t) => {
  const voxl = await fakeVoxl(t);
  const lease = voxl.lease();
  const port = await startApp(t, { voxlUpstream: () => async () => lease });
  const client = new WebSocket(voxlUrl(port));
  await opened(client);
  const upstream = await voxl.nextClient();
  // 48 MiB in 1 MiB frames while the viewer reads nothing: far past the relay's 8 MiB mark, so the
  // relay pauses voxl's socket and must resume it as the viewer drains.
  const FRAMES = 48;
  const frame = (i: number) => Buffer.alloc(1024 * 1024, i);
  client.pause();
  const received = messages(client, FRAMES);
  const sent = Promise.all(
    Array.from({ length: FRAMES }, (_, i) => new Promise<void>((resolve, reject) => upstream.send(frame(i), (error) => (error ? reject(error) : resolve()))))
  );
  client.resume();
  const got = await received;
  await sent;
  assert.equal(got.length, FRAMES);
  got.forEach((m, i) => {
    assert.equal(m.binary, true);
    assert.equal(m.data.length, 1024 * 1024);
    assert.ok(m.data.every((byte) => byte === i % 256), `frame ${i} intact`);
  });
});

test("voxl relay: a desktop without voxl, voxl that cannot start, or a refused password closes with 1011", async (t) => {
  const voxl = await fakeVoxl(t);
  const wrong = voxl.lease("wrong-password");
  const cases: Array<DesktopWsDeps["voxlUpstream"]> = [
    () => null,
    () => async () => {
      throw new VoxlUnavailableError("voxl exited while starting (1)");
    },
    () => async () => wrong
  ];
  for (const voxlUpstream of cases) {
    const port = await startApp(t, { voxlUpstream });
    const client = new WebSocket(voxlUrl(port));
    const { code, reason } = await closeOf(client);
    assert.equal(code, 1011);
    assert.equal(reason, "voxl unavailable");
  }
  await wrong.released;
});
