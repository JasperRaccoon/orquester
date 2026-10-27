// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/**
 * serve-emu frame metadata (`frame-meta=1`), big-endian:
 *   [0..3] "SEMU"  [4] version  [5] flags (bit 0 keyframe)  [6..7] reserved
 *   [8..15] u64 scrcpy pts (µs)  [16..23] u64 server send time, epoch µs (v2 only)
 * expo-device-hub's Node middleware writes v1 (16 bytes); serve-emu's Bun
 * server writes v2 (24 bytes). Anything else is raw Annex-B.
 */

const SEMU_MAGIC = 0x53454d55;
const SEMU_V1_HEADER_BYTES = 16;
const SEMU_V2_HEADER_BYTES = 24;
const SEMU_FLAG_KEY = 1;

export interface SemuPacket {
  /** Annex-B access unit (a view into the message). */
  readonly data: Uint8Array;
  /** From the header flag; null when there is no header (scan the NALs instead). */
  readonly isKey: boolean | null;
  /** Presentation time in µs, or null without a header or when it exceeds 2^53. */
  readonly timestamp: number | null;
}

export function parseSemuPacket(raw: ArrayBuffer | Uint8Array): SemuPacket {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > SEMU_V1_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) === SEMU_MAGIC) {
      const version = view.getUint8(4);
      const isKey = (view.getUint8(5) & SEMU_FLAG_KEY) !== 0;
      const pts = view.getBigUint64(8, false);
      const timestamp = pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null;
      if (version === 2 && bytes.byteLength > SEMU_V2_HEADER_BYTES) {
        return {
          data: bytes.subarray(SEMU_V2_HEADER_BYTES),
          isKey,
          timestamp
        };
      }
      if (version === 1) {
        return { data: bytes.subarray(SEMU_V1_HEADER_BYTES), isKey, timestamp };
      }
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}
