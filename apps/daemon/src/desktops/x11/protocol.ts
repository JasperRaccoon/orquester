// Pure encoders and decoders for the small X11 core-protocol subset the window tracker (spec
// 2026-09-30 §6.1) and the automation engine (spec 2026-11-10 §2.2) need. Every function here is
// byte-in / byte-out so it can be tested against fixtures; the socket, sequence numbers and reply
// matching live in ./connection.ts.
//
// The client always speaks little-endian ('l'), so every multi-byte field is LE, and the server
// answers in the same order. Image data is the exception: its byte order is the server's own
// (`SetupInfo.imageByteOrder`), whatever the client speaks.

export const BYTE_ORDER_LSB_FIRST = 0x6c; // 'l'

export const Opcode = {
  CreateWindow: 1,
  ChangeWindowAttributes: 2,
  GetGeometry: 14,
  InternAtom: 16,
  ChangeProperty: 18,
  DeleteProperty: 19,
  GetProperty: 20,
  SetSelectionOwner: 22,
  GetSelectionOwner: 23,
  ConvertSelection: 24,
  SendEvent: 25,
  QueryPointer: 38,
  TranslateCoordinates: 40,
  GetInputFocus: 43,
  GetImage: 73,
  QueryExtension: 98,
  ChangeKeyboardMapping: 100,
  GetKeyboardMapping: 101,
  GetModifierMapping: 119
} as const;

export const EventCode = {
  KeyPress: 2,
  KeyRelease: 3,
  ButtonPress: 4,
  ButtonRelease: 5,
  DestroyNotify: 17,
  ConfigureNotify: 22,
  PropertyNotify: 28,
  SelectionClear: 29,
  SelectionRequest: 30,
  SelectionNotify: 31,
  ClientMessage: 33,
  MappingNotify: 34,
  GenericEvent: 35
} as const;

