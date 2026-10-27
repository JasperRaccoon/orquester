/**
 * Test doubles for the vphone host (no Mac needed):
 *
 * - {@link startFakeVphoned}: a loopback server shaped like a VM's `--api-listen` proxy and vphoned
 *   (`Research/vphoned_http_api.md`): bearer token admission (401), `Origin` refused (403),
 *   `/v1/health`, `/v1/rpc` (JSON only, 415 otherwise), `PUT /v1/files/content`, the `/v1/events`
 *   WebSocket, and `/v1/host/screen` answering each pull with a frame built per the protocol
 *   (4-byte LE header length, JSON header, length-prefixed NALs; `record` on key frames).
 * - {@link FakeMacLink}: a `BoxConnection` subset whose `exec` answers scripted vphone-cli and
 *   probe commands, and whose `vm launch` starts a fake vphoned with the token it was given in its
 *   environment and prints the API address as vphone-vm does.
 * - {@link avccDemux}: the panel's `AvccDemuxer` parse loop, replicated byte for byte from
 *   `packages/ui/src/components/device/stream/avcc.ts` (the daemon cannot import the UI package).
 */

import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import type { BoxSysInfo } from "@orquester/api";
import { WebSocketServer, type WebSocket } from "ws";

import type { BoxExecOptions, BoxHostForward, BoxProcess } from "../../../boxes/contracts.ts";
import { localSysInfo } from "../../../boxes/testing.ts";
import type { VphoneBoxLink } from "./host.ts";

// ---------------------------------------------------------------------------
// Recorded-shape H.264 (an iPhone screen at 738×1600, High profile)
// ---------------------------------------------------------------------------

export const FIXTURE_SPS = Buffer.from("6764001fac d9405005 bb011000 00030010 00000303 c0f18319 60".replace(/\s/g, ""), "hex");
export const FIXTURE_PPS = Buffer.from("68ebe3cb22c0", "hex");
/** An AVCDecoderConfigurationRecord: version 1, High 3.1, 4-byte NAL lengths, one SPS, one PPS. */
export const FIXTURE_AVCC = Buffer.concat([
  Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1]),
  u16(FIXTURE_SPS.length),
  FIXTURE_SPS,
  Buffer.from([1]),
  u16(FIXTURE_PPS.length),
  FIXTURE_PPS
]);
/** One IDR access unit (an SEI and an IDR slice), 4-byte length-prefixed. */
export const FIXTURE_KEY_AU = lengthPrefixed([Buffer.from("06051a47564adc5c4c433f94efc5113cd143a801ffccccff020004000080", "hex"), Buffer.from("65888400337ff8ec1de7c2c8a07a0b7e", "hex")]);
/** One P slice. */
export const FIXTURE_DELTA_AU = lengthPrefixed([Buffer.from("419a2c4c43ff", "hex")]);

function u16(value: number): Buffer {
  return Buffer.from([value >> 8, value & 0xff]);
}

export function lengthPrefixed(nals: Buffer[]): Buffer {
  return Buffer.concat(
    nals.flatMap((nal) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(nal.length, 0);
      return [length, nal];
    })
  );
}

/** A `/v1/host/screen` answer as vphone-vm builds it (`VPhoneHostScreenProtocol.message`). */
export function encodeScreenReply(header: Record<string, unknown>, payload: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(json.length, 0);
  return Buffer.concat([length, json, payload]);
}

/** A tiny JPEG-looking image (SOI … EOI). */
export const FIXTURE_JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

// ---------------------------------------------------------------------------
// The panel's demuxer, replicated
// ---------------------------------------------------------------------------

export interface AvccChunk {
  type: "description" | "keyframe" | "delta" | "seed";
  payload: Uint8Array;
}

/** `AvccDemuxer.push` over one buffer (same loop, same tags, unknown tags skipped). */
export function avccDemux(bytes: Uint8Array): { chunks: AvccChunk[]; rest: number } {
  const tags: Record<number, AvccChunk["type"] | undefined> = { 1: "description", 2: "keyframe", 3: "delta", 4: "seed" };
  const chunks: AvccChunk[] = [];
  let offset = 0;
  while (bytes.length - offset >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    const envelopeLength = view.getUint32(0, false);
    if (bytes.length - offset - 4 < envelopeLength) break;
    if (envelopeLength >= 1) {
      const type = tags[bytes[offset + 4]!];
      if (type) chunks.push({ type, payload: bytes.slice(offset + 5, offset + 4 + envelopeLength) });
    }
    offset += 4 + envelopeLength;
  }
  return { chunks, rest: bytes.length - offset };
}

