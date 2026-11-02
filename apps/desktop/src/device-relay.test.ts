import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { startDeviceRelay, type DeviceRelay } from "./device-relay";

const HUB = "/api/devices/hosts/local/hub/vendor/serve-sim/x/stream.avcc";

interface FakeDaemon {
  seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[];
  sockets: string[];
  socketPath: string;
}

/** A daemon on a real unix socket: answers every path, and echoes WebSocket messages. */
async function serveDaemon(t: TestContext, respond?: http.RequestListener): Promise<FakeDaemon> {
  const dir = mkdtempSync(join(tmpdir(), "device-relay-"));
  const socketPath = join(dir, "daemon.sock");
  const daemon: FakeDaemon = { seen: [], sockets: [], socketPath };
  const server = http.createServer((req, res) => {
    daemon.seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (respond) return void respond(req, res);
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end("frames");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    daemon.sockets.push(req.url ?? "");
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data, binary) => ws.send(data, { binary })));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return daemon;
}

async function relayFor(t: TestContext, socketPath: string | undefined): Promise<DeviceRelay> {
  const relay = await startDeviceRelay(() => socketPath);
  t.after(() => relay.close());
  return relay;
}

const bearer = (relay: DeviceRelay) => ({ authorization: `Bearer ${relay.token}` });

test("listens on loopback only, with a long random token", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  assert.match(relay.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(relay.token.length >= 32);
  const other = await relayFor(t, daemon.socketPath);
  assert.notEqual(relay.token, other.token);
});

test("takes no connection from another interface", async (t) => {
  const address = Object.values(networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
  if (!address) return t.skip("this machine has no external interface");
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const code = await new Promise<string>((resolve) => {
    const socket = net.connect(Number(new URL(relay.origin).port), address);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
  });
  assert.equal(code, "ECONNREFUSED");
});

test("a hub request reaches the daemon without the relay's token, and its answer reaches a cross-origin page", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const res = await fetch(`${relay.origin}${HUB}?device=abc`, { headers: { ...bearer(relay), origin: "null" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "frames");
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(daemon.seen[0]!.url, `${HUB}?device=abc`);
  assert.equal(daemon.seen[0]!.headers.authorization, undefined);
});

test("a request body streams through", async (t) => {
  const daemon = await serveDaemon(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => res.end(Buffer.concat(chunks)));
  });
  const relay = await relayFor(t, daemon.socketPath);
  const res = await fetch(`${relay.origin}/api/devices/hosts/local/hub/vendor/serve-emu/api/fold`, { method: "POST", headers: bearer(relay), body: new Uint8Array([1, 2, 3]) });
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  assert.equal(daemon.seen[0]!.method, "POST");
});

test("an image takes the token in its query, which the daemon never sees", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const res = await fetch(`${relay.origin}/api/devices/leases/l1/thumbnail?w=240&token=${relay.token}`);
  assert.equal(res.status, 200);
  assert.equal(daemon.seen[0]!.url, "/api/devices/leases/l1/thumbnail?w=240");
});

test("answers the browser's preflight without a token, and lets the bearer header through", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const res = await fetch(`${relay.origin}${HUB}`, { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  assert.deepEqual(daemon.seen, []);
});

test("a missing or wrong token never reaches the daemon", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  assert.equal((await fetch(`${relay.origin}${HUB}`)).status, 401);
  assert.equal((await fetch(`${relay.origin}${HUB}`, { headers: { authorization: `Bearer ${"x".repeat(relay.token.length)}` } })).status, 401);
  assert.equal((await fetch(`${relay.origin}${HUB}?token=nope`)).status, 401);
  assert.deepEqual(daemon.seen, []);
});

