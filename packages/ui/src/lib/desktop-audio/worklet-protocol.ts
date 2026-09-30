// Messages between the main thread and the `player.worklet.ts` AudioWorkletProcessor. Types and
// constants only: the worklet bundle imports this too.
import type { DesktopAudioStats } from "./jitter-buffer.ts";

export const DESKTOP_AUDIO_PROCESSOR = "orq-desktop-audio-player";

export interface PlayerProcessorOptions {
  /** Start from the target an earlier stream of this desktop learned. */
  initialTargetMs?: number;
}

/** Main → worklet. `frames` carries transferred planar buffers, one per channel. */
export type PlayerInboundMessage = { type: "frames"; planes: Float32Array[] } | { type: "stop" };

/** Worklet → main, every 500 ms. */
export type PlayerOutboundMessage = { type: "stats"; stats: DesktopAudioStats };
