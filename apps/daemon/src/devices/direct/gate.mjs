/**
 * The stream gate (tailnet machines spec 2026-11-22 §4.5): a small server the daemon runs on the
 * owner's own device machines, in front of the device hub, so the owner's viewer can stream from
 * the machine directly instead of through the daemon. Plain JavaScript on Node's standard library
 * only (types in `gate.d.mts`); the daemon uploads it with `hub-paths.mjs` beside it and starts it
 * as a detached `orq-agent` process (`machine-gate.ts`).
 *
 * - Listens on `0.0.0.0:<port>` (the LAN route; `tailscale serve` on the machine proxies its HTTPS
 *   name to `127.0.0.1:<port>`, the tailnet route) — on macOS on `127.0.0.1` only, with no LAN route:
 *   a non-loopback listener there makes the application firewall ask the owner on screen, and a Mac
 *   travels onto networks that are not the owner's — and writes `{pid, port, version, boot}` to its
 *   0600 state file once listening.
 * - `GET /.well-known/orquester/device-host`: the public identity `{hostId, machineId}` (no auth,
 *   no secret, `Access-Control-Allow-Origin: *`), which the viewer checks before sending a ticket.
 * - The hub paths of `hub-paths.mjs` that name a device (never the device list, never anything
 *   else): each request carries a ticket (`?ticket=`) the daemon signed with this host's secret —
 *   HMAC-SHA256 over `{host, device, expiry, origin}` — for this host and the device it names.
 *   The ticket is removed, the request goes to the hub on loopback with the hub's own token as a
 *   bearer (read from the hub's 0600 state file, never from the client), and only allowlisted
 *   headers pass either way. CORS answers the origin the ticket was issued to (`*` for a ticket
 *   issued without one: the desktop app's unix socket). WebSockets are relayed byte for byte (no
 *   compression negotiated), the client's frames read only to tell input from serve-emu's
 *   `reset-video`.
 * - `/.orq/gate/*` (the daemon only, through the box link, with a bearer derived from the secret):
 *   `status`; `events`, a long poll of the streams open per device, the devices that saw input, and
 *   the machine's LAN IPv4 addresses (so the daemon keeps control handoff, idle clocks and capture
 *   recycling right, and learns the LAN route); `stop`.
 *
 * The secret lives only in the gate's 0600 config file and in the daemon's memory; it is never in a
 * process argument, an environment variable or a log line.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FORWARDED_REQUEST_HEADERS, FORWARDED_RESPONSE_HEADERS, hubDeviceOf, isResetVideoText, matchHubHttpRoute, matchHubWsRoute, TOKEN_SUBPROTOCOL } from "./hub-paths.mjs";

/** Must equal `DEVICE_HOST_IDENTITY_PATH` in `@orquester/api` (a test holds them together). */
export const IDENTITY_PATH = "/.well-known/orquester/device-host";
/** Must equal `DEVICE_STREAM_TICKET_PARAM`. */
export const TICKET_PARAM = "ticket";
/** The daemon's control routes. */
export const CONTROL_PREFIX = "/.orq/gate/";

const TICKET_VERSION = "t1";
const MAX_TICKET_CHARS = 2048;
const LONG_POLL_MS = 25_000;
const LAN_POLL_MS = 10_000;
/** One input report per device at most this often (the daemon only needs the first of a burst). */
const INPUT_REPORT_MS = 1_000;
const INPUT_LOG_MAX = 200;
/** Client text frames up to this size are read (serve-emu's `reset-video` is a few bytes). */
const INSPECT_MAX_BYTES = 4096;
const HUB_CACHE_MS = 2_000;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const mac = (secret, text) => createHmac("sha256", secret).update(text).digest();

