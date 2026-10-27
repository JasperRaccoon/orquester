/**
 * The two wire formats the vphone bridge translates between (phase 3 §2.3):
 *
 * - vphone `GET /v1/host/screen` (a WebSocket `vphone-vm` serves on the `--api-listen` proxy): the
 *   client pulls one frame per text request `{"id","codec","box":[w,h],"fps","bitrate","key"}`;
 *   each answer is one binary message — a 4-byte LITTLE-endian header length, the JSON header,
 *   then the payload. A `status: "frame"` payload is one access unit of 4-byte length-prefixed NAL
 *   units without parameter sets; a key frame's header carries the `avcC` record in base64
 *   (`record`). `unchanged` / `dropped` carry nothing; `error: {code, message}` replaces `status`.
 * - serve-sim `stream.avcc` (what the panel's `AvccDemuxer` reads, `packages/ui/src/components/
 *   device/stream/avcc.ts`): envelopes `u32 BIG-endian length (tag included) | u8 tag | payload`,
 *   tag 1 the avcC description, 2 a keyframe and 3 a delta (both AVCC length-prefixed NALs, as
 *   VideoToolbox writes them — the same bytes vphone sends), 4 a JPEG seed.
 *
 * Pure: no I/O. The bridge (`bridge.ts`) drives the sockets.
 */

/** serve-sim avcc envelope tags. */
export const AVCC_TAG = { description: 1, keyframe: 2, delta: 3, seed: 4 } as const;

/** A `/v1/host/screen` request. vphone requires every field (`bitrate` too). */
export interface HostScreenRequest {
  id: number;
  codec: "h264";
  box: [number, number];
  fps: number;
  bitrate: number;
  key: boolean;
}

export interface HostScreenError {
  code: string;
  message: string;
}

/** A `/v1/host/screen` answer's header (only the fields the bridge reads). */
export interface HostScreenHeader {
  id: number | null;
  status: "frame" | "unchanged" | "dropped" | null;
  error: HostScreenError | null;
  key: boolean;
  /** The decoder configuration record (avcC), decoded; key frames only. */
  record: Buffer | null;
  session: number | null;
  width: number | null;
  height: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  scale: number | null;
}

export interface HostScreenReply {
  header: HostScreenHeader;
  payload: Buffer;
}

/** Headers longer than this are not vphone's: the reply is refused. */
const MAX_HEADER_BYTES = 64 * 1024;

export function encodeScreenRequest(request: HostScreenRequest): string {
  return JSON.stringify({ id: request.id, codec: request.codec, box: request.box, fps: request.fps, bitrate: request.bitrate, key: request.key });
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Parse one binary answer. Throws on a malformed message (the bridge drops the socket). */
export function decodeScreenReply(message: Buffer): HostScreenReply {
  if (message.length < 4) throw new Error("host screen reply shorter than its header length");
  const headerLength = message.readUInt32LE(0);
  if (headerLength > MAX_HEADER_BYTES || 4 + headerLength > message.length) throw new Error(`host screen reply header of ${headerLength} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(message.subarray(4, 4 + headerLength).toString("utf8"));
  } catch {
    throw new Error("host screen reply header is not JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("host screen reply header is not an object");
  const record = raw as Record<string, unknown>;
  const error = record.error;
  const status = record.status === "frame" || record.status === "unchanged" || record.status === "dropped" ? record.status : null;
  const header: HostScreenHeader = {
    id: num(record.id),
    status,
    error:
      error !== null && typeof error === "object"
        ? {
            code: typeof (error as Record<string, unknown>).code === "string" ? ((error as Record<string, unknown>).code as string) : "unknown",
            message: typeof (error as Record<string, unknown>).message === "string" ? ((error as Record<string, unknown>).message as string) : ""
          }
        : null,
    key: record.key === true,
    record: typeof record.record === "string" && record.record.length > 0 ? Buffer.from(record.record, "base64") : null,
    session: num(record.session),
    width: num(record.width),
    height: num(record.height),
    sourceWidth: num(record.sourceWidth),
    sourceHeight: num(record.sourceHeight),
    scale: num(record.scale)
  };
  if (header.error === null && header.status === null) throw new Error("host screen reply has neither status nor error");
  return { header, payload: message.subarray(4 + headerLength) };
}

/** One serve-sim envelope. */
export function avccEnvelope(tag: number, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32BE(payload.length + 1, 0);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

/** Whether `payload` is a run of 4-byte big-endian length-prefixed NAL units that ends exactly. */
export function isLengthPrefixedAccessUnit(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  let offset = 0;
  while (offset < payload.length) {
    if (payload.length - offset < 4) return false;
    const length = ((payload[offset]! << 24) >>> 0) + (payload[offset + 1]! << 16) + (payload[offset + 2]! << 8) + payload[offset + 3]!;
    if (length === 0) return false;
    offset += 4 + length;
  }
  return offset === payload.length;
}

/** Whether `record` looks like an AVCDecoderConfigurationRecord with 4-byte NAL lengths. */
export function isAvcC(record: Uint8Array): boolean {
  return record.length >= 7 && record[0] === 1 && (record[4]! & 0x03) === 3;
}

/**
 * Turns `/v1/host/screen` answers into serve-sim envelopes for one subscriber: the avcC
 * description goes out before the first key frame and again whenever it changes (a new encoder
 * session: size, orientation); deltas before the first key frame are dropped, as the panel's
 * decoder would.
 */
export class HostScreenToAvcc {
  private description: Buffer | null = null;
  private keyed = false;

  /** Envelopes for one answer (none for `unchanged`, `dropped`, errors and unusable frames). */
  convert(reply: HostScreenReply): Buffer[] {
    const { header, payload } = reply;
    if (header.status !== "frame" || payload.length === 0) return [];
    if (!isLengthPrefixedAccessUnit(payload)) return [];
    const out: Buffer[] = [];
    if (header.key) {
      if (!header.record || !isAvcC(header.record)) return [];
      if (!this.description || !this.description.equals(header.record)) {
        this.description = Buffer.from(header.record);
        out.push(avccEnvelope(AVCC_TAG.description, this.description));
      }
      this.keyed = true;
      out.push(avccEnvelope(AVCC_TAG.keyframe, payload));
      return out;
    }
    if (!this.keyed) return [];
    out.push(avccEnvelope(AVCC_TAG.delta, payload));
    return out;
  }

  /** The next frame must be a key frame (after an encoder error, or a skipped frame). */
  resetKey(): void {
    this.keyed = false;
  }
}

/** The `multipart/x-mixed-replace` boundary the bridge's `stream.mjpeg` uses. */
export const MJPEG_BOUNDARY = "frame";

/** One `stream.mjpeg` part, as serve-sim writes it. */
export function mjpegPart(jpeg: Uint8Array): Buffer {
  const head = Buffer.from(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`, "latin1");
  return Buffer.concat([head, jpeg, Buffer.from("\r\n", "latin1")]);
}
