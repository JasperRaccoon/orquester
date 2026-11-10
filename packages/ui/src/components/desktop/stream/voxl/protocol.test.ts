import test from "node:test";
import assert from "node:assert/strict";

import {
  parseVoxlCursor,
  parseVoxlServerText,
  parseVoxlVideoHeader,
  voxlCmd,
  voxlCodecFromSps,
  voxlCommandAllowed
} from "./protocol.ts";

test("a video header parses flags, frame id, stripe and its row from the wire bytes", () => {
  // type, flags (key | paintover), frame 0x01020304, pipe 1234, stripe 2 of 4, 3 parts, pad, y 540
  const bytes = Uint8Array.from([0x01, 0x03, 1, 2, 3, 4, 0, 0, 0x04, 0xd2, 2, 4, 3, 0, 0x02, 0x1c, 0xaa]);
  assert.deepEqual(parseVoxlVideoHeader(bytes), {
    key: true,
    paintover: true,
    frame: 0x01020304,
    pipe: 1234,
    stripe: 2,
    stripeCount: 4,
    parts: 3,
    y: 540
  });
  const delta = Uint8Array.from([0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0]);
  assert.equal(parseVoxlVideoHeader(delta)?.key, false);
  assert.equal(parseVoxlVideoHeader(delta)?.frame, 0xffffffff);
  assert.equal(parseVoxlVideoHeader(delta.subarray(0, 15)), null);
});

test("a cursor message parses size, hotspot, serial and its RGBA pixels", () => {
  // 2×1 cursor, hotspot (1, 0), serial 7, then a red and a transparent pixel
  const bytes = Uint8Array.from([0x03, 0, 0, 2, 0, 1, 0, 1, 0, 0, 0, 0, 0, 7, 255, 0, 0, 255, 0, 0, 0, 0]);
  const cursor = parseVoxlCursor(bytes.buffer);
  assert.ok(cursor);
  assert.deepEqual({ ...cursor, rgba: [...cursor.rgba] }, {
    width: 2,
    height: 1,
    hotX: 1,
    hotY: 0,
    serial: 7,
    rgba: [255, 0, 0, 255, 0, 0, 0, 0]
  });
  // Truncated pixels are rejected; a zero-sized cursor (hidden) is valid.
  assert.equal(parseVoxlCursor(bytes.slice(0, 20).buffer), null);
  const hidden = parseVoxlCursor(Uint8Array.from([0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]).buffer);
  assert.equal(hidden?.width, 0);
});

test("hello parses the display, stripes and resize, defaulting to one stripe", () => {
  assert.deepEqual(
    parseVoxlServerText(
      '{"t":"hello","w":1920,"h":1080,"stripes":[[0,544],[544,536]],"os":"linux","audio":false,"mic":false,"files":{"upload":false},"resize":{"scale":1.5}}'
    ),
    {
      t: "hello",
      w: 1920,
      h: 1080,
      stripes: [
        [0, 544],
        [544, 536]
      ],
      os: "linux",
      audio: false,
      mic: false,
      readOnly: false,
      resize: { scale: 1.5 }
    }
  );
  const plain = parseVoxlServerText('{"t":"hello","w":800,"h":600,"readOnly":true}');
  assert.deepEqual(plain && plain.t === "hello" && [plain.stripes, plain.readOnly, plain.resize], [[[0, 600]], true, undefined]);
  assert.equal(parseVoxlServerText('{"t":"hello","w":0,"h":600}'), null);
});

test("ping, clip and close parse; anything else is ignored", () => {
  assert.deepEqual(parseVoxlServerText('{"t":"ping","s":123456789}'), { t: "ping", s: 123456789 });
  assert.deepEqual(parseVoxlServerText('{"t":"clip","d":"héllo, world"}'), { t: "clip", d: "héllo, world" });
  assert.deepEqual(parseVoxlServerText('{"t":"close"}'), { t: "close" });
  assert.equal(parseVoxlServerText('{"t":"mic","on":true}'), null);
  assert.equal(parseVoxlServerText('{"t":"ping"}'), null);
  assert.equal(parseVoxlServerText("not json"), null);
});

test("commands serialise to voxl's comma-separated text", () => {
  assert.deepEqual(
    [
      voxlCmd.ack(42),
      voxlCmd.pong(123456789),
      voxlCmd.move(10, 20),
      voxlCmd.button(3, true),
      voxlCmd.scroll(1.25, -40),
      voxlCmd.key(0xffe3, false),
      voxlCmd.clipboard("a,b"),
      voxlCmd.resize(1280, 800),
      voxlCmd.video(false)
    ],
    ["a,42", "po,123456789", "m,10,20", "b,3,1", "sp,1.3,-40.0", "k,65507,0", "c,a,b", "sz,1280,800", "v,0"]
  );
});

test("a read-only viewer sends only what watching needs", () => {
  assert.equal(voxlCommandAllowed("a,1", true), true);
  assert.equal(voxlCommandAllowed("kf", true), true);
  assert.equal(voxlCommandAllowed("m,1,2", true), false);
  assert.equal(voxlCommandAllowed("r", true), false);
  assert.equal(voxlCommandAllowed("m,1,2", false), true);
});

test("the codec string comes from the keyframe's SPS", () => {
  const keyframe = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 1, 0x68]);
  assert.equal(voxlCodecFromSps(keyframe), "avc1.640028");
  assert.equal(voxlCodecFromSps(Uint8Array.from([0, 0, 1, 0x65, 1, 2, 3, 4])), null);
});