/** A ticket for one device of one host until `expiresAt` (epoch ms); `origin` binds it to the page that asked for it. */
export function signStreamTicket(secret, claims) {
  const body = { h: claims.hostId, d: claims.device, e: Math.floor(claims.expiresAt), n: randomBytes(9).toString("base64url") };
  if (typeof claims.origin === "string" && claims.origin !== "") body.o = claims.origin;
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${TICKET_VERSION}.${payload}.${mac(secret, `${TICKET_VERSION}.${payload}`).toString("base64url")}`;
}

/**
 * Whether `ticket` is this host's, unexpired, and (with `expect.device`) for that device. Reasons:
 * `malformed`, `signature`, `expired`, `host`, `device`.
 */
export function verifyStreamTicket(secret, ticket, expect) {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > MAX_TICKET_CHARS) return { ok: false, reason: "malformed" };
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION || parts[1] === "" || parts[2] === "") return { ok: false, reason: "malformed" };
  const want = mac(secret, `${parts[0]}.${parts[1]}`);
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "signature" };
  let body;
  try {
    body = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof body !== "object" || body === null || typeof body.h !== "string" || typeof body.d !== "string" || !Number.isFinite(body.e) || (body.o !== undefined && typeof body.o !== "string")) {
    return { ok: false, reason: "malformed" };
  }
  if (body.e <= expect.now) return { ok: false, reason: "expired" };
  if (body.h !== expect.hostId) return { ok: false, reason: "host" };
  if (expect.device !== undefined && body.d !== expect.device) return { ok: false, reason: "device" };
  return { ok: true, claims: { hostId: body.h, device: body.d, expiresAt: body.e, origin: body.o ?? null } };
}

/** The bearer of the daemon's control routes, derived from the host's secret. */
export function controlToken(secret) {
  return mac(secret, "orq-gate-control").toString("base64url");
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/** Interfaces that are no LAN: loopback, containers, VMs, VPNs and tunnels (Tailscale's included), Apple's peer links. */
const NOT_LAN = /^(lo|docker|br-|virbr|veth|vnet|tailscale|utun|tun|tap|wg|zt|vmnet|vboxnet|bridge|awdl|llw|anpi|cni|flannel|kube|podman|lxc|lxd|ham|ipsec|ppp)/i;

function isPrivateIpv4(address) {
  const bytes = address.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return false;
  const [a, b] = bytes;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The machine's LAN IPv4 addresses (private ranges on physical-looking interfaces), at most three. */
export function lanAddresses(interfaces) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (NOT_LAN.test(name)) continue;
    for (const entry of entries ?? []) {
      const v4 = entry.family === "IPv4" || entry.family === 4;
      if (v4 && !entry.internal && isPrivateIpv4(entry.address) && !found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found.slice(0, 3);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The running hub's port and token from its state dir (`server-<port>.json`, 0600), newest live one first; null when none runs. */
export function readHubState(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const states = [];
  for (const name of names) {
    if (!/^server-\d+\.json$/.test(name)) continue;
    try {
      const path = join(dir, name);
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || !processAlive(value.pid)) continue;
      states.push({ port: value.port, token: typeof value.token === "string" ? value.token : null, mtime: statSync(path).mtimeMs });
    } catch {
      // A state file being written, or gone.
    }
  }
  states.sort((a, b) => b.mtime - a.mtime);
  return states[0] ? { port: states[0].port, token: states[0].token } : null;
}

// ---------------------------------------------------------------------------
// WebSocket frames (client → hub), read only to tell input from control
// ---------------------------------------------------------------------------

/**
 * Follows the frames of one direction of a WebSocket (RFC 6455) without changing a byte: for each
 * data message's first frame, `onMessage(opcode, fin, text)` — `text` is the unmasked payload of a
 * small unfragmented text frame, else null. Continuations and control frames are skipped.
 */
export class FrameScanner {
  constructor(onMessage, inspectMax = INSPECT_MAX_BYTES) {
    this.onMessage = onMessage;
    this.inspectMax = inspectMax;
    this.header = Buffer.alloc(0);
    this.payload = null;
  }

  push(chunk) {
    let data = chunk;
    while (data.length > 0) {
      if (this.payload) {
        const take = Math.min(this.payload.remaining, data.length);
        if (this.payload.collect) this.payload.parts.push(Buffer.from(data.subarray(0, take)));
        this.payload.remaining -= take;
        data = data.subarray(take);
        if (this.payload.remaining === 0) this.finish();
        continue;
      }
      const buf = this.header.length > 0 ? Buffer.concat([this.header, data]) : data;
      if (buf.length < 2) {
        this.header = Buffer.from(buf);
        return;
      }
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      const short = buf[1] & 0x7f;
      const extra = short === 126 ? 2 : short === 127 ? 8 : 0;
      const need = 2 + extra + (masked ? 4 : 0);
      if (buf.length < need) {
        this.header = Buffer.from(buf);
        return;
      }
      let length = short;
      if (short === 126) length = buf.readUInt16BE(2);
      else if (short === 127) length = Number(buf.readBigUInt64BE(2));
      const mask = masked ? Buffer.from(buf.subarray(2 + extra, need)) : null;
      this.header = Buffer.alloc(0);
      data = buf.subarray(need);
      this.payload = { opcode, fin, mask, remaining: length, collect: opcode === 1 && fin && length <= this.inspectMax, parts: [] };
      if (length === 0) this.finish();
    }
  }

  finish() {
    const frame = this.payload;
    this.payload = null;
    if (frame.opcode !== 1 && frame.opcode !== 2) return;
    let text = null;
    if (frame.collect) {
      const bytes = Buffer.concat(frame.parts);
      if (frame.mask) for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= frame.mask[i % 4];
      text = bytes.toString("utf8");
    }
    this.onMessage(frame.opcode, frame.fin, text);
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The gate's HTTP server (not listening yet). `options`: `hostId`, `machineId`, `secret` (Buffer),
 * `version`, `hub()` (the hub's `{port, token}` or null), and optionally `now`, `lan()`,
 * `onMachineId(id)`, `onStop()`, `longPollMs`, `lanPollMs`.
 */
export function createStreamGate(options) {
  const now = options.now ?? Date.now;
  const lanOf = options.lan ?? (() => lanAddresses(networkInterfaces()));
  const longPollMs = options.longPollMs ?? LONG_POLL_MS;
  const control = controlToken(options.secret);
  const identity = { hostId: options.hostId, machineId: options.machineId ?? null };
  const boot = randomBytes(6).toString("base64url");
  let seq = 0;
  const viewers = new Map();
  const inputs = [];
  const lastInput = new Map();
  const waiters = new Set();
  let lan = lanOf();

  const bump = () => {
    seq += 1;
    for (const wake of [...waiters]) wake();
  };
  const viewer = (device, delta) => {
    const next = Math.max(0, (viewers.get(device) ?? 0) + delta);
    if (next === 0) viewers.delete(device);
    else viewers.set(device, next);
    bump();
  };
  const watch = (device) => {
    viewer(device, 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      viewer(device, -1);
    };
  };
  const input = (device) => {
    const at = now();
    const last = lastInput.get(device);
    if (last !== undefined && at - last < INPUT_REPORT_MS) return;
    lastInput.set(device, at);
    inputs.push({ seq: seq + 1, device });
    if (inputs.length > INPUT_LOG_MAX) inputs.splice(0, inputs.length - INPUT_LOG_MAX);
    bump();
  };
  const lanTimer = setInterval(() => {
    const next = lanOf();
    if (next.join(",") !== lan.join(",")) {
      lan = next;
      bump();
    }
  }, options.lanPollMs ?? LAN_POLL_MS);
  lanTimer.unref?.();

  const snapshot = (sameBoot, after) => ({
    boot,
    seq,
    hostId: identity.hostId,
    machineId: identity.machineId,
    viewers: Object.fromEntries(viewers),
    // Only inputs this caller has not seen: a daemon that restarted (another boot) must not replay old ones.
    inputs: sameBoot ? [...new Set(inputs.filter((entry) => entry.seq > after).map((entry) => entry.device))] : [],
    lan
  });

  const json = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
    res.end(text);
  };

  const controlRoute = (req, res, url) => {
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), control)) return json(res, 401, { code: "UNAUTHORIZED" });
    const name = url.pathname.slice(CONTROL_PREFIX.length);
    if (name === "status" && req.method === "GET") return json(res, 200, { hostId: identity.hostId, machineId: identity.machineId, version: options.version ?? null, boot, pid: process.pid });
    if (name === "stop" && req.method === "POST") {
      json(res, 200, { stopping: true });
      res.once("finish", () => options.onStop?.());
      return;
    }
    if (name === "events" && req.method === "GET") {
      const machineId = url.searchParams.get("machineId");
      if (machineId !== null && machineId !== "" && machineId.length <= 200 && machineId !== identity.machineId) {
        identity.machineId = machineId;
        options.onMachineId?.(machineId);
      }
      const sameBoot = url.searchParams.get("boot") === boot;
      const after = Number(url.searchParams.get("after"));
      if (!sameBoot || after !== seq) return json(res, 200, snapshot(sameBoot, after));
      let done = false;
      const answer = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(answer);
        if (!res.destroyed) json(res, 200, snapshot(true, after));
      };
      const timer = setTimeout(answer, longPollMs);
      waiters.add(answer);
      req.once("close", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(answer);
      });
      return;
    }
    return json(res, 404, { code: "NOT_FOUND" });
  };

  /** The ticket check every hub request passes: null when allowed, else the refusal (status, code). */
  const admit = (url, device, originHeader) => {
    const verdict = verifyStreamTicket(options.secret, url.searchParams.get(TICKET_PARAM), { hostId: identity.hostId, device, now: now() });
    if (!verdict.ok) return { refusal: { status: 403, code: `TICKET_${verdict.reason.toUpperCase()}` } };
    if (verdict.claims.origin && originHeader !== undefined && originHeader !== verdict.claims.origin) return { refusal: { status: 403, code: "TICKET_ORIGIN" } };
    return { cors: verdict.claims.origin ?? "*" };
  };

  const handle = (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://gate.invalid");
    } catch {
      return json(res, 400, { code: "INVALID_ARGUMENT" });
    }
    const path = url.pathname;
    if (path === IDENTITY_PATH) {
      const cors = { "access-control-allow-origin": "*" };
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET", "access-control-allow-private-network": "true", "access-control-max-age": "600" });
        return res.end();
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { code: "METHOD_NOT_ALLOWED" }, { ...cors, allow: "GET" });
      return json(res, 200, { hostId: identity.hostId, machineId: identity.machineId }, cors);
    }
    if (path.startsWith(CONTROL_PREFIX)) return controlRoute(req, res, url);

    const found = matchHubHttpRoute(path);
    // A ticket names one device: paths that name none (the device list) are not offered here.
    if (!found || found.route.device === "none") return json(res, 404, { code: "NOT_FOUND" }, { "access-control-allow-origin": "*" });
    const { route, match } = found;
    const device = hubDeviceOf(match, route.device, url.search);
    if (device === null) return json(res, 400, { code: "INVALID_ARGUMENT" }, { "access-control-allow-origin": "*" });
    const verdict = admit(url, device, req.headers.origin);
    if (verdict.refusal) return json(res, verdict.refusal.status, { code: verdict.refusal.code }, { "access-control-allow-origin": "*" });
    const cors = { "access-control-allow-origin": verdict.cors, vary: "origin" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": route.methods.join(", "),
        "access-control-allow-headers": "content-type, range",
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600"
      });
      return res.end();
    }
    if (!route.methods.includes(req.method ?? "")) return json(res, 405, { code: "METHOD_NOT_ALLOWED" }, { ...cors, allow: route.methods.join(", ") });
    const hub = options.hub();
    if (!hub) return json(res, 502, { code: "UNAVAILABLE" }, cors);

    url.searchParams.delete(TICKET_PARAM);
    const search = url.searchParams.toString();
    const headers = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    // serve-emu refuses mutations whose Origin differs from the request's own.
    if (req.headers.origin !== undefined) headers.origin = `http://127.0.0.1:${hub.port}`;
    if (hub.token) headers.authorization = `Bearer ${hub.token}`;
    if (route.input && req.method === "POST") input(device);

    const upstream = httpRequest({ host: "127.0.0.1", port: hub.port, path: `${path}${search ? `?${search}` : ""}`, method: req.method, headers });
    res.once("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.once("error", () => {
      options.hubFailed?.();
      if (!res.headersSent) json(res, 502, { code: "UNAVAILABLE" }, cors);
      else res.destroy();
    });
    upstream.once("response", (response) => {
      const out = { ...cors };
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers[name];
        if (typeof value === "string") out[name] = value;
      }
      if (out["content-type"]?.startsWith("multipart/x-mixed-replace")) delete out["content-length"];
      out["cache-control"] = "no-store, no-transform";
      out["x-content-type-options"] = "nosniff";
      const status = response.statusCode ?? 502;
      if (route.stream && status < 300) {
        const unwatch = watch(device);
        res.once("close", unwatch);
        response.once("close", unwatch);
      }
      res.writeHead(status, out);
      response.pipe(res);
      response.once("error", () => res.destroy());
    });
    if (req.method !== "GET" && req.method !== "HEAD") req.pipe(upstream);
    else upstream.end();
  };

  const upgrade = (req, socket, head) => {
    const refuse = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on("error", () => socket.destroy());
    let url;
    try {
      url = new URL(req.url ?? "/", "http://gate.invalid");
    } catch {
      return refuse(400, "Bad Request");
    }
    const route = matchHubWsRoute(url.pathname);
    if (!route) return refuse(404, "Not Found");
    const device = url.searchParams.get("device");
    if (!device) return refuse(400, "Bad Request");
    const verdict = admit(url, device, req.headers.origin);
    if (verdict.refusal) return refuse(403, "Forbidden");
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key === "") return refuse(400, "Bad Request");
    const hub = options.hub();
    if (!hub) return refuse(502, "Bad Gateway");
    url.searchParams.delete(TICKET_PARAM);
    const search = url.searchParams.toString();
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "" && !TOKEN_SUBPROTOCOL.test(entry) && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry));
    const version = typeof req.headers["sec-websocket-version"] === "string" ? req.headers["sec-websocket-version"] : "13";
    const lines = [
      `GET ${url.pathname}${search ? `?${search}` : ""} HTTP/1.1`,
      `Host: 127.0.0.1:${hub.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Version: ${version.replace(/[^0-9]/g, "") || "13"}`,
      `Sec-WebSocket-Key: ${key.replace(/[^A-Za-z0-9+/=]/g, "")}`,
      ...(protocols.length > 0 ? [`Sec-WebSocket-Protocol: ${protocols.join(", ")}`] : []),
      `Origin: http://127.0.0.1:${hub.port}`,
      ...(hub.token ? [`Authorization: Bearer ${hub.token}`] : []),
      "",
      ""
    ];

    const upstream = connect(hub.port, "127.0.0.1");
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    let unwatch = null;
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      unwatch?.();
      socket.destroy();
      upstream.destroy();
    };
    socket.once("close", closeBoth);
    upstream.once("close", closeBoth);
    upstream.once("error", () => {
      options.hubFailed?.();
      if (!unwatch && !socket.destroyed) refuse(502, "Bad Gateway");
      closeBoth();
    });

    // Hub → client: its handshake answer first (101 counts a viewer), then the bytes as they come.
    let pending = Buffer.alloc(0);
    const onHandshake = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) {
        if (pending.length > 16 * 1024) closeBoth();
        return;
      }
      upstream.off("data", onHandshake);
      const switched = /^HTTP\/1\.1 101 /.test(pending.subarray(0, end).toString("latin1"));
      socket.write(pending);
      pending = Buffer.alloc(0);
      if (!switched) {
        socket.end();
        return;
      }
      unwatch = watch(device);
      upstream.pipe(socket);
    };
    upstream.on("data", onHandshake);

    // Client → hub: unchanged; each data message is input unless it is serve-emu's `reset-video`.
    const scanner = new FrameScanner((opcode, fin, text) => {
      const control = route.control === "reset-video" && opcode === 1 && fin && text !== null && isResetVideoText(text);
      if (!control) input(device);
    });
    const forward = (chunk) => {
      scanner.push(chunk);
      if (!upstream.write(chunk)) socket.pause();
    };
    upstream.on("drain", () => socket.resume());
    upstream.once("connect", () => {
      upstream.write(lines.join("\r\n"));
      if (head && head.length > 0) forward(head);
      socket.on("data", forward);
    });
  };

  const server = createServer(handle);
  server.on("upgrade", upgrade);
  server.on("clientError", (_error, socket) => socket.destroy());

  return {
    server,
    boot,
    /** Stop the timers and wake the long polls (the server is closed by its owner). */
    close() {
      clearInterval(lanTimer);
      for (const wake of [...waiters]) wake();
    }
  };
}

