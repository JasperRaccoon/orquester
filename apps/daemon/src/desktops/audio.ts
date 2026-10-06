// Desktop audio (spec §8.1): one ffmpeg per desktop captures the desktop's
// PulseAudio `orq.monitor`, encodes 10 ms Opus frames into Ogg on stdout, and
// the hub splits the pages into packets and fans each one out, framed with a
// per-desktop `seq`, to every subscribed audio socket.
//
// ffmpeg is a disposable daemon child (not a tmux process): it starts on a
// desktop's first subscriber, stops 2 s after the last one leaves (so a quick tab
// switch doesn't restart it), and restarts with backoff if it dies while
// subscribers remain.
import { spawn, type ChildProcess } from "node:child_process";
import {
  DESKTOP_AUDIO_HEADER_BYTES,
  DESKTOP_AUDIO_PACKET_OPUS,
  type DesktopAudioAvailability,
  type DesktopAudioStateMessage
} from "@orquester/api";
import { OggOpusSplitter } from "./ogg-opus.ts";

export interface DesktopAudioSink {
  /** Send one framed binary audio packet (header + Opus). */
  send(packet: Buffer): void;
  /** Bytes queued on the socket; the hub skips this sink above 32 KiB. */
  bufferedAmount(): number;
  /** Send a JSON state message. */
  sendState(state: DesktopAudioStateMessage): void;
  /** End the stream (the desktop stopped). Optional: without it the sink just stops receiving. */
  close?(): void;
}

export interface DesktopAudioHubOptions {
  /** Resolved ffmpeg binary, or null (audio unavailable). */
  ffmpegPath: string | null;
  log?: (message: string, error?: unknown) => void;
  /** Delay between the last unsubscribe and stopping the encoder. Default 2000 ms. */
  stopGraceMs?: number;
  /** Restart delays after consecutive unexpected exits; the last one repeats. */
  restartBackoffMs?: readonly number[];
  /** Called whenever an encoder process exits; `expected` when the hub killed it. */
  onEncoderExit?: (desktopId: string, exit: DesktopAudioEncoderExit) => void;
}

export interface DesktopAudioEncoderExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

/** Queued bytes above which a sink misses packets (~250 ms of 96 kbit/s audio). */
export const DESKTOP_AUDIO_SINK_MAX_BUFFERED = 32 * 1024;
const DEFAULT_STOP_GRACE_MS = 2000;
const DEFAULT_RESTART_BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;
/** Consecutive failed starts before subscribers are told audio is unavailable. */
const FAILURES_BEFORE_UNAVAILABLE = 3;
const STDERR_TAIL_BYTES = 2048;
/** A run this long counts as healthy even without packets (an idle monitor produces none). */
const HEALTHY_RUN_MS = 10_000;

export function desktopAudioState(audio: DesktopAudioAvailability, reason?: string): DesktopAudioStateMessage {
  return {
    type: "state",
    audio,
    ...(reason === undefined ? {} : { reason }),
    sampleRate: 48000,
    channels: 2,
    frameMs: 10
  };
}

/** `[u8 type=1][u8 flags=0][u16 reserved=0][u32 seq BE][opus]`. */
function frameDesktopAudioPacket(seq: number, opus: Buffer): Buffer {
  const packet = Buffer.allocUnsafe(DESKTOP_AUDIO_HEADER_BYTES + opus.length);
  packet.writeUInt8(DESKTOP_AUDIO_PACKET_OPUS, 0);
  packet.writeUInt8(0, 1);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt32BE(seq >>> 0, 4);
  opus.copy(packet, DESKTOP_AUDIO_HEADER_BYTES);
  return packet;
}