// ---------------------------------------------------------------------------
// Fake vphoned
// ---------------------------------------------------------------------------

export interface FakeVphonedCall {
  method: string;
  params: Record<string, unknown>;
  via: "http" | "ws";
}

export interface FakeVphonedOptions {
  token: string;
  /** Method → result (or a function of params); unknown methods answer `unknown_method`. */
  rpc?: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>;
  /** Answer health with 503 this many times first (a guest still booting). */
  unhealthyFirst?: number;
  /** Override the screen answers: request → header and payload. */
  screen?: (request: Record<string, unknown>, index: number) => { header: Record<string, unknown>; payload?: Buffer };
}

export interface FakeVphoned {
  port: number;
  calls: FakeVphonedCall[];
  screenRequests: Record<string, unknown>[];
  uploads: Map<string, Buffer>;
  /** Requests refused for an Origin header (should stay empty). */
  originRefusals: string[];
  /** Requests refused for a missing or wrong token. */
  tokenRefusals: string[];
  /** Every request head's headers, for assertions. */
  heads: IncomingMessage["headers"][];
  /** Resolves with the first call to `method` from now on (or already made, after `since`). */
  waitForCall(method: string, since?: number): Promise<FakeVphonedCall>;
  close(): Promise<void>;
}

/** The default screen answers: a key frame with its avcC first, then deltas, an `unchanged` every fourth. */
export function defaultScreen(request: Record<string, unknown>, index: number): { header: Record<string, unknown>; payload?: Buffer } {
  const base = { id: request.id, session: 1, width: 738, height: 1600, sourceWidth: 1290, sourceHeight: 2796, scale: 3, captureUs: 900, encodeUs: 2100 };
  if (request.key === true || index === 0) return { header: { ...base, status: "frame", key: true, record: FIXTURE_AVCC.toString("base64") }, payload: FIXTURE_KEY_AU };
  if (index % 4 === 3) return { header: { ...base, status: "unchanged" } };
  return { header: { ...base, status: "frame", key: false }, payload: FIXTURE_DELTA_AU };
}

