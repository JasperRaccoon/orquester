// One desktop's audio stream (spec §7.2, §8.2): the socket is open only while the tab is active,
// sound is unlocked and the desktop isn't muted — closing it is how the client pauses. Packets go
// to the decoder in order; decoded frames go to a per-stream worklet node behind the desktop's
// GainNode. Browser pieces are injected (`DesktopAudioControllerDeps`) so this module stays free
// of Web Audio, WebCodecs and Vite-only imports and can be tested with fakes.
import {
  DESKTOP_AUDIO_HEADER_BYTES,
  DESKTOP_AUDIO_PACKET_OPUS,
  type DesktopAudioClientMessage,
  type DesktopAudioServerJsonMessage,
  type DesktopAudioStateMessage
} from "@orquester/api";

import type { DesktopAudioStats } from "./jitter-buffer.ts";

export type DesktopAudioDecoderKind = "webcodecs" | "wasm" | "none";

export interface DesktopAudioInputs {
  url: string | null;
  active: boolean;
  unlocked: boolean;
  muted: boolean;
  /** 0..1 */
  volume: number;
}

export interface DesktopAudioSnapshot {
  decoder: DesktopAudioDecoderKind | "checking";
  serverState: DesktopAudioStateMessage | null;
  stats: DesktopAudioStats | null;
  error: string | null;
}

export interface DecoderSink {
  /** Planar Float32 frames, one array (own buffer) per channel. */
  frames(planes: Float32Array[]): void;
  error(message: string): void;
}

export interface DesktopAudioDecoder {
  decode(seq: number, packet: Uint8Array): void;
  close(): void;
}

/** The worklet node of one open stream. */
export interface DesktopAudioPlayer {
  push(planes: Float32Array[]): void;
  dispose(): void;
}

/** A desktop's output: its GainNode, and a factory for per-stream players behind it. */
export interface DesktopAudioOutput {
  setVolume(volume: number): void;
  openPlayer(options: { initialTargetMs?: number; onStats(stats: DesktopAudioStats): void }): Promise<DesktopAudioPlayer>;
  dispose(): void;
}

/** A handler property checked bivariantly, so a real `WebSocket` satisfies `AudioSocket`. */
type SocketHandler<E> = { bivarianceHack(event: E): void }["bivarianceHack"];

/** The subset of `WebSocket` the controller uses. */
export interface AudioSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  onmessage: SocketHandler<{ data: unknown }> | null;
  onclose: SocketHandler<{ code: number; reason: string }> | null;
  onerror: SocketHandler<unknown> | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DesktopAudioControllerDeps {
  detectDecoder(): Promise<DesktopAudioDecoderKind>;
  createSocket(url: string): AudioSocket;
  createDecoder(kind: "webcodecs" | "wasm", sink: DecoderSink): DesktopAudioDecoder;
  /** `null` while there is no unlocked AudioContext. */
  createOutput(volume: number): DesktopAudioOutput | null;
}

export interface AudioPacket {
  seq: number;
  /** View into the frame's buffer, after the header. */
  payload: Uint8Array;
}

export const AUDIO_KEEPALIVE_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Decoded frames held while the worklet node is being created (~300 ms). */
const MAX_PENDING_FRAMES = 30;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

/** The controller rule: stream only while the tab is active, sound is unlocked and not muted. */
export function shouldStreamAudio(inputs: Pick<DesktopAudioInputs, "url" | "active" | "unlocked" | "muted">): boolean {
  return Boolean(inputs.url) && inputs.active && inputs.unlocked && !inputs.muted;
}

/** `[u8 type=1][u8 flags][u16 reserved][u32 seq BE][opus packet]`, or `null` if not an Opus packet. */
export function parseAudioPacket(data: ArrayBuffer): AudioPacket | null {
  if (data.byteLength <= DESKTOP_AUDIO_HEADER_BYTES) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== DESKTOP_AUDIO_PACKET_OPUS) return null;
  return { seq: view.getUint32(4, false), payload: new Uint8Array(data, DESKTOP_AUDIO_HEADER_BYTES) };
}

export function parseAudioServerMessage(text: string): DesktopAudioServerJsonMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "pong") return { type: "pong" };
  if (message.type === "state" && (message.audio === "available" || message.audio === "unavailable")) {
    return {
      type: "state",
      audio: message.audio,
      ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
      sampleRate: 48000,
      channels: 2,
      frameMs: 10
    };
  }
  return null;
}

interface Connection {
  url: string;
  socket: AudioSocket;
  decoder: DesktopAudioDecoder | null;
  player: DesktopAudioPlayer | null;
  pending: Float32Array[][];
  keepalive: ReturnType<typeof setInterval>;
  /** Anything received since the last keepalive tick. */
  heard: boolean;
  closed: boolean;
}

export class DesktopAudioController {
  private inputs: DesktopAudioInputs = { url: null, active: false, unlocked: false, muted: false, volume: 1 };
  private snapshot: DesktopAudioSnapshot = { decoder: "checking", serverState: null, stats: null, error: null };
  private readonly listeners = new Set<() => void>();
  private connection: Connection | null = null;
  private output: DesktopAudioOutput | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** The target the last stream learned; the next stream starts from it. */
  private lastTargetMs: number | undefined;

