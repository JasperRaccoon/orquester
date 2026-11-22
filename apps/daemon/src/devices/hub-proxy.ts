// Allowlists adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/server/src/device/DeviceHubProxy.ts
/**
 * The authenticated proxy to a device host's hub (devices spec §8): HTTP under
 * `/api/devices/hosts/:hostId/hub/*`, WebSockets under `/ws-device/:hostId/*`. The routes
 * (`http-routes.ts`, `ws-routes.ts`) authenticate, find the host, its loopback hub origin and
 * token, and hand the request here with the hub path. This module owns:
 *
 * - the allowlists (`direct/hub-paths.mjs`, shared with the stream gate on the owner's machines):
 *   only the paths the Device panel uses (device list, serve-sim helper streams, input socket and
 *   screenshot, serve-emu socket, screenshot and fold); serve-sim's grid start is the box host's
 *   own call (`hosts/box/host.ts`), never a client's; everything else 404, a method off the path's
 *   list 405;
 * - the device check: a `?device=` (or a helper path's UDID) must name a device leased on the host;
 * - headers: only an allowlist goes upstream (no cookie, authorization, dpop, forwarding or
 *   client token), `Host` and `Origin` become the hub's, the hub's own token is added as
 *   `Authorization: Bearer` (expo-device-hub `--require-token`), client token subprotocols are
 *   dropped; responses carry `Cache-Control: no-store, no-transform` and never set cookies;
 * - the MJPEG still-frame repeat (`mjpeg-still-frame.ts`);
 * - WebSocket relaying with 8 MiB back-pressure each way (as `desktops/ws-routes.ts`);
 * - control: an input frame (serve-sim helper messages, serve-emu gestures; not serve-emu's
 *   `reset-video`) or a fold is the user's input — control switches to the user at once
 *   (`DeviceService.userInput`, spec §7); watching never changes control;
 * - viewer activity: an open stream restarts the lease's idle clock and the host learns how many
 *   streams of a device are open (it may recycle a capture session nobody watches) — the streams
 *   its stream gate reports open on a direct route (tailnet machines spec §4.5) counted too, and
 *   the gate's input reports switch control like proxied input.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, type RawData } from "ws";

import { FORWARDED_REQUEST_HEADERS, FORWARDED_RESPONSE_HEADERS, hubDeviceOf, isResetVideoText, matchHubHttpRoute, matchHubWsRoute, TOKEN_SUBPROTOCOL } from "./direct/hub-paths.mjs";
import { repeatStillFrame } from "./mjpeg-still-frame.ts";

/** Where one proxied request goes. */
interface HubProxyTarget {
  hostId: string;
  /** The hub's loopback origin (`http://127.0.0.1:<port>`; a box host's `forwardToHost` port). */
  origin: string;
  /** The hub path after the prefix, with a leading `/` (`/vendor/serve-emu/ws`). */
  hubPath: string;
  /** The query string to forward (the `token` already removed), with its `?`, or "". */
  search: string;
  /** The hub's session token (`DeviceHost.hubToken`), sent upstream as a bearer; null: none. */
  token: string | null;
}

export interface HubProxy {
  /** Answer one HTTP request (any method) for the target. */
  handleHttp(request: FastifyRequest, reply: FastifyReply, target: HubProxyTarget): Promise<void>;
  /** Relay an accepted, authenticated WebSocket to the target. */
  handleWebSocket(socket: WebSocket, request: FastifyRequest, target: HubProxyTarget): void;
  /**
   * How many streams of a device the host's stream gate has open on its direct routes (it reports
   * them over its control channel, `direct/machine-gate.ts`): counted with the proxied ones, and the
   * lease's idle clock restarts while any is open.
   */
  directViewers(hostId: string, deviceParam: string, count: number): void;
  /** The stream gate saw the panel's input on a device (a direct route): the user takes control, as through the proxy. */
  directInput(hostId: string, deviceParam: string): void;
}

interface HubProxyDeps {
  /** The live lease on a device (its id or stream `device` parameter) of the host, or null. */
  leaseOnDevice(hostId: string, deviceParam: string): { id: string } | null;
  /** The panel's input on a device: the user takes control at once (spec §7). */
  userInput(hostId: string, deviceParam: string): void;
  /** A stream of the lease's device is being watched: its idle clock restarts. */
  viewerActive(leaseId: string): void;
  /** How many proxied streams of a device are open now. */
  viewersChanged?(hostId: string, deviceParam: string, count: number): void;
  logger: Pick<Console, "info" | "warn" | "error">;
}

/** Above this many bytes queued toward one side, the other side is paused. */
const HUB_SEND_HWM = 8 * 1024 * 1024;
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
const PENDING_MAX_MSGS = 512;
/** How often an open stream restarts its lease's idle clock. */
const VIEWER_TOUCH_MS = 60_000;
const UPSTREAM_OPEN_TIMEOUT_MS = 10_000;