/** ffmpeg arguments for one desktop's encoder (spec §8.1; measured ~21 ms sink → packet). */
function desktopAudioFfmpegArgs(pulseSocketPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-f", "pulse",
    "-server", `unix:${pulseSocketPath}`,
    // 10 ms of s16 stereo 48 kHz; the pulse input otherwise buffers ~50 ms.
    "-fragment_size", "1920",
    "-i", "orq.monitor",
    "-c:a", "libopus",
    "-application", "lowdelay",
    "-frame_duration", "10",
    "-b:a", "96k",
    "-f", "ogg",
    "-page_duration", "10000",
    "-flush_packets", "1",
    "pipe:1"
  ];
}

interface DesktopEncoder {
  desktopId: string;
  pulseSocketPath: string;
  sinks: Set<DesktopAudioSink>;
  child: ChildProcess | null;
  /** Next packet's sequence number; per desktop, wraps at 2^32. */
  seq: number;
  state: DesktopAudioStateMessage;
  /** Consecutive unexpected exits; an exit after a healthy run (packets, or a long run) counts as the first. */
  failures: number;
  stopTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
}

export class DesktopAudioHub {
  private readonly encoders = new Map<string, DesktopEncoder>();
  private disposed = false;

  constructor(readonly options: DesktopAudioHubOptions) {}