  constructor(private readonly deps: DesktopAudioControllerDeps) {
    deps.detectDecoder().then(
      (decoder) => {
        this.patch({ decoder });
        this.reconcile();
      },
      () => this.patch({ decoder: "none" })
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DesktopAudioSnapshot => this.snapshot;

  /** Whether a socket is open or opening (for tests and diagnostics). */
  get streaming(): boolean {
    return this.connection !== null;
  }

  update(inputs: DesktopAudioInputs): void {
    this.inputs = { ...inputs };
    this.output?.setVolume(this.gain());
    this.reconcile();
  }

  /** Close everything. The controller stays usable: a later `update` reopens as needed. */
  dispose(): void {
    this.cancelReconnect();
    this.closeConnection();
    this.output?.dispose();
    this.output = null;
  }

  private gain(): number {
    if (this.inputs.muted) return 0;
    const volume = Number.isFinite(this.inputs.volume) ? this.inputs.volume : 1;
    return Math.min(1, Math.max(0, volume));
  }

  private reconcile(): void {
    const decoder = this.snapshot.decoder;
    const want = shouldStreamAudio(this.inputs) && (decoder === "webcodecs" || decoder === "wasm");
    if (!want) {
      this.cancelReconnect();
      this.attempt = 0;
      this.closeConnection();
      this.patch({ stats: null, error: null });
      return;
    }
    // A new URL (fresh token, other desktop) means a new socket.
    if (this.connection && this.connection.url !== this.inputs.url) this.closeConnection();
    if (!this.connection && !this.reconnectTimer) this.open(decoder);
  }

  private open(kind: "webcodecs" | "wasm"): void {
    const url = this.inputs.url!;
    this.output ??= this.deps.createOutput(this.gain());
    const output = this.output;
    if (!output) {
      this.patch({ error: "Sound isn't enabled." });
      return;
    }
    let socket: AudioSocket;
    try {
      socket = this.deps.createSocket(url);
    } catch (error) {
      this.patch({ error: `Couldn't open the audio stream: ${describe(error)}` });
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    const connection: Connection = {
      url,
      socket,
      decoder: null,
      player: null,
      pending: [],
      keepalive: setInterval(() => this.keepalive(connection), AUDIO_KEEPALIVE_MS),
      heard: false,
      closed: false
    };
    this.connection = connection;
    socket.onmessage = (event) => this.onMessage(connection, event.data);
    socket.onclose = (event) => this.onClose(connection, event);
    socket.onerror = () => {
      // A close event follows; that is where it is handled.
    };
    try {
      connection.decoder = this.deps.createDecoder(kind, {
        frames: (planes) => {
          if (connection.closed) return;
          if (connection.player) connection.player.push(planes);
          else {
            connection.pending.push(planes);
            if (connection.pending.length > MAX_PENDING_FRAMES) connection.pending.shift();
          }
        },
        error: (message) => this.fail(connection, message)
      });
    } catch (error) {
      this.fail(connection, `Couldn't start the audio decoder: ${describe(error)}`);
      return;
    }
    output
      .openPlayer({
        initialTargetMs: this.lastTargetMs,
        onStats: (stats) => {
          if (connection.closed) return;
          this.lastTargetMs = stats.targetMs;
          this.patch({ stats });
        }
      })
      .then(
        (player) => {
          if (connection.closed) {
            player.dispose();
            return;
          }
          connection.player = player;
          for (const planes of connection.pending) player.push(planes);
          connection.pending = [];
        },
        (error: unknown) => this.fail(connection, `Couldn't start audio playback: ${describe(error)}`)
      );
  }

  private onMessage(connection: Connection, data: unknown): void {
    if (connection.closed) return;
    connection.heard = true;
    if (typeof data === "string") {
      const message = parseAudioServerMessage(data);
      if (message?.type === "state") {
        this.attempt = 0;
        this.patch({ serverState: message });
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const packet = parseAudioPacket(data);
    if (!packet) return;
    this.attempt = 0;
    if (this.snapshot.error) this.patch({ error: null });
    // A seq gap is lost audio: nothing is inserted; the jitter buffer absorbs it.
    connection.decoder?.decode(packet.seq, packet.payload);
  }

  private keepalive(connection: Connection): void {
    if (connection.closed) return;
    if (!connection.heard) {
      // Nothing — not even a pong — for a whole interval: the connection is dead.
      this.fail(connection, "The audio stream stopped responding.");
      return;
    }
    connection.heard = false;
    if (connection.socket.readyState === SOCKET_OPEN) {
      const ping: DesktopAudioClientMessage = { type: "ping" };
      connection.socket.send(JSON.stringify(ping));
    }
  }

  private onClose(connection: Connection, event: { code: number; reason: string }): void {
    if (connection.closed || connection !== this.connection) return;
    const message =
      event.code === 1008 ? "Not authorised for the audio stream."
      : event.reason ? `Audio stream closed: ${event.reason}`
      : `Audio stream closed (${event.code}).`;
    this.fail(connection, message);
  }

  /** Drop a broken connection and retry with backoff while it should still be open. */
  private fail(connection: Connection, message: string): void {
    if (connection.closed || connection !== this.connection) return;
    this.closeConnection();
    this.patch({ error: message, stats: null });
    if (shouldStreamAudio(this.inputs)) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconcile();
    }, delay);
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeConnection(): void {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    connection.closed = true;
    clearInterval(connection.keepalive);
    const { socket } = connection;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) socket.close(1000);
    connection.decoder?.close();
    connection.player?.dispose();
    connection.player = null;
    connection.pending = [];
  }

  private patch(next: Partial<DesktopAudioSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(next) as (keyof DesktopAudioSnapshot)[]) {
      if (this.snapshot[key] !== next[key]) changed = true;
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
