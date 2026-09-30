// X-Resource extension (XRes 1.2) subset: QueryVersion and QueryClientIds, which gives the pid of the
// client that owns a window even when the app does not set `_NET_WM_PID` (spec §6.1).

import { extensionRequest } from "./protocol.ts";

export const XRES_EXTENSION_NAME = "X-Resource";

const XRES_QUERY_VERSION = 0;
const XRES_QUERY_CLIENT_IDS = 4;

/** `XRES_CLIENT_ID_XID_MASK` / `XRES_CLIENT_ID_PID_MASK`. */
export const XResClientIdMask = {
  ClientXid: 1,
  LocalClientPid: 2
} as const;

export function encodeXResQueryVersion(majorOpcode: number, clientMajor = 1, clientMinor = 2): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt8(clientMajor, 0);
  body.writeUInt8(clientMinor, 1);
  return extensionRequest(majorOpcode, XRES_QUERY_VERSION, body);
}

export const decodeXResQueryVersionReply = (reply: Buffer): { major: number; minor: number } => ({
  major: reply.readUInt16LE(8),
  minor: reply.readUInt16LE(10)
});

export interface XResClientIdSpec {
  /** Any XID owned by the client (for example a window), or 0 for every client. */
  client: number;
  mask: number;
}

export function encodeXResQueryClientIds(majorOpcode: number, specs: readonly XResClientIdSpec[]): Buffer {
  const body = Buffer.alloc(4 + specs.length * 8);
  body.writeUInt32LE(specs.length, 0);
  specs.forEach((spec, i) => {
    body.writeUInt32LE(spec.client, 4 + i * 8);
    body.writeUInt32LE(spec.mask, 8 + i * 8);
  });
  return extensionRequest(majorOpcode, XRES_QUERY_CLIENT_IDS, body);
}

export interface XResClientIdValue {
  spec: XResClientIdSpec;
  values: number[];
}

export function decodeXResQueryClientIdsReply(reply: Buffer): XResClientIdValue[] {
  const count = reply.readUInt32LE(8);
  const ids: XResClientIdValue[] = [];
  let offset = 32;
  for (let i = 0; i < count; i++) {
    if (offset + 12 > reply.length) throw new Error("XResQueryClientIds reply is truncated");
    const spec = { client: reply.readUInt32LE(offset), mask: reply.readUInt32LE(offset + 4) };
    const length = reply.readUInt32LE(offset + 8);
    offset += 12;
    if (offset + length > reply.length) throw new Error("XResQueryClientIds reply is truncated");
    const values: number[] = [];
    for (let v = 0; v + 4 <= length; v += 4) values.push(reply.readUInt32LE(offset + v));
    ids.push({ spec, values });
    offset += length;
  }
  return ids;
}

/** The pid from a QueryClientIds reply for a `LocalClientPid` spec, or null when the server does not know it. */
export function pidFromClientIds(ids: readonly XResClientIdValue[]): number | null {
  for (const id of ids) {
    if ((id.spec.mask & XResClientIdMask.LocalClientPid) !== 0 && id.values.length > 0 && id.values[0]! > 0) return id.values[0]!;
  }
  return null;
}