function isResetVideo(data: RawData): boolean {
  return isResetVideoText(toBuffer(data).toString("utf8"));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** What the client sends upstream: allowlisted headers, the hub's Origin when one was sent, the hub's bearer. */
function upstreamHeaders(headers: FastifyRequest["headers"], target: Pick<HubProxyTarget, "origin" | "token">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") out[name] = value;
  }
  // serve-emu refuses mutations whose Origin differs from the request's own.
  if (headers.origin !== undefined) out.origin = target.origin;
  if (target.token) out.authorization = `Bearer ${target.token}`;
  return out;
}

/** The response headers the client sees. */
function downstreamHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") out[name] = value;
  }
  if (out["content-type"]?.startsWith("multipart/x-mixed-replace")) delete out["content-length"];
  // Long-lived MJPEG and AVCC responses must not be buffered or recompressed on the way.
  out["cache-control"] = "no-store, no-transform";
  out["x-content-type-options"] = "nosniff";
  return out;
}

async function refuse(reply: FastifyReply, status: number, code: string, message: string): Promise<void> {
  await reply.code(status).header("cache-control", "no-store").send({ code, message });
}

export function createHubProxy(deps: HubProxyDeps): HubProxy {
  const viewers = new Map<string, number>();
  /** Streams open on the hosts' direct routes, as their gates last reported (key → count and its idle-clock timer). */
  const direct = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();
  const keyOf = (hostId: string, device: string): string => `${hostId}\u0000${device}`;
  /** Proxied and direct streams of a device together: what its host learns. */
  const total = (key: string): number => (viewers.get(key) ?? 0) + (direct.get(key)?.count ?? 0);

  /** A stream of a device opened: count it, touch its lease now and while it stays open. Returns the close. */
  const watch = (hostId: string, device: string, leaseId: string): (() => void) => {
    const key = keyOf(hostId, device);
    viewers.set(key, (viewers.get(key) ?? 0) + 1);
    deps.viewerActive(leaseId);
    deps.viewersChanged?.(hostId, device, total(key));
    const timer = setInterval(() => deps.viewerActive(leaseId), VIEWER_TOUCH_MS);
    timer.unref?.();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      const left = Math.max(0, (viewers.get(key) ?? 1) - 1);
      if (left === 0) viewers.delete(key);
      else viewers.set(key, left);
      deps.viewersChanged?.(hostId, device, total(key));
    };
  };

  return {
    directViewers(hostId, device, count) {
      const key = keyOf(hostId, device);
      const before = direct.get(key);
      const next = Math.max(0, Math.floor(count));
      if ((before?.count ?? 0) === next) return;
      if (before) clearInterval(before.timer);
      if (next === 0) direct.delete(key);
      else {
        const touch = () => {
          const lease = deps.leaseOnDevice(hostId, device);
          if (lease) deps.viewerActive(lease.id);
        };
        const timer = setInterval(touch, VIEWER_TOUCH_MS);
        timer.unref?.();
        direct.set(key, { count: next, timer });
        if (!before) touch();
      }
      deps.viewersChanged?.(hostId, device, total(key));
    },

    directInput(hostId, device) {
      if (deps.leaseOnDevice(hostId, device)) deps.userInput(hostId, device);
    },

    async handleHttp(request, reply, target) {
      const found = matchHubHttpRoute(target.hubPath);
      if (!found) return refuse(reply, 404, "NOT_FOUND", "This hub path is not available through Orquester.");
      const { route, match } = found;
      if (!route.methods.includes(request.method)) {
        void reply.header("allow", route.methods.join(", "));
        return refuse(reply, 405, "METHOD_NOT_ALLOWED", `${request.method} is not allowed on this hub path.`);
      }
      const device = hubDeviceOf(match, route.device, target.search);
      if (route.device !== "none" && device === null) return refuse(reply, 400, "INVALID_ARGUMENT", "Name the device (`device`).");
      const lease = device !== null ? deps.leaseOnDevice(target.hostId, device) : null;
      if (device !== null && !lease) return refuse(reply, 404, "DEVICE_NOT_LEASED", "That device is not leased on this host.");
      if (route.input && request.method === "POST" && device !== null) deps.userInput(target.hostId, device);

      const url = new URL(`${target.hubPath}${target.search}`, target.origin);
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = send(url, { method: request.method, headers: upstreamHeaders(request.headers, target) });
      const body = request.body as Readable | undefined;
      // The client went away before the answer finished: stop the upstream request too.
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) upstream.destroy();
      });
      if (body && typeof body.pipe === "function" && request.method !== "GET" && request.method !== "HEAD") body.pipe(upstream);
      else upstream.end();

      let response: IncomingMessage;
      try {
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          upstream.once("response", resolve);
          upstream.once("error", reject);
        });
      } catch (error) {
        if (reply.sent || request.raw.destroyed) return;
        deps.logger.warn(`[devices] hub ${target.hostId} did not answer ${target.hubPath}`, error instanceof Error ? error.message : String(error));
        return refuse(reply, 502, "UNAVAILABLE", "The device hub did not answer.");
      }
      const headers = downstreamHeaders(response.headers);
      let stream: Readable = response;
      if (headers["content-type"]?.startsWith("multipart/x-mixed-replace")) stream = response.pipe(repeatStillFrame());
      if (route.stream && device !== null && lease && (response.statusCode ?? 500) < 300) {
        const unwatch = watch(target.hostId, device, lease.id);
        reply.raw.once("close", unwatch);
        response.once("close", unwatch);
      }
      response.once("error", () => stream.destroy());
      reply.raw.once("close", () => response.destroy());
      await reply.code(response.statusCode ?? 502).headers(headers).send(stream);
    },

    handleWebSocket(socket, request, target) {
      const route = matchHubWsRoute(target.hubPath);
      if (!route) {
        socket.close(1008, "hub path not available");
        return;
      }
      const device = new URLSearchParams(target.search).get("device");
      const lease = device ? deps.leaseOnDevice(target.hostId, device) : null;
      if (!device || !lease) {
        socket.close(1008, "device not leased");
        return;
      }

      let closed = false;
      let upstream: WebSocket | null = null;
      let upstreamOpen = false;
      let clientPaused = false;
      let upstreamPaused = false;
      const pending: { data: RawData; isBinary: boolean }[] = [];
      let pendingBytes = 0;
      const unwatch = watch(target.hostId, device, lease.id);

      const closeBoth = (code: number, reason: string) => {
        if (closed) return;
        closed = true;
        unwatch();
        try {
          socket.close(code, reason);
        } catch {
          // closing
        }
        try {
          if (upstream && upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
          else upstream?.close();
        } catch {
          // closing
        }
      };

      // Client → hub: pause the client above the HWM until the hub side drains.
      const writeUpstream = (data: RawData, isBinary: boolean) => {
        const ws = upstream!;
        ws.send(data, { binary: isBinary }, () => {
          if (clientPaused && !closed && ws.bufferedAmount <= HUB_SEND_HWM) {
            clientPaused = false;
            socket.resume();
          }
        });
        if (!clientPaused && ws.bufferedAmount > HUB_SEND_HWM) {
          clientPaused = true;
          socket.pause();
        }
      };

      // Attach synchronously: fastify-websocket drops messages that arrive before a listener exists.
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (closed) return;
        if (!(route.control === "reset-video" && !isBinary && isResetVideo(data))) {
          // Input: the panel touched or typed — the user takes control (spec §7).
          if (!deps.leaseOnDevice(target.hostId, device)) {
            closeBoth(1008, "device not leased");
            return;
          }
          deps.userInput(target.hostId, device);
        }
        if (upstreamOpen) {
          writeUpstream(data, isBinary);
          return;
        }
        const size = toBuffer(data).length;
        pending.push({ data, isBinary });
        pendingBytes += size;
        if (pending.length > PENDING_MAX_MSGS || pendingBytes > PENDING_MAX_BYTES) closeBoth(1011, "device buffer overflow");
      });
      socket.on("close", () => closeBoth(1000, "client closed"));
      socket.on("error", () => closeBoth(1011, "client error"));

      const requested = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "" && !TOKEN_SUBPROTOCOL.test(entry));
      const url = new URL(`${target.hubPath}${target.search}`, target.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url, requested, {
        headers: { ...(target.token ? { authorization: `Bearer ${target.token}` } : {}), origin: target.origin },
        perMessageDeflate: false,
        handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
        maxPayload: 64 * 1024 * 1024
      });
      upstream = ws;
      ws.on("open", () => {
        if (closed) return;
        upstreamOpen = true;
        for (const message of pending.splice(0)) writeUpstream(message.data, message.isBinary);
        pendingBytes = 0;
      });
      // Hub → client: pause the hub side above the HWM; resume once the client flushed below it.
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (closed) return;
        socket.send(data, { binary: isBinary }, () => {
          if (upstreamPaused && !closed && socket.bufferedAmount <= HUB_SEND_HWM) {
            upstreamPaused = false;
            ws.resume();
          }
        });
        if (!upstreamPaused && socket.bufferedAmount > HUB_SEND_HWM) {
          upstreamPaused = true;
          ws.pause();
        }
      });
      ws.on("close", (code, reason) => closeBoth(upstreamOpen ? closeCodeFor(code) : 1011, upstreamOpen ? reason.toString().slice(0, 120) || "device stream closed" : "device hub unreachable"));
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        closeBoth(1011, `device hub refused (${res.statusCode ?? "?"})`);
      });
      ws.on("error", () => closeBoth(1011, upstreamOpen ? "device stream error" : "device hub unreachable"));
    }
  };
}

/** A close code the client may receive (1005/1006 and reserved codes cannot be sent). */
function closeCodeFor(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
}
