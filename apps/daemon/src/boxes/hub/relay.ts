/**
 * The per-box local relay server (protocol: `../client/relay-codec.ts`). Each
 * client's requests go through the box's `LinkedBoxConnection` (so they wait
 * for a reconnect like any daemon request); its channels are passed through
 * to the box raw, with ids remapped, so flow control stays end to end. When
 * a client goes away its channels are closed and its watches and forwards
 * are removed from the box.
 */

import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { parseControlMessage, type BoxControlMessage, type BoxStream } from "@orquester/api";

import type { LinkedBoxConnection } from "../client/connection.ts";
import { BOX_DISCONNECTED } from "../client/mux.ts";
import {
  RELAY_FRAME_BINARY,
  RELAY_PROTOCOL_VERSION,
  RelayFrameDecoder,
  encodeRelayFrame,
  encodeRelayText,
  parseRelayJson,
  type RelayBoxState
} from "../client/relay-codec.ts";
import type { BoxHubLogger } from "./hub.ts";

/** Relayed requests wait at most this long for the box (the client times out on its own). */
const RELAY_REQUEST_TIMEOUT_MS = 10 * 60_000;

function decodeData(frame: Uint8Array): { channel: number; stream: BoxStream; payload: Uint8Array } | null {
  if (frame.byteLength < 5) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const stream = view.getUint8(4);
  if (stream > 2) return null;
  return { channel: view.getUint32(0, false), stream: stream as BoxStream, payload: frame.subarray(5) };
}

function encodeData(channel: number, stream: BoxStream, payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt32BE(channel, 0);
  frame.writeUInt8(stream, 4);
  frame.set(payload, 5);
  return frame;
}

class RelayClientSession {
  private readonly socket: Socket;
  private readonly relay: BoxRelayServer;
  private welcomed = false;
  /** client channel id → box channel id (and the reverse on the box mux). */
  private readonly channels = new Map<number, { boxId: number; mux: ReturnType<LinkedBoxConnection["currentMux"]> }>();
  private readonly requests = new Map<number, AbortController>();
  private readonly watches = new Set<string>();
  private readonly forwards = new Set<number>();
  private closed = false;

