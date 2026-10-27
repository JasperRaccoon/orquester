/**
 * Device screenshots for an MCP image block (devices spec §9): the PNG agent-device saves, kept as
 * PNG when its base64 fits the cap, else re-encoded as JPEG and halved until it does (as
 * `html-preview`'s `MAX_SCREENSHOT_BASE64_CHARS`). No image library ships with the daemon, so this
 * holds a small PNG decoder (8-bit, non-interlaced) and a baseline JPEG encoder (4:4:4, the
 * standard tables). The daemon runs these in its image workers (`image-pool.ts`), never on the
 * event loop.
 */

import { inflateSync } from "node:zlib";

/** As `html-preview`'s `MAX_SCREENSHOT_BASE64_CHARS`: the largest image an MCP result inlines. */
export const DEVICE_SCREENSHOT_MAX_BASE64_CHARS = 4 * 1024 * 1024;

interface RgbImage {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, row-major. */
  data: Buffer;
}

export interface FittedScreenshot {
  mimeType: "image/png" | "image/jpeg";
  data: Buffer;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's width and height from its header, or null when it is not a PNG. */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Decode an 8-bit, non-interlaced PNG (gray, RGB, palette, with or without alpha; alpha is dropped). */
function decodePng(png: Buffer): RgbImage {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8]!;
      colorType = body[9]!;
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined || width === 0 || height === 0) throw new Error("unsupported PNG");
  if (colorType === 3 && !palette) throw new Error("PNG palette missing");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG");
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x]!;
      const a = x >= channels ? pixels[dst + x - channels]! : 0;
      const b = y > 0 ? pixels[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[dst + x] = out & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    if (colorType === 3) {
      const index = pixels[p]! * 3;
      rgb[i * 3] = palette![index] ?? 0;
      rgb[i * 3 + 1] = palette![index + 1] ?? 0;
      rgb[i * 3 + 2] = palette![index + 2] ?? 0;
    } else if (channels <= 2) {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = pixels[p]!;
    } else {
      rgb[i * 3] = pixels[p]!;
      rgb[i * 3 + 1] = pixels[p + 1]!;
      rgb[i * 3 + 2] = pixels[p + 2]!;
    }
  }
  return { width, height, data: rgb };
}

/** Shrink by an integer factor (each output pixel averages a `factor`×`factor` block). */
function downscale(image: RgbImage, factor: number): RgbImage {
  if (factor <= 1) return image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < factor && y * factor + dy < image.height; dy += 1) {
        for (let dx = 0; dx < factor && x * factor + dx < image.width; dx += 1) {
          const i = ((y * factor + dy) * image.width + x * factor + dx) * 3;
          r += image.data[i]!;
          g += image.data[i + 1]!;
          b += image.data[i + 2]!;
          n += 1;
        }
      }
      const o = (y * width + x) * 3;
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
    }
  }
  return { width, height, data };
}

/** Base64 length of `bytes` bytes. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * The PNG as-is when its base64 fits `maxBase64Chars`; else JPEG (quality 80), halved until it
 * fits (at worst 1/16 scale).
 */
export function fitScreenshot(png: Buffer, maxBase64Chars: number): FittedScreenshot {
  const size = pngSize(png);
  if (!size) throw new Error("not a PNG");
  if (base64Length(png.length) <= maxBase64Chars) return { mimeType: "image/png", data: png, width: size.width, height: size.height };
  const image = decodePng(png);
  for (let factor = 1; ; factor *= 2) {
    const scaled = downscale(image, factor);
    const jpeg = encodeJpeg(scaled, 80);
    if (base64Length(jpeg.length) <= maxBase64Chars || factor >= 16) return { mimeType: "image/jpeg", data: jpeg, width: scaled.width, height: scaled.height };
  }
}

/** The fleet view's thumbnail quality. */
const THUMBNAIL_JPEG_QUALITY = 60;

/** A PNG (or a JPEG passed through) as a JPEG at most `width` px wide (integer-factor box downscale; never upscaled). */
export function thumbnailJpeg(image: Buffer, width: number): Buffer {
  if (image[0] === 0xff && image[1] === 0xd8) return image;
  const decoded = decodePng(image);
  const factor = Math.max(1, Math.ceil(decoded.width / Math.max(1, width)));
  return encodeJpeg(downscale(decoded, factor), THUMBNAIL_JPEG_QUALITY);
}

// ---------------------------------------------------------------------------
// Baseline JPEG encoder (ITU T.81, standard Annex K tables)
// ---------------------------------------------------------------------------

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20,
  22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63
];

