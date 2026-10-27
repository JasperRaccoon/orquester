import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { base64Length, decodePng, downscale, encodeJpeg, fitScreenshot, JPEG_HUFFMAN, pngSize } from "./screenshot-image.ts";

/** An RGBA PNG of noise (filter type cycling 0–4 per row, so every unfilter path runs). */
function noisePng(width: number, height: number): { png: Buffer; rgb: Buffer } {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  const pixels = Buffer.alloc(height * width * 4);
  let seed = 7;
  for (let i = 0; i < pixels.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = seed >> 16;
  }
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!;
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x]! - predictor) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) pixels.copy(rgb, i * 3, i * 4, i * 4 + 3);
  return { png, rgb };
}

test("PNG decoding undoes every filter; downscaling averages blocks", () => {
  const { png, rgb } = noisePng(37, 23);
  assert.deepEqual(pngSize(png), { width: 37, height: 23 });
  const image = decodePng(png);
  assert.equal(image.width, 37);
  assert.deepEqual(image.data, rgb);
  const half = downscale({ width: 2, height: 2, data: Buffer.from([0, 0, 0, 10, 10, 10, 20, 20, 20, 30, 30, 30]) }, 2);
  assert.deepEqual(half, { width: 1, height: 1, data: Buffer.from([15, 15, 15]) });
  assert.equal(pngSize(Buffer.from("not a png at all, really not")), null);
});

test("JPEG: standard tables, valid markers; fitting keeps a small PNG and shrinks a large one to the cap", () => {
  for (const spec of Object.values(JPEG_HUFFMAN)) assert.equal(spec.counts.reduce((a, b) => a + b, 0), spec.symbols.length);
  const { png } = noisePng(256, 192);
  const jpeg = encodeJpeg(decodePng(png), 80);
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
  // SOF0 carries the size.
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(jpeg.readUInt16BE(sof + 5), 192);
  assert.equal(jpeg.readUInt16BE(sof + 7), 256);

  const small = fitScreenshot(png, base64Length(png.length));
  assert.equal(small.mimeType, "image/png");
  assert.equal(small.data, png);
  const capped = fitScreenshot(png, 20_000);
  assert.equal(capped.mimeType, "image/jpeg");
  assert.ok(base64Length(capped.data.length) <= 20_000);
  assert.ok(capped.width < 256 && capped.width * 192 === capped.height * 256);
});
