// One voxl connection: the WebSocket, the stream session and WebCodecs decoders, painting each
// whole frame straight onto a canvas the moment its stripes are decoded. It runs in the decode
// worker on an OffscreenCanvas, or on the page with the visible canvas where workers cannot.
//
// Portions derived from voxl (https://github.com/tembo/voxl), MIT License, Copyright (c) 2026 Tembo
// (web/src/worker.ts).

import type { VoxlHello } from "./protocol";
import { VoxlStreamSession, type VoxlDecoder } from "./session";

/** What a connection reports to the client. */
export type VoxlConnectionEvent =
  | { t: "open" }
  | { t: "closed"; reason?: string }
  | { t: "hello"; hello: VoxlHello }
  | { t: "clip"; d: string }
  | { t: "cursor"; buf: ArrayBuffer }
  | { t: "stats"; fps: number; kbps: number }
  | { t: "log"; s: string };

export interface VoxlConnectionHandle {
  send(text: string): void;
  setVideo(on: boolean): void;
  close(): void;
}

/** voxl pings every 500 ms: this long without any message after its `hello` means the link is dead. */
const STALE_AFTER_MS = 10_000;
/**
 * Before voxl's `hello` the relay may legitimately be silent: the daemon checks for and starts voxl
 * for the first viewer (up to 30 s) and dials it (up to 10 s), then answers or closes.
 */
const HELLO_WITHIN_MS = 45_000;
const STATS_INTERVAL_MS = 1000;

type Painter = { drawImage(image: VideoFrame, dx: number, dy: number): void };
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function context2d(canvas: AnyCanvas): Painter | null {
  const get = canvas.getContext.bind(canvas) as (id: "2d", options?: object) => unknown;
  try {
    return (get("2d", { alpha: false, desynchronized: true }) as Painter | null) ?? null;
  } catch {
    try {
      return (get("2d") as Painter | null) ?? null;
    } catch {
      return null;
    }
  }
}

function webCodecsDecoder(codec: string, output: (frame: VideoFrame) => void, error: (message: string) => void): VoxlDecoder {
  const decoder = new VideoDecoder({ output, error: (e) => error(e.message) });
  decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
  return {
    get state() {
      return decoder.state;
    },
    decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
    close: () => decoder.close()
  };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function openVoxlConnection(url: string, canvas: AnyCanvas, emit: (event: VoxlConnectionEvent) => void): VoxlConnectionHandle {
  // Firefox rejects a second getContext with other attributes: take it once.
  let painter: Painter | null = null;
  let closed = false;
  let lastMessageAt = now();
  let lastStatsAt = now();
  let helloSeen = false;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  const send = (text: string) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(text);
  };

  const session = new VoxlStreamSession<VideoFrame>({
    send,
    createDecoder: webCodecsDecoder,
    present: (parts) => {
      for (const part of parts) {
        try {
          painter?.drawImage(part.frame, 0, part.y);
        } finally {
          part.frame.close();
        }
      }
    },
    emit: (event) => {
      if (event.t === "hello") {
        helloSeen = true;
        if (canvas.width !== event.hello.w || canvas.height !== event.hello.h) {
          canvas.width = event.hello.w;
          canvas.height = event.hello.h;
        }
        painter ??= context2d(canvas);
      }
      if (event.t === "close") {
        finish("The desktop closed the stream");
        return;
      }
      emit(event);
    }
  });

  const timer = setInterval(() => {
    const t = now();
    if (socket.readyState === WebSocket.OPEN && t - lastMessageAt > (helloSeen ? STALE_AFTER_MS : HELLO_WITHIN_MS)) {
      finish("The stream went silent");
      return;
    }
    const stats = session.takeStats(t - lastStatsAt);
    lastStatsAt = t;
    if (socket.readyState === WebSocket.OPEN) emit({ t: "stats", fps: stats.fps, kbps: stats.kbps });
  }, STATS_INTERVAL_MS);

  function finish(reason?: string): void {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    session.close();
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    emit(reason ? { t: "closed", reason } : { t: "closed" });
  }

  socket.addEventListener("open", () => {
    if (closed) return;
    lastMessageAt = now();
    session.open();
    emit({ t: "open" });
  });
  socket.addEventListener("message", (e: MessageEvent<string | ArrayBuffer>) => {
    if (closed) return;
    lastMessageAt = now();
    if (typeof e.data === "string") session.handleText(e.data);
    else session.handleBinary(e.data);
  });
  socket.addEventListener("close", (e: CloseEvent) => {
    finish(e.reason || (e.code === 1000 || e.code === 1005 ? undefined : `The stream closed (${e.code})`));
  });

  return {
    send,
    setVideo: (on) => session.setVideo(on),
    close: () => finish()
  };
}
