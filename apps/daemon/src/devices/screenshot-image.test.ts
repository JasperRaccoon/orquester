import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { decode } from "jpeg-js";

import { fitRgbScreenshot, fitScreenshot, thumbnailJpeg } from "./screenshot-image.ts";

const fixture = (filter: number): Buffer => readFileSync(new URL(`./fixtures/image-codec/filter-${filter}.png`, import.meta.url));

test("PNG filters preserve known colors through public thumbnail JPEG output", () => {
  // Authored source colors, independently encoded by libpng; see the fixture README.
  const colors = [[220, 30, 20], [20, 200, 40], [30, 40, 210], [160, 160, 160]];
  for (const filter of [0, 1, 2, 3, 4]) {
    const image = decode(thumbnailJpeg(fixture(filter), 32), { formatAsRGBA: false, tolerantDecoding: false });
    assert.ok(image.width > 0 && image.width <= 32);
    assert.equal(image.width, image.height * 2);
    for (const [bar, expected] of colors.entries()) {
      const x = Math.floor((bar + 0.5) * image.width / 4);
      const offset = (Math.floor(image.height / 2) * image.width + x) * 3;
      for (const [channel, value] of expected.entries()) {
        assert.ok(Math.abs(image.data[offset + channel]! - value) <= 8, `filter ${filter}, bar ${bar}, channel ${channel}: expected ${value}, got ${image.data[offset + channel]}`);
      }
    }
  }
});

test("fitting preserves an exact-cap PNG and returns a decodable JPEG within a smaller cap", () => {
  const png = fixture(0);
  const small = fitScreenshot(png, png.toString("base64").length);
  assert.equal(small.mimeType, "image/png");
  assert.equal(small.data, png);
  const capped = fitScreenshot(png, 900);
  assert.equal(capped.mimeType, "image/jpeg");
  assert.ok(capped.data.toString("base64").length <= 900);
  const image = decode(capped.data, { tolerantDecoding: false });
  assert.deepEqual([image.width, image.height], [capped.width, capped.height]);
  assert.ok(image.width < 64 && image.width === image.height * 2);
});

/** An exact reader for the 8-bit RGB PNGs `fitRgbScreenshot` writes (the test's oracle). */
function readRgbPng(png: Buffer): { width: number; height: number; data: number[] } {
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.deepEqual([png[24], png[25], png[28]], [8, 2, 0], "8-bit truecolour, not interlaced");
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    if (png.toString("latin1", offset + 4, offset + 8) === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + png.readUInt32BE(offset)));
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const data: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? data[y * stride + x - 3]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const c = x >= 3 && y > 0 ? data[(y - 1) * stride + x - 3]! : 0;
      const p = a + b - c;
      const predictor = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][filter]!;
      data.push((raw[y * (stride + 1) + 1 + x]! + predictor) & 0xff);
    }
  }
  return { width, height, data };
}

test("RGB fitting: an image within the bound is a lossless PNG of the same pixels", () => {
  // A gradient plus noise, so rows pick different filters.
  let seed = 3;
  const data = Buffer.alloc(37 * 23 * 3);
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    data[i] = i % 7 === 0 ? seed >>> 23 : (i * 3) & 0xff;
  }
  const fitted = fitRgbScreenshot({ width: 37, height: 23, data }, 1920, 1 << 20);
  assert.equal(fitted.mimeType, "image/png");
  assert.deepEqual([fitted.width, fitted.height], [37, 23]);
  assert.deepEqual(readRgbPng(fitted.data), { width: 37, height: 23, data: [...data] });
});

test("RGB fitting: scaling to the long edge averages the source area each pixel covers", () => {
  // 3×1 gray 0, 90, 180 → 2×1: each output pixel covers 1.5 source pixels.
  const row = Buffer.from([0, 0, 0, 90, 90, 90, 180, 180, 180]);
  const scaled = fitRgbScreenshot({ width: 3, height: 1, data: row }, 2, 1 << 20);
  assert.deepEqual(readRgbPng(scaled.data), { width: 2, height: 1, data: [30, 30, 30, 150, 150, 150] });
  // The long edge may be the height; the aspect ratio is kept.
  const tall = fitRgbScreenshot({ width: 40, height: 100, data: Buffer.alloc(40 * 100 * 3, 200) }, 50, 1 << 20);
  assert.deepEqual([tall.width, tall.height], [20, 50]);
  assert.ok(readRgbPng(tall.data).data.every((value) => value === 200));
  assert.throws(() => fitRgbScreenshot({ width: 2, height: 2, data: Buffer.alloc(11) }, 10, 1 << 20), /not 2×2×3/);
});

test("RGB fitting: an image whose PNG is over the cap becomes a decodable JPEG within it", () => {
  let seed = 11;
  const data = Buffer.alloc(200 * 100 * 3);
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    data[i] = seed >>> 23;
  }
  const fitted = fitRgbScreenshot({ width: 200, height: 100, data }, 100, 6_000);
  assert.equal(fitted.mimeType, "image/jpeg");
  assert.ok(fitted.data.toString("base64").length <= 6_000);
  const image = decode(fitted.data, { tolerantDecoding: false });
  assert.deepEqual([image.width, image.height], [fitted.width, fitted.height]);
  assert.ok(fitted.width <= 100 && fitted.width === fitted.height * 2);
});
