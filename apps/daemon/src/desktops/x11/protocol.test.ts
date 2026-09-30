import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decodeGetGeometryReply,
  decodeGetPropertyReply,
  decodeInternAtomReply,
  decodeQueryExtensionReply,
  decodeServerMessage,
  decodeSetupResponse,
  encodeClientMessage,
  encodeGetGeometry,
  encodeGetProperty,
  encodeInternAtom,
  encodeQueryExtension,
  encodeSelectInput,
  encodeSendEvent,
  encodeSetupRequest,
  EventMask,
  propertyStrings,
  propertyUint32s,
  serverMessageLength,
  setupResponseLength
} from "./protocol.ts";
import {
  decodeXResQueryClientIdsReply,
  decodeXResQueryVersionReply,
  encodeXResQueryClientIds,
  encodeXResQueryVersion,
  pidFromClientIds,
  XResClientIdMask
} from "./xres.ts";

const hex = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ""), "hex");

/** A 32-byte-header reply: bytes 8…31 from `fields`, then `extra` (length in 4-byte units at 4). */
function replyFixture(sequence: number, byte1: number, fields: Buffer, extra: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.alloc(32 + extra.length);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(byte1, 1);
  buf.writeUInt16LE(sequence & 0xffff, 2);
  buf.writeUInt32LE(extra.length / 4, 4);
  fields.copy(buf, 8);
  extra.copy(buf, 32);
  return buf;
}

describe("x11 request encoding", () => {
  test("setup request carries the byte order, version 11.0 and padded auth", () => {
    const cookie = hex("00112233445566778899aabbccddeeff");
    assert.deepEqual(
      encodeSetupRequest({ name: "MIT-MAGIC-COOKIE-1", data: cookie }),
      hex(`6c00 0b00 0000 1200 1000 0000
           4d49542d4d414749432d434f4f4b49452d31 0000
           00112233445566778899aabbccddeeff`)
    );
    assert.deepEqual(encodeSetupRequest(null), hex("6c00 0b00 0000 0000 0000 0000"));
  });

  test("InternAtom pads the name and sets only-if-exists", () => {
    assert.deepEqual(encodeInternAtom("WM_NAME"), hex("10 00 0400 0700 0000 574d5f4e414d45 00"));
    assert.equal(encodeInternAtom("WM_NAME", true)[1], 1);
    // A name that is already a multiple of four needs no padding.
    assert.deepEqual(encodeInternAtom("ABCD"), hex("10 00 0300 0400 0000 41424344"));
  });

  test("GetProperty", () => {
    assert.deepEqual(
      encodeGetProperty(0x100, 0x27, 0, 0, 0x4000),
      hex("14 00 0600 00010000 27000000 00000000 00000000 00400000")
    );
  });

  test("ChangeWindowAttributes sets only the event mask", () => {
    assert.deepEqual(
      encodeSelectInput(0x200, EventMask.PropertyChange | EventMask.StructureNotify),
      hex("02 00 0400 00020000 00080000 00004200")
    );
  });

  test("GetGeometry and QueryExtension", () => {
    assert.deepEqual(encodeGetGeometry(0x1e5), hex("0e 00 0200 e5010000"));
    assert.deepEqual(encodeQueryExtension("X-Resource"), hex("62 00 0500 0a00 0000 582d5265736f75726365 0000"));
  });

  test("SendEvent wraps a format-32 ClientMessage", () => {
    const message = encodeClientMessage(0x400001, 0x123, [2, 0, 0x400002]);
    assert.deepEqual(message, hex("21 20 0000 01004000 23010000 02000000 00000000 02004000 00000000 00000000"));
    assert.deepEqual(
      encodeSendEvent(false, 0x1e5, EventMask.SubstructureRedirect | EventMask.SubstructureNotify, message),
      Buffer.concat([hex("19 00 0b00 e5010000 00001800"), message])
    );
    assert.throws(() => encodeClientMessage(1, 1, [1, 2, 3, 4, 5, 6]));
    assert.throws(() => encodeSendEvent(false, 1, 0, Buffer.alloc(31)));
  });

  test("X-Resource QueryVersion and QueryClientIds with the pid mask", () => {
    assert.deepEqual(encodeXResQueryVersion(140), hex("8c 00 0200 01 02 0000"));
    assert.deepEqual(
      encodeXResQueryClientIds(140, [{ client: 0x400001, mask: XResClientIdMask.LocalClientPid }]),
      hex("8c 04 0400 01000000 01004000 02000000")
    );
  });
});

