/**
 * The vphone streaming bridge: a loopback HTTP + WebSocket server in the daemon, one per vphone
 * host, that speaks the serve-sim endpoints the Device panel already uses, so a research VM streams
 * and takes input through the ordinary hub proxy (`DeviceHost.hubOrigin()` points here; the proxy
 * adds `hubToken()` as `Authorization: Bearer`, which every request must carry).
 *
 * | serve-sim (panel side) | vphone (VM side, through the box forward) |
 * |---|---|
 * | `GET /vendor/serve-sim/helper/<id>/stream.avcc` | `WS /v1/host/screen`: one `{codec:"h264", box, fps, bitrate, key}` pull per frame; each answer re-emitted as avcc envelopes (`screen-protocol.ts`) |
 * | `GET /vendor/serve-sim/helper/<id>/stream.mjpeg` | `screen.screenshot` JPEGs as `multipart/x-mixed-replace` parts |
 * | `POST /vendor/serve-sim/api/screenshot?device=<id>` | one `screen.screenshot` JPEG (the fleet view's thumbnail, through the daemon or the hub proxy) |
 * | `WS /vendor/serve-sim/helper/ws?device=<id>` | `WS /v1/events`: `0x83` admitted and `0x82` screen config down; `0x03` touch → `input.touch {phase, x, y, normalized: true}`, `0x04` button → `input.button`, `0x06` key → `input.hid {page: 7, usage, down}`, a text frame `{"type":"text","text"}` → `input.type` |
 *
 * Input is sent one request at a time (vphoned runs requests concurrently; touches must stay in
 * order), and queued moves collapse into the latest. Frames are pulled only while the client keeps
 * up, so a slow viewer never builds a backlog.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { asRecord, type VphoneGuestClient } from "./guest-client.ts";
import { decodeScreenReply, encodeScreenRequest, HostScreenToAvcc, MJPEG_BOUNDARY, mjpegPart } from "./screen-protocol.ts";

/** serve-sim helper socket tags (`packages/ui/src/components/device/stream/serveSimInput.ts`). */
export const SERVE_SIM_TAG = { touch: 0x03, button: 0x04, key: 0x06, orientation: 0x07, screenConfig: 0x82, inputAdmitted: 0x83 } as const;

/** USB HID keyboard page. */
const HID_KEYBOARD_PAGE = 7;

export interface VphoneBridgeDevice {
  client: VphoneGuestClient;
  /** The screen in points (portrait), when known. */
  screen: { width: number; height: number } | null;
}

export interface VphoneStreamTuning {
  /** The box frames are fitted into (no enlarging). */
  box: [number, number];
  fps: number;
  bitrate: number;
  /** Least time between two MJPEG screenshots. */
  mjpegIntervalMs: number;
}

const DEFAULT_STREAM_TUNING: VphoneStreamTuning = { box: [1600, 1600], fps: 30, bitrate: 6_000_000, mjpegIntervalMs: 250 };

export interface VphoneBridgeOptions {
  /** What the proxy sends as `Authorization: Bearer`. */
  token: string;
  /** A device the bridge serves (`orq-<leaseId>`), or null. */
  device(id: string): VphoneBridgeDevice | null;
  logger: Pick<Console, "info" | "warn" | "error">;
  tuning?: Partial<VphoneStreamTuning>;
}

/** Pulls in flight at once on `/v1/host/screen` (vphoned refuses more than 16 waiting). */
const MAX_IN_FLIGHT = 2;
const MAX_INPUT_QUEUE = 256;
const STREAM_PATH = /^\/vendor\/serve-sim\/helper\/([^/]+)\/(stream\.avcc|stream\.mjpeg)$/;
const INPUT_PATH = "/vendor/serve-sim/helper/ws";
const SCREENSHOT_PATH = "/vendor/serve-sim/api/screenshot";
const SCREENSHOT_TIMEOUT_MS = 30_000;

export class VphoneBridge {
  private server: Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  private originValue: string | null = null;
  private closed = false;
  private readonly tuning: VphoneStreamTuning;
  private readonly sessions = new Set<{ close(): void }>();

  constructor(private readonly options: VphoneBridgeOptions) {
    this.tuning = { ...DEFAULT_STREAM_TUNING, ...options.tuning };
  }

  /** Listen on 127.0.0.1 (an OS-chosen port). */
  async start(): Promise<string> {
    if (this.originValue) return this.originValue;
    if (this.closed) throw new Error("the vphone bridge is closed");
    const server = createServer((request, response) => this.handleHttp(request, response));
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (this.closed) {
      // Closed while it was starting.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("the vphone bridge is closed");
    }
    this.server = server;
    this.originValue = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.originValue;
  }

