// Pure encoders and decoders for the small X11 core-protocol subset the window tracker needs
// (spec §6.1). Every function here is byte-in / byte-out so it can be tested against fixtures;
// the socket, sequence numbers and reply matching live in ./connection.ts.
//
// The client always speaks little-endian ('l'), so every multi-byte field is LE, and the server
// answers in the same order.

export const BYTE_ORDER_LSB_FIRST = 0x6c; // 'l'

export const Opcode = {
  ChangeWindowAttributes: 2,
  GetGeometry: 14,
  InternAtom: 16,
  GetProperty: 20,
  SendEvent: 25,
  GetInputFocus: 43,
  QueryExtension: 98
} as const;

export const EventCode = {
  DestroyNotify: 17,
  ConfigureNotify: 22,
  PropertyNotify: 28,
  ClientMessage: 33,
  GenericEvent: 35
} as const;

export const EventMask = {
  StructureNotify: 0x0002_0000,
  SubstructureNotify: 0x0008_0000,
  SubstructureRedirect: 0x0010_0000,
  PropertyChange: 0x0040_0000
} as const;

/** Predefined atoms (X11 protocol appendix B) the tracker uses. */
export const PredefinedAtom = {
  ATOM: 4,
  CARDINAL: 6,
  STRING: 31,
  WINDOW: 33,
  WM_NAME: 39,
  WM_CLASS: 67
} as const;

export const AnyPropertyType = 0;

/** Core error codes worth naming. */
export const ErrorCode = {
  BadWindow: 3,
  BadAtom: 5,
  BadMatch: 8
} as const;

const CW_EVENT_MASK = 0x0800;

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

/** A request buffer: `opcode`, the header data byte, and a body padded to 4 bytes. */
function request(opcode: number, data: number, body: Buffer): Buffer {
  const total = 4 + body.length + pad4(body.length);
  const buf = Buffer.alloc(total);
  buf.writeUInt8(opcode, 0);
  buf.writeUInt8(data, 1);
  buf.writeUInt16LE(total / 4, 2);
  body.copy(buf, 4);
  return buf;
}

/** Like `request` but for extension requests: `major` is the extension opcode, `minor` the header data byte. */
export const extensionRequest = (major: number, minor: number, body: Buffer): Buffer => request(major, minor, body);

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

export interface XAuthData {
  name: string;
  data: Buffer;
}

export function encodeSetupRequest(auth: XAuthData | null): Buffer {
  const name = Buffer.from(auth?.name ?? "", "latin1");
  const data = auth?.data ?? Buffer.alloc(0);
  const buf = Buffer.alloc(12 + name.length + pad4(name.length) + data.length + pad4(data.length));
  buf.writeUInt8(BYTE_ORDER_LSB_FIRST, 0);
  buf.writeUInt16LE(11, 2);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(name.length, 6);
  buf.writeUInt16LE(data.length, 8);
  name.copy(buf, 12);
  data.copy(buf, 12 + name.length + pad4(name.length));
  return buf;
}

export interface ScreenInfo {
  root: number;
  width: number;
  height: number;
}

export interface SetupInfo {
  protocolMajor: number;
  protocolMinor: number;
  resourceIdBase: number;
  resourceIdMask: number;
  maximumRequestLength: number;
  vendor: string;
  screens: ScreenInfo[];
}

export type SetupResponse =
  | { status: "success"; info: SetupInfo }
  | { status: "failed"; reason: string }
  | { status: "authenticate"; reason: string };

/** Total byte length of the setup response, given at least its first 8 bytes. */
export const setupResponseLength = (header: Buffer): number => 8 + header.readUInt16LE(6) * 4;