/** Setup success: vendor "Test", one pixmap format, two screens (the first with one depth and one visual). */
function setupSuccessFixture(): Buffer {
  const vendor = Buffer.from("Test");
  const format = hex("18 20 20 00 00000000");
  const screen = (root: number, width: number, height: number, depths: Buffer[]): Buffer => {
    const head = Buffer.alloc(40);
    head.writeUInt32LE(root, 0);
    head.writeUInt16LE(width, 20);
    head.writeUInt16LE(height, 22);
    head.writeUInt8(24, 38);
    head.writeUInt8(depths.length, 39);
    return Buffer.concat([head, ...depths]);
  };
  const depth = Buffer.concat([hex("18 00 0100 00000000"), Buffer.alloc(24, 0xaa)]);
  const body = Buffer.concat([
    (() => {
      const fixed = Buffer.alloc(32);
      fixed.writeUInt32LE(12_013_000, 0); // release
      fixed.writeUInt32LE(0x0040_0000, 4); // resource-id-base
      fixed.writeUInt32LE(0x001f_ffff, 8); // resource-id-mask
      fixed.writeUInt16LE(vendor.length, 16);
      fixed.writeUInt16LE(0xffff, 18);
      fixed.writeUInt8(2, 20); // screens
      fixed.writeUInt8(1, 21); // formats
      return fixed;
    })(),
    vendor,
    format,
    screen(0x1e5, 1024, 768, [depth]),
    screen(0x2e5, 640, 480, [])
  ]);
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(body.length / 4, 6);
  return Buffer.concat([head, body]);
}

describe("x11 setup response decoding", () => {
  test("success: ids, vendor and every screen's root and size", () => {
    const buf = setupSuccessFixture();
    assert.equal(setupResponseLength(buf.subarray(0, 8)), buf.length);
    assert.deepEqual(decodeSetupResponse(buf), {
      status: "success",
      info: {
        protocolMajor: 11,
        protocolMinor: 0,
        resourceIdBase: 0x400000,
        resourceIdMask: 0x1fffff,
        maximumRequestLength: 0xffff,
        vendor: "Test",
        screens: [
          { root: 0x1e5, width: 1024, height: 768 },
          { root: 0x2e5, width: 640, height: 480 }
        ]
      }
    });
  });

  test("failure carries the server's reason", () => {
    const buf = hex("00 1d 0b00 0000 0800");
    const reason = Buffer.from("Authorization required, but n");
    const full = Buffer.concat([buf, reason, Buffer.alloc(3)]);
    full.writeUInt16LE((reason.length + 3) / 4, 6);
    assert.equal(setupResponseLength(full), full.length);
    assert.deepEqual(decodeSetupResponse(full), { status: "failed", reason: "Authorization required, but n" });
  });

  test("authenticate", () => {
    const full = Buffer.concat([hex("02 0000000000 0200"), Buffer.from("more\0\0\0\0")]);
    assert.deepEqual(decodeSetupResponse(full), { status: "authenticate", reason: "more" });
  });
});