test("only device media passes, whatever the token: the socket behind it is full control", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  for (const path of ["/api/config/daemon", "/api/devices", "/api/devices/settings", "/api/devices/leases/l1/actions", "/api/devices/hosts/local", "/events"]) {
    assert.equal((await fetch(`${relay.origin}${path}`, { headers: bearer(relay) })).status, 404, path);
  }
  // A dot segment cannot climb out of an allowed prefix.
  for (const path of ["/api/devices/hosts/local/hub/../../../config/daemon", "/api/devices/hosts/local/hub/%2e%2e/%2e%2e/%2e%2e/config/daemon"]) {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${relay.origin}${path}`, { headers: bearer(relay) }, (res) => {
        res.resume();
        assert.equal(res.statusCode, 404, path);
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
  }
  // An image route reads; it takes no writes.
  assert.equal((await fetch(`${relay.origin}/api/devices/leases/l1/thumbnail`, { method: "DELETE", headers: bearer(relay) })).status, 404);
  assert.deepEqual(daemon.seen, []);
});

test("a semicolon cannot turn a device path into another route: the daemon's router cuts the path there", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const cases: [string, string][] = [
    ["DELETE", "/api/devices/hosts/box1;/hub/x"],
    ["GET", "/api/devices/leases/l1;/thumbnail"],
    ["GET", "/api/devices/hosts/local/hub/vendor;/x"]
  ];
  for (const [method, path] of cases) {
    assert.equal((await fetch(`${relay.origin}${path}`, { method, headers: bearer(relay) })).status, 404, path);
  }
  const socket = new WebSocket(`${relay.origin.replace(/^http/, "ws")}/ws-device/local;/x?token=${relay.token}`);
  await new Promise((resolve) => {
    socket.once("unexpected-response", resolve);
    socket.once("error", resolve);
  });
  socket.terminate();
  assert.deepEqual(daemon.seen, []);
  assert.deepEqual(daemon.sockets, []);
});

/** Send raw bytes to the relay and read to the end of what it answers. */
function rawExchange(relay: DeviceRelay, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(relay.origin).port), "127.0.0.1", () => socket.write(request));
    let answer = "";
    socket.on("data", (chunk) => (answer += chunk.toString()));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });
}

test("a request line that is no URL is refused, and the relay lives on", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  assert.match(await rawExchange(relay, "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 400/);
  assert.match(await rawExchange(relay, "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"), /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`${relay.origin}${HUB}`, { headers: bearer(relay) })).status, 200);
});

test("a client that resets during a refused upgrade does not bring the relay down", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const port = Number(new URL(relay.origin).port);
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("GET /ws-device/local/x HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n");
        socket.resetAndDestroy();
        socket.once("close", () => resolve());
      });
      socket.once("error", () => undefined);
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fetch(`${relay.origin}${HUB}`, { headers: bearer(relay) })).status, 200);
});

test("answers 503 while there is no daemon socket", async (t) => {
  const relay = await relayFor(t, undefined);
  assert.equal((await fetch(`${relay.origin}${HUB}`, { headers: bearer(relay) })).status, 503);
});

test("a device WebSocket relays frames both ways without the token", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const url = `${relay.origin.replace(/^http/, "ws")}/ws-device/local/vendor/serve-emu/ws?device=abc&token=${relay.token}`;
  const socket = new WebSocket(url);
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(Buffer.from([7, 8, 9]));
  const [echoed] = (await new Promise<[Buffer]>((resolve) => socket.once("message", (data) => resolve([data as Buffer]))));
  assert.deepEqual([...echoed], [7, 8, 9]);
  assert.deepEqual(daemon.sockets, ["/ws-device/local/vendor/serve-emu/ws?device=abc"]);
});

test("a WebSocket without the token, or off the device routes, is refused before the daemon", async (t) => {
  const daemon = await serveDaemon(t);
  const relay = await relayFor(t, daemon.socketPath);
  const base = relay.origin.replace(/^http/, "ws");
  for (const url of [`${base}/ws-device/local/x`, `${base}/ws?token=${relay.token}`, `${base}/ws-browser?token=${relay.token}`]) {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(url);
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("open", () => resolve(101));
      socket.once("error", () => undefined);
    });
    assert.notEqual(status, 101, url);
  }
  assert.deepEqual(daemon.sockets, []);
});