  constructor(relay: BoxRelayServer, socket: Socket) {
    this.relay = relay;
    this.socket = socket;
    const decoder = new RelayFrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.kind === "binary") this.onData(frame.data);
        else this.onText(frame.text);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => this.cleanup());
  }

  private sendText(value: unknown): void {
    if (!this.closed) this.socket.write(encodeRelayText(JSON.stringify(value)));
  }

  sendState(state: RelayBoxState): void {
    if (this.welcomed) this.sendText({ t: "relay-status", ...state });
  }

  sendEvent(name: string, data: unknown): void {
    if (this.welcomed) this.sendText({ t: "event", name, data });
  }

  private onText(text: string): void {
    if (!this.welcomed) {
      const hello = parseRelayJson(text);
      if (!hello || hello.t !== "relay-hello" || hello.protocol !== RELAY_PROTOCOL_VERSION || hello.boxId !== this.relay.boxId) {
        this.sendText({ t: "relay-reject", message: "This relay serves another box or protocol" });
        this.socket.end();
        return;
      }
      this.welcomed = true;
      this.sendText({ t: "relay-welcome", ...this.relay.state() });
      return;
    }
    const local = parseRelayJson(text);
    if (local?.t === "relay-cancel" && typeof local.id === "number") {
      this.requests.get(local.id)?.abort();
      return;
    }
    const message = parseControlMessage(text);
    if (!message) {
      this.socket.destroy();
      return;
    }
    this.onControl(message);
  }

  private onControl(message: BoxControlMessage): void {
    switch (message.t) {
      case "ping":
        this.sendText({ t: "pong", id: message.id });
        return;
      case "req":
        void this.relayRequest(message.id, message.method, message.params);
        return;
      case "open":
        this.relayOpen(message.ch, message);
        return;
      case "eof":
      case "resize":
      case "signal":
      case "credit":
      case "close":
      case "exit": {
        const entry = this.channels.get(message.ch);
        if (!entry) return;
        if (message.t === "close") this.channels.delete(message.ch);
        entry.mux?.sendRaw(entry.boxId, message);
        return;
      }
      default:
        return;
    }
  }

  private onData(frame: Uint8Array): void {
    const decoded = decodeData(frame);
    if (!decoded) return;
    const entry = this.channels.get(decoded.channel);
    entry?.mux?.sendRawData(entry.boxId, decoded.stream, decoded.payload);
  }

  private async relayRequest(id: number, method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    this.requests.set(id, controller);
    try {
      const result = await this.relay.connection.requestRaw(method, params, { timeoutMs: RELAY_REQUEST_TIMEOUT_MS, signal: controller.signal });
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "fs.watch") this.watches.add(String(p.watchId));
      if (method === "fs.unwatch") this.watches.delete(String(p.watchId));
      if (method === "forward.listen") this.forwards.add(Number(p.boxPort));
      if (method === "forward.unlisten") this.forwards.delete(Number(p.boxPort));
      this.sendText({ t: "res", id, ok: true, result: result ?? null });
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "INTERNAL";
      this.sendText({ t: "res", id, ok: false, error: { code, message: (error as Error).message } });
    } finally {
      this.requests.delete(id);
    }
  }

  private relayOpen(clientId: number, message: Extract<BoxControlMessage, { t: "open" }>): void {
    const mux = this.relay.connection.currentMux();
    if (clientId % 2 !== 0 || this.channels.has(clientId)) {
      this.sendText({ t: "open-failed", ch: clientId, error: { code: "BAD_CHANNEL", message: "Channel id not allowed" } });
      return;
    }
    if (!mux) {
      this.sendText({ t: "open-failed", ch: clientId, error: { code: BOX_DISCONNECTED, message: "The box is not connected" } });
      return;
    }
    const boxId = mux.openRaw(message.spec, {
      control: (frame) => {
        if (frame.t === "close" || frame.t === "open-failed") this.channels.delete(clientId);
        this.sendText({ ...frame, ch: clientId });
      },
      data: (stream, payload) => {
        if (!this.closed) this.socket.write(encodeRelayFrame(RELAY_FRAME_BINARY, encodeData(clientId, stream, payload)));
      },
      lost: () => {
        if (!this.channels.delete(clientId)) return;
        this.sendText({ t: "close", ch: clientId, error: { code: BOX_DISCONNECTED, message: "The box link dropped" } });
      }
    });
    this.channels.set(clientId, { boxId, mux });
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.forgetSession(this);
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    for (const entry of this.channels.values()) entry.mux?.sendRaw(entry.boxId, { t: "close", ch: entry.boxId });
    this.channels.clear();
    const connection = this.relay.connection;
    for (const watchId of this.watches) {
      connection.request("fs.unwatch", { watchId }).catch(() => undefined);
    }
    for (const boxPort of this.forwards) {
      connection.request("forward.unlisten", { boxPort }).catch(() => undefined);
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export class BoxRelayServer {
  readonly boxId: string;
  readonly connection: LinkedBoxConnection;
  private readonly socketPath: string;
  private readonly logger: BoxHubLogger | undefined;
  private server: Server | null = null;
  private readonly sessions = new Set<RelayClientSession>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(boxId: string, connection: LinkedBoxConnection, socketPath: string, logger?: BoxHubLogger) {
    this.boxId = boxId;
    this.connection = connection;
    this.socketPath = socketPath;
    this.logger = logger;
  }

  state(): RelayBoxState {
    return {
      boxId: this.boxId,
      connected: this.connection.connected,
      sys: this.connection.sys,
      paths: this.connection.paths,
      agentVersion: this.connection.agentVersion,
      procs: this.connection.detachedProcs()
    };
  }

  async start(): Promise<void> {
    const dir = dirname(this.socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    try {
      const info = await lstat(this.socketPath);
      if (!info.isSocket()) throw new Error(`${this.socketPath} exists and is not a socket`);
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer((socket) => {
      const session = new RelayClientSession(this, socket);
      this.sessions.add(session);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    server.on("error", (error) => this.logger?.warn("box relay socket error", { boxId: this.boxId, error: error.message }));
    this.server = server;
    this.unsubscribe.push(
      this.connection.onStatus(() => {
        const state = this.state();
        for (const session of this.sessions) session.sendState(state);
      }),
      this.connection.onAnyEvent((name, data) => {
        for (const session of this.sessions) session.sendEvent(name, data);
      })
    );
  }

  /** @internal */
  forgetSession(session: RelayClientSession): void {
    this.sessions.delete(session);
  }

  async close(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const session of [...this.sessions]) session.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
  }
}
