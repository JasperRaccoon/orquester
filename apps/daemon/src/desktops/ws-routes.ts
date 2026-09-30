// Desktop WebSockets (spec §7.2), following the `/ws-devtools` proxy pattern:
// a child context under the root @fastify/websocket, `?token=` checked after the
// upgrade (close 1008), a bounded pre-open queue and high-water-mark backpressure.
//
// - `/ws-desktop/:id`: opaque RFB relay to the desktop's `vnc.sock`. Binary frames
//   are RFB bytes both ways; client text frames are a control side channel
//   (`{type:"ping",t}` → `{type:"pong",t}`), never forwarded to the VNC socket.
// - `/ws-desktop-audio/:id`: the desktop's Opus stream from the audio hub.
import { createConnection, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { DesktopAudioStateMessage } from "@orquester/api";
import { desktopAudioState, type DesktopAudioHub, type DesktopAudioSink } from "./audio.ts";

export interface DesktopWsDeps {
  /** True when `token` (the `?token=` query value) is a valid credential. */
  authorize(token: string | undefined): boolean;
  /** Path of a RUNNING desktop's RFB unix socket; null when unknown or not running. */
  vncSocketPath(desktopId: string): string | null;
  /**
   * Audio source of a desktop: its pulse socket when it is running with audio,
   * `{ unavailable: reason }` when running without audio, null when unknown or
   * not running.
   */
  audioSource(desktopId: string): { pulseSocketPath: string } | { unavailable: string } | null;
  audio: DesktopAudioHub;
}

// RFB is stateful → never drop bytes; PAUSE/RESUME on a high-water mark instead.
// The pre-open client queue is bounded by bytes AND count (fail-closed).
const SEND_HWM = 8 * 1024 * 1024;
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
const PENDING_MAX_MSGS = 512;
const NOT_RUNNING = "desktop not running";

type RawData = Buffer | ArrayBuffer | Buffer[];

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function parseControl(data: RawData): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(toBuffer(data).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tokenOf(query: unknown): string | undefined {
  const token = (query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : undefined;
}

/** Register both desktop WebSocket routes on a child context (root @fastify/websocket already registered). */
export async function registerDesktopWsRoutes(app: FastifyInstance, deps: DesktopWsDeps): Promise<void> {
  void app.register(async (instance) => {
    instance.get<{ Params: { id: string } }>("/ws-desktop/:id", { websocket: true }, (socket, request) => {
      if (!deps.authorize(tokenOf(request.query))) {
        socket.close(1008, "unauthorized");
        return;
      }

      let upstream: Socket | null = null;
      let upstreamOpen = false;
      let closed = false;
      let clientPaused = false;
      let upstreamPaused = false;
      const pending: Buffer[] = [];
      let pendingBytes = 0;

      const closeBoth = (code: number, reason: string) => {
        if (closed) return;
        closed = true;
        try { socket.close(code, reason); } catch { /* closing */ }
        upstream?.destroy();
      };

      // Client → VNC: pause the client above the HWM until the unix socket drains.
      const writeUpstream = (data: Buffer) => {
        upstream!.write(data);
        if (!clientPaused && upstream!.writableLength > SEND_HWM) {
          clientPaused = true;
          socket.pause();
          upstream!.once("drain", () => {
            clientPaused = false;
            if (!closed) socket.resume();
          });
        }
      };

      // Attach the client listener SYNCHRONOUSLY (fastify-websocket drops messages
      // that arrive before a listener exists): buffer into the bounded queue until
      // the unix socket connects.
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (closed) return;
        if (!isBinary) {
          // Control side channel. The pong is queued behind any RFB bytes already
          // sent, so its round trip includes the video backlog (spec §11.2).
          const message = parseControl(data);
          if (message?.type === "ping" && typeof message.t === "number" && Number.isFinite(message.t)) {
            try { socket.send(JSON.stringify({ type: "pong", t: message.t })); } catch { /* closing */ }
          }
          return;
        }
        const bytes = toBuffer(data);
        if (upstreamOpen) {
          writeUpstream(bytes);
          return;
        }
        pendingBytes += bytes.length;
        pending.push(bytes);
        if (pending.length > PENDING_MAX_MSGS || pendingBytes > PENDING_MAX_BYTES) {
          closeBoth(1011, "desktop buffer overflow");
        }
      });
      socket.on("close", () => closeBoth(1000, "client closed"));
      socket.on("error", () => closeBoth(1011, "client error"));

      const path = deps.vncSocketPath(request.params.id);
      if (path === null) {
        closeBoth(1011, NOT_RUNNING);
        return;
      }
      if (closed) return;
      const conn = createConnection(path);
      upstream = conn;
      conn.on("connect", () => {
        if (closed) return;
        upstreamOpen = true;
        for (const bytes of pending) writeUpstream(bytes);
        pending.length = 0;
        pendingBytes = 0;
      });
      // VNC → client: pause the unix socket above the HWM; resume from the send
      // callbacks once the WebSocket has flushed below it.
      const onFlushed = () => {
        if (upstreamPaused && !closed && socket.bufferedAmount <= SEND_HWM) {
          upstreamPaused = false;
          conn.resume();
        }
      };
      conn.on("data", (chunk: Buffer) => {
        if (closed) return;
        try { socket.send(chunk, { binary: true }, onFlushed); } catch { /* closing */ }
        if (!upstreamPaused && socket.bufferedAmount > SEND_HWM) {
          upstreamPaused = true;
          conn.pause();
        }
      });
      conn.on("close", () => closeBoth(upstreamOpen ? 1000 : 1011, upstreamOpen ? "desktop closed" : NOT_RUNNING));
      conn.on("error", () => closeBoth(1011, upstreamOpen ? "desktop connection error" : NOT_RUNNING));
    });

    instance.get<{ Params: { id: string } }>("/ws-desktop-audio/:id", { websocket: true }, (socket, request) => {
      if (!deps.authorize(tokenOf(request.query))) {
        socket.close(1008, "unauthorized");
        return;
      }

      let unsubscribe: (() => void) | null = null;
      let closed = false;
      const sendText = (message: DesktopAudioStateMessage | { type: "pong" }) => {
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify(message)); } catch { /* closing */ }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
      };

      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        if (parseControl(data)?.type === "ping") sendText({ type: "pong" });
      });
      socket.on("close", finish);
      socket.on("error", () => {
        finish();
        try { socket.close(1011, "client error"); } catch { /* closing */ }
      });

      const source = deps.audioSource(request.params.id);
      if (source === null) {
        closed = true;
        socket.close(1011, NOT_RUNNING);
        return;
      }
      if ("unavailable" in source) {
        // Stay open: the client keeps pinging, and the tab shows the reason.
        sendText(desktopAudioState("unavailable", source.unavailable));
        return;
      }
      const sink: DesktopAudioSink = {
        send: (packet) => {
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          socket.send(packet, { binary: true });
        },
        bufferedAmount: () => socket.bufferedAmount,
        sendState: (state) => sendText(state),
        close: () => {
          finish();
          try { socket.close(1011, NOT_RUNNING); } catch { /* closing */ }
        }
      };
      const off = deps.audio.subscribe(request.params.id, source.pulseSocketPath, sink);
      if (closed) off();
      else unsubscribe = off;
    });
  });
}
