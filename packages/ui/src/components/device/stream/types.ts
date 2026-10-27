/**
 * Shared shapes of the browser-side device stream: the session state machine,
 * stats for the debug tooltip, errors, and the injectable browser APIs that
 * let Node tests drive a session without a DOM.
 */

export type DevicePlatform = "ios" | "android";

/** `connecting` until the first painted frame; `stalled` keeps the last frame after silence. */
export type DeviceStreamState = "connecting" | "live" | "stalled" | "error" | "closed";

/**
 * - `serve-sim-h264`: iOS `stream.avcc` envelopes into WebCodecs.
 * - `serve-sim-mjpeg`: iOS `stream.mjpeg` multipart JPEGs (Blacksmith VMs have no working H.264 encoder).
 * - `serve-emu`: Android SEMU-framed Annex-B H.264 over the WebSocket that also carries input.
 * - `screenshots`: Android without WebCodecs; a periodic screenshot poll.
 */
export type DeviceTransport = "serve-sim-h264" | "serve-sim-mjpeg" | "serve-emu" | "screenshots";

export type TouchPhase = "begin" | "move" | "end";

/** Hardware buttons in one vocabulary; each input channel maps them to its own names. */
export type DeviceButton = "home" | "back" | "recents" | "power";

export type DeviceOrientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";

/** The device's screen as its host reports it (serve-sim `0x82`, or the decoded Android frame). */
export interface DeviceScreenConfig {
  readonly width: number;
  readonly height: number;
  readonly orientation: DeviceOrientation;
  /** serve-sim: another client holds the simulator's input. */
  readonly inputUnavailable?: boolean;
}

export type DeviceStreamErrorCode =
  /** 401/403 or a policy close: the URL's token is no longer accepted. */
  | "unauthorized"
  /** The browser cannot decode this stream's codec. */
  | "unsupported"
  /** The H.264 feed never produced a decodable frame (e.g. no encoder on the host). */
  | "no-video"
  | "http"
  | "network"
  | "decode"
  | "protocol";

export class DeviceStreamError extends Error {
  readonly code: DeviceStreamErrorCode;
  /** Fatal errors end the session; others are retried with backoff. */
  readonly fatal: boolean;

  constructor(code: DeviceStreamErrorCode, message: string, fatal = false) {
    super(message);
    this.name = "DeviceStreamError";
    this.code = code;
    this.fatal = fatal;
  }
}

export interface DeviceStreamStats {
  readonly transport: DeviceTransport;
  /** Painted frames per second over the last two seconds. */
  readonly fps: number;
  /** Received kilobits per second over the last two seconds (all payload bytes). */
  readonly kbps: number;
  /** WebCodecs codec string (`avc1.42c020`), `mjpeg` or `png`; null before the first configuration. */
  readonly decoder: string | null;
  readonly framesPainted: number;
  readonly bytesReceived: number;
  /** Connection attempts after the first. */
  readonly reconnects: number;
  readonly width: number;
  readonly height: number;
}

export interface DeviceStreamCallbacks {
  /** A frame was painted into the canvas. Called synchronously after the paint. */
  readonly onFrame?: () => void;
  readonly onState?: (state: DeviceStreamState, error: DeviceStreamError | null) => void;
  /** Painted frame size changed. */
  readonly onVideoSize?: (width: number, height: number) => void;
  /** Recoverable oddities: unknown server messages, rejected input, decoder resets. */
  readonly onWarning?: (message: string) => void;
}

export interface DeviceVideoSession {
  readonly transport: DeviceTransport;
  readonly state: DeviceStreamState;
  readonly error: DeviceStreamError | null;
  stats(): DeviceStreamStats;
  /** Abort every request, socket, timer and decoder. Idempotent. */
  close(): void;
}

/** Browser APIs a session uses, injectable for tests. Defaults come from `globalThis`. */
export interface StreamDeps {
  readonly fetch: typeof fetch;
  readonly WebSocket: typeof WebSocket;
  readonly createImageBitmap: (blob: Blob) => Promise<ImageBitmap>;
  readonly VideoDecoder: typeof VideoDecoder | undefined;
  readonly EncodedVideoChunk: typeof EncodedVideoChunk | undefined;
  readonly random: () => number;
  readonly now: () => number;
}

export function resolveDeps(overrides: Partial<StreamDeps> = {}): StreamDeps {
  const g = globalThis as Partial<typeof globalThis>;
  return {
    fetch: overrides.fetch ?? ((input, init) => g.fetch!(input, init)),
    WebSocket: overrides.WebSocket ?? (g.WebSocket as typeof WebSocket),
    createImageBitmap: overrides.createImageBitmap ?? ((blob) => g.createImageBitmap!(blob)),
    VideoDecoder: "VideoDecoder" in overrides ? overrides.VideoDecoder : g.VideoDecoder,
    EncodedVideoChunk: "EncodedVideoChunk" in overrides ? overrides.EncodedVideoChunk : g.EncodedVideoChunk,
    random: overrides.random ?? Math.random,
    now: overrides.now ?? (() => performance.now())
  };
}

/** Options every video session takes. */
export interface VideoSessionOptions extends DeviceStreamCallbacks {
  /** Full URL; the caller's API client has already added the auth token. */
  readonly url: string;
  readonly canvas: HTMLCanvasElement;
  /** Silence after the last frame before the state turns `stalled` (default 2 s). */
  readonly stallMs?: number;
  /** Silence before the session reconnects on its own (default 15 s). */
  readonly reconnectAfterMs?: number;
  readonly deps?: Partial<StreamDeps>;
}
