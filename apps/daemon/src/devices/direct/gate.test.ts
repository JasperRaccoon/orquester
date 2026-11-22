import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { DEVICE_HOST_IDENTITY_PATH, DEVICE_STREAM_TICKET_PARAM } from "@orquester/api";
import { WebSocket, WebSocketServer } from "ws";

import { controlToken, createStreamGate, IDENTITY_PATH, signStreamTicket, TICKET_PARAM, verifyStreamTicket, type GateEvents } from "./gate.mjs";

const SECRET = Buffer.alloc(32, 7);
const HOST = "box:mac1";
const DEVICE = "UDID-1";
const NOW = 1_800_000_000_000;

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A hub that answers only its own token, and records what reached it. */
async function fakeHub() {
  const seen: { url: string; authorization: string | undefined; origin: string | undefined }[] = [];
  const messages: string[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization, origin: req.headers.origin });
    if (req.headers.authorization !== "Bearer hub-token") {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "set-cookie": "nope=1" });
    res.end("frames");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization, origin: req.headers.origin });
    if (req.headers.authorization !== "Bearer hub-token") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        ws.send(`echo:${data.toString()}`);
      });
    });
  });
  const port = await listen(server);
  closers.push(() => {
    wss.close();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, seen, messages };
}

async function startGate(hubPort: number, clock = { now: NOW }) {
  const gate = createStreamGate({ hostId: HOST, machineId: "ts:mac", secret: SECRET, version: "v1", hub: () => ({ port: hubPort, token: "hub-token" }), now: () => clock.now, lan: () => ["192.168.2.6"], longPollMs: 50 });
  const port = await listen(gate.server);
  closers.push(() => {
    gate.close();
    gate.server.closeAllConnections();
    return new Promise<void>((resolve) => gate.server.close(() => resolve()));
  });
  return { origin: `http://127.0.0.1:${port}`, port };
}

const ticket = (claims: Partial<{ hostId: string; device: string; expiresAt: number; origin: string }> = {}, secret = SECRET) =>
  signStreamTicket(secret, { hostId: HOST, device: DEVICE, expiresAt: NOW + 120_000, ...claims });

async function events(origin: string, query = ""): Promise<GateEvents> {
  const response = await fetch(`${origin}/.orq/gate/events${query}`, { headers: { authorization: `Bearer ${controlToken(SECRET)}` } });
  assert.equal(response.status, 200);
  return (await response.json()) as GateEvents;
}

describe("stream tickets", () => {
  it("verify only for this host and device, unexpired and untampered", () => {
    const good = ticket({ origin: "https://orq.example.ts.net" });
    const ok = verifyStreamTicket(SECRET, good, { hostId: HOST, device: DEVICE, now: NOW });
    assert.deepEqual(ok.ok && ok.claims, { hostId: HOST, device: DEVICE, expiresAt: NOW + 120_000, origin: "https://orq.example.ts.net" });

    const reason = (value: string, expect: { hostId?: string; device?: string; now?: number } = {}) => {
      const verdict = verifyStreamTicket(SECRET, value, { hostId: HOST, device: DEVICE, now: NOW, ...expect });
      return verdict.ok ? "ok" : verdict.reason;
    };
    assert.equal(reason(good, { now: NOW + 120_000 }), "expired");
    assert.equal(reason(good, { hostId: "box:other" }), "host");
    assert.equal(reason(good, { device: "UDID-2" }), "device");
    assert.equal(reason(ticket({}, Buffer.alloc(32, 8))), "signature");
    // A payload rewritten to another device keeps its old signature: refused.
    const [version, , mac] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ h: HOST, d: "UDID-2", e: NOW + 120_000, n: "x" })).toString("base64url");
    assert.equal(reason(`${version}.${forged}.${mac}`, { device: "UDID-2" }), "signature");
    assert.equal(reason(`${good}x`), "signature");
    assert.equal(reason("not-a-ticket"), "malformed");
  });

  it("use the API's identity path and ticket parameter", () => {
    assert.equal(IDENTITY_PATH, DEVICE_HOST_IDENTITY_PATH);
    assert.equal(TICKET_PARAM, DEVICE_STREAM_TICKET_PARAM);
  });
});

