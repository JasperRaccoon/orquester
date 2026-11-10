// XTEST extension (2.2) subset: GetVersion and FakeInput, the automation engine's only way to
// press keys and buttons and move the pointer (spec 2026-11-10 §2.2).

import { extensionRequest } from "./protocol.ts";

export const XTEST_EXTENSION_NAME = "XTEST";

const XTEST_GET_VERSION = 0;
const XTEST_FAKE_INPUT = 2;

/** FakeInput event types (the core event codes). */
export const FakeEventType = {
  KeyPress: 2,
  KeyRelease: 3,
  ButtonPress: 4,
  ButtonRelease: 5,
  MotionNotify: 6
} as const;

export function encodeXTestGetVersion(majorOpcode: number, clientMajor = 2, clientMinor = 2): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt8(clientMajor, 0);
  body.writeUInt16LE(clientMinor, 2);
  return extensionRequest(majorOpcode, XTEST_GET_VERSION, body);
}

export const decodeXTestGetVersionReply = (reply: Buffer): { major: number; minor: number } => ({
  major: reply.readUInt8(1),
  minor: reply.readUInt16LE(8)
});

export interface FakeInput {
  type: (typeof FakeEventType)[keyof typeof FakeEventType];
  /** The keycode or button; for MotionNotify 0 (absolute) or 1 (relative). */
  detail: number;
  /** MotionNotify: the root window (0: the pointer's screen) and position. */
  root?: number;
  x?: number;
  y?: number;
}

/** FakeInput on the core devices, with no delay (time CurrentTime). */
export function encodeXTestFakeInput(majorOpcode: number, input: FakeInput): Buffer {
  const body = Buffer.alloc(32);
  body.writeUInt8(input.type, 0);
  body.writeUInt8(input.detail, 1);
  body.writeUInt32LE(0, 4); // time: CurrentTime
  body.writeUInt32LE(input.root ?? 0, 8);
  body.writeInt16LE(input.x ?? 0, 20);
  body.writeInt16LE(input.y ?? 0, 22);
  // deviceid (byte 31) 0: the core devices.
  return extensionRequest(majorOpcode, XTEST_FAKE_INPUT, body);
}
