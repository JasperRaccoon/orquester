// DAMAGE extension (1.1) subset, and the XFIXES QueryVersion it needs first: the automation engine
// follows every change to the screen through a RawRectangles damage on the root (spec 2026-11-10
// §2.2–§2.3).

import { extensionRequest } from "./protocol.ts";

export const DAMAGE_EXTENSION_NAME = "DAMAGE";
export const XFIXES_EXTENSION_NAME = "XFIXES";

const XFIXES_QUERY_VERSION = 0;
const DAMAGE_QUERY_VERSION = 0;
const DAMAGE_CREATE = 1;
const DAMAGE_DESTROY = 2;
const DAMAGE_SUBTRACT = 3;

/** DamageNotify is the extension's first event (`firstEvent + 0`). */
export const DAMAGE_NOTIFY = 0;

export const DamageReportLevel = {
  RawRectangles: 0,
  DeltaRectangles: 1,
  BoundingBox: 2,
  NonEmpty: 3
} as const;

function queryVersion(majorOpcode: number, minor: number, clientMajor: number, clientMinor: number): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(clientMajor, 0);
  body.writeUInt32LE(clientMinor, 4);
  return extensionRequest(majorOpcode, minor, body);
}

const decodeVersion = (reply: Buffer): { major: number; minor: number } => ({ major: reply.readUInt32LE(8), minor: reply.readUInt32LE(12) });

/** XFIXES QueryVersion: the server only enables DAMAGE's region handling for a client that has sent it. */
export const encodeXFixesQueryVersion = (majorOpcode: number, clientMajor = 5, clientMinor = 0): Buffer =>
  queryVersion(majorOpcode, XFIXES_QUERY_VERSION, clientMajor, clientMinor);

export const decodeXFixesQueryVersionReply = decodeVersion;

export const encodeDamageQueryVersion = (majorOpcode: number, clientMajor = 1, clientMinor = 1): Buffer =>
  queryVersion(majorOpcode, DAMAGE_QUERY_VERSION, clientMajor, clientMinor);

export const decodeDamageQueryVersionReply = decodeVersion;

export function encodeDamageCreate(majorOpcode: number, damage: number, drawable: number, level: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(damage, 0);
  body.writeUInt32LE(drawable, 4);
  body.writeUInt8(level, 8);
  return extensionRequest(majorOpcode, DAMAGE_CREATE, body);
}

export function encodeDamageDestroy(majorOpcode: number, damage: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(damage, 0);
  return extensionRequest(majorOpcode, DAMAGE_DESTROY, body);
}

/** DamageSubtract; `repair` and `parts` None (0) clear the whole damage region. */
export function encodeDamageSubtract(majorOpcode: number, damage: number, repair = 0, parts = 0): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(damage, 0);
  body.writeUInt32LE(repair, 4);
  body.writeUInt32LE(parts, 8);
  return extensionRequest(majorOpcode, DAMAGE_SUBTRACT, body);
}

export interface DamageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DamageNotify {
  level: number;
  /** More notifications for the same change follow. */
  more: boolean;
  drawable: number;
  damage: number;
  timestamp: number;
  /** The damaged rectangle, relative to the drawable. */
  area: DamageRect;
  /** The drawable's geometry. */
  geometry: DamageRect;
}

const rect = (buf: Buffer, offset: number): DamageRect => ({
  x: buf.readInt16LE(offset),
  y: buf.readInt16LE(offset + 2),
  width: buf.readUInt16LE(offset + 4),
  height: buf.readUInt16LE(offset + 6)
});

/** Decode a DamageNotify (an event whose code is the extension's `firstEvent`). */
export function decodeDamageNotify(event: Buffer): DamageNotify {
  const level = event.readUInt8(1);
  return {
    level: level & 0x7f,
    more: (level & 0x80) !== 0,
    drawable: event.readUInt32LE(4),
    damage: event.readUInt32LE(8),
    timestamp: event.readUInt32LE(12),
    area: rect(event, 16),
    geometry: rect(event, 24)
  };
}
