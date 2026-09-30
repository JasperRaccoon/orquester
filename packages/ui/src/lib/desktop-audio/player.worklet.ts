// AudioWorkletProcessor for the desktop audio stream: a thin shell around the jitter-buffer
// policy. Decoded planar frames arrive on the node's MessagePort (transferred, not copied); every
// 128-frame render quantum is pulled from the buffer; stats go back every 500 ms.
//
// Bundled as its own file via `./player.worklet.ts?worker&url` (see context.ts), so it loads
// same-origin under `script-src 'self'`.
import { JitterBuffer } from "./jitter-buffer.ts";
import {
  DESKTOP_AUDIO_PROCESSOR,
  type PlayerInboundMessage,
  type PlayerOutboundMessage,
  type PlayerProcessorOptions
} from "./worklet-protocol.ts";

// AudioWorkletGlobalScope isn't in TypeScript's DOM lib; describe the parts used here.
interface ProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => ProcessorBase;
  registerProcessor(name: string, ctor: new (options: { processorOptions?: PlayerProcessorOptions }) => ProcessorBase): void;
  sampleRate: number;
}
const scope = globalThis as unknown as WorkletScope;

const STATS_INTERVAL_MS = 500;

class DesktopAudioPlayerProcessor extends scope.AudioWorkletProcessor {
  private readonly buffer: JitterBuffer;
  private readonly statsEvery: number;
  private sinceStats = 0;
  private stopped = false;

  constructor(options: { processorOptions?: PlayerProcessorOptions }) {
    super(options);
    const initialTargetMs = options.processorOptions?.initialTargetMs;
    this.buffer = new JitterBuffer({
      sampleRate: scope.sampleRate,
      channels: 2,
      ...(typeof initialTargetMs === "number" && Number.isFinite(initialTargetMs) ? { initialTargetMs } : {})
    });
    this.statsEvery = Math.round((STATS_INTERVAL_MS * scope.sampleRate) / 1000);
    this.port.onmessage = (event: MessageEvent<PlayerInboundMessage>) => {
      const message = event.data;
      if (message.type === "frames") this.buffer.push(message.planes);
      else if (message.type === "stop") this.stopped = true;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    this.buffer.render(output);
    this.sinceStats += output[0]!.length;
    if (this.sinceStats >= this.statsEvery) {
      this.sinceStats = 0;
      const message: PlayerOutboundMessage = { type: "stats", stats: this.buffer.stats() };
      this.port.postMessage(message);
    }
    return true;
  }
}

scope.registerProcessor(DESKTOP_AUDIO_PROCESSOR, DesktopAudioPlayerProcessor);
