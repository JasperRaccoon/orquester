/**
 * What this browser can decode, and which transport a device stream uses.
 * Measured: Android emulators stream H.264 Baseline (`avc1.42c020`); serve-sim
 * encodes High (`avc1.640033`) but only where VideoToolbox has a working
 * encoder — Blacksmith macOS VMs don't, so iOS hosts there stream MJPEG.
 */

import type { DevicePlatform, DeviceTransport } from "./types.ts";

export interface BrowserStreamCaps {
  /** `VideoDecoder` and `EncodedVideoChunk` exist (secure context, modern browser). */
  readonly webCodecs: boolean;
  /** H.264 Baseline decodes with `optimizeForLatency` (Android emulators). */
  readonly h264Baseline: boolean;
  /** H.264 High decodes with `optimizeForLatency` (serve-sim). */
  readonly h264High: boolean;
}

/** What the device host advertises for its streams. */
export interface HostStreamCaps {
  /** The host's serve-sim can encode H.264 (BYO Macs with VideoToolbox); false/absent → MJPEG. */
  readonly h264?: boolean;
}

const NO_BROWSER_CAPS: BrowserStreamCaps = { webCodecs: false, h264Baseline: false, h264High: false };

const BASELINE_CODEC = "avc1.42c020";
const HIGH_CODEC = "avc1.640033";

async function supported(Decoder: typeof VideoDecoder, codec: string): Promise<boolean> {
  try {
    const result = await Decoder.isConfigSupported({ codec, optimizeForLatency: true });
    return result.supported === true;
  } catch {
    return false;
  }
}

let cached: Promise<BrowserStreamCaps> | null = null;

/** Probe once per page (the answer does not change). */
export function capabilities(): Promise<BrowserStreamCaps> {
  const Decoder = globalThis.VideoDecoder;
  const Chunk = globalThis.EncodedVideoChunk;
  const probe = async (): Promise<BrowserStreamCaps> => {
    if (!Decoder || !Chunk) return NO_BROWSER_CAPS;
    const [h264Baseline, h264High] = await Promise.all([supported(Decoder, BASELINE_CODEC), supported(Decoder, HIGH_CODEC)]);
    return { webCodecs: true, h264Baseline, h264High };
  };
  cached ??= probe();
  return cached;
}

export interface ChooseTransportInput {
  readonly platform: DevicePlatform;
  readonly hostCaps?: HostStreamCaps;
  readonly browserCaps: BrowserStreamCaps;
}

/**
 * Android → serve-emu, or screenshots when the browser can't decode H.264.
 * iOS → H.264 only when the host advertises it and the browser decodes it; else MJPEG.
 */
export function chooseTransport({ platform, hostCaps, browserCaps }: ChooseTransportInput): DeviceTransport {
  if (platform === "android") return browserCaps.webCodecs && browserCaps.h264Baseline ? "serve-emu" : "screenshots";
  return hostCaps?.h264 === true && browserCaps.webCodecs && browserCaps.h264High ? "serve-sim-h264" : "serve-sim-mjpeg";
}