  origin(): string | null {
    return this.originValue;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.originValue = null;
    for (const session of [...this.sessions]) session.close();
    for (const client of this.wss.clients) client.terminate();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (typeof header !== "string") return false;
    const expected = Buffer.from(`Bearer ${this.options.token}`);
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request)) return void response.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
    const url = new URL(request.url ?? "/", "http://bridge");
    if (url.pathname === SCREENSHOT_PATH) return void this.screenshot(request, response, url.searchParams.get("device") ?? "");
    const match = STREAM_PATH.exec(url.pathname);
    if (!match) return void response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    if (request.method !== "GET" && request.method !== "HEAD") return void response.writeHead(405, { allow: "GET, HEAD" }).end();
    const id = decodeURIComponent(match[1]!);
    const device = this.options.device(id);
    if (!device) return void response.writeHead(404, { "content-type": "text/plain" }).end("unknown device");
    if (match[2] === "stream.avcc") {
      response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store, no-transform" });
      if (request.method === "HEAD") return void response.end();
      const pump: H264Pump = new H264Pump(device, response, this.tuning, this.options.logger, () => this.sessions.delete(pump));
      this.sessions.add(pump);
      pump.start();
    } else {
      response.writeHead(200, { "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`, "cache-control": "no-store, no-transform" });
      if (request.method === "HEAD") return void response.end();
      const pump: MjpegPump = new MjpegPump(device, response, this.tuning, this.options.logger, () => this.sessions.delete(pump));
      this.sessions.add(pump);
      pump.start();
    }
  }

  /** serve-sim's `POST /api/screenshot?device=`: the device's screen as one JPEG (`screen.screenshot`). */
  private async screenshot(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    request.resume();
    if (request.method !== "POST") return void response.writeHead(405, { allow: "POST" }).end();
    if (id === "") return void response.writeHead(400, { "content-type": "text/plain" }).end("name the device");
    const device = this.options.device(id);
    if (!device) return void response.writeHead(404, { "content-type": "text/plain" }).end("unknown device");
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    try {
      const result = await device.client.call("screen.screenshot", {}, { signal: abort.signal, timeoutMs: SCREENSHOT_TIMEOUT_MS });
      const jpeg = typeof result.data === "string" ? Buffer.from(result.data, "base64") : null;
      if (!jpeg || jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        return void response.writeHead(502, { "content-type": "text/plain" }).end("the research iPhone answered no JPEG");
      }
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": String(jpeg.length), "cache-control": "no-store" }).end(jpeg);
    } catch (error) {
      if (abort.signal.aborted || response.headersSent) return void response.destroy();
      this.options.logger.warn("[devices] vphone screenshot failed", error instanceof Error ? error.message : String(error));
      response.writeHead(502, { "content-type": "text/plain" }).end("the research iPhone did not answer");
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!this.authorized(request)) return refuse(401, "Unauthorized");
    const url = new URL(request.url ?? "/", "http://bridge");
    if (url.pathname !== INPUT_PATH) return refuse(404, "Not Found");
    const id = url.searchParams.get("device") ?? "";
    const device = this.options.device(id);
    if (!device) return refuse(404, "Not Found");
    this.wss.handleUpgrade(request, socket, head, (panel) => {
      const relay: InputRelay = new InputRelay(device, panel, this.options.logger, () => this.sessions.delete(relay));
      this.sessions.add(relay);
      relay.start();
    });
  }
}

/** One `stream.avcc` subscriber: its own `/v1/host/screen` socket (its own encoder, session 1, a key frame first). */
class H264Pump {
  private readonly guest: WebSocket;
  private readonly convert = new HostScreenToAvcc();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private nextId = 1;
  private wantKey = true;
  private closed = false;

  constructor(
    device: VphoneBridgeDevice,
    private readonly out: ServerResponse,
    private readonly tuning: VphoneStreamTuning,
    private readonly logger: Pick<Console, "warn">,
    private readonly ended: () => void
  ) {
    this.guest = device.client.openSocket("/v1/host/screen");
  }