describe("the stream gate", () => {
  it("answers its identity to anyone, with no secret", async () => {
    const hub = await fakeHub();
    const gate = await startGate(hub.port);
    const response = await fetch(`${gate.origin}${IDENTITY_PATH}`);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), { hostId: HOST, machineId: "ts:mac" });
  });

  it("forwards a ticketed stream with the hub's own token, and refuses anything else before the hub", async () => {
    const hub = await fakeHub();
    const gate = await startGate(hub.port);
    const page = "https://orq.example.ts.net";
    const path = `/vendor/serve-sim/helper/${DEVICE}/stream.avcc`;

    const ok = await fetch(`${gate.origin}${path}?${TICKET_PARAM}=${encodeURIComponent(ticket({ origin: page }))}`, { headers: { origin: page } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "frames");
    assert.equal(ok.headers.get("access-control-allow-origin"), page);
    assert.equal(ok.headers.get("set-cookie"), null);
    assert.deepEqual(hub.seen, [{ url: path, authorization: "Bearer hub-token", origin: `http://127.0.0.1:${hub.port}` }]);

    const refused = async (url: string, headers: Record<string, string> = {}) => (await fetch(`${gate.origin}${url}`, { headers })).status;
    assert.equal(await refused(path), 403, "no ticket");
    assert.equal(await refused(`/vendor/serve-sim/helper/UDID-2/stream.avcc?ticket=${encodeURIComponent(ticket())}`), 403, "another device");
    assert.equal(await refused(`${path}?ticket=${encodeURIComponent(ticket({ hostId: "box:other" }))}`), 403, "another host");
    assert.equal(await refused(`${path}?ticket=${encodeURIComponent(ticket({ origin: page }))}`, { origin: "https://evil.example" }), 403, "another page");
    assert.equal(await refused(`/api/devices?ticket=${encodeURIComponent(ticket())}`), 404, "a path naming no device");
    assert.equal(await refused(`/api/exec?ticket=${encodeURIComponent(ticket())}`), 404, "a path off the allowlist");
    assert.equal(hub.seen.length, 1);
  });

  it("relays a ticketed WebSocket and reports its viewer and its input, not serve-emu's reset-video", async () => {
    const hub = await fakeHub();
    const gate = await startGate(hub.port);
    const before = await events(gate.origin);
    assert.deepEqual(before.viewers, {});
    assert.deepEqual(before.lan, ["192.168.2.6"]);

    const socket = new WebSocket(`ws://127.0.0.1:${gate.port}/vendor/serve-emu/ws?device=${DEVICE}&${TICKET_PARAM}=${encodeURIComponent(ticket())}`, ["serve-emu.token.stolen", "semu"]);
    await once(socket, "open");
    assert.equal(socket.protocol, "semu");
    const watched = await events(gate.origin, `?boot=${before.boot}&after=${before.seq}`);
    assert.deepEqual(watched.viewers, { [DEVICE]: 1 });
    assert.deepEqual(watched.inputs, []);

    socket.send(JSON.stringify({ type: "reset-video" }));
    const [first] = await once(socket, "message");
    assert.equal(String(first), 'echo:{"type":"reset-video"}');
    const afterReset = await events(gate.origin, `?boot=${before.boot}&after=${watched.seq}`);
    assert.deepEqual(afterReset.inputs, [], "reset-video is no input");

    socket.send(JSON.stringify({ type: "touch", x: 1, y: 2 }));
    await once(socket, "message");
    const touched = await events(gate.origin, `?boot=${before.boot}&after=${afterReset.seq}`);
    assert.deepEqual(touched.inputs, [DEVICE]);
    assert.equal(hub.seen.at(-1)?.authorization, "Bearer hub-token");
    assert.ok(!hub.seen.at(-1)?.url.includes(TICKET_PARAM), "the ticket stays at the gate");

    socket.close();
    await once(socket, "close");
    let after = touched;
    while (after.viewers[DEVICE] !== undefined) after = await events(gate.origin, `?boot=${before.boot}&after=${after.seq}`);
    assert.deepEqual(after.viewers, {});
  });

  it("refuses a WebSocket without a ticket for its device", async () => {
    const hub = await fakeHub();
    const gate = await startGate(hub.port);
    const socket = new WebSocket(`ws://127.0.0.1:${gate.port}/vendor/serve-emu/ws?device=UDID-2&${TICKET_PARAM}=${encodeURIComponent(ticket())}`);
    const [, response] = (await once(socket, "unexpected-response")) as [unknown, IncomingMessage];
    assert.equal(response.statusCode, 403);
    assert.equal(hub.seen.length, 0);
  });

  it("answers the control routes only to the daemon's bearer, and never replays another boot's input", async () => {
    const hub = await fakeHub();
    const gate = await startGate(hub.port);
    assert.equal((await fetch(`${gate.origin}/.orq/gate/events`)).status, 401);
    assert.equal((await fetch(`${gate.origin}/.orq/gate/status`, { headers: { authorization: `Bearer ${controlToken(Buffer.alloc(32, 9))}` } })).status, 401);

    const fold = await fetch(`${gate.origin}/vendor/serve-emu/api/fold?device=${DEVICE}&${TICKET_PARAM}=${encodeURIComponent(ticket())}`, { method: "POST" });
    assert.equal(fold.status, 200);
    const current = await events(gate.origin, "?after=0");
    assert.deepEqual(current.inputs, [], "a caller of another boot gets the state, not old input");
    const updated = await events(gate.origin, `?boot=${current.boot}&after=0&machineId=ts:renamed`);
    assert.deepEqual(updated.inputs, [DEVICE]);
    assert.deepEqual(await (await fetch(`${gate.origin}${IDENTITY_PATH}`)).json(), { hostId: HOST, machineId: "ts:renamed" });
  });
});
