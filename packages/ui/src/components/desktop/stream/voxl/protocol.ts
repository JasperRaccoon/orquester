// The voxl wire protocol as the browser speaks it (spec 2026-11-10 R4.5), through the daemon's 1:1
// relay at `desktopRoutes.voxlSocket(id)`. One WebSocket carries everything: binary messages start
// with a type byte, text messages are JSON from the server and short comma-separated commands from
// the client.
//
// Portions derived from voxl (https://github.com/tembo/voxl), MIT License, Copyright (c) 2026 Tembo
// (web/src/protocol.ts, web/src/client/cursor.ts).

/** Type byte of binary messages. */
export const VoxlBin = {
  /** Server: H.264 stripe update (16-byte header, then Annex-B). */
  Video: 0x01,
  /** Server: Opus desktop audio (Orquester keeps audio off in voxl). */
  Audio: 0x02,
  /** Server: cursor image (straight RGBA). */
  Cursor: 0x03,
  /** Server: clipboard image (PNG). */
  ClipImage: 0x04,
  /** Client: clipboard image (PNG). */
  ClipImageUp: 0x11
} as const;

/** A horizontal band of the screen encoded as its own H.264 stream: [y, height]. */
export type VoxlStripe = [y: number, h: number];

export interface VoxlHello {
  t: "hello";
  w: number;
  h: number;
  /** Always at least one stripe (`[[0, h]]` when the server sent none). */
  stripes: VoxlStripe[];
  os?: string;
  audio: boolean;
  mic: boolean;
  /** The viewer only watches: input commands would be dropped by the server. */
  readOnly: boolean;
  /** Present when the server resizes the desktop on `sz` (`--enable-resize`). */
  resize?: { scale: number };
}

/** JSON text messages from the server, validated. */
export type VoxlServerMessage =
  | VoxlHello
  | { t: "ping"; s: number }
  | { t: "clip"; d: string }
  | { t: "close" };

/** Text commands to the server. */
export const voxlCmd = {
  ack: (frame: number) => `a,${frame}`,
  move: (x: number, y: number) => `m,${x},${y}`,
  /** X buttons: 1 left, 2 middle, 3 right (8/9 back/forward). */
  button: (button: number, down: boolean) => `b,${button},${down ? 1 : 0}`,
  /** Scroll in display pixels; the server turns it into smooth scrolling or wheel clicks. */
  scroll: (dx: number, dy: number) => `sp,${dx.toFixed(1)},${dy.toFixed(1)}`,
  key: (keysym: number, down: boolean) => `k,${keysym},${down ? 1 : 0}`,
  releaseAll: "r",
  clipboard: (text: string) => `c,${text}`,
  video: (on: boolean) => `v,${on ? 1 : 0}`,
  audio: (on: boolean) => `au,${on ? 1 : 0}`,
  /** Ask for a desktop of this size (dynamic resolution). */
  resize: (w: number, h: number) => `sz,${w},${h}`,
  keyframe: "kf",
  pong: (sent: number) => `po,${sent}`
} as const;

/**
 * Commands a read-only viewer may send (voxl's READ_ONLY_COMMANDS): acks, video and audio on/off,
 * keyframe requests and ping replies. The server drops anything else from such a viewer.
 */
const READ_ONLY_COMMANDS = new Set(["a", "v", "au", "kf", "po"]);

export function voxlCommandAllowed(command: string, readOnly: boolean): boolean {
  if (!readOnly) return true;
  const comma = command.indexOf(",");
  return READ_ONLY_COMMANDS.has(comma < 0 ? command : command.slice(0, comma));
}

export const VOXL_VIDEO_HEADER_BYTES = 16;

/** The header of a video message (byte 0 is the type byte). */
export interface VoxlVideoHeader {
  key: boolean;
  /** The server repainted a static area at higher quality. */
  paintover: boolean;
  frame: number;
  /** Server-side pipeline time (capture to send), in 0.1 ms. */
  pipe: number;
  stripe: number;
  stripeCount: number;
  /** Stripe updates that make up this frame. */
  parts: number;
  /** The stripe's top row in display pixels. */
  y: number;
}

