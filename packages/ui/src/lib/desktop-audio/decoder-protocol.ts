// Messages between `decoder.ts` and the WASM decoder worker. Types only.

/** One Opus packet: a view into a transferred buffer (the whole socket frame, header included). */
export interface WasmDecoderInbound {
  type: "decode";
  buffer: ArrayBuffer;
  offset: number;
  length: number;
}

export type WasmDecoderOutbound = { type: "frames"; planes: Float32Array[] } | { type: "error"; message: string };