export async function startFakeVphoned(options: FakeVphonedOptions): Promise<FakeVphoned> {
  const calls: FakeVphonedCall[] = [];
  const screenRequests: Record<string, unknown>[] = [];
  const uploads = new Map<string, Buffer>();
  const originRefusals: string[] = [];
  const tokenRefusals: string[] = [];
  const heads: IncomingMessage["headers"][] = [];
  let unhealthy = options.unhealthyFirst ?? 0;
  const callEvents = new EventEmitter();
  const record = (call: FakeVphonedCall) => {
    calls.push(call);
    callEvents.emit("call", call);
  };

  const admit = (request: IncomingMessage): number => {
    heads.push(request.headers);
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      tokenRefusals.push(request.url ?? "");
      return 401;
    }
    if (request.headers.origin !== undefined) {
      originRefusals.push(request.url ?? "");
      return 403;
    }
    return 0;
  };

  const answer = (method: string, params: Record<string, unknown>): { result?: unknown; error?: { code: string; message: string } } => {
    if (Object.prototype.hasOwnProperty.call(params, "force")) return { error: { code: "invalid_request", message: "force methods are refused by this fake" } };
    const handler = options.rpc?.[method];
    if (handler === undefined) return { error: { code: "unknown_method", message: `Unknown method: ${method}` } };
    return { result: typeof handler === "function" ? (handler as (p: Record<string, unknown>) => unknown)(params) : handler };
  };

  const server: Server = createServer((request, response) => {
    const refused = admit(request);
    if (refused) return void response.writeHead(refused).end();
    const url = new URL(request.url ?? "/", "http://vphoned");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        if (unhealthy > 0) {
          unhealthy -= 1;
          return void response.writeHead(503).end();
        }
        return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, instance: "fake", capabilities: ["screen_unlock"] }));
      }
      if (request.method === "POST" && url.pathname === "/v1/rpc") {
        if (request.headers["content-type"] !== "application/json") return void response.writeHead(415).end();
        const message = JSON.parse(body.toString("utf8")) as { id: string; method: string; params?: Record<string, unknown> };
        const params = message.params ?? {};
        record({ method: message.method, params, via: "http" });
        return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "response", id: message.id, ...answer(message.method, params) }));
      }
      if (request.method === "PUT" && url.pathname === "/v1/files/content") {
        uploads.set(url.searchParams.get("path") ?? "", body);
        return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      }
      response.writeHead(404).end();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const refused = admit(request);
    if (refused) {
      socket.end(`HTTP/1.1 ${refused} Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    const path = new URL(request.url ?? "/", "http://vphoned").pathname;
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      if (path === "/v1/events") {
        ws.send(JSON.stringify({ type: "event", event: "connected", data: {} }));
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString()) as { id: string; method: string; params?: Record<string, unknown> };
          const params = message.params ?? {};
          record({ method: message.method, params, via: "ws" });
          ws.send(JSON.stringify({ type: "response", id: message.id, ...answer(message.method, params) }));
        });
      } else if (path === "/v1/host/screen") {
        let index = 0;
        ws.on("message", (data, isBinary) => {
          if (isBinary) return void ws.close(1003);
          const request = JSON.parse(data.toString()) as Record<string, unknown>;
          screenRequests.push(request);
          const reply = (options.screen ?? defaultScreen)(request, index++);
          ws.send(encodeScreenReply(reply.header, reply.payload ?? Buffer.alloc(0)), { binary: true });
        });
      } else ws.close(1008);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    screenRequests,
    uploads,
    originRefusals,
    tokenRefusals,
    heads,
    waitForCall(method, since = 0) {
      const made = calls.slice(since).find((call) => call.method === method);
      if (made) return Promise.resolve(made);
      return new Promise((resolve) => {
        const listener = (call: FakeVphonedCall) => {
          if (call.method !== method) return;
          callEvents.off("call", listener);
          resolve(call);
        };
        callEvents.on("call", listener);
      });
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

// ---------------------------------------------------------------------------
// Fake Mac (box link)
// ---------------------------------------------------------------------------

export class FakeProcess extends EventEmitter implements BoxProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(readonly procId: string | null) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.finish(null, signal);
    return true;
  }

  resize(): void {}

  /** Write output, then exit. */
  answer(result: { stdout?: string; stderr?: string; exitCode?: number }): void {
    setImmediate(() => {
      if (result.stdout) this.stdout.write(result.stdout);
      if (result.stderr) this.stderr.write(result.stderr);
      this.finish(result.exitCode ?? 0, null);
    });
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code ?? null;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("exit", code, signal));
  }
}

export interface FakeMacOptions {
  sys?: Partial<BoxSysInfo>;
  /** Answers for probe and vphone-cli commands: return undefined to fall back to the defaults. */
  answer?: (command: string, args: string[]) => { stdout?: string; stderr?: string; exitCode?: number } | undefined;
  /** vphoned options for machines `vm launch` starts (the token comes from the launch's env). */
  vphoned?: Omit<FakeVphonedOptions, "token">;
}

export const VPHONE_CLI_PATH = "/opt/homebrew/bin/vphone-cli";

/** What a ready Mac answers (captured shapes). */
export function defaultMacAnswer(command: string, args: string[]): { stdout?: string; stderr?: string; exitCode?: number } {
  const joined = [command, ...args].join(" ");
  if (command === "/usr/bin/printenv") return { exitCode: 1 };
  if (joined === "/usr/bin/which vphone-cli") return { stdout: `${VPHONE_CLI_PATH}\n` };
  if (joined === "/usr/bin/which vphone-launchpad-cli") return { exitCode: 1 };
  if (command === "/bin/test") return { exitCode: args[1] === VPHONE_CLI_PATH ? 0 : 1 };
  if (command === "/usr/bin/sw_vers") return { stdout: "26.1\n" };
  if (command === "/usr/sbin/sysctl") return { stdout: "0\n" };
  if (command === "/usr/bin/csrutil") return { stdout: "Allow Research Guests status: enabled.\n" };
  if (command === "/usr/sbin/nvram") return { stdout: "boot-args\tamfi_get_out_of_my_way=1 -v\n" };
  if (command === "/bin/ps") return { stdout: "/sbin/launchd\n/usr/libexec/amfid\n" };
  if (command === VPHONE_CLI_PATH) {
    const sub = args.join(" ");
    if (sub === "host preflight") return { stdout: "host preflight: ok\n" };
    if (sub === "vm template list --json") {
      return { stdout: JSON.stringify({ templates: [{ id: "3f2a91c0d4e7", key: { summary: "iPhone17,3 iOS 26.1 standard" }, stale: false, machines: [] }], building: [], damaged: [] }) };
    }
    if (sub === "vm list --json") return { stdout: JSON.stringify([{ name: "orq-base", cpuCount: 8, memoryMB: 8192, restoreInfo: { ios: { version: "26.1", build: "23B85" } } }]) };
    if (args[0] === "vm" && args[1] === "info") {
      return { stdout: JSON.stringify({ name: args[2], cpuCount: 8, memoryMB: 8192, restoreInfo: { ios: { version: "26.1", build: "23B85" }, cloudOS: { version: "26.1", build: "x" } }, template: "3f2a91c0d4e7" }) };
    }
    if (args[0] === "vm" && (args[1] === "create" || args[1] === "clone" || args[1] === "stop" || args[1] === "delete")) return { stdout: `${args[1]} ${args[2]}: done\n` };
  }
  return { exitCode: 127, stderr: `${command}: not found\n` };
}

/** A connected Mac whose `exec` answers like vphone-cli and macOS would. */
export class FakeMacLink implements VphoneBoxLink {
  readonly boxId = "mac1";
  readonly sys: BoxSysInfo;
  connected = true;
  readonly execs: { command: string; args: string[]; env: Record<string, string> | undefined; detach: string | null }[] = [];
  readonly requests: { method: string; params: unknown }[] = [];
  readonly forwards: { boxPort: number; closed: boolean }[] = [];
  readonly vphoneds: FakeVphoned[] = [];
  readonly launches: FakeProcess[] = [];
  private readonly status = new EventEmitter();

  constructor(private readonly options: FakeMacOptions = {}) {
    this.sys = localSysInfo({ os: "darwin", memBytes: 32 * 1024 ** 3, isRoot: false, canElevate: false, ...options.sys });
  }

  exec(options: BoxExecOptions): BoxProcess {
    const args = options.args ?? [];
    this.execs.push({ command: options.command, args: [...args], env: options.env ? { ...options.env } : undefined, detach: options.detach?.procId ?? null });
    const process = new FakeProcess(options.detach?.procId ?? null);
    if (args[0] === "vm" && args[1] === "launch") {
      this.launches.push(process);
      const token = options.env?.VPHONE_API_TOKEN ?? "";
      void startFakeVphoned({ ...this.options.vphoned, token }).then((vphoned) => {
        this.vphoneds.push(vphoned);
        process.stdout.write(`[vm] starting ${args[2]}\n[api] HTTP/WebSocket API: http://127.0.0.1:${vphoned.port}\n[api] token: ${token}\n[api] send it as: Authorization: Bearer ${token}\n`);
      });
      return process;
    }
    process.answer(this.options.answer?.(options.command, args) ?? defaultMacAnswer(options.command, args));
    return process;
  }

  async forwardToHost(boxPort: number): Promise<BoxHostForward> {
    const entry = { boxPort, closed: false };
    this.forwards.push(entry);
    return {
      hostPort: boxPort,
      boxPort,
      close: async () => {
        entry.closed = true;
      }
    };
  }

  request = (async (method: string, params: unknown) => {
    this.requests.push({ method, params });
    return undefined;
  }) as unknown as VphoneBoxLink["request"];

  detachedProcs(): [] {
    return [];
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.status.on("status", listener);
    return () => void this.status.off("status", listener);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.status.emit("status", connected);
  }

  async close(): Promise<void> {
    for (const process of this.launches) process.finish(0, null);
    await Promise.all(this.vphoneds.map((vphoned) => vphoned.close()));
  }
}