// ---------------------------------------------------------------------------
// main: node gate.mjs <config.json>
// ---------------------------------------------------------------------------

function writePrivate(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function readConfig(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const valid =
    typeof value === "object" &&
    value !== null &&
    typeof value.hostId === "string" &&
    (value.machineId === null || typeof value.machineId === "string") &&
    typeof value.secret === "string" &&
    typeof value.hubStateDir === "string" &&
    typeof value.statePath === "string" &&
    Number.isInteger(value.port) &&
    value.port >= 0 &&
    value.port <= 65535;
  if (!valid) throw new Error("the gate config is not valid");
  const secret = Buffer.from(value.secret, "base64url");
  if (secret.length < 32) throw new Error("the gate secret is too short");
  return { ...value, secret };
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function main(configPath) {
  if (!configPath) throw new Error("usage: gate.mjs <config.json>");
  const config = readConfig(configPath);
  let cache = { at: 0, value: null };
  const hub = () => {
    if (cache.value && Date.now() - cache.at < HUB_CACHE_MS) return cache.value;
    cache = { at: Date.now(), value: readHubState(config.hubStateDir) };
    return cache.value;
  };
  let stopping = false;
  // macOS: loopback only (the tailnet route through `tailscale serve`), no LAN route.
  const loopbackOnly = process.platform === "darwin";
  const bindHost = loopbackOnly ? "127.0.0.1" : "0.0.0.0";
  const gate = createStreamGate({
    ...(loopbackOnly ? { lan: () => [] } : {}),
    hostId: config.hostId,
    machineId: config.machineId,
    secret: config.secret,
    version: typeof config.version === "string" ? config.version : null,
    hub,
    hubFailed: () => {
      cache = { at: 0, value: null };
    },
    onMachineId: (machineId) => {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf8"));
        writePrivate(configPath, `${JSON.stringify({ ...raw, machineId })}\n`);
      } catch {
        // The identity in memory is what answers; the file catches up on the next change.
      }
    },
    onStop: () => shutdown(0)
  });
  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    gate.close();
    gate.server.close();
    gate.server.closeAllConnections?.();
    setTimeout(() => process.exit(code), 200).unref();
  }
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
  try {
    await listen(gate.server, config.port, bindHost);
  } catch (error) {
    if (config.port === 0 || error?.code !== "EADDRINUSE") throw error;
    await listen(gate.server, 0, bindHost);
  }
  const port = gate.server.address().port;
  writePrivate(config.statePath, `${JSON.stringify({ pid: process.pid, port, version: config.version ?? null, boot: gate.boot })}\n`);
  console.log(`orquester stream gate for ${config.hostId} on port ${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((error) => {
    console.error(`orquester stream gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