  start(): void {
    this.guest.on("open", () => {
      this.timer = setInterval(() => this.pull(), Math.max(5, Math.round(1000 / this.tuning.fps)));
      this.pull();
    });
    this.guest.on("message", (data, isBinary) => this.onReply(data, isBinary));
    this.guest.on("error", () => this.close());
    this.guest.on("close", () => this.close());
    this.guest.on("unexpected-response", (_request, response) => {
      this.logger.warn(`[devices] vphone screen socket refused (${response.statusCode})`);
      this.close();
    });
    this.out.on("close", () => this.close());
  }

  private pull(): void {
    if (this.closed || this.guest.readyState !== WebSocket.OPEN || this.inFlight >= MAX_IN_FLIGHT || this.out.writableNeedDrain) return;
    const key = this.wantKey;
    this.wantKey = false;
    this.inFlight += 1;
    this.guest.send(encodeScreenRequest({ id: this.nextId++, codec: "h264", box: this.tuning.box, fps: this.tuning.fps, bitrate: this.tuning.bitrate, key }));
  }

  private onReply(data: RawData, isBinary: boolean): void {
    if (!isBinary || this.closed) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    let reply;
    try {
      reply = decodeScreenReply(toBuffer(data));
    } catch (error) {
      this.logger.warn("[devices] vphone sent a malformed screen frame", error instanceof Error ? error.message : String(error));
      this.close();
      return;
    }
    const { error } = reply.header;
    if (error) {
      if (error.code === "encoder_failed") {
        this.wantKey = true;
        this.convert.resetKey();
        return;
      }
      if (error.code === "too_many_requests" || error.code === "display_unavailable") return;
      // codec_unavailable (no H.264 encoder) or bad_request: the panel falls back to MJPEG.
      this.logger.warn(`[devices] vphone screen stream ended: ${error.code} ${error.message}`.trim());
      this.close();
      return;
    }
    const envelopes = this.convert.convert(reply);
    if (reply.header.status === "frame" && envelopes.length === 0) {
      // A delta before the first key frame, or an unusable frame: start over from a key frame.
      this.wantKey = true;
      this.convert.resetKey();
      return;
    }
    for (const envelope of envelopes) this.out.write(envelope);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ended();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.guest.readyState === WebSocket.OPEN || this.guest.readyState === WebSocket.CONNECTING) this.guest.terminate();
    if (!this.out.writableEnded) this.out.end();
  }
}

/** One `stream.mjpeg` subscriber: screenshots, one at a time, no faster than the client reads them. */
class MjpegPump {
  private readonly abort = new AbortController();

  constructor(
    private readonly device: VphoneBridgeDevice,
    private readonly out: ServerResponse,
    private readonly tuning: VphoneStreamTuning,
    private readonly logger: Pick<Console, "warn">,
    private readonly ended: () => void
  ) {}

  start(): void {
    this.out.on("close", () => this.abort.abort());
    void this.run().finally(this.ended);
  }

  close(): void {
    this.abort.abort();
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const result = await this.device.client.call("screen.screenshot", {}, { signal, timeoutMs: 30_000 });
        const jpeg = typeof result.data === "string" ? Buffer.from(result.data, "base64") : null;
        if (jpeg && jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
          failures = 0;
          if (!this.out.write(mjpegPart(jpeg))) await waitFor(this.out, "drain", signal);
        } else failures += 1;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        if (failures === 1) this.logger.warn("[devices] vphone screenshot failed", error instanceof Error ? error.message : String(error));
      }
      if (failures >= 5) break;
      await delay(Math.max(0, this.tuning.mjpegIntervalMs * (failures > 0 ? 4 : 1) - (Date.now() - started)), signal);
    }
    if (!this.out.writableEnded) this.out.end();
  }
}

/** One panel input socket, relayed to the VM's `/v1/events` socket. */
class InputRelay {
  private readonly guest: WebSocket;
  private readonly pending = new Map<string, () => void>();
  private readonly queue: { method: string; params: Record<string, unknown>; move: boolean }[] = [];
  private sending = false;
  private nextId = 1;
  private closed = false;
  private warned = false;

  constructor(
    private readonly device: VphoneBridgeDevice,
    private readonly panel: WebSocket,
    private readonly logger: Pick<Console, "warn">,
    private readonly ended: () => void
  ) {
    this.guest = device.client.openSocket("/v1/events");
  }