/** Parse a video message's header, or null when it is too short to hold one. */
export function parseVoxlVideoHeader(b: Uint8Array): VoxlVideoHeader | null {
  if (b.length < VOXL_VIDEO_HEADER_BYTES || b[0] !== VoxlBin.Video) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    key: (b[1]! & 1) === 1,
    paintover: (b[1]! & 2) === 2,
    frame: view.getUint32(2),
    pipe: view.getUint32(6),
    stripe: b[10]!,
    stripeCount: b[11]!,
    parts: b[12]!,
    y: view.getUint16(14)
  };
}

export const VOXL_CURSOR_HEADER_BYTES = 14;

export interface VoxlCursor {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  serial: number;
  /** Straight (non-premultiplied) RGBA, `width * height * 4` bytes; empty for a hidden cursor. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Parse a cursor message: type byte, pad, width, height, hot x, hot y (u16 BE each), serial (u32
 * BE), then RGBA. A zero-sized cursor means "no cursor". Null when malformed.
 */
export function parseVoxlCursor(buf: ArrayBuffer): VoxlCursor | null {
  if (buf.byteLength < VOXL_CURSOR_HEADER_BYTES) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== VoxlBin.Cursor) return null;
  const width = view.getUint16(2);
  const height = view.getUint16(4);
  const bytes = width * height * 4;
  if (buf.byteLength < VOXL_CURSOR_HEADER_BYTES + bytes) return null;
  return {
    width,
    height,
    hotX: Math.min(view.getUint16(6), Math.max(0, width - 1)),
    hotY: Math.min(view.getUint16(8), Math.max(0, height - 1)),
    serial: view.getUint32(10),
    rgba: new Uint8ClampedArray(buf, VOXL_CURSOR_HEADER_BYTES, bytes)
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isDim = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535;

function parseStripes(value: unknown, height: number): VoxlStripe[] {
  if (Array.isArray(value)) {
    const out: VoxlStripe[] = [];
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length < 2) return [[0, height]];
      const [y, h] = entry as unknown[];
      if (typeof y !== "number" || !Number.isInteger(y) || y < 0 || !isDim(h)) return [[0, height]];
      out.push([y, h]);
    }
    if (out.length > 0) return out;
  }
  return [[0, height]];
}

/** Parse and validate a server text message; null for anything unknown or malformed. */
export function parseVoxlServerText(text: string): VoxlServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.t) {
    case "hello": {
      if (!isDim(value.w) || !isDim(value.h)) return null;
      const hello: VoxlHello = {
        t: "hello",
        w: value.w,
        h: value.h,
        stripes: parseStripes(value.stripes, value.h),
        audio: value.audio === true,
        mic: value.mic === true,
        readOnly: value.readOnly === true
      };
      if (typeof value.os === "string") hello.os = value.os;
      if (isRecord(value.resize)) {
        const scale = value.resize.scale;
        hello.resize = { scale: typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1 };
      }
      return hello;
    }
    case "ping":
      return typeof value.s === "number" && Number.isFinite(value.s) ? { t: "ping", s: value.s } : null;
    case "clip":
      return typeof value.d === "string" ? { t: "clip", d: value.d } : null;
    case "close":
      return { t: "close" };
    default:
      return null;
  }
}

/** `avc1.PPCCLL` from the first SPS NAL unit in an Annex-B keyframe, or null without one. */
export function voxlCodecFromSps(d: Uint8Array): string | null {
  const hex2 = (x: number) => x.toString(16).padStart(2, "0");
  for (let i = 0; i + 6 < d.length; i++) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3]! & 0x1f) === 7) {
      return `avc1.${hex2(d[i + 4]!)}${hex2(d[i + 5]!)}${hex2(d[i + 6]!)}`;
    }
  }
  return null;
}

/** voxl's x264 encodes High profile: the codec assumed for a keyframe without an SPS. */
export const VOXL_FALLBACK_CODEC = "avc1.640034";
