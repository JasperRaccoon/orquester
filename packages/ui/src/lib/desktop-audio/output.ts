// A desktop's Web Audio graph: per-stream worklet node → the desktop's GainNode → destination.
import { desktopAudioContext, loadDesktopAudioWorklet } from "./context.ts";
import type { DesktopAudioOutput, DesktopAudioPlayer } from "./controller.ts";
import {
  DESKTOP_AUDIO_PROCESSOR,
  type PlayerInboundMessage,
  type PlayerOutboundMessage,
  type PlayerProcessorOptions
} from "./worklet-protocol.ts";

/** Volume changes glide over ~15 ms instead of clicking. */
const VOLUME_TIME_CONSTANT_S = 0.015;

export function createDesktopAudioOutput(volume: number): DesktopAudioOutput | null {
  const ctx = desktopAudioContext();
  if (!ctx) return null;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  return {
    setVolume(next) {
      gain.gain.setTargetAtTime(next, ctx.currentTime, VOLUME_TIME_CONSTANT_S);
    },
    async openPlayer({ initialTargetMs, onStats }): Promise<DesktopAudioPlayer> {
      await loadDesktopAudioWorklet(ctx);
      const processorOptions: PlayerProcessorOptions = initialTargetMs === undefined ? {} : { initialTargetMs };
      const node = new AudioWorkletNode(ctx, DESKTOP_AUDIO_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions
      });
      node.port.onmessage = (event: MessageEvent<PlayerOutboundMessage>) => {
        if (event.data.type === "stats") onStats(event.data.stats);
      };
      node.connect(gain);
      return {
        push(planes) {
          const message: PlayerInboundMessage = { type: "frames", planes };
          const transfer = [...new Set(planes.map((plane) => plane.buffer as ArrayBuffer))];
          node.port.postMessage(message, transfer);
        },
        dispose() {
          const stop: PlayerInboundMessage = { type: "stop" };
          node.port.postMessage(stop);
          node.port.onmessage = null;
          node.port.close();
          node.disconnect();
        }
      };
    },
    dispose() {
      gain.disconnect();
    }
  };
}
