// Streaming Ogg page parser for ffmpeg's `-f ogg` Opus output (spec §8.1).
//
// Bytes arrive from ffmpeg's stdout in arbitrary chunks. Each Ogg page is a
// 27-byte header ("OggS", version 0, flags, granule, serial, sequence, CRC,
// segment count), a segment table of lacing values, then the segment bodies.
// A packet is a run of segments ending with a lacing value < 255; a packet may
// continue into the next page (whose header then carries the "continued"
// flag). The first two packets of a stream are the `OpusHead` and `OpusTags`
// headers and are not audio, so they are skipped.
//
// The CRC is not checked: the input is a local pipe from ffmpeg. The parser
// still resyncs on garbage by searching for the next "OggS" capture pattern.

const CAPTURE = Buffer.from("OggS", "latin1");
const HEADER_BYTES = 27;
const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
/** OpusHead + OpusTags. */
const HEADER_PACKETS = 2;
/** A packet larger than this is not an Opus frame; drop it rather than grow without bound. */
const MAX_PACKET_BYTES = 1024 * 1024;

export class OggOpusSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  /** Segments of a packet still waiting for its terminating lacing value. */
  private partial: Buffer[] = [];
  private partialBytes = 0;
  /** True while `partial` holds the start of a packet that must continue on the next page. */
  private inPacket = false;
  private headersRemaining = HEADER_PACKETS;

  constructor(private readonly onPacket: (packet: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    for (;;) {
      const found = this.buffer.indexOf(CAPTURE, offset);
      if (found < 0) {
        // Keep a possible partial capture pattern at the tail for the next chunk.
        offset = Math.max(offset, this.buffer.length - (CAPTURE.length - 1));
        break;
      }
      if (found !== offset) this.dropPartial(); // skipped garbage: the packet in flight is lost
      offset = found;
      if (this.buffer.length - offset < HEADER_BYTES) break;
      if (this.buffer[offset + 4] !== 0) {
        // Not a version-0 page: a stray "OggS" inside garbage. Resync past it.
        this.dropPartial();
        offset += 1;
        continue;
      }
      const segmentCount = this.buffer[offset + 26]!;
      const tableEnd = offset + HEADER_BYTES + segmentCount;
      if (this.buffer.length < tableEnd) break;
      let bodyBytes = 0;
      for (let i = offset + HEADER_BYTES; i < tableEnd; i += 1) bodyBytes += this.buffer[i]!;
      if (this.buffer.length < tableEnd + bodyBytes) break;
      this.page(this.buffer[offset + 5]!, this.buffer.subarray(offset + HEADER_BYTES, tableEnd), tableEnd);
      offset = tableEnd + bodyBytes;
    }
    // Copy the unparsed tail so the (possibly large) consumed prefix can be freed.
    this.buffer = offset >= this.buffer.length ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(offset));
  }

  private page(flags: number, lacing: Buffer, bodyStart: number): void {
    if (flags & FLAG_BOS) {
      // A new logical stream (e.g. a restarted encoder): its headers come first.
      this.dropPartial();
      this.headersRemaining = HEADER_PACKETS;
    }
    // Without the continued flag, any packet in flight was truncated by a lost page;
    // with it, but nothing in flight, the leading segments belong to a packet whose
    // start we never saw.
    let skipContinuation = false;
    if (flags & FLAG_CONTINUED) {
      if (!this.inPacket) skipContinuation = true;
    } else {
      this.dropPartial();
    }
    let position = bodyStart;
    for (const value of lacing) {
      const segment = this.buffer.subarray(position, position + value);
      position += value;
      if (skipContinuation) {
        if (value < 255) skipContinuation = false;
        continue;
      }
      if (this.partialBytes + value > MAX_PACKET_BYTES) {
        this.dropPartial();
        skipContinuation = value === 255;
        continue;
      }
      this.partial.push(segment);
      this.partialBytes += value;
      this.inPacket = true;
      if (value < 255) this.finishPacket();
    }
  }

  private finishPacket(): void {
    const packet = Buffer.concat(this.partial, this.partialBytes);
    this.partial = [];
    this.partialBytes = 0;
    this.inPacket = false;
    if (this.headersRemaining > 0) {
      this.headersRemaining -= 1;
      return;
    }
    this.onPacket(packet);
  }

  private dropPartial(): void {
    this.partial = [];
    this.partialBytes = 0;
    this.inPacket = false;
  }
}

export function createOggOpusSplitter(onPacket: (packet: Buffer) => void): OggOpusSplitter {
  return new OggOpusSplitter(onPacket);
}
