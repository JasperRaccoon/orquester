import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decodeDamageNotify,
  decodeDamageQueryVersionReply,
  decodeXFixesQueryVersionReply,
  DamageReportLevel,
  encodeDamageCreate,
  encodeDamageDestroy,
  encodeDamageQueryVersion,
  encodeDamageSubtract,
  encodeXFixesQueryVersion
} from "./damage.ts";
import {
  decodeGetGeometryReply,
  decodeGetImageReply,
  decodeGetKeyboardMappingReply,
  decodeGetModifierMappingReply,
  decodeGetPropertyReply,
  decodeGetSelectionOwnerReply,
  decodeInternAtomReply,
  decodeQueryExtensionReply,
  decodeQueryPointerReply,
  decodeServerMessage,
  decodeSetupResponse,
  decodeTranslateCoordinatesReply,
  encodeChangeKeyboardMapping,
  encodeChangeProperty,
  encodeClientMessage,
  encodeConvertSelection,
  encodeCreateWindow,
  encodeDeleteProperty,
  encodeGetGeometry,
  encodeGetImage,
  encodeGetKeyboardMapping,
  encodeGetModifierMapping,
  encodeGetProperty,
  encodeGetSelectionOwner,
  encodeInternAtom,
  encodeQueryExtension,
  encodeQueryPointer,
  encodeSelectInput,
  encodeSelectionNotify,
  encodeSendEvent,
  encodeSetSelectionOwner,
  encodeSetupRequest,
  encodeTranslateCoordinates,
  EventMask,
  ImageFormat,
  PropertyMode,
  propertyStrings,
  propertyUint32s,
  serverMessageLength,
  setupResponseLength,
  WindowClass
} from "./protocol.ts";
import { decodeXTestGetVersionReply, encodeXTestFakeInput, encodeXTestGetVersion, FakeEventType } from "./xtest.ts";
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

/**
 * Setup success: vendor "Test", two pixmap formats, two screens (the first with a depth-8 visual
 * and a depth-24 TrueColor root visual), MSBFirst image byte order, keycodes 8–255.
 */
function setupSuccessFixture(): Buffer {
  const vendor = Buffer.from("Test");
  const formats = hex("01 01 20 00 00000000 18 20 20 00 00000000");
  const screen = (root: number, width: number, height: number, rootVisual: number, depths: Buffer[]): Buffer => {
    const head = Buffer.alloc(40);
    head.writeUInt32LE(root, 0);
    head.writeUInt16LE(width, 20);
    head.writeUInt16LE(height, 22);
    head.writeUInt32LE(rootVisual, 32);
    head.writeUInt8(24, 38);
    head.writeUInt8(depths.length, 39);
    return Buffer.concat([head, ...depths]);
  };
  // visual id, class, bits-per-rgb, colormap entries, red/green/blue masks, padding.
  const grayscale = hex("22000000 01 08 0001 00000000 00000000 00000000 00000000");
  const trueColor = hex("21000000 04 08 0001 0000ff00 00ff0000 ff000000 00000000");
  const depths = [Buffer.concat([hex("08 00 0100 00000000"), grayscale]), Buffer.concat([hex("18 00 0100 00000000"), trueColor])];
  const body = Buffer.concat([
    (() => {
      const fixed = Buffer.alloc(32);
      fixed.writeUInt32LE(12_013_000, 0); // release
      fixed.writeUInt32LE(0x0040_0000, 4); // resource-id-base
      fixed.writeUInt32LE(0x001f_ffff, 8); // resource-id-mask
      fixed.writeUInt16LE(vendor.length, 16);
      fixed.writeUInt16LE(0xffff, 18);
      fixed.writeUInt8(2, 20); // screens
      fixed.writeUInt8(2, 21); // formats
      fixed.writeUInt8(1, 22); // image byte order: MSBFirst
      fixed.writeUInt8(8, 26); // min keycode
      fixed.writeUInt8(255, 27); // max keycode
      return fixed;
    })(),
    vendor,
    formats,
    screen(0x1e5, 1024, 768, 0x21, depths),
    screen(0x2e5, 640, 480, 0, [])
  ]);
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(body.length / 4, 6);
  return Buffer.concat([head, body]);
}