export const EventMask = {
  KeyPress: 0x0000_0001,
  KeyRelease: 0x0000_0002,
  ButtonPress: 0x0000_0004,
  ButtonRelease: 0x0000_0008,
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
/** `None` for windows, atoms and other resources. */
export const None = 0;
/** `CurrentTime` for requests that take a timestamp. */
export const CurrentTime = 0;

export const WindowClass = {
  CopyFromParent: 0,
  InputOutput: 1,
  InputOnly: 2
} as const;

export const PropertyMode = {
  Replace: 0,
  Prepend: 1,
  Append: 2
} as const;

export const ImageFormat = {
  XYPixmap: 1,
  ZPixmap: 2
} as const;

/** MappingNotify `request`. */
export const MappingRequest = {
  Modifier: 0,
  Keyboard: 1,
  Pointer: 2
} as const;

const CW_BACK_PIXEL = 0x0002;
const CW_OVERRIDE_REDIRECT = 0x0200;
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

/** A visual's colour masks (TrueColor / DirectColor pixels hold red, green and blue at these bits). */
export interface VisualInfo {
  id: number;
  /** 4 TrueColor, 5 DirectColor; 0–3 are colormapped. */
  class: number;
  bitsPerRgb: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
}

export interface ScreenInfo {
  root: number;
  width: number;
  height: number;
  rootDepth: number;
  /** The root window's visual, or null when the setup does not list it under the root depth. */
  rootVisual: VisualInfo | null;
}

export interface PixmapFormat {
  depth: number;
  bitsPerPixel: number;
  scanlinePad: number;
}

export interface SetupInfo {
  protocolMajor: number;
  protocolMinor: number;
  resourceIdBase: number;
  resourceIdMask: number;
  /** In 4-byte units. */
  maximumRequestLength: number;
  /** The byte order of image data (GetImage replies), independent of the connection's. */
  imageByteOrder: "lsb" | "msb";
  minKeycode: number;
  maxKeycode: number;
  pixmapFormats: PixmapFormat[];
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
  let offset = 40 + vendorLength + pad4(vendorLength);
  const pixmapFormats: PixmapFormat[] = [];
  for (let i = 0; i < formatCount; i++, offset += 8) {
    pixmapFormats.push({ depth: buf.readUInt8(offset), bitsPerPixel: buf.readUInt8(offset + 1), scanlinePad: buf.readUInt8(offset + 2) });
  }
  const screens: ScreenInfo[] = [];
  for (let i = 0; i < screenCount; i++) {
    const root = buf.readUInt32LE(offset);
    const width = buf.readUInt16LE(offset + 20);
    const height = buf.readUInt16LE(offset + 22);
    const rootVisualId = buf.readUInt32LE(offset + 32);
    const rootDepth = buf.readUInt8(offset + 38);
    const depthCount = buf.readUInt8(offset + 39);
    let rootVisual: VisualInfo | null = null;
    offset += 40;
    for (let d = 0; d < depthCount; d++) {
      const depth = buf.readUInt8(offset);
      const visualCount = buf.readUInt16LE(offset + 2);
      offset += 8;
      for (let v = 0; v < visualCount; v++, offset += 24) {
        if (depth !== rootDepth || buf.readUInt32LE(offset) !== rootVisualId) continue;
        rootVisual = {
          id: rootVisualId,
          class: buf.readUInt8(offset + 4),
          bitsPerRgb: buf.readUInt8(offset + 5),
          redMask: buf.readUInt32LE(offset + 8),
          greenMask: buf.readUInt32LE(offset + 12),
          blueMask: buf.readUInt32LE(offset + 16)
        };
      }
    }
    screens.push({ root, width, height, rootDepth, rootVisual });
  }
  return {
    status: "success",
    info: {
      protocolMajor: buf.readUInt16LE(2),
      protocolMinor: buf.readUInt16LE(4),
      resourceIdBase: buf.readUInt32LE(12),
      resourceIdMask: buf.readUInt32LE(16),
      maximumRequestLength: buf.readUInt16LE(26),
      imageByteOrder: buf.readUInt8(30) === 0 ? "lsb" : "msb",
      minKeycode: buf.readUInt8(34),
      maxKeycode: buf.readUInt8(35),
      pixmapFormats,
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

export interface CreateWindowValues {
  /** InputOutput windows only. */
  backgroundPixel?: number;
  overrideRedirect?: boolean;
  eventMask?: number;
}

/**
 * CreateWindow with the parent's depth and visual and no border (an InputOnly window needs exactly
 * that). Only the attributes in `values` are set.
 */
export function encodeCreateWindow(
  wid: number,
  parent: number,
  rect: { x: number; y: number; width: number; height: number },
  windowClass: number,
  values: CreateWindowValues = {}
): Buffer {
  const list: number[] = [];
  let mask = 0;
  // The value list is in mask-bit order.
  if (values.backgroundPixel !== undefined) {
    mask |= CW_BACK_PIXEL;
    list.push(values.backgroundPixel);
  }
  if (values.overrideRedirect !== undefined) {
    mask |= CW_OVERRIDE_REDIRECT;
    list.push(values.overrideRedirect ? 1 : 0);
  }
  if (values.eventMask !== undefined) {
    mask |= CW_EVENT_MASK;
    list.push(values.eventMask);
  }
  const body = Buffer.alloc(28 + list.length * 4);
  body.writeUInt32LE(wid, 0);
  body.writeUInt32LE(parent, 4);
  body.writeInt16LE(rect.x, 8);
  body.writeInt16LE(rect.y, 10);
  body.writeUInt16LE(rect.width, 12);
  body.writeUInt16LE(rect.height, 14);
  body.writeUInt16LE(0, 16); // border-width
  body.writeUInt16LE(windowClass, 18);
  body.writeUInt32LE(0, 20); // visual: CopyFromParent
  body.writeUInt32LE(mask, 24);
  list.forEach((value, i) => body.writeUInt32LE(value >>> 0, 28 + i * 4));
  return request(Opcode.CreateWindow, 0, body);
}

/** ChangeProperty; `data` holds `data.length / (format / 8)` items. */
export function encodeChangeProperty(mode: number, window: number, property: number, type: number, format: 8 | 16 | 32, data: Buffer): Buffer {
  const unit = format / 8;
  if (data.length % unit !== 0) throw new Error(`ChangeProperty: ${data.length} bytes is not a whole number of format-${format} items`);
  const body = Buffer.alloc(20 + data.length);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(property, 4);
  body.writeUInt32LE(type, 8);
  body.writeUInt8(format, 12);
  body.writeUInt32LE(data.length / unit, 16);
  data.copy(body, 20);
  return request(Opcode.ChangeProperty, mode, body);
}

export function encodeDeleteProperty(window: number, property: number): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(property, 4);
  return request(Opcode.DeleteProperty, 0, body);
}

export function encodeSetSelectionOwner(owner: number, selection: number, time: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(owner, 0);
  body.writeUInt32LE(selection, 4);
  body.writeUInt32LE(time >>> 0, 8);
  return request(Opcode.SetSelectionOwner, 0, body);
}

export function encodeGetSelectionOwner(selection: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(selection, 0);
  return request(Opcode.GetSelectionOwner, 0, body);
}

export function encodeConvertSelection(requestor: number, selection: number, target: number, property: number, time: number): Buffer {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(requestor, 0);
  body.writeUInt32LE(selection, 4);
  body.writeUInt32LE(target, 8);
  body.writeUInt32LE(property, 12);
  body.writeUInt32LE(time >>> 0, 16);
  return request(Opcode.ConvertSelection, 0, body);
}

/** A 32-byte SelectionNotify event (sent with SendEvent to answer a SelectionRequest); `property` None refuses it. */
export function encodeSelectionNotify(time: number, requestor: number, selection: number, target: number, property: number): Buffer {
  const event = Buffer.alloc(32);
  event.writeUInt8(EventCode.SelectionNotify, 0);
  event.writeUInt32LE(time >>> 0, 4);
  event.writeUInt32LE(requestor, 8);
  event.writeUInt32LE(selection, 12);
  event.writeUInt32LE(target, 16);
  event.writeUInt32LE(property, 20);
  return event;
}

export function encodeQueryPointer(window: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(window, 0);
  return request(Opcode.QueryPointer, 0, body);
}

export function encodeTranslateCoordinates(source: number, destination: number, x: number, y: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(source, 0);
  body.writeUInt32LE(destination, 4);
  body.writeInt16LE(x, 8);
  body.writeInt16LE(y, 10);
  return request(Opcode.TranslateCoordinates, 0, body);
}

export function encodeGetImage(format: number, drawable: number, rect: { x: number; y: number; width: number; height: number }, planeMask = 0xffff_ffff): Buffer {
  const body = Buffer.alloc(16);
  body.writeUInt32LE(drawable, 0);
  body.writeInt16LE(rect.x, 4);
  body.writeInt16LE(rect.y, 6);
  body.writeUInt16LE(rect.width, 8);
  body.writeUInt16LE(rect.height, 10);
  body.writeUInt32LE(planeMask >>> 0, 12);
  return request(Opcode.GetImage, format, body);
}

export function encodeGetKeyboardMapping(firstKeycode: number, count: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt8(firstKeycode, 0);
  body.writeUInt8(count, 1);
  return request(Opcode.GetKeyboardMapping, 0, body);
}

/** ChangeKeyboardMapping for `keysyms.length / keysymsPerKeycode` keycodes from `firstKeycode` (0 is NoSymbol). */
export function encodeChangeKeyboardMapping(firstKeycode: number, keysymsPerKeycode: number, keysyms: readonly number[]): Buffer {
  if (keysymsPerKeycode < 1 || keysyms.length % keysymsPerKeycode !== 0) throw new Error("ChangeKeyboardMapping: keysyms do not fill whole keycodes");
  const body = Buffer.alloc(4 + keysyms.length * 4);
  body.writeUInt8(firstKeycode, 0);
  body.writeUInt8(keysymsPerKeycode, 1);
  keysyms.forEach((keysym, i) => body.writeUInt32LE(keysym >>> 0, 4 + i * 4));
  return request(Opcode.ChangeKeyboardMapping, keysyms.length / keysymsPerKeycode, body);
}

export const encodeGetModifierMapping = (): Buffer => request(Opcode.GetModifierMapping, 0, Buffer.alloc(0));

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
  | {
      type: "KeyPress" | "KeyRelease" | "ButtonPress" | "ButtonRelease";
      sequence: number;
      sent: boolean;
      /** The keycode or button. */
      detail: number;
      time: number;
      root: number;
      event: number;
      child: number;
      rootX: number;
      rootY: number;
      eventX: number;
      eventY: number;
      /** Modifier and button state before the event. */
      state: number;
    }
  | { type: "SelectionClear"; sequence: number; sent: boolean; time: number; owner: number; selection: number }
  | {
      type: "SelectionRequest";
      sequence: number;
      sent: boolean;
      time: number;
      owner: number;
      requestor: number;
      selection: number;
      target: number;
      /** None from obsolete clients (the target is the property then). */
      property: number;
    }
  | { type: "SelectionNotify"; sequence: number; sent: boolean; time: number; requestor: number; selection: number; target: number; property: number }
  | { type: "MappingNotify"; sequence: number; sent: boolean; request: number; firstKeycode: number; count: number }
  /** Anything else, extension events included: `data` is the whole event for an extension's decoder. */
  | { type: "other"; code: number; sequence: number; sent: boolean; data: Buffer };

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
    case EventCode.KeyPress:
    case EventCode.KeyRelease:
    case EventCode.ButtonPress:
    case EventCode.ButtonRelease:
      return {
        type: code === EventCode.KeyPress ? "KeyPress" : code === EventCode.KeyRelease ? "KeyRelease" : code === EventCode.ButtonPress ? "ButtonPress" : "ButtonRelease",
        sequence,
        sent,
        detail: buf.readUInt8(1),
        time: buf.readUInt32LE(4),
        root: buf.readUInt32LE(8),
        event: buf.readUInt32LE(12),
        child: buf.readUInt32LE(16),
        rootX: buf.readInt16LE(20),
        rootY: buf.readInt16LE(22),
        eventX: buf.readInt16LE(24),
        eventY: buf.readInt16LE(26),
        state: buf.readUInt16LE(28)
      };
    case EventCode.SelectionClear:
      return { type: "SelectionClear", sequence, sent, time: buf.readUInt32LE(4), owner: buf.readUInt32LE(8), selection: buf.readUInt32LE(12) };
    case EventCode.SelectionRequest:
      return {
        type: "SelectionRequest",
        sequence,
        sent,
        time: buf.readUInt32LE(4),
        owner: buf.readUInt32LE(8),
        requestor: buf.readUInt32LE(12),
        selection: buf.readUInt32LE(16),
        target: buf.readUInt32LE(20),
        property: buf.readUInt32LE(24)
      };
    case EventCode.SelectionNotify:
      return {
        type: "SelectionNotify",
        sequence,
        sent,
        time: buf.readUInt32LE(4),
        requestor: buf.readUInt32LE(8),
        selection: buf.readUInt32LE(12),
        target: buf.readUInt32LE(16),
        property: buf.readUInt32LE(20)
      };
    case EventCode.MappingNotify:
      return { type: "MappingNotify", sequence, sent, request: buf.readUInt8(4), firstKeycode: buf.readUInt8(5), count: buf.readUInt8(6) };
    default:
      // A copy: the event may be a view into a much larger read.
      return { type: "other", code, sequence, sent, data: Buffer.from(buf) };
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

export const decodeGetSelectionOwnerReply = (reply: Buffer): number => reply.readUInt32LE(8);

export interface QueryPointerReply {
  sameScreen: boolean;
  root: number;
  child: number;
  rootX: number;
  rootY: number;
  winX: number;
  winY: number;
  mask: number;
}

export const decodeQueryPointerReply = (reply: Buffer): QueryPointerReply => ({
  sameScreen: reply.readUInt8(1) === 1,
  root: reply.readUInt32LE(8),
  child: reply.readUInt32LE(12),
  rootX: reply.readInt16LE(16),
  rootY: reply.readInt16LE(18),
  winX: reply.readInt16LE(20),
  winY: reply.readInt16LE(22),
  mask: reply.readUInt16LE(24)
});

export interface TranslateCoordinatesReply {
  sameScreen: boolean;
  child: number;
  x: number;
  y: number;
}

export const decodeTranslateCoordinatesReply = (reply: Buffer): TranslateCoordinatesReply => ({
  sameScreen: reply.readUInt8(1) === 1,
  child: reply.readUInt32LE(8),
  x: reply.readInt16LE(12),
  y: reply.readInt16LE(14)
});

export interface GetImageReply {
  depth: number;
  visual: number;
  /** The image bytes (a view into the reply, not a copy). */
  data: Buffer;
}

export const decodeGetImageReply = (reply: Buffer): GetImageReply => ({
  depth: reply.readUInt8(1),
  visual: reply.readUInt32LE(8),
  data: reply.subarray(32, 32 + reply.readUInt32LE(4) * 4)
});

export interface KeyboardMapping {
  keysymsPerKeycode: number;
  /** `keysymsPerKeycode` keysyms per keycode, from the requested first keycode on; 0 is NoSymbol. */
  keysyms: Uint32Array;
}

export function decodeGetKeyboardMappingReply(reply: Buffer): KeyboardMapping {
  const count = reply.readUInt32LE(4);
  const keysyms = new Uint32Array(count);
  for (let i = 0; i < count; i++) keysyms[i] = reply.readUInt32LE(32 + i * 4);
  return { keysymsPerKeycode: reply.readUInt8(1), keysyms };
}

/** The eight modifier rows (Shift, Lock, Control, Mod1…Mod5), each the keycodes that set it (0 entries dropped). */
export function decodeGetModifierMappingReply(reply: Buffer): number[][] {
  const perModifier = reply.readUInt8(1);
  const rows: number[][] = [];
  for (let modifier = 0; modifier < 8; modifier++) {
    const row: number[] = [];
    for (let i = 0; i < perModifier; i++) {
      const keycode = reply.readUInt8(32 + modifier * perModifier + i);
      if (keycode !== 0) row.push(keycode);
    }
    rows.push(row);
  }
  return rows;
}

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