  start(): void {
    this.guest.on("open", () => {
      if (this.closed) return;
      const screen = this.device.screen ?? { width: 402, height: 874 };
      this.panel.send(Buffer.from([SERVE_SIM_TAG.inputAdmitted]));
      this.panel.send(tagged(SERVE_SIM_TAG.screenConfig, { width: screen.width, height: screen.height, orientation: "portrait" }));
    });
    this.guest.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = asRecord(safeJson(toBuffer(data).toString("utf8")));
      if (message?.type !== "response" || typeof message.id !== "string") return;
      const done = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error && !this.warned) {
        this.warned = true;
        const error = asRecord(message.error);
        this.logger.warn(`[devices] vphone refused input: ${typeof error?.message === "string" ? error.message : "error"}`);
      }
      done?.();
    });
    this.guest.on("error", () => this.close(1011, "device input unavailable"));
    this.guest.on("close", () => this.close(1011, "device input closed"));
    this.guest.on("unexpected-response", () => this.close(1011, "device input refused"));
    this.panel.on("message", (data, isBinary) => this.onPanel(toBuffer(data), isBinary));
    this.panel.on("close", () => this.close());
    this.panel.on("error", () => this.close());
  }

  private onPanel(bytes: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      const message = asRecord(safeJson(bytes.toString("utf8")));
      if (message?.type === "text" && typeof message.text === "string" && message.text.length > 0 && message.text.length <= 4000) this.enqueue("input.type", { text: message.text });
      return;
    }
    if (bytes.length < 1) return;
    const payload = asRecord(safeJson(bytes.subarray(1).toString("utf8")));
    if (!payload) return;
    for (const [method, params] of mapPanelInput(bytes[0]!, payload)) this.enqueue(method, params);
  }

  private enqueue(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const move = method === "input.touch" && params.phase === "move";
    const last = this.queue[this.queue.length - 1];
    if (move && last?.move) last.params = params;
    else if (this.queue.length < MAX_INPUT_QUEUE) this.queue.push({ method, params, move });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    while (!this.closed && this.queue.length > 0 && this.guest.readyState === WebSocket.OPEN) {
      const next = this.queue.shift()!;
      const id = `in-${this.nextId++}`;
      await new Promise<void>((resolve) => {
        this.pending.set(id, resolve);
        this.guest.send(JSON.stringify({ id, method: next.method, params: next.params }));
      });
    }
    this.sending = false;
    // Input that arrived before the VM socket opened.
    if (!this.closed && this.queue.length > 0 && this.guest.readyState === WebSocket.CONNECTING) this.guest.once("open", () => void this.drain());
  }

  close(code = 1001, reason = "closing"): void {
    if (this.closed) return;
    this.closed = true;
    this.ended();
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
    this.queue.length = 0;
    if (this.guest.readyState === WebSocket.OPEN || this.guest.readyState === WebSocket.CONNECTING) this.guest.terminate();
    if (this.panel.readyState === WebSocket.OPEN) this.panel.close(code, reason);
  }
}

const TOUCH_PHASE: Readonly<Record<string, string>> = { begin: "down", move: "move", end: "up" };

/** A panel input message (tag + JSON) as vphoned requests; none for anything not understood. */
export function mapPanelInput(tag: number, payload: Record<string, unknown>): [string, Record<string, unknown>][] {
  switch (tag) {
    case SERVE_SIM_TAG.touch: {
      const phase = typeof payload.type === "string" ? TOUCH_PHASE[payload.type] : undefined;
      const x = unit(payload.x);
      const y = unit(payload.y);
      if (!phase || x === null || y === null) return [];
      return [["input.touch", { phase, x, y, normalized: true }]];
    }
    case SERVE_SIM_TAG.button:
      switch (payload.button) {
        case "home":
          return [["input.button", { name: "home" }]];
        case "lock":
          return [["input.button", { name: "power" }]];
        case "app_switcher":
          return [
            ["input.button", { name: "home" }],
            ["input.button", { name: "home" }]
          ];
        default:
          return [];
      }
    case SERVE_SIM_TAG.key: {
      const usage = payload.usage;
      if ((payload.type !== "down" && payload.type !== "up") || typeof usage !== "number" || !Number.isInteger(usage) || usage < 0 || usage > 0xffff) return [];
      return [["input.hid", { page: HID_KEYBOARD_PAGE, usage, down: payload.type === "down" }]];
    }
    default:
      // 0x07 orientation and anything newer: vphone rotates with the guest's own Settings.
      return [];
  }
}

function unit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function tagged(tag: number, payload: unknown): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload), "utf8")]);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function waitFor(emitter: ServerResponse, event: "drain", signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      emitter.off(event, done);
      emitter.off("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    emitter.once(event, done);
    emitter.once("close", done);
    signal.addEventListener("abort", done, { once: true });
  });
}
