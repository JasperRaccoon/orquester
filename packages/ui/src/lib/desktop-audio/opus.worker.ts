// WASM Opus decoder worker: the fallback for browsers without WebCodecs Opus (spec §8.3). Loaded
// only when `decoder.ts` needs it; Vite bundles it (with opus-decoder's inlined WASM) as its own
// same-origin file. Compiling the WASM needs `'wasm-unsafe-eval'` in the CSP.
import "./opus-worker-shim.ts";
import { OpusDecoder } from "opus-decoder";

import type { WasmDecoderInbound, WasmDecoderOutbound } from "./decoder-protocol.ts";

// The DOM lib types `self` as a Window; describe the dedicated-worker surface used here.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WasmDecoderInbound>) => void) | null;
  postMessage(message: WasmDecoderOutbound, transfer?: Transferable[]): void;
};

/** Packets that arrive while the WASM compiles (~300 ms of audio at most). */
const MAX_PENDING = 30;

const decoder = new OpusDecoder({ sampleRate: 48_000, channels: 2 });
let state: "loading" | "ready" | "failed" = "loading";
let pending: WasmDecoderInbound[] = [];

decoder.ready.then(
  () => {
    state = "ready";
    const queued = pending;
    pending = [];
    for (const message of queued) decode(message);
  },
  (error: unknown) => {
    state = "failed";
    pending = [];
    worker.postMessage({ type: "error", message: `The WASM Opus decoder failed to load: ${describe(error)}` });
  }
);

worker.onmessage = (event) => {
  const message = event.data;
  if (message.type !== "decode") return;
  if (state === "ready") decode(message);
  else if (state === "loading") {
    pending.push(message);
    if (pending.length > MAX_PENDING) pending.shift();
  }
};

function decode(message: WasmDecoderInbound): void {
  let planes: Float32Array[];
  try {
    const { channelData, samplesDecoded } = decoder.decodeFrame(new Uint8Array(message.buffer, message.offset, message.length));
    if (samplesDecoded === 0) return;
    // decodeFrame returns fresh arrays (copied out of WASM memory), so they can be transferred.
    planes = channelData.map((plane) => (plane.length === samplesDecoded ? plane : plane.slice(0, samplesDecoded)));
  } catch {
    // A corrupt packet is a lost packet; the jitter buffer absorbs it.
    return;
  }
  worker.postMessage({ type: "frames", planes }, planes.map((plane) => plane.buffer as ArrayBuffer));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
