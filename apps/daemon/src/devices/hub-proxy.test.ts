/**
 * The hub proxy against a fake hub on a random port, through the real device routes: allowlists,
 * methods, the device check, the hub token, header stripping, the MJPEG still-frame repeat, the
 * WebSocket relay with its control handoff, and viewer counts.
 */

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";

import { deviceRoutes } from "@orquester/api";

import { registerDeviceHttpRoutes } from "./http-routes.ts";
import { createHubProxy } from "./hub-proxy.ts";
import type { DeviceService } from "./service.ts";
import { FakeDeviceHost, FakeHostFactory, startTestDeviceService } from "./testing.ts";
import { registerDeviceWsRoutes } from "./ws-routes.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface HubRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeHub {
  origin: string;
  requests: HubRequest[];
  upgrades: { url: string; headers: IncomingHttpHeaders }[];
  messages: string[];
}

const FRAME = (n: number) => Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n`), Buffer.from([0xff, 0xd8, n, 0xd9]), Buffer.from("\r\n")]);

async function startHub(t: TestContext): Promise<FakeHub> {
  const hub: FakeHub = { origin: "", requests: [], upgrades: [], messages: [] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hub.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url?.includes("stream.mjpeg")) {
        res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
        res.write(FRAME(1));
        return; // stays open and quiet
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "hub=1", "access-control-allow-origin": "*", "x-secret": "no" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  const wss = new WebSocketServer({ server, handleProtocols: (protocols) => (protocols.has("other") ? "other" : false) });
  wss.on("connection", (socket, req) => {
    hub.upgrades.push({ url: req.url ?? "", headers: req.headers });
    socket.send(Buffer.from([0x53, 0x45, 0x4d, 0x55]));
    socket.on("message", (data) => hub.messages.push(data.toString()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return hub;
}

async function startApp(t: TestContext, service: DeviceService): Promise<number> {
  const proxy = createHubProxy({
    leaseOnDevice: (hostId, device) => service.leaseOnDevice(hostId, device),
    userInput: (hostId, device) => service.userInput(hostId, device),
    viewerActive: (leaseId) => service.viewerActive(leaseId),
    viewersChanged: (hostId, device, count) => service.streamViewers(hostId, device, count),
    logger: quiet
  });
  const app = Fastify();
  await app.register(websocketPlugin);
  registerDeviceHttpRoutes(app, { devices: () => service, hubProxy: () => proxy, logger: quiet }, "remote");
  await registerDeviceWsRoutes(app, { authorize: (token) => token === "good", devices: () => service, hubProxy: () => proxy });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const client of app.websocketServer.clients) client.terminate();
    await app.close();
  });
  return (app.server.address() as AddressInfo).port;
}

async function setup(t: TestContext, token: string | null = "hub-secret") {
  const hub = await startHub(t);
  const host = new FakeDeviceHost();
  host.hubOriginValue = hub.origin;
  host.hubTokenValue = token;
  const svc = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { android: { enabled: true } } });
  t.after(() => svc.cleanup());
  const opened = await svc.service.toolOpen("t1", { platform: "android" }, new AbortController().signal);
  const port = await startApp(t, svc.service);
  return { hub, host, svc, port, lease: opened.lease, base: `http://127.0.0.1:${port}` };
}

test("HTTP: allowlisted paths only, methods per path, the device must be leased here", async (t) => {
  const { base, lease } = await setup(t);
  const device = lease.deviceId!;
  const status = async (method: string, path: string, body?: string) =>
    (await fetch(`${base}${deviceRoutes.hub("local", path)}`, { method, ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}) })).status;
  assert.equal(await status("GET", "api/devices"), 200);
  assert.equal(await status("POST", "api/devices", "{}"), 405);
  assert.equal(await status("DELETE", "api/devices"), 405);
  assert.equal(await status("GET", "vendor/serve-sim/exec"), 404);
  assert.equal(await status("POST", "vendor/serve-sim/exec-ws", "{}"), 404);
  assert.equal(await status("GET", "vendor/serve-emu/api/devices"), 404);
  assert.equal(await status("GET", "api/devices/../vendor/serve-sim/exec"), 404);
  assert.equal(await status("POST", "vendor/serve-sim/grid/api/start", "{}"), 200);
  assert.equal(await status("GET", "vendor/serve-sim/grid/api/start"), 405);
  // serve-emu answers its screenshot to POST (the panel's poll fallback).
  assert.equal(await status("POST", `vendor/serve-emu/api/screenshot?device=${device}`, "{}"), 200);
  assert.equal(await status("POST", "vendor/serve-emu/api/screenshot", "{}"), 400);
  assert.equal(await status("POST", "vendor/serve-emu/api/screenshot?device=emulator-9999", "{}"), 404);
  assert.equal(await status("GET", "vendor/serve-sim/helper/OTHER-UDID/stream.avcc"), 404);
});

