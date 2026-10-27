import assert from "node:assert/strict";
import test from "node:test";

import { decodeScreenReply, encodeScreenRequest, HostScreenToAvcc } from "./screen-protocol.ts";
import { encodeScreenReply, FIXTURE_AVCC, FIXTURE_DELTA_AU, FIXTURE_KEY_AU } from "./testing.ts";

const keyHeader = { id: 1, status: "frame", key: true, record: FIXTURE_AVCC.toString("base64"), session: 1, width: 738, height: 1600, sourceWidth: 1290, sourceHeight: 2796, scale: 3 };

test("requests carry every field vphone requires (bitrate included)", () => {
  assert.deepEqual(JSON.parse(encodeScreenRequest({ id: 7, codec: "h264", box: [1600, 1600], fps: 30, bitrate: 6_000_000, key: true })), {
    id: 7,
    codec: "h264",
    box: [1600, 1600],
    fps: 30,
    bitrate: 6_000_000,
    key: true
  });
});

test("an answer is a little-endian header length, the JSON header, then the access unit", () => {
  const message = encodeScreenReply(keyHeader, FIXTURE_KEY_AU);
  const reply = decodeScreenReply(message);
  assert.equal(reply.header.status, "frame");
  assert.equal(reply.header.key, true);
  assert.deepEqual(reply.header.record, FIXTURE_AVCC);
  assert.equal(reply.header.sourceWidth, 1290);
  assert.deepEqual(reply.payload, FIXTURE_KEY_AU);

  const error = decodeScreenReply(encodeScreenReply({ id: 2, error: { code: "codec_unavailable", message: "no encoder" } }));
  assert.deepEqual(error.header.error, { code: "codec_unavailable", message: "no encoder" });
  assert.equal(error.payload.length, 0);

  assert.throws(() => decodeScreenReply(Buffer.from([1, 2])));
  assert.throws(() => decodeScreenReply(Buffer.from([0xff, 0xff, 0, 0, 1])));
  assert.throws(() => decodeScreenReply(encodeScreenReply({ id: 3 })));
});

test("frames become the serve-sim envelopes the panel's demuxer reads, byte for byte", () => {
  const convert = new HostScreenToAvcc();
  const out = [
    ...convert.convert(decodeScreenReply(encodeScreenReply(keyHeader, FIXTURE_KEY_AU))),
    ...convert.convert(decodeScreenReply(encodeScreenReply({ ...keyHeader, id: 2, status: "unchanged", key: undefined, record: undefined }))),
    ...convert.convert(decodeScreenReply(encodeScreenReply({ id: 3, status: "frame", key: false }, FIXTURE_DELTA_AU)))
  ];
  const bytes = Buffer.concat(out);
  // u32 BE length counting the tag, the tag, the payload.
  const expected = Buffer.concat([
    Buffer.from([0, 0, 0, FIXTURE_AVCC.length + 1, 1]),
    FIXTURE_AVCC,
    Buffer.from([0, 0, 0, FIXTURE_KEY_AU.length + 1, 2]),
    FIXTURE_KEY_AU,
    Buffer.from([0, 0, 0, FIXTURE_DELTA_AU.length + 1, 3]),
    FIXTURE_DELTA_AU
  ]);
  assert.deepEqual(bytes, expected);

});

test("the description repeats only when it changes; deltas before a key frame are dropped", () => {
  const convert = new HostScreenToAvcc();
  const delta = decodeScreenReply(encodeScreenReply({ id: 1, status: "frame", key: false }, FIXTURE_DELTA_AU));
  assert.deepEqual(convert.convert(delta), []);
  const key = decodeScreenReply(encodeScreenReply(keyHeader, FIXTURE_KEY_AU));
  assert.deepEqual(convert.convert(key).map((frame) => frame[4]), [1, 2]);
  assert.deepEqual(convert.convert(key).map((frame) => frame[4]), [2], "same record: no second description");
  const changed = Buffer.from(FIXTURE_AVCC);
  changed[3] = 0x28;
  const reconfigured = convert.convert(decodeScreenReply(encodeScreenReply({ ...keyHeader, record: changed.toString("base64") }, FIXTURE_KEY_AU)));
  assert.deepEqual(reconfigured.map((frame) => frame[4]), [1, 2]);
  assert.deepEqual(reconfigured[0]!.subarray(5), changed);
  convert.resetKey();
  assert.deepEqual(convert.convert(delta), []);
  // A key frame without a usable record, or a payload that is not length-prefixed, is skipped.
  assert.deepEqual(convert.convert(decodeScreenReply(encodeScreenReply(keyHeader, Buffer.from([0, 0, 0, 9, 1])))), []);
  assert.deepEqual(convert.convert(decodeScreenReply(encodeScreenReply({ ...keyHeader, record: Buffer.from([0, 1, 2, 3, 4, 5, 6]).toString("base64") }, FIXTURE_KEY_AU))), []);
  assert.deepEqual(convert.convert(decodeScreenReply(encodeScreenReply({ id: 9, status: "frame", key: true }, FIXTURE_KEY_AU))), []);
  assert.deepEqual(convert.convert(decodeScreenReply(encodeScreenReply(keyHeader, Buffer.from([0, 0, 0, 1, 0x00, 0x00, 0x01, 0x65])))), []);
});