export function decodeSetupResponse(buf: Buffer): SetupResponse {
  const status = buf.readUInt8(0);
  if (status === 0) {
    const reasonLength = buf.readUInt8(1);
    return { status: "failed", reason: buf.toString("latin1", 8, 8 + reasonLength) };
  }
  if (status === 2) {
    return { status: "authenticate", reason: buf.toString("latin1", 8).replace(/\0+$/, "") };
  }
  if (status !== 1) throw new Error(`X11 setup: unknown status ${status}`);
  const vendorLength = buf.readUInt16LE(24);
  const screenCount = buf.readUInt8(28);
  const formatCount = buf.readUInt8(29);
  let offset = 40 + vendorLength + pad4(vendorLength) + formatCount * 8;
  const screens: ScreenInfo[] = [];
  for (let i = 0; i < screenCount; i++) {
    screens.push({ root: buf.readUInt32LE(offset), width: buf.readUInt16LE(offset + 20), height: buf.readUInt16LE(offset + 22) });
    const depthCount = buf.readUInt8(offset + 39);
    offset += 40;
    for (let d = 0; d < depthCount; d++) {
      const visualCount = buf.readUInt16LE(offset + 2);
      offset += 8 + visualCount * 24;
    }
  }
  return {
    status: "success",
    info: {
      protocolMajor: buf.readUInt16LE(2),
      protocolMinor: buf.readUInt16LE(4),
      resourceIdBase: buf.readUInt32LE(12),
      resourceIdMask: buf.readUInt32LE(16),
      maximumRequestLength: buf.readUInt16LE(26),
      vendor: buf.toString("latin1", 40, 40 + vendorLength),
      screens
    }
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function encodeInternAtom(name: string, onlyIfExists = false): Buffer {
  const bytes = Buffer.from(name, "latin1");
  const body = Buffer.alloc(4 + bytes.length);
  body.writeUInt16LE(bytes.length, 0);
  bytes.copy(body, 4);
  return request(Opcode.InternAtom, onlyIfExists ? 1 : 0, body);
}

export function encodeGetProperty(window: number, property: number, type: number, longOffset: number, longLength: number, del = false): Buffer {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(property, 4);
  body.writeUInt32LE(type, 8);
  body.writeUInt32LE(longOffset, 12);
  body.writeUInt32LE(longLength, 16);
  return request(Opcode.GetProperty, del ? 1 : 0, body);
}

/** ChangeWindowAttributes setting only the event mask. */
export function encodeSelectInput(window: number, eventMask: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(CW_EVENT_MASK, 4);
  body.writeUInt32LE(eventMask >>> 0, 8);
  return request(Opcode.ChangeWindowAttributes, 0, body);
}

export function encodeGetGeometry(drawable: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(drawable, 0);
  return request(Opcode.GetGeometry, 0, body);
}

export const encodeGetInputFocus = (): Buffer => request(Opcode.GetInputFocus, 0, Buffer.alloc(0));

export function encodeQueryExtension(name: string): Buffer {
  const bytes = Buffer.from(name, "latin1");
  const body = Buffer.alloc(4 + bytes.length);
  body.writeUInt16LE(bytes.length, 0);
  bytes.copy(body, 4);
  return request(Opcode.QueryExtension, 0, body);
}

/** A 32-byte ClientMessage event, format 32, carrying up to five 32-bit values. */
export function encodeClientMessage(window: number, type: number, data: readonly number[]): Buffer {
  if (data.length > 5) throw new Error("ClientMessage carries at most five 32-bit values");
  const event = Buffer.alloc(32);
  event.writeUInt8(EventCode.ClientMessage, 0);
  event.writeUInt8(32, 1);
  event.writeUInt32LE(window, 4);
  event.writeUInt32LE(type, 8);
  data.forEach((value, i) => event.writeUInt32LE(value >>> 0, 12 + i * 4));
  return event;
}

export function encodeSendEvent(propagate: boolean, destination: number, eventMask: number, event: Buffer): Buffer {
  if (event.length !== 32) throw new Error("SendEvent needs a 32-byte event");
  const body = Buffer.alloc(40);
  body.writeUInt32LE(destination, 0);
  body.writeUInt32LE(eventMask >>> 0, 4);
  event.copy(body, 8);
  return request(Opcode.SendEvent, propagate ? 1 : 0, body);
}

// ---------------------------------------------------------------------------
// Server messages: framing, replies, errors, events
// ---------------------------------------------------------------------------

/** Byte length of the server message at the start of `buf` (needs ≥ 32 bytes), or null if short. */
export function serverMessageLength(buf: Buffer): number | null {
  if (buf.length < 32) return null;
  const code = buf.readUInt8(0) & 0x7f;
  // Replies and GenericEvents carry an extra length (in 4-byte units) after the 32-byte header.
  if (buf.readUInt8(0) === 1 || code === EventCode.GenericEvent) return 32 + buf.readUInt32LE(4) * 4;
  return 32;
}

export interface XErrorInfo {
  code: number;
  sequence: number;
  badValue: number;
  minorOpcode: number;
  majorOpcode: number;
}

export type XEvent =
  | { type: "PropertyNotify"; sequence: number; sent: boolean; window: number; atom: number; time: number; deleted: boolean }
  | {
      type: "ConfigureNotify";
      sequence: number;
      sent: boolean;
      event: number;
      window: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { type: "DestroyNotify"; sequence: number; sent: boolean; event: number; window: number }
  | { type: "other"; code: number; sequence: number; sent: boolean };

export type ServerMessage =
  | { kind: "reply"; sequence: number; data: Buffer }
  | { kind: "error"; error: XErrorInfo }
  | { kind: "event"; event: XEvent };

export function decodeServerMessage(buf: Buffer): ServerMessage {
  const first = buf.readUInt8(0);
  const sequence = buf.readUInt16LE(2);
  if (first === 0) {
    return {
      kind: "error",
      error: {
        code: buf.readUInt8(1),
        sequence,
        badValue: buf.readUInt32LE(4),
        minorOpcode: buf.readUInt16LE(8),
        majorOpcode: buf.readUInt8(10)
      }
    };
  }
  if (first === 1) return { kind: "reply", sequence, data: buf };
  return { kind: "event", event: decodeEvent(buf) };
}

export function decodeEvent(buf: Buffer): XEvent {
  const code = buf.readUInt8(0) & 0x7f;
  const sent = (buf.readUInt8(0) & 0x80) !== 0;
  const sequence = buf.readUInt16LE(2);
  switch (code) {
    case EventCode.PropertyNotify:
      return {
        type: "PropertyNotify",
        sequence,
        sent,
        window: buf.readUInt32LE(4),
        atom: buf.readUInt32LE(8),
        time: buf.readUInt32LE(12),
        deleted: buf.readUInt8(16) === 1
      };
    case EventCode.ConfigureNotify:
      return {
        type: "ConfigureNotify",
        sequence,
        sent,
        event: buf.readUInt32LE(4),
        window: buf.readUInt32LE(8),
        x: buf.readInt16LE(16),
        y: buf.readInt16LE(18),
        width: buf.readUInt16LE(20),
        height: buf.readUInt16LE(22)
      };
    case EventCode.DestroyNotify:
      return { type: "DestroyNotify", sequence, sent, event: buf.readUInt32LE(4), window: buf.readUInt32LE(8) };
    default:
      return { type: "other", code, sequence, sent };
  }
}

export const decodeInternAtomReply = (reply: Buffer): number => reply.readUInt32LE(8);

export interface GetPropertyReply {
  format: number;
  /** 0 (None) when the property does not exist. */
  type: number;
  bytesAfter: number;
  value: Buffer;
}

export function decodeGetPropertyReply(reply: Buffer): GetPropertyReply {
  const format = reply.readUInt8(1);
  const items = reply.readUInt32LE(16);
  const bytes = format === 0 ? 0 : items * (format / 8);
  return {
    format,
    type: reply.readUInt32LE(8),
    bytesAfter: reply.readUInt32LE(12),
    value: Buffer.from(reply.subarray(32, 32 + bytes))
  };
}

export interface QueryExtensionReply {
  present: boolean;
  majorOpcode: number;
  firstEvent: number;
  firstError: number;
}

export const decodeQueryExtensionReply = (reply: Buffer): QueryExtensionReply => ({
  present: reply.readUInt8(8) === 1,
  majorOpcode: reply.readUInt8(9),
  firstEvent: reply.readUInt8(10),
  firstError: reply.readUInt8(11)
});

export interface GeometryReply {
  root: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const decodeGetGeometryReply = (reply: Buffer): GeometryReply => ({
  root: reply.readUInt32LE(8),
  x: reply.readInt16LE(12),
  y: reply.readInt16LE(14),
  width: reply.readUInt16LE(16),
  height: reply.readUInt16LE(18)
});

// ---------------------------------------------------------------------------
// Property value helpers
// ---------------------------------------------------------------------------

/** Format-32 values (CARDINAL, WINDOW, ATOM lists). */
export function propertyUint32s(value: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= value.length; i += 4) out.push(value.readUInt32LE(i));
  return out;
}

/** NUL-separated format-8 strings (e.g. WM_CLASS); a trailing NUL does not add an empty entry. */
export function propertyStrings(value: Buffer, encoding: "utf8" | "latin1"): string[] {
  const text = value.toString(encoding);
  const parts = text.split("\0");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
