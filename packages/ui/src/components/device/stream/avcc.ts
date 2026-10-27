// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/**
 * serve-sim `stream.avcc` envelopes: `u32 BE length | u8 tag | payload`, where
 * the length counts the tag byte. Tags: 1 avcC description, 2 keyframe,
 * 3 delta (both AVCC length-prefixed NALs), 4 JPEG seed. Unknown tags are skipped.
 */

export type AvccChunkType = "description" | "keyframe" | "delta" | "seed";

export interface AvccChunk {
  readonly type: AvccChunkType;
  readonly payload: Uint8Array;
}

const AVCC_TAGS: Record<number, AvccChunkType | undefined> = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed"
};

/** A single envelope larger than this means the stream is not avcc; the demuxer throws. */
export const MAX_AVCC_ENVELOPE_BYTES = 32 * 1024 * 1024;

export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;

  /** Append bytes from one read and return every envelope they complete, in order. */
  push(bytes: Uint8Array): AvccChunk[] {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;

    const chunks: AvccChunk[] = [];
    let offset = 0;
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
      const envelopeLength = view.getUint32(0, false);
      if (envelopeLength > MAX_AVCC_ENVELOPE_BYTES) {
        this.reset();
        throw new Error(`avcc envelope of ${envelopeLength} bytes`);
      }
      if (this.length - offset - 4 < envelopeLength) break;
      if (envelopeLength >= 1) {
        const type = AVCC_TAGS[this.buffer[offset + 4]!];
        if (type) chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + envelopeLength) });
      }
      offset += 4 + envelopeLength;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return chunks;
  }

  /** Bytes held for an incomplete envelope. */
  get pending(): number {
    return this.length;
  }

  reset(): void {
    this.length = 0;
  }
}

/** Build one envelope (tests and fixtures). */
export function encodeAvccEnvelope(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}