describe("x11 server message decoding", () => {
  test("framing: events and errors are 32 bytes, replies and generic events carry a length", () => {
    assert.equal(serverMessageLength(Buffer.alloc(31)), null);
    assert.equal(serverMessageLength(Buffer.alloc(32)), 32);
    assert.equal(serverMessageLength(replyFixture(1, 0, Buffer.alloc(24), Buffer.alloc(12))), 44);
    const generic = Buffer.alloc(32);
    generic.writeUInt8(35, 0);
    generic.writeUInt32LE(2, 4);
    assert.equal(serverMessageLength(generic), 40);
  });

  test("error", () => {
    const buf = hex("00 03 0700 01004000 0000 14 00");
    const full = Buffer.concat([buf, Buffer.alloc(20)]);
    assert.deepEqual(decodeServerMessage(full), {
      kind: "error",
      error: { code: 3, sequence: 7, badValue: 0x400001, minorOpcode: 0, majorOpcode: 20 }
    });
  });

  test("PropertyNotify, including one delivered by SendEvent", () => {
    const buf = Buffer.concat([hex("1c 00 0900 e5010000 60010000 78563412 01"), Buffer.alloc(15)]);
    assert.deepEqual(decodeServerMessage(buf), {
      kind: "event",
      event: { type: "PropertyNotify", sequence: 9, sent: false, window: 0x1e5, atom: 0x160, time: 0x12345678, deleted: true }
    });
    buf[0] = 0x80 | 28;
    const decoded = decodeServerMessage(buf);
    assert.equal(decoded.kind === "event" && decoded.event.sent, true);
  });

  test("ConfigureNotify with signed position", () => {
    const buf = Buffer.concat([hex("16 00 0a00 e5010000 e5010000 00000000 fbff 0500 2003 5802 0000 00"), Buffer.alloc(5)]);
    assert.deepEqual(decodeServerMessage(buf), {
      kind: "event",
      event: { type: "ConfigureNotify", sequence: 10, sent: false, event: 0x1e5, window: 0x1e5, x: -5, y: 5, width: 800, height: 600 }
    });
  });

  test("DestroyNotify and unknown events", () => {
    const destroy = Buffer.concat([hex("11 00 0b00 e5010000 01004000"), Buffer.alloc(20)]);
    assert.deepEqual(decodeServerMessage(destroy), {
      kind: "event",
      event: { type: "DestroyNotify", sequence: 11, sent: false, event: 0x1e5, window: 0x400001 }
    });
    const other = Buffer.alloc(32);
    other.writeUInt8(12, 0); // Expose
    assert.deepEqual(decodeServerMessage(other), { kind: "event", event: { type: "other", code: 12, sequence: 0, sent: false } });
  });

  test("replies: InternAtom, QueryExtension, GetGeometry", () => {
    assert.equal(decodeInternAtomReply(replyFixture(1, 0, Buffer.concat([hex("60010000"), Buffer.alloc(20)]))), 0x160);
    assert.deepEqual(decodeQueryExtensionReply(replyFixture(2, 0, Buffer.concat([hex("01 8c 5a a0"), Buffer.alloc(20)]))), {
      present: true,
      majorOpcode: 140,
      firstEvent: 90,
      firstError: 160
    });
    assert.deepEqual(decodeGetGeometryReply(replyFixture(3, 24, Buffer.concat([hex("e5010000 0000 0000 0004 0003 0000"), Buffer.alloc(10)]))), {
      root: 0x1e5,
      x: 0,
      y: 0,
      width: 1024,
      height: 768
    });
  });

  test("GetProperty reply: format 8 and 32 values, missing property", () => {
    const utf8 = Buffer.from("héllo", "utf8"); // 6 bytes, padded to 8
    const fields = Buffer.alloc(24);
    fields.writeUInt32LE(0x150, 0); // type
    fields.writeUInt32LE(0, 4); // bytes after
    fields.writeUInt32LE(utf8.length, 8); // items
    const reply = decodeGetPropertyReply(replyFixture(4, 8, fields, Buffer.concat([utf8, Buffer.alloc(2)])));
    assert.equal(reply.format, 8);
    assert.equal(reply.type, 0x150);
    assert.equal(reply.value.toString("utf8"), "héllo");

    const list = Buffer.alloc(24);
    list.writeUInt32LE(33, 0);
    list.writeUInt32LE(4, 4);
    list.writeUInt32LE(2, 8);
    const windows = decodeGetPropertyReply(replyFixture(5, 32, list, hex("01004000 01006000")));
    assert.equal(windows.bytesAfter, 4);
    assert.deepEqual(propertyUint32s(windows.value), [0x400001, 0x600001]);

    const missing = decodeGetPropertyReply(replyFixture(6, 0, Buffer.alloc(24)));
    assert.equal(missing.type, 0);
    assert.equal(missing.value.length, 0);
  });

  test("property strings split on NUL", () => {
    assert.deepEqual(propertyStrings(Buffer.from("xterm\0XTerm\0"), "latin1"), ["xterm", "XTerm"]);
    assert.deepEqual(propertyStrings(Buffer.from("solo"), "latin1"), ["solo"]);
  });
});

describe("X-Resource replies", () => {
  test("QueryVersion", () => {
    assert.deepEqual(decodeXResQueryVersionReply(replyFixture(1, 0, Buffer.concat([hex("0100 0200"), Buffer.alloc(20)]))), { major: 1, minor: 2 });
  });

  test("QueryClientIds: pid value", () => {
    const fields = Buffer.alloc(24);
    fields.writeUInt32LE(1, 0);
    const reply = replyFixture(7, 0, fields, hex("01004000 02000000 04000000 39300000"));
    const ids = decodeXResQueryClientIdsReply(reply);
    assert.deepEqual(ids, [{ spec: { client: 0x400001, mask: 2 }, values: [12345] }]);
    assert.equal(pidFromClientIds(ids), 12345);
  });

  test("QueryClientIds: no pid known, several ids, truncation", () => {
    const empty = Buffer.alloc(24);
    empty.writeUInt32LE(1, 0);
    assert.equal(pidFromClientIds(decodeXResQueryClientIdsReply(replyFixture(8, 0, empty, hex("01004000 02000000 00000000")))), null);

    const two = Buffer.alloc(24);
    two.writeUInt32LE(2, 0);
    const ids = decodeXResQueryClientIdsReply(replyFixture(9, 0, two, hex("01004000 01000000 04000000 00004000 01004000 02000000 04000000 d2040000")));
    assert.equal(ids.length, 2);
    assert.equal(pidFromClientIds(ids), 1234);

    const truncated = replyFixture(10, 0, two, hex("01004000 02000000 04000000 d2040000"));
    assert.throws(() => decodeXResQueryClientIdsReply(truncated), /truncated/);
  });
});