describe("x11 setup response decoding", () => {
  test("success: ids, image format, keycodes, vendor and every screen's root, size and root visual", () => {
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
        imageByteOrder: "msb",
        minKeycode: 8,
        maxKeycode: 255,
        pixmapFormats: [
          { depth: 1, bitsPerPixel: 1, scanlinePad: 32 },
          { depth: 24, bitsPerPixel: 32, scanlinePad: 32 }
        ],
        vendor: "Test",
        screens: [
          {
            root: 0x1e5,
            width: 1024,
            height: 768,
            rootDepth: 24,
            rootVisual: { id: 0x21, class: 4, bitsPerRgb: 8, redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff }
          },
          { root: 0x2e5, width: 640, height: 480, rootDepth: 24, rootVisual: null }
        ]
      }
    });
    // LSBFirst is 0.
    buf.writeUInt8(0, 30);
    const lsb = decodeSetupResponse(buf);
    assert.equal(lsb.status === "success" && lsb.info.imageByteOrder, "lsb");
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
    assert.deepEqual(decodeServerMessage(other), { kind: "event", event: { type: "other", code: 12, sequence: 0, sent: false, data: other } });
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

describe("automation request encoding (spec 2026-11-10 §2.2)", () => {
  test("CreateWindow: an InputOnly helper with an event mask, and attributes in mask-bit order", () => {
    assert.deepEqual(
      encodeCreateWindow(0x400001, 0x1e5, { x: -1, y: -1, width: 1, height: 1 }, WindowClass.InputOnly, { eventMask: EventMask.PropertyChange }),
      hex("01 00 0900 01004000 e5010000 ffff ffff 0100 0100 0000 0200 00000000 00080000 00004000")
    );
    assert.deepEqual(
      encodeCreateWindow(0x400002, 0x1e5, { x: 10, y: 20, width: 64, height: 32 }, WindowClass.InputOutput, { eventMask: 1, overrideRedirect: true, backgroundPixel: 0xff0000 }),
      hex("01 00 0b00 02004000 e5010000 0a00 1400 4000 2000 0000 0100 00000000 020a0000 0000ff00 01000000 01000000")
    );
  });

  test("ChangeProperty counts items in the format's units and pads the data; DeleteProperty", () => {
    assert.deepEqual(
      encodeChangeProperty(PropertyMode.Append, 0x400001, 0x150, 31, 8, Buffer.from("abc")),
      hex("12 02 0700 01004000 50010000 1f000000 08 000000 03000000 616263 00")
    );
    assert.deepEqual(
      encodeChangeProperty(PropertyMode.Replace, 0x400001, 0x150, 4, 32, hex("50010000 51010000")),
      hex("12 00 0800 01004000 50010000 04000000 20 000000 02000000 50010000 51010000")
    );
    assert.throws(() => encodeChangeProperty(PropertyMode.Replace, 1, 1, 4, 32, Buffer.alloc(6)), /whole number/);
    assert.deepEqual(encodeDeleteProperty(0x400001, 0x150), hex("13 00 0300 01004000 50010000"));
  });

  test("selections: SetSelectionOwner, GetSelectionOwner, ConvertSelection and a SelectionNotify to send", () => {
    assert.deepEqual(encodeSetSelectionOwner(0x400001, 0x1a0, 0x12345678), hex("16 00 0400 01004000 a0010000 78563412"));
    assert.deepEqual(encodeGetSelectionOwner(0x1a0), hex("17 00 0200 a0010000"));
    assert.deepEqual(encodeConvertSelection(0x400001, 0x1a0, 0x1a1, 0x1a2, 0), hex("18 00 0600 01004000 a0010000 a1010000 a2010000 00000000"));
    const notify = encodeSelectionNotify(0x10, 0x600001, 0x1a0, 0x1a1, 0x1a2);
    assert.deepEqual(notify, Buffer.concat([hex("1f 00 0000 10000000 01006000 a0010000 a1010000 a2010000"), Buffer.alloc(8)]));
    assert.deepEqual(encodeSendEvent(false, 0x600001, 0, notify).subarray(0, 12), hex("19 00 0b00 01006000 00000000"));
  });

  test("QueryPointer, TranslateCoordinates and a ZPixmap GetImage", () => {
    assert.deepEqual(encodeQueryPointer(0x1e5), hex("26 00 0200 e5010000"));
    assert.deepEqual(encodeTranslateCoordinates(0x400001, 0x1e5, -3, 4), hex("28 00 0400 01004000 e5010000 fdff 0400"));
    assert.deepEqual(
      encodeGetImage(ImageFormat.ZPixmap, 0x1e5, { x: 0, y: 256, width: 1920, height: 546 }),
      hex("49 02 0500 e5010000 0000 0001 8007 2202 ffffffff")
    );
  });

  test("keyboard: GetKeyboardMapping, ChangeKeyboardMapping (count in the header), GetModifierMapping", () => {
    assert.deepEqual(encodeGetKeyboardMapping(8, 248), hex("65 00 0200 08 f8 0000"));
    assert.deepEqual(encodeChangeKeyboardMapping(0xfd, 2, [0xe9, 0xe9]), hex("64 01 0400 fd 02 0000 e9000000 e9000000"));
    assert.deepEqual(encodeChangeKeyboardMapping(0xfc, 2, [0x41, 0, 0x42, 0]), hex("64 02 0600 fc 02 0000 41000000 00000000 42000000 00000000"));
    assert.throws(() => encodeChangeKeyboardMapping(8, 2, [1, 2, 3]), /whole keycodes/);
    assert.deepEqual(encodeGetModifierMapping(), hex("77 00 0100"));
  });

  test("XTEST GetVersion and FakeInput key, button and absolute motion", () => {
    assert.deepEqual(encodeXTestGetVersion(0x85), hex("85 00 0200 02 00 0200"));
    assert.deepEqual(
      encodeXTestFakeInput(0x85, { type: FakeEventType.KeyPress, detail: 38 }),
      hex("85 02 0900 02 26 0000 00000000 00000000 0000000000000000 0000 0000 00000000000000 00")
    );
    assert.equal(encodeXTestFakeInput(0x85, { type: FakeEventType.ButtonRelease, detail: 3 }).readUInt16LE(4), 0x0305);
    assert.deepEqual(
      encodeXTestFakeInput(0x85, { type: FakeEventType.MotionNotify, detail: 0, root: 0x1e5, x: 100, y: -2 }),
      hex("85 02 0900 06 00 0000 00000000 e5010000 0000000000000000 6400 feff 00000000000000 00")
    );
  });

  test("XFIXES QueryVersion, then DAMAGE QueryVersion, Create, Subtract and Destroy", () => {
    assert.deepEqual(encodeXFixesQueryVersion(0x8b), hex("8b 00 0300 05000000 00000000"));
    assert.deepEqual(encodeDamageQueryVersion(0x90), hex("90 00 0300 01000000 01000000"));
    assert.deepEqual(encodeDamageCreate(0x90, 0x400002, 0x1e5, DamageReportLevel.RawRectangles), hex("90 01 0400 02004000 e5010000 00 000000"));
    assert.deepEqual(encodeDamageSubtract(0x90, 0x400002), hex("90 03 0400 02004000 00000000 00000000"));
    assert.deepEqual(encodeDamageDestroy(0x90, 0x400002), hex("90 02 0200 02004000"));
  });
});

describe("automation reply and event decoding", () => {
  test("GetSelectionOwner, QueryPointer and TranslateCoordinates replies", () => {
    assert.equal(decodeGetSelectionOwnerReply(replyFixture(1, 0, Buffer.concat([hex("01004000"), Buffer.alloc(20)]))), 0x400001);
    assert.deepEqual(decodeQueryPointerReply(replyFixture(2, 1, Buffer.concat([hex("e5010000 01006000 2c01 c800 0a00 f6ff 0001"), Buffer.alloc(6)]))), {
      sameScreen: true,
      root: 0x1e5,
      child: 0x600001,
      rootX: 300,
      rootY: 200,
      winX: 10,
      winY: -10,
      mask: 0x100
    });
    assert.deepEqual(decodeTranslateCoordinatesReply(replyFixture(3, 1, Buffer.concat([hex("00000000 fbff 1e00"), Buffer.alloc(16)]))), {
      sameScreen: true,
      child: 0,
      x: -5,
      y: 30
    });
  });

  test("GetImage reply: depth, visual and the pixel bytes as a view", () => {
    const pixels = hex("0000ff00 00ff0000");
    const reply = replyFixture(4, 24, Buffer.concat([hex("21000000"), Buffer.alloc(20)]), pixels);
    const image = decodeGetImageReply(reply);
    assert.equal(image.depth, 24);
    assert.equal(image.visual, 0x21);
    assert.deepEqual(image.data, pixels);
    assert.equal(image.data.buffer, reply.buffer, "no copy of a large reply");
  });

  test("GetKeyboardMapping and GetModifierMapping replies", () => {
    const mapping = decodeGetKeyboardMappingReply(replyFixture(5, 2, Buffer.alloc(24), hex("61000000 41000000 00000000 00000000")));
    assert.equal(mapping.keysymsPerKeycode, 2);
    assert.deepEqual([...mapping.keysyms], [0x61, 0x41, 0, 0]);
    // Two keycodes per modifier; zeros are unused slots.
    const modifiers = decodeGetModifierMappingReply(replyFixture(6, 2, Buffer.alloc(24), hex("323e 4200 2569 0000 4000 0000 0000 0000 8500 0000 0000 0000")));
    assert.deepEqual(modifiers, [[0x32, 0x3e], [0x42], [0x25, 0x69], [], [0x40], [], [], []]);
  });

  test("XTEST, XFIXES and DAMAGE version replies", () => {
    assert.deepEqual(decodeXTestGetVersionReply(replyFixture(7, 2, Buffer.concat([hex("0200"), Buffer.alloc(22)]))), { major: 2, minor: 2 });
    assert.deepEqual(decodeXFixesQueryVersionReply(replyFixture(8, 0, Buffer.concat([hex("05000000 00000000"), Buffer.alloc(16)]))), { major: 5, minor: 0 });
    assert.deepEqual(decodeDamageQueryVersionReply(replyFixture(9, 0, Buffer.concat([hex("01000000 01000000"), Buffer.alloc(16)]))), { major: 1, minor: 1 });
  });

  test("KeyPress and ButtonRelease", () => {
    const key = hex("02 26 0c00 10000000 e5010000 01006000 00000000 2c01 c800 0a00 0b00 0100 01 00");
    assert.deepEqual(decodeServerMessage(key), {
      kind: "event",
      event: {
        type: "KeyPress",
        sequence: 12,
        sent: false,
        detail: 38,
        time: 0x10,
        root: 0x1e5,
        event: 0x600001,
        child: 0,
        rootX: 300,
        rootY: 200,
        eventX: 10,
        eventY: 11,
        state: 1
      }
    });
    key[0] = 5;
    const decoded = decodeServerMessage(key);
    assert.equal(decoded.kind === "event" && decoded.event.type, "ButtonRelease");
  });

  test("SelectionClear, SelectionRequest, SelectionNotify and MappingNotify", () => {
    assert.deepEqual(decodeServerMessage(Buffer.concat([hex("1d 00 0100 20000000 01004000 a0010000"), Buffer.alloc(16)])), {
      kind: "event",
      event: { type: "SelectionClear", sequence: 1, sent: false, time: 0x20, owner: 0x400001, selection: 0x1a0 }
    });
    assert.deepEqual(decodeServerMessage(Buffer.concat([hex("1e 00 0200 00000000 01004000 01006000 a0010000 a1010000 a2010000"), Buffer.alloc(4)])), {
      kind: "event",
      event: { type: "SelectionRequest", sequence: 2, sent: false, time: 0, owner: 0x400001, requestor: 0x600001, selection: 0x1a0, target: 0x1a1, property: 0x1a2 }
    });
    // A SelectionNotify sent by another client has the SendEvent bit.
    assert.deepEqual(decodeServerMessage(Buffer.concat([hex("9f 00 0300 30000000 01004000 a0010000 a1010000 00000000"), Buffer.alloc(8)])), {
      kind: "event",
      event: { type: "SelectionNotify", sequence: 3, sent: true, time: 0x30, requestor: 0x400001, selection: 0x1a0, target: 0x1a1, property: 0 }
    });
    assert.deepEqual(decodeServerMessage(Buffer.concat([hex("22 00 0400 01 fd 01"), Buffer.alloc(25)])), {
      kind: "event",
      event: { type: "MappingNotify", sequence: 4, sent: false, request: 1, firstKeycode: 0xfd, count: 1 }
    });
  });

  test("DamageNotify: level, the more flag, the damaged area and the drawable's geometry", () => {
    const event = hex("5e 80 0500 e5010000 02004000 40000000 1000 2000 3000 4000 0000 0000 8007 3804");
    const message = decodeServerMessage(event);
    assert.ok(message.kind === "event" && message.event.type === "other" && message.event.code === 0x5e);
    assert.deepEqual(decodeDamageNotify(message.event.data), {
      level: DamageReportLevel.RawRectangles,
      more: true,
      drawable: 0x1e5,
      damage: 0x400002,
      timestamp: 0x40,
      area: { x: 16, y: 32, width: 48, height: 64 },
      geometry: { x: 0, y: 0, width: 1920, height: 1080 }
    });
  });
});