const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];

const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array<number>(32).fill(99)
];

const AAN_SCALE = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

/** A Huffman table as DHT carries it: the code counts per length 1–16, then the symbols. */
interface HuffmanSpec {
  counts: number[];
  symbols: number[];
}

const AC_LUMA_SYMBOLS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
];

const AC_CHROMA_SYMBOLS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
  0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
];

const JPEG_HUFFMAN: Readonly<Record<"dcLuma" | "acLuma" | "dcChroma" | "acChroma", HuffmanSpec>> = {
  dcLuma: { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  acLuma: { counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], symbols: AC_LUMA_SYMBOLS },
  dcChroma: { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  acChroma: { counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], symbols: AC_CHROMA_SYMBOLS }
};

/** symbol → [code, length], canonical (T.81 Annex C). */
function huffmanCodes(spec: HuffmanSpec): Map<number, [number, number]> {
  const codes = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < spec.counts[length - 1]!; i += 1) codes.set(spec.symbols[k++]!, [code++, length]);
    code <<= 1;
  }
  return codes;
}

function scaledQuant(base: readonly number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

class BitWriter {
  private readonly bytes: number[] = [];
  private buffer = 0;
  private count = 0;

  write(code: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.buffer = (this.buffer << 1) | ((code >> i) & 1);
      this.count += 1;
      if (this.count === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.buffer);
    if (this.buffer === 0xff) this.bytes.push(0);
    this.buffer = 0;
    this.count = 0;
  }

  /** Pad the last byte with 1 bits. */
  finish(): number[] {
    if (this.count > 0) this.write((1 << (8 - this.count)) - 1, 8 - this.count);
    return this.bytes;
  }
}

/** Forward DCT (AAN) of one 8×8 block in place, then quantize into zigzag order. */
function dctQuantize(block: Float64Array, divisors: Float64Array, out: Int32Array): void {
  for (let pass = 0; pass < 2; pass += 1) {
    const step = pass === 0 ? 1 : 8;
    const line = pass === 0 ? 8 : 1;
    for (let i = 0; i < 8; i += 1) {
      const o = i * line;
      const d0 = block[o]!;
      const d1 = block[o + step]!;
      const d2 = block[o + 2 * step]!;
      const d3 = block[o + 3 * step]!;
      const d4 = block[o + 4 * step]!;
      const d5 = block[o + 5 * step]!;
      const d6 = block[o + 6 * step]!;
      const d7 = block[o + 7 * step]!;
      const tmp0 = d0 + d7;
      const tmp7 = d0 - d7;
      const tmp1 = d1 + d6;
      const tmp6 = d1 - d6;
      const tmp2 = d2 + d5;
      const tmp5 = d2 - d5;
      const tmp3 = d3 + d4;
      const tmp4 = d3 - d4;
      let tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      let tmp11 = tmp1 + tmp2;
      let tmp12 = tmp1 - tmp2;
      block[o] = tmp10 + tmp11;
      block[o + 4 * step] = tmp10 - tmp11;
      const z1 = (tmp12 + tmp13) * 0.707106781;
      block[o + 2 * step] = tmp13 + z1;
      block[o + 6 * step] = tmp13 - z1;
      tmp10 = tmp4 + tmp5;
      tmp11 = tmp5 + tmp6;
      tmp12 = tmp6 + tmp7;
      const z5 = (tmp10 - tmp12) * 0.382683433;
      const z2 = 0.5411961 * tmp10 + z5;
      const z4 = 1.306562965 * tmp12 + z5;
      const z3 = tmp11 * 0.707106781;
      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;
      block[o + 5 * step] = z13 + z2;
      block[o + 3 * step] = z13 - z2;
      block[o + step] = z11 + z4;
      block[o + 7 * step] = z11 - z4;
    }
  }
  for (let i = 0; i < 64; i += 1) out[ZIGZAG[i]!] = Math.round(block[i]! * divisors[i]!);
}

function divisorsFor(table: readonly number[]): Float64Array {
  const divisors = new Float64Array(64);
  for (let i = 0; i < 64; i += 1) divisors[i] = 1 / (table[ZIGZAG[i]!]! * AAN_SCALE[i >> 3]! * AAN_SCALE[i & 7]! * 8);
  return divisors;
}

function bitLength(value: number): number {
  let magnitude = Math.abs(value);
  let length = 0;
  while (magnitude > 0) {
    length += 1;
    magnitude >>= 1;
  }
  return length;
}

/** Encode RGB as a baseline JPEG (4:4:4). */
function encodeJpeg(image: RgbImage, quality = 80): Buffer {
  const { width, height, data } = image;
  // Quant tables in zigzag order (as DQT stores them).
  const lumaNatural = scaledQuant(LUMA_QUANT, quality);
  const chromaNatural = scaledQuant(CHROMA_QUANT, quality);
  const lumaZigzag = new Array<number>(64);
  const chromaZigzag = new Array<number>(64);
  for (let i = 0; i < 64; i += 1) {
    lumaZigzag[ZIGZAG[i]!] = lumaNatural[i]!;
    chromaZigzag[ZIGZAG[i]!] = chromaNatural[i]!;
  }
  const lumaDiv = divisorsFor(lumaZigzag);
  const chromaDiv = divisorsFor(chromaZigzag);
  const dcLuma = huffmanCodes(JPEG_HUFFMAN.dcLuma);
  const acLuma = huffmanCodes(JPEG_HUFFMAN.acLuma);
  const dcChroma = huffmanCodes(JPEG_HUFFMAN.dcChroma);
  const acChroma = huffmanCodes(JPEG_HUFFMAN.acChroma);

  const bits = new BitWriter();
  const yBlock = new Float64Array(64);
  const cbBlock = new Float64Array(64);
  const crBlock = new Float64Array(64);
  const quantized = new Int32Array(64);
  const previous = [0, 0, 0];

  const encodeBlock = (block: Float64Array, divisors: Float64Array, component: number, dc: Map<number, [number, number]>, ac: Map<number, [number, number]>) => {
    dctQuantize(block, divisors, quantized);
    const diff = quantized[0]! - previous[component]!;
    previous[component] = quantized[0]!;
    const dcSize = bitLength(diff);
    const [dcCode, dcLength] = dc.get(dcSize)!;
    bits.write(dcCode, dcLength);
    if (dcSize > 0) bits.write(diff < 0 ? diff + (1 << dcSize) - 1 : diff, dcSize);
    let run = 0;
    for (let k = 1; k < 64; k += 1) {
      const value = quantized[k]!;
      if (value === 0) {
        run += 1;
        continue;
      }
      while (run >= 16) {
        const [zrl, zrlLength] = ac.get(0xf0)!;
        bits.write(zrl, zrlLength);
        run -= 16;
      }
      const size = bitLength(value);
      const [code, length] = ac.get((run << 4) | size)!;
      bits.write(code, length);
      bits.write(value < 0 ? value + (1 << size) - 1 : value, size);
      run = 0;
    }
    if (run > 0) {
      const [eob, eobLength] = ac.get(0x00)!;
      bits.write(eob, eobLength);
    }
  };

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y += 1) {
        const row = Math.min(by + y, height - 1);
        for (let x = 0; x < 8; x += 1) {
          const col = Math.min(bx + x, width - 1);
          const p = (row * width + col) * 3;
          const r = data[p]!;
          const g = data[p + 1]!;
          const b = data[p + 2]!;
          const i = y * 8 + x;
          yBlock[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          cbBlock[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          crBlock[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      encodeBlock(yBlock, lumaDiv, 0, dcLuma, acLuma);
      encodeBlock(cbBlock, chromaDiv, 1, dcChroma, acChroma);
      encodeBlock(crBlock, chromaDiv, 2, dcChroma, acChroma);
    }
  }
  const scan = bits.finish();

  const header: number[] = [0xff, 0xd8];
  // APP0 JFIF 1.1, no density.
  header.push(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  header.push(0xff, 0xdb, 0, 132, 0, ...lumaZigzag, 1, ...chromaZigzag);
  header.push(0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
  const tables: [number, HuffmanSpec][] = [
    [0x00, JPEG_HUFFMAN.dcLuma],
    [0x10, JPEG_HUFFMAN.acLuma],
    [0x01, JPEG_HUFFMAN.dcChroma],
    [0x11, JPEG_HUFFMAN.acChroma]
  ];
  const dhtLength = 2 + tables.reduce((sum, [, spec]) => sum + 17 + spec.symbols.length, 0);
  header.push(0xff, 0xc4, dhtLength >> 8, dhtLength & 0xff);
  for (const [klass, spec] of tables) header.push(klass, ...spec.counts, ...spec.symbols);
  header.push(0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);
  return Buffer.concat([Buffer.from(header), Buffer.from(scan), Buffer.from([0xff, 0xd9])]);
}