test("HTTP: the hub token goes upstream as a bearer; client credentials, cookies and forwarding headers never do", async (t) => {
  const { base, hub } = await setup(t);
  const response = await fetch(`${base}${deviceRoutes.hub("local", "api/devices")}?token=client-bearer&x=1`, {
    headers: {
      authorization: "Bearer client-bearer",
      cookie: "orq=session",
      dpop: "proof",
      origin: "https://orquester.example",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
      accept: "application/json"
    }
  });
  assert.equal(response.status, 200);
  const seen = hub.requests.at(-1)!;
  assert.equal(seen.url, "/api/devices?x=1");
  assert.equal(seen.headers.authorization, "Bearer hub-secret");
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers.dpop, undefined);
  assert.equal(seen.headers["x-forwarded-for"], undefined);
  assert.equal(seen.headers["x-forwarded-proto"], undefined);
  assert.equal(seen.headers.origin, hub.origin);
  assert.equal(seen.headers.host, new URL(hub.origin).host);
  assert.equal(seen.headers.accept, "application/json");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-secret"), null);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.deepEqual(await response.json(), { ok: true, url: "/api/devices?x=1" });
});

test("HTTP: a hub without a token gets no authorization header; a POST body streams through", async (t) => {
  const { base, hub, lease } = await setup(t, null);
  const response = await fetch(`${base}${deviceRoutes.hub("local", `vendor/serve-emu/api/screenshot?device=${lease.deviceId}`)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client" },
    body: JSON.stringify({ format: "jpeg" })
  });
  assert.equal(response.status, 200);
  const seen = hub.requests.at(-1)!;
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, JSON.stringify({ format: "jpeg" }));
});

test("HTTP: the fold route — reading is watching, a POST is the user's input; the panel's URL (with ?token=) works", async (t) => {
  const { base, svc, lease, hub } = await setup(t);
  const device = lease.deviceId!;
  // The panel's URL: `deviceMediaUrl` adds the bearer as ?token=, `deviceFoldUrl` the device.
  const url = `${base}${deviceRoutes.hub("local", "vendor/serve-emu/api/fold")}?token=client-bearer&device=${device}`;
  const read = await fetch(url);
  assert.equal(read.status, 200);
  assert.equal(hub.requests.at(-1)!.url, `/vendor/serve-emu/api/fold?device=${device}`, "the client's token never reaches the hub");
  assert.equal(svc.service.lease(lease.id)!.controller, "agent", "reading the posture leaves control alone");

  const posted = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ posture: "closed" }) });
  assert.equal(posted.status, 200);
  const seen = hub.requests.at(-1)!;
  assert.deepEqual([seen.method, seen.body, seen.headers.authorization], ["POST", JSON.stringify({ posture: "closed" }), "Bearer hub-secret"]);
  assert.equal(svc.service.lease(lease.id)!.controller, "user", "folding takes control");

  const status = async (method: string, path: string) => (await fetch(`${base}${deviceRoutes.hub("local", path)}`, { method })).status;
  assert.equal(await status("DELETE", `vendor/serve-emu/api/fold?device=${device}`), 405);
  assert.equal(await status("POST", "vendor/serve-emu/api/fold"), 400);
  assert.equal(await status("POST", "vendor/serve-emu/api/fold?device=emulator-9999"), 404);
});

test("HTTP: a fold is the user's input (control switches); watching an MJPEG stream repeats the still frame and counts the viewer", async (t) => {
  const { base, svc, lease, host } = await setup(t);
  assert.equal(svc.service.lease(lease.id)!.controller, "agent");
  const fold = await fetch(`${base}${deviceRoutes.hub("local", `vendor/serve-emu/api/fold?device=${lease.deviceId}`)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(fold.status, 200);
  assert.equal(svc.service.lease(lease.id)!.controller, "user");

  // A stream: the hub sends one part and goes quiet; the proxy repeats it once.
  const received = await new Promise<Buffer>((resolve, reject) => {
    const req = httpRequest(`${base}${deviceRoutes.hub("local", `vendor/serve-sim/helper/${lease.deviceId}/stream.mjpeg`)}`, (res) => {
      assert.equal(res.headers["cache-control"], "no-store, no-transform");
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length >= FRAME(1).length * 2) {
          req.destroy();
          resolve(Buffer.concat(chunks));
        }
      });
    });
    req.on("error", (error) => (error.message.includes("socket hang up") ? undefined : reject(error)));
    req.end();
  });
  assert.deepEqual(received.subarray(0, FRAME(1).length * 2), Buffer.concat([FRAME(1), FRAME(1)]));
  // The viewer was counted while the stream was open, and leaves.
  await waitFor(() => host.viewerCounts.some((entry) => entry.count === 0));
  assert.deepEqual(host.viewerCounts, [
    { deviceId: lease.deviceId, count: 1 },
    { deviceId: lease.deviceId, count: 0 }
  ]);
});

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function closeOf(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

test("WebSocket: the relay adds the hub token, drops client token subprotocols, pumps frames, and hands control over on input only", async (t) => {
  const { port, hub, svc, lease, host } = await setup(t);
  const url = `ws://127.0.0.1:${port}${deviceRoutes.socket("local", "vendor/serve-emu/ws")}?device=${lease.deviceId}&frame-meta=1&token=good`;
  const client = new WebSocket(url, ["serve-emu.token.stolen", "other"]);
  const first = new Promise<Buffer>((resolve) => client.once("message", (data) => resolve(data as Buffer)));
  await opened(client);
  assert.deepEqual(await first, Buffer.from([0x53, 0x45, 0x4d, 0x55]));
  const upgrade = hub.upgrades.at(-1)!;
  assert.equal(upgrade.url, `/vendor/serve-emu/ws?device=${lease.deviceId}&frame-meta=1`);
  assert.equal(upgrade.headers.authorization, "Bearer hub-secret");
  assert.equal(upgrade.headers.origin, hub.origin);
  assert.equal(upgrade.headers["sec-websocket-protocol"], "other");

  // A keyframe request is not input: watching never changes control.
  client.send(JSON.stringify({ type: "reset-video" }));
  await waitFor(() => hub.messages.length === 1);
  assert.equal(svc.service.lease(lease.id)!.controller, "agent");
  // A touch is: the user takes control at once, and the frame still goes through.
  client.send(JSON.stringify({ type: "touch", action: "down", x: 0.5, y: 0.5 }));
  await waitFor(() => hub.messages.length === 2);
  assert.equal(svc.service.lease(lease.id)!.controller, "user");
  assert.deepEqual(host.viewerCounts.at(-1), { deviceId: lease.deviceId, count: 1 });

  const closed = closeOf(client);
  client.close();
  await closed;
  await waitFor(() => host.viewerCounts.at(-1)?.count === 0);
});

test("WebSocket: off-list paths and devices not leased here are refused", async (t) => {
  const { port, lease } = await setup(t);
  const expectClose = async (path: string, reason: string) => {
    const result = await closeOf(new WebSocket(`ws://127.0.0.1:${port}${deviceRoutes.socket("local", path)}${path.includes("?") ? "&" : "?"}token=good`));
    assert.deepEqual(result, { code: 1008, reason }, path);
  };
  await expectClose("vendor/serve-sim/exec-ws", "hub path not available");
  await expectClose("api/devices/ws", "hub path not available");
  await expectClose("vendor/serve-emu/ws?device=emulator-9999", "device not leased");
  await expectClose("vendor/serve-sim/helper/ws", "device not leased");
  // The helper socket on a leased device is relayed (the fake hub accepts it).
  const ok = new WebSocket(`ws://127.0.0.1:${port}${deviceRoutes.socket("local", "vendor/serve-sim/helper/ws")}?device=${lease.deviceId}&token=good`, ["other"]);
  await opened(ok);
  ok.terminate();
});
