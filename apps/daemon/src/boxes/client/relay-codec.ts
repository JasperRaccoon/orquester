/**
 * The per-box local relay socket (`boxSocketPath(appdir, boxId)`): the same
 * control/data frames as the box link, over a byte stream:
 * `[u32 BE length][u8 0=text|1=binary][length bytes]`.
 *
 * Local-only frames (never sent to a box; not part of box-protocol.ts):
 * - client → daemon, first: {@link RelayHello}; then `relay-cancel` to abort a request.
 * - daemon → client: {@link RelayWelcome} (or {@link RelayReject} and close),
 *   then {@link RelayStatus} whenever the box connects or drops.
 *
 * Everything else is box-protocol traffic. The client opens EVEN channel ids
 * on its own socket; the daemon remaps them onto the box link. Box events
 * are broadcast to every client. Box → host requests and box-opened channels
 * are served by the daemon, never relayed.
 *
 * Authentication is the socket's place in the filesystem: the directory is
 * 0700 and the socket 0600, owned by the daemon user. The hello names the box
 * so a client cannot end up on the wrong one.
 */

import type { BoxDetachedProcInfo, BoxPathMap, BoxSysInfo } from "@orquester/api";

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_FRAME_TEXT = 0;
export const RELAY_FRAME_BINARY = 1;
/** Largest relay frame accepted (a control frame can carry a big `req`). */
export const RELAY_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface RelayHello {
  t: "relay-hello";
  protocol: number;
  boxId: string;
}

export interface RelayBoxState {
  boxId: string;
  connected: boolean;
  sys: BoxSysInfo;
  paths: BoxPathMap;
  agentVersion: string;
  procs: BoxDetachedProcInfo[];
}

export type RelayWelcome = { t: "relay-welcome" } & RelayBoxState;
export type RelayStatus = { t: "relay-status" } & RelayBoxState;

export interface RelayReject {
  t: "relay-reject";
  message: string;
}

export interface RelayCancel {
  t: "relay-cancel";
  id: number;
}

export type RelayLocalMessage = RelayHello | RelayWelcome | RelayStatus | RelayReject | RelayCancel;

export function encodeRelayFrame(kind: typeof RELAY_FRAME_TEXT | typeof RELAY_FRAME_BINARY, payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.writeUInt8(kind, 4);
  frame.set(payload, 5);
  return frame;
}

export function encodeRelayText(text: string): Buffer {
  return encodeRelayFrame(RELAY_FRAME_TEXT, Buffer.from(text, "utf8"));
}

export type RelayFrame = { kind: "text"; text: string } | { kind: "binary"; data: Uint8Array };

/** Incremental decoder; throws on a malformed stream (the peer is then dropped). */
export class RelayFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RelayFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: RelayFrame[] = [];
    while (this.buffer.byteLength >= 5) {
      const length = this.buffer.readUInt32BE(0);
      if (length > RELAY_MAX_FRAME_BYTES) throw new Error(`Relay frame of ${length} bytes exceeds the limit`);
      const kind = this.buffer.readUInt8(4);
      if (kind !== RELAY_FRAME_TEXT && kind !== RELAY_FRAME_BINARY) throw new Error(`Bad relay frame kind ${kind}`);
      if (this.buffer.byteLength < 5 + length) break;
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      frames.push(kind === RELAY_FRAME_TEXT ? { kind: "text", text: payload.toString("utf8") } : { kind: "binary", data: Buffer.from(payload) });
    }
    return frames;
  }
}

export function parseRelayJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { t?: unknown }).t === "string"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
