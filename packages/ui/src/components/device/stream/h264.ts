// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/** H.264 helpers shared by the serve-sim (avcC) and serve-emu (Annex-B) feeds. */

const hex = (byte: number) => byte.toString(16).padStart(2, "0");

/**
 * WebCodecs `avc1.PPCCLL` from profile, constraint flags and level. Both an
 * avcC record (`configurationVersion, profile, compat, level, …`) and an SPS
 * NAL (`nal header, profile, compat, level, …`) keep them at bytes 1..3.
 */
function codecFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

/** Codec string of a serve-sim `stream.avcc` description (an AVCDecoderConfigurationRecord). */
export function codecFromAvcC(record: Uint8Array): string | null {
  if (record.length < 4 || record[0] !== 1) return null;
  return codecFromBytes(record);
}

/** Codec string of an SPS NAL unit that starts at its NAL header byte (type 7). */
export function codecFromSps(sps: Uint8Array): string | null {
  if (sps.length < 4 || (sps[0]! & 0x1f) !== 7) return null;
  return codecFromBytes(sps);
}

export interface AccessUnitScan {
  /** An IDR slice (type 5) is present. */
  readonly isKey: boolean;
  /** The first SPS NAL (from its header byte to the end of the unit), if any. */
  readonly sps: Uint8Array | null;
}

/** Find IDR and SPS NAL units in an Annex-B access unit (3- or 4-byte start codes). */
export function scanAccessUnit(buf: Uint8Array): AccessUnitScan {
  let isKey = false;
  let sps: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen && i + codeLen < len) {
        const nalType = buf[i + codeLen]! & 0x1f;
        if (nalType === 7 && !sps) sps = buf.subarray(i + codeLen);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, sps };
}