  /**
   * Subscribe a sink to a desktop's Opus stream. Starts one encoder per desktop on
   * the first subscriber (reading `<pulseSocketPath>`'s `orq.monitor`), stops it 2 s
   * after the last one leaves. Sends a `state` message to the sink first. Returns
   * the unsubscribe function.
   */
  subscribe(desktopId: string, pulseSocketPath: string, sink: DesktopAudioSink): () => void {
    if (this.options.ffmpegPath === null) {
      sink.sendState(desktopAudioState("unavailable", "ffmpeg is not installed on the host"));
      return () => {};
    }
    if (this.disposed) {
      sink.sendState(desktopAudioState("unavailable", "the daemon is shutting down"));
      return () => {};
    }
    let encoder = this.encoders.get(desktopId);
    if (encoder && encoder.pulseSocketPath !== pulseSocketPath) {
      // The desktop restarted with a new pulse socket: the old encoder is reading a dead server.
      encoder.pulseSocketPath = pulseSocketPath;
      this.killChild(encoder);
      encoder.failures = 0;
    }
    if (!encoder) {
      encoder = {
        desktopId,
        pulseSocketPath,
        sinks: new Set(),
        child: null,
        seq: 0,
        state: desktopAudioState("available"),
        failures: 0,
        stopTimer: null,
        restartTimer: null
      };
      this.encoders.set(desktopId, encoder);
    }
    if (encoder.stopTimer) {
      clearTimeout(encoder.stopTimer);
      encoder.stopTimer = null;
    }
    encoder.sinks.add(sink);
    sink.sendState(encoder.state);
    if (!encoder.child && !encoder.restartTimer) this.start(encoder);

    const current = encoder;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.unsubscribe(current, sink);
    };
  }

  /** Stop a desktop's encoder immediately and end its subscribers' streams. */
  stopDesktop(desktopId: string): void {
    const encoder = this.encoders.get(desktopId);
    if (!encoder) return;
    this.dispose(encoder);
    for (const sink of encoder.sinks) {
      try {
        sink.close?.();
      } catch {
        /* closing */
      }
    }
    encoder.sinks.clear();
  }

  shutdown(): void {
    this.disposed = true;
    for (const encoder of [...this.encoders.values()]) this.dispose(encoder);
  }

  /** The running encoder's pid, for diagnostics and tests. */
  encoderPid(desktopId: string): number | null {
    return this.encoders.get(desktopId)?.child?.pid ?? null;
  }

  private unsubscribe(encoder: DesktopEncoder, sink: DesktopAudioSink): void {
    encoder.sinks.delete(sink);
    if (encoder.sinks.size > 0 || this.encoders.get(encoder.desktopId) !== encoder) return;
    if (encoder.stopTimer) clearTimeout(encoder.stopTimer);
    encoder.stopTimer = setTimeout(() => {
      encoder.stopTimer = null;
      if (encoder.sinks.size === 0) this.dispose(encoder);
    }, this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    encoder.stopTimer.unref();
  }

  /** Kill the encoder, clear its timers and forget it. */
  private dispose(encoder: DesktopEncoder): void {
    if (this.encoders.get(encoder.desktopId) === encoder) this.encoders.delete(encoder.desktopId);
    if (encoder.stopTimer) clearTimeout(encoder.stopTimer);
    if (encoder.restartTimer) clearTimeout(encoder.restartTimer);
    encoder.stopTimer = null;
    encoder.restartTimer = null;
    this.killChild(encoder);
  }

  private killChild(encoder: DesktopEncoder): void {
    const child = encoder.child;
    if (!child) return;
    encoder.child = null; // marks the exit as expected
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  private start(encoder: DesktopEncoder): void {
    const ffmpegPath = this.options.ffmpegPath;
    if (ffmpegPath === null) return;
    const child = spawn(ffmpegPath, desktopAudioFfmpegArgs(encoder.pulseSocketPath), {
      stdio: ["ignore", "pipe", "pipe"],
      // Minimal env: the pulse server is explicit (`-server unix:…`), so libpulse
      // neither reads the daemon's PULSE_* settings nor autospawns a server.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/",
        LANG: "C.UTF-8"
      }
    });
    encoder.child = child;
    const startedAt = Date.now();
    let producedPacket = false;
    let stderrTail = "";

    const splitter = new OggOpusSplitter((opus) => {
      if (encoder.child !== child) return;
      if (!producedPacket) {
        producedPacket = true;
        encoder.failures = 0;
        if (encoder.state.audio !== "available") this.broadcastState(encoder, desktopAudioState("available"));
      }
      const packet = frameDesktopAudioPacket(encoder.seq, opus);
      encoder.seq = (encoder.seq + 1) >>> 0;
      for (const sink of encoder.sinks) {
        // A slow socket misses packets; the seq gap tells its client.
        if (sink.bufferedAmount() > DESKTOP_AUDIO_SINK_MAX_BUFFERED) continue;
        try {
          sink.send(packet);
        } catch {
          /* closing */
        }
      }
    });
    child.stdout!.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => {
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
    });

    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (exited) return;
      exited = true;
      const expected = encoder.child !== child;
      if (!expected) encoder.child = null;
      this.options.onEncoderExit?.(encoder.desktopId, { code, signal, expected });
      if (expected) return;
      const detail = error?.message ?? stderrTail.trim().split("\n").pop() ?? "";
      const reason = `ffmpeg exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ""}`;
      this.options.log?.(`desktop ${encoder.desktopId} audio encoder ${reason}`, error);
      if (this.encoders.get(encoder.desktopId) !== encoder || encoder.sinks.size === 0) return;
      if (producedPacket || Date.now() - startedAt >= HEALTHY_RUN_MS) encoder.failures = 0;
      encoder.failures += 1;
      if (encoder.failures >= FAILURES_BEFORE_UNAVAILABLE && encoder.state.audio !== "unavailable") {
        this.broadcastState(encoder, desktopAudioState("unavailable", reason));
      }
      const backoff = this.options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
      const delay = backoff[Math.min(Math.max(encoder.failures - 1, 0), backoff.length - 1)] ?? 1000;
      encoder.restartTimer = setTimeout(() => {
        encoder.restartTimer = null;
        if (this.encoders.get(encoder.desktopId) === encoder && encoder.sinks.size > 0 && !encoder.child) {
          this.start(encoder);
        }
      }, delay);
    };
    child.once("error", (error) => onExit(null, null, error));
    // "close", not "exit": stdout is drained first, so no trailing packet is lost.
    child.once("close", (code, signal) => onExit(code, signal));
  }

  private broadcastState(encoder: DesktopEncoder, state: DesktopAudioStateMessage): void {
    encoder.state = state;
    for (const sink of encoder.sinks) {
      try {
        sink.sendState(state);
      } catch {
        /* closing */
      }
    }
  }
}
