// Opus → Float32 planar (spec §8.2, §8.3). WebCodecs `AudioDecoder` where it supports Opus;
// otherwise a WASM `opus-decoder` Worker, whose bundle is fetched only when this path is taken.
import type { DecoderSink, DesktopAudioDecoder, DesktopAudioDecoderKind } from "./controller.ts";
import { desktopAudioSupported } from "./context.ts";
import type { WasmDecoderInbound, WasmDecoderOutbound } from "./decoder-protocol.ts";
import OpusDecoderWorker from "./opus.worker.ts?worker";

const OPUS_CONFIG: AudioDecoderConfig = { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 };
/** Packet duration: seq → chunk timestamp in µs. */
const FRAME_US = 10_000;

let detection: Promise<DesktopAudioDecoderKind> | null = null;

/** Which decoder this browser can use; probed once per page. */
export function detectDesktopAudioDecoder(): Promise<DesktopAudioDecoderKind> {
  detection ??= detect();
  return detection;
}

async function detect(): Promise<DesktopAudioDecoderKind> {
  // Without an AudioWorklet there is nowhere to play decoded audio (e.g. Lockdown Mode).
  if (!desktopAudioSupported()) return "none";
  if (typeof AudioDecoder !== "undefined") {
    try {
      if ((await AudioDecoder.isConfigSupported(OPUS_CONFIG)).supported) return "webcodecs";
    } catch {
      // Treat a throwing probe as unsupported.
    }
  }
  if (typeof Worker !== "undefined" && typeof WebAssembly !== "undefined") return "wasm";
  return "none";
}

export function createDesktopAudioDecoder(kind: "webcodecs" | "wasm", sink: DecoderSink): DesktopAudioDecoder {
  return kind === "webcodecs" ? new WebCodecsOpusDecoder(sink) : new WasmOpusDecoder(sink);
}

class WebCodecsOpusDecoder implements DesktopAudioDecoder {
  private readonly decoder: AudioDecoder;
  private closed = false;

  constructor(private readonly sink: DecoderSink) {
    this.decoder = new AudioDecoder({
      output: (data) => this.output(data),
      error: (error) => {
        if (!this.closed) sink.error(`The audio decoder failed: ${error.message}`);
      }
    });
    this.decoder.configure(OPUS_CONFIG);
  }

  decode(seq: number, packet: Uint8Array): void {
    if (this.decoder.state !== "configured") return;
    // Opus packets are independently decodable: every chunk is a key chunk.
    this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: seq * FRAME_US, data: packet }));
  }

  close(): void {
    this.closed = true;
    if (this.decoder.state !== "closed") this.decoder.close();
  }

  private output(data: AudioData): void {
    try {
      if (!this.closed) this.sink.frames(toPlanes(data));
    } catch (error) {
      this.sink.error(`Couldn't read decoded audio: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      data.close();
    }
  }
}

/** One Float32Array per channel, each backed by its own buffer so it can be transferred. */
function toPlanes(data: AudioData): Float32Array[] {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  const planes: Float32Array[] = [];
  try {
    for (let ch = 0; ch < channels; ch++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
      planes.push(plane);
    }
    return planes;
  } catch (error) {
    // Some implementations can't convert formats in copyTo: de-interleave "f32" by hand.
    if (data.format !== "f32") throw error;
    const interleaved = new Float32Array(frames * channels);
    data.copyTo(interleaved, { planeIndex: 0 });
    return Array.from({ length: channels }, (_, ch) => {
      const plane = new Float32Array(frames);
      for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + ch]!;
      return plane;
    });
  }
}

class WasmOpusDecoder implements DesktopAudioDecoder {
  private readonly worker: Worker;
  private closed = false;

  constructor(sink: DecoderSink) {
    this.worker = new OpusDecoderWorker();
    this.worker.onmessage = (event: MessageEvent<WasmDecoderOutbound>) => {
      if (this.closed) return;
      const message = event.data;
      if (message.type === "frames") sink.frames(message.planes);
      else sink.error(message.message);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      if (!this.closed) sink.error("The WASM Opus decoder couldn't start.");
    };
  }

  decode(_seq: number, packet: Uint8Array): void {
    // Hand the socket frame's buffer over instead of copying the packet out of it.
    const message: WasmDecoderInbound = {
      type: "decode",
      buffer: packet.buffer as ArrayBuffer,
      offset: packet.byteOffset,
      length: packet.byteLength
    };
    this.worker.postMessage(message, [message.buffer]);
  }

  close(): void {
    this.closed = true;
    this.worker.terminate();
  }
}
