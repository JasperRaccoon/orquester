import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OggOpusSplitter } from "./ogg-opus.ts";

// Fixture: a 200 ms 440 Hz tone through the audio pipeline's encoder and muxer
// flags (spec §8.1), with `-fflags +bitexact` so the stream serial and vendor
// tags are reproducible. Generated with ffmpeg 6.1.1 (6.1.1-3ubuntu5):
//
//   ffmpeg -hide_banner -loglevel error \
//     -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=0.2" -ac 2 \
//     -c:a libopus -application lowdelay -frame_duration 10 -b:a 96k \
//     -fflags +bitexact -f ogg -page_duration 10000 -flush_packets 1 \
//     tone-440hz-200ms.opus.ogg
//
// It is 23 pages, one packet each: OpusHead, OpusTags, then 21 audio packets
// (20 × 10 ms of tone plus one covering the encoder's 312-sample pre-skip).
const FIXTURE = readFileSync(new URL("./__fixtures__/tone-440hz-200ms.opus.ogg", import.meta.url));
const AUDIO_PACKETS = 21;

function split(chunks: Iterable<Buffer>): Buffer[] {
  const packets: Buffer[] = [];
  const splitter = new OggOpusSplitter((packet) => packets.push(packet));
  for (const chunk of chunks) splitter.push(chunk);
  return packets;
}

function* chunked(data: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

/** Independent reference: walk the fixture's pages and return each page's body. */
function pageBodies(data: Buffer): Buffer[] {
  const bodies: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    assert.equal(data.toString("latin1", offset, offset + 4), "OggS");
    const count = data[offset + 26]!;
    const table = data.subarray(offset + 27, offset + 27 + count);
    const size = table.reduce((sum, value) => sum + value, 0);
    bodies.push(data.subarray(offset + 27 + count, offset + 27 + count + size));
    offset += 27 + count + size;
  }
  return bodies;
}

/** Build one Ogg page (CRC left zero: the splitter does not check it). */
function oggPage(flags: number, lacing: number[], body: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[4] = 0;
  header[5] = flags;
  header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), body]);
}

/** Lacing values for one packet of `size` bytes. */
function lace(size: number): number[] {
  const values: number[] = [];
  let remaining = size;
  while (remaining >= 255) {
    values.push(255);
    remaining -= 255;
  }
  values.push(remaining);
  return values;
}

function filled(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const HEADERS = Buffer.concat([
  oggPage(0x02, lace(19), Buffer.from("OpusHead".padEnd(19, "\0"), "latin1")),
  oggPage(0, lace(16), Buffer.from("OpusTags".padEnd(16, "\0"), "latin1"))
]);

test("fixture: header packets skipped, one 10 ms audio packet per page", () => {
  const packets = split([FIXTURE]);
  const bodies = pageBodies(FIXTURE);
  assert.equal(bodies.length, AUDIO_PACKETS + 2);
  assert.equal(bodies[0]!.toString("latin1", 0, 8), "OpusHead");
  assert.equal(bodies[1]!.toString("latin1", 0, 8), "OpusTags");
  assert.equal(packets.length, AUDIO_PACKETS);
  assert.deepEqual(packets, bodies.slice(2));
  for (const packet of packets) {
    assert.notEqual(packet.toString("latin1", 0, 4), "Opus");
    // TOC byte (RFC 6716 §3.1): config 28–31 = CELT fullband at 2.5/5/10/20 ms, the
    // stereo bit, and code 0 = one frame per packet. So every packet is one 10 ms frame.
    assert.equal(packet[0]! >> 3, 30, "CELT fullband, 10 ms frame");
    assert.equal(packet[0]! & 0x04, 0x04, "stereo");
    assert.equal(packet[0]! & 0x03, 0, "one frame per packet");
    // 96 kbit/s × 10 ms ≈ 120 bytes; the tone packets sit around that, bounded well under 300.
    assert.ok(packet.length > 40 && packet.length < 300, `packet size ${packet.length}`);
  }
});

test("fixture: 1-byte and odd-sized chunking give identical output", () => {
  const whole = pageBodies(FIXTURE).slice(2);
  assert.deepEqual(split(chunked(FIXTURE, 1)), whole);
  assert.deepEqual(split(chunked(FIXTURE, 7)), whole);
  assert.deepEqual(split(chunked(FIXTURE, 4096)), whole);
  // Every split point of a page header / segment table / body boundary.
  for (let cut = 1; cut < 200; cut += 1) {
    assert.deepEqual(split([FIXTURE.subarray(0, cut), FIXTURE.subarray(cut)]), whole, `cut at ${cut}`);
  }
});

test("garbage before, between and inside pages resyncs on the next capture pattern", () => {
  const whole = pageBodies(FIXTURE).slice(2);
  const bodies = pageBodies(FIXTURE);
  // Page boundaries: garbage between pages 5 and 6 loses nothing.
  let offset = 0;
  const boundaries: number[] = [];
  for (const body of bodies) {
    const count = FIXTURE[offset + 26]!;
    offset += 27 + count + body.length;
    boundaries.push(offset);
  }
  const garbage = Buffer.from("junk Ogg OggX \x00\xff OggS\x01 not-a-page", "latin1");
  const withGarbage = Buffer.concat([
    garbage,
    FIXTURE.subarray(0, boundaries[5]),
    garbage,
    FIXTURE.subarray(boundaries[5])
  ]);
  assert.deepEqual(split([withGarbage]), whole);
  assert.deepEqual(split(chunked(withGarbage, 1)), whole);
});

test("a packet laced with 255s continues across segments and across pages", () => {
  const big = filled(700, 1); // 255 + 255 + 190
  const exact = filled(510, 2); // 255 + 255 + 0: a terminating zero-length segment
  const small = filled(40, 3);
  // `big` starts on page A (two 255 segments) and finishes on continued page B,
  // which also carries `exact` split across B and continued page C.
  const pageA = oggPage(0, [255, 255], big.subarray(0, 510));
  const pageB = oggPage(0x01, [190, 255], Buffer.concat([big.subarray(510), exact.subarray(0, 255)]));
  const pageC = oggPage(0x01, [255, 0, 40], Buffer.concat([exact.subarray(255), small]));
  const stream = Buffer.concat([HEADERS, pageA, pageB, pageC]);

  const expected = [big, exact, small];
  assert.deepEqual(split([stream]), expected);
  assert.deepEqual(split(chunked(stream, 1)), expected);
  assert.deepEqual(split(chunked(stream, 13)), expected);
});

test("a lost page drops only the packet it truncated", () => {
  const first = filled(300, 4);
  const second = filled(50, 5);
  // Page A starts `first` but its continuation page is lost: page B is not flagged
  // continued, so the partial packet is discarded and B's packet is intact.
  const pageA = oggPage(0, [255], first.subarray(0, 255));
  const pageB = oggPage(0, [50], second);
  assert.deepEqual(split([Buffer.concat([HEADERS, pageA, pageB])]), [second]);

  // A continued page with nothing in flight: its leading segments are skipped.
  const orphan = oggPage(0x01, [255, 45, 50], Buffer.concat([first, second]));
  assert.deepEqual(split([Buffer.concat([HEADERS, orphan])]), [second]);
});

test("a new stream (BOS) restarts header skipping", () => {
  const packets = split([FIXTURE, FIXTURE]);
  assert.equal(packets.length, AUDIO_PACKETS * 2);
});
